import { execFile, spawn } from "node:child_process";
import { access, lstat, opendir, readFile, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Trusted Controller composition only. This factory is deliberately absent from model tools.
 * Untrusted implementations and verification commands execute in child processes, never in
 * the Controller JS realm. The OS sandbox, not the TypeScript brand, protects its authority.
 * Darwin only: child creation and networking are unconditionally denied. Programs needing
 * subprocesses must be split into separately bounded Controller invocations. Exec replacement
 * is allowed only for the fixed executable list and preserves the same sandbox and process.
 */
export interface ExecutionSandboxConfiguration {
  target_root: string;
  read_scope: string[];
  write_scope: string[];
  common_git_root: string;
  protected_roots: string[];
  allowed_executables: string[];
  runtime_read_roots?: string[];
}
declare const sandboxBrand: unique symbol;
export interface ExecutionSandbox { readonly [sandboxBrand]: true }
export interface SandboxedProcessRequest {
  executable: string; args: string[]; cwd: string; env?: Record<string, string>;
  timeout_ms?: number; max_buffer_bytes?: number;
}
export interface SandboxedProcessResult {
  stdout: string; stderr: string; exit_code: number | null;
  signal: NodeJS.Signals | null; timed_out: boolean; output_limit_exceeded: boolean;
}
interface Scope { path: string; recursive: boolean }
interface BoundSandbox {
  config: ExecutionSandboxConfiguration; reads: Scope[]; writes: Scope[];
  protected: string[]; executables: string[]; runtime: string[]; system_exclusions: string[];
}
const SYSTEM_READ_ROOTS = ["/System/Library", "/usr/lib", "/bin", "/usr/bin"];
const execFileAsync = promisify(execFile);
const sandboxes = new WeakMap<ExecutionSandbox, BoundSandbox>();
function fail(reason: string): never { throw new Error(`execution_sandbox:${reason}`); }
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) fail("string");
}
function inside(root: string, path: string): boolean { return path === root || path.startsWith(root === sep ? root : root + sep); }
function absolute(value: unknown): asserts value is string { text(value); if (!isAbsolute(value) || resolve(value) !== value) fail("absolute_path"); }
function list(value: unknown, nonempty = false): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 256 || (nonempty && !value.length)) fail("list");
  value.forEach(text); if (new Set(value).size !== value.length) fail("duplicate");
}
function fields(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(k => typeof k !== "string" || ![...required, ...optional].includes(k)) || required.some(k => !Object.hasOwn(value, k)) || Object.values(descriptors).some(d => !Object.hasOwn(d, "value"))) fail("fields");
}
async function canonicalFuture(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { await lstat(path); fail("dangling_symlink"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(path); if (parent === path) fail("missing_root");
    return join(await canonicalFuture(parent), path.slice(parent.length + (parent === sep ? 0 : 1)));
  }
}
/** APFS can preserve equivalent case/Unicode spelling in realpath output. Reject
 * conservative spelling overlaps and confirm filesystem identity for existing roots.
 * Conservative rejection is intentional even on a case-sensitive volume.
 */
async function rootsOverlap(a: string, b: string): Promise<boolean> {
  const folded = (path: string) => path.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
  if (inside(folded(a), folded(b)) || inside(folded(b), folded(a))) return true;
  async function isAncestor(root: string, descendant: string): Promise<boolean> {
    let rootInfo;
    try { rootInfo = await lstat(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    let path = descendant;
    while (true) {
      try { const info = await lstat(path); if (info.dev === rootInfo.dev && info.ino === rootInfo.ino) return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const parent = dirname(path); if (parent === path) return false; path = parent;
    }
  }
  return await isAncestor(a, b) || await isAncestor(b, a);
}

async function scope(root: string, value: string): Promise<Scope> {
  text(value); const recursive = value.endsWith("/**"); const local = recursive ? value.slice(0, -3) : value;
  if (!local || isAbsolute(local) || /[\\*?\[\]{}]/.test(local) || local.split("/").some(p => !p || p === "." || p === "..")) fail("scope_pattern");
  const path = resolve(root, local); if (!inside(root, path)) fail("scope_escape");
  if (await canonicalFuture(path) !== path) fail("scope_symlink");
  try {
    const info = await lstat(path);
    if (info.isDirectory() !== recursive) fail("scope_kind");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { path, recursive };
}
async function auditScope(bound: BoundSandbox, scope: Scope): Promise<void> {
  let remaining = 100000;
  async function visit(path: string): Promise<void> {
    if (--remaining < 0) fail("scope_too_large");
    if (bound.protected.some(root => inside(root, path)) || relative(bound.config.target_root, path).split(sep).includes(".git")) return;
    let info; try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (info.isSymbolicLink()) {
      const target = await canonicalFuture(path); if (!inside(bound.config.target_root, target)) fail("scope_symlink_escape");
      return;
    }
    if (info.isFile() && info.nlink > 1) fail("scope_hardlink");
    if (info.isDirectory() && scope.recursive) for (const name of await readdir(path)) await visit(join(path, name));
  }
  if (await canonicalFuture(scope.path) !== scope.path) fail("scope_changed");
  try { if ((await lstat(scope.path)).isDirectory() !== scope.recursive) fail("scope_kind_changed"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await visit(scope.path);
}
/** Broad system read exceptions are safe only on the sealed read-only OS volume.
 * Writable firmlink namespaces under system library paths are expressly excluded.
 */
async function systemReadExclusions(): Promise<string[]> {
  const { stdout } = await execFileAsync("/sbin/mount", [], {env:{PATH:"/usr/bin:/bin"},encoding:"utf8",timeout:5000,maxBuffer:1048576});
  const mounts = stdout.trim().split("\n").map(line => {
    const match = /^.+ on (.+) \((.+)\)$/.exec(line); if (!match) fail("system_mount_format");
    return { path: match[1], flags: match[2].split(", ") };
  });
  const root = mounts.find(mount => mount.path === "/");
  if (!root?.flags.includes("sealed") || !root.flags.includes("read-only")) fail("unsealed_system");
  for (const mount of mounts) if (mount.path !== "/" && SYSTEM_READ_ROOTS.some(root => inside(root, mount.path)) && !mount.flags.includes("read-only")) fail("writable_system_mount");
  const firmlinks = await readFile("/usr/share/firmlinks", "utf8");
  if (firmlinks.length > 1048576) fail("firmlink_budget");
  return firmlinks.trim().split("\n").map(line => {
    const parts = line.split("\t"); if (parts.length !== 2) fail("firmlink_format"); absolute(parts[0]); return parts[0];
  }).filter(path => SYSTEM_READ_ROOTS.some(root => inside(root, path))).sort();
}

/** Every non-system read exception is an authority surface: a preexisting hardlink
 * can expose a protected inode even when its canonical protected path is denied.
 * The same bounded audit is repeated immediately before each launch.
 */
async function auditRuntimeReads(bound: BoundSandbox): Promise<void> {
  let remaining = 10000;
  const visited = new Set<string>();
  async function visit(path: string): Promise<void> {
    if (--remaining < 0) fail("runtime_audit_budget");
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const canonical = await realpath(path);
      if (!bound.runtime.some(root => inside(root, canonical)) && !bound.executables.includes(canonical)) fail("runtime_symlink_escape");
      await visit(canonical); return;
    }
    if (info.isFile() && info.nlink !== 1) fail("runtime_hardlink");
    if (!info.isFile() && !info.isDirectory()) fail("runtime_file_kind");
    const identity = `${info.dev}:${info.ino}`;
    if (visited.has(identity)) return;
    visited.add(identity);
    if (info.isDirectory()) {
      for await (const entry of await opendir(path)) await visit(join(path, entry.name));
    }
  }
  for (const path of [...bound.runtime, ...bound.executables]) await visit(path);
}

function quote(value: string): string { return JSON.stringify(value); }
function filter(scope: Scope): string { return `(${scope.recursive ? "subpath" : "literal"} ${quote(scope.path)})`; }
function profile(bound: BoundSandbox): string {
  // Directory entries, not descendants: required by Darwin getcwd and dyld.
  const fixed = [bound.config.target_root, "/", "/dev/null", "/dev/random", "/dev/urandom"];
  const aliasEntries = new Set<string>();
  for (const grant of [...bound.runtime, ...(bound.config.runtime_read_roots ?? [])]) {
    let path = dirname(grant);
    while (true) { aliasEntries.add(path); const parent = dirname(path); if (parent === path) break; path = parent; }
  }
  const reads = [
    ...SYSTEM_READ_ROOTS.map(path => ({ path, recursive: true })),
    ...fixed.map(path => ({ path, recursive: false })),
    ...bound.runtime.map(path => ({ path, recursive: true })),
    ...(bound.config.runtime_read_roots ?? []).map(path => ({ path, recursive: true })),
    ...[...aliasEntries].map(path => ({ path, recursive: false })),
    ...bound.executables.map(path => ({ path, recursive: false })),
    ...bound.reads,
  ];
  // Otherwise renaming an ancestor moves protected descendants out of their path filters.
  const lockedAncestors = new Set<string>();
  for (const protectedPath of [...bound.protected, bound.config.target_root]) {
    let path = dirname(protectedPath);
    while (true) {
      lockedAncestors.add(path);
      const parent = dirname(path);
      if (parent === path) break;
      path = parent;
    }
  }
  const literals = (paths: string[]) => paths.map(path => `(literal ${quote(path)})`).join(" ");
  return [
    "(version 1)",
    "(deny default)",
    `(allow process-exec ${literals(bound.executables)})`,
    "(deny process-fork)",
    '(allow sysctl-read (sysctl-name-regex #"^hw[.]") (sysctl-name "kern.osrelease") (sysctl-name "kern.osversion") (sysctl-name "kern.version"))',
    "(allow file-map-executable)",
    `(allow file-read* ${reads.map(filter).join(" ")})`,
    ...(bound.writes.length ? [`(allow file-write* ${bound.writes.map(filter).join(" ")})`] : []),
    // Component matching also denies .GIT on case-insensitive filesystems.
    `(deny file-read* file-write* (regex #"/[.][gG][iI][tT](/.*)?$") ${bound.protected.map(path => `(subpath ${quote(path)})`).join(" ")})`,
    `(deny file-write* ${literals([...lockedAncestors])})`,
    // Readable libraries must never be hardlinked into a writable scope.
    ...(bound.system_exclusions.length ? [`(deny file-read* file-write* ${bound.system_exclusions.map(path => `(subpath ${quote(path)})`).join(" ")})`] : []),
    "(deny file-link)",
    "(deny network*)",
  ].join("\n");
}
export async function configureExecutionSandbox(configuration: ExecutionSandboxConfiguration): Promise<ExecutionSandbox> {
  if (process.platform !== "darwin") fail("platform_unavailable");
  await access("/usr/bin/sandbox-exec", constants.X_OK);
  fields(configuration, ["target_root", "read_scope", "write_scope", "common_git_root", "protected_roots", "allowed_executables"], ["runtime_read_roots"]);
  const config = structuredClone(configuration);
  absolute(config.target_root); absolute(config.common_git_root);
  list(config.read_scope); list(config.write_scope); list(config.protected_roots, true); list(config.allowed_executables, true); list(config.runtime_read_roots ?? []);
  config.target_root = await realpath(config.target_root);
  if (!(await lstat(config.target_root)).isDirectory()) fail("target_directory");
  for (const runtimeRoot of SYSTEM_READ_ROOTS) if (await rootsOverlap(runtimeRoot, config.target_root)) fail("system_runtime_scope_overlap");
  const protectedRoots = await Promise.all([config.common_git_root, ...config.protected_roots].map(async path => { absolute(path); return canonicalFuture(path); }));
  if (protectedRoots.some(path => inside(path, config.target_root))) fail("protected_target");
  const executables = await Promise.all(config.allowed_executables.map(async path => { absolute(path); const canonical = await realpath(path); await access(canonical, constants.X_OK); if (!(await lstat(canonical)).isFile() || protectedRoots.some(root => inside(root, canonical))) fail("executable"); return canonical; }));
  const runtime = await Promise.all((config.runtime_read_roots ?? []).map(async path => {
    absolute(path); const canonical = await realpath(path);
    if (await rootsOverlap(canonical, config.target_root)) fail("runtime_scope_overlap");
    for (const protectedRoot of protectedRoots) if (await rootsOverlap(canonical, protectedRoot)) fail("runtime_protected_overlap");
    return canonical;
  }));
  const bound: BoundSandbox = { config, system_exclusions: await systemReadExclusions(), protected: protectedRoots, executables, runtime, reads: await Promise.all(config.read_scope.map(s => scope(config.target_root, s))), writes: await Promise.all(config.write_scope.map(s => scope(config.target_root, s))) };
  await auditRuntimeReads(bound);
  for (const item of [...bound.reads, ...bound.writes]) await auditScope(bound, item);
  const handle = Object.freeze({}) as ExecutionSandbox; sandboxes.set(handle, bound); return handle;
}
export function describeExecutionSandbox(handle: ExecutionSandbox): Readonly<ExecutionSandboxConfiguration> {
  const bound = sandboxes.get(handle); if (!bound) fail("identity");
  const copy = structuredClone(bound.config); Object.freeze(copy.read_scope); Object.freeze(copy.write_scope); Object.freeze(copy.protected_roots); Object.freeze(copy.allowed_executables); if (copy.runtime_read_roots) Object.freeze(copy.runtime_read_roots); return Object.freeze(copy);
}
export async function runSandboxedProcess(handle: ExecutionSandbox, request: SandboxedProcessRequest): Promise<SandboxedProcessResult> {
  const bound = sandboxes.get(handle); if (!bound) fail("identity");
  fields(request, ["executable", "args", "cwd"], ["env", "timeout_ms", "max_buffer_bytes"]);
  const input = structuredClone(request); absolute(input.executable); absolute(input.cwd);
  if (!Array.isArray(input.args) || input.args.length > 4096 || input.args.some(arg => typeof arg !== "string" || arg.length > 1048576 || arg.includes("\0"))) fail("arguments");
  const timeout = input.timeout_ms ?? 60000; const limit = input.max_buffer_bytes ?? 1048576;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16777216) fail("limits");
  const executable = await realpath(input.executable); if (!bound.executables.includes(executable)) fail("command_not_allowed");
  if (await realpath(bound.config.target_root) !== bound.config.target_root) fail("target_changed");
  const cwd = await realpath(input.cwd); if (!inside(bound.config.target_root, cwd) || bound.protected.some(root => inside(root, cwd))) fail("cwd_escape");
  if (cwd !== bound.config.target_root && !bound.reads.some(item => item.recursive ? inside(item.path, cwd) : item.path === cwd)) fail("cwd_out_of_scope");
  if (JSON.stringify(await systemReadExclusions()) !== JSON.stringify(bound.system_exclusions)) fail("system_boundary_changed");
  for (const [index, path] of bound.runtime.entries()) {
    if (await realpath(path) !== path || await realpath(bound.config.runtime_read_roots![index]) !== path) fail("runtime_changed");
  }
  for (const path of bound.protected) if (await canonicalFuture(path) !== path) fail("protected_changed");
  await auditRuntimeReads(bound);
  for (const item of [...bound.reads, ...bound.writes]) await auditScope(bound, item);
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", LANG: "C", OPENSSL_CONF: "/dev/null" };
  if (input.env !== undefined) {
    fields(input.env, [], ["LANG", "LC_ALL", "TZ"]);
    for (const [name, value] of Object.entries(input.env)) { text(value); env[name] = value; }
  }
  return new Promise((resolveResult, reject) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile(bound), executable, ...input.args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let bytes = 0, timed_out = false, output_limit_exceeded = false;
    const killProcess = () => { child.kill("SIGKILL"); };
    const timer = setTimeout(() => { timed_out = true; killProcess(); }, timeout);
    function collect(chunks: Buffer[], chunk: Buffer) { const available = Math.max(0, limit - bytes); if (available) chunks.push(chunk.subarray(0, available)); bytes += chunk.length; if (bytes > limit) { output_limit_exceeded = true; killProcess(); } }
    child.stdout.on("data", chunk => collect(stdout, chunk)); child.stderr.on("data", chunk => collect(stderr, chunk));
    child.on("error", error => { clearTimeout(timer); killProcess(); reject(error); });
    child.on("close", (exit_code, signal) => { clearTimeout(timer); killProcess(); resolveResult({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exit_code, signal, timed_out, output_limit_exceeded }); });
  });
}
