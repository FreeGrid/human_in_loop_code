import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ContentIdentity } from "./contracts.ts";
import { resolveContainedPath } from "./targets.ts";

export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const missing: ContentIdentity = { kind: "missing" };
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const LIMIT = 32 * 1024 * 1024;
export function safeName(path: string): void {
  if (!path || path.length > 4096 || isAbsolute(path) || /[\\\x00-\x1f\x7f]/.test(path) || path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git")) throw new Error(`Unsafe Git path: ${path}`);
}
/** Never inherit repository selectors, object overrides, external filters or helper programs. */
export async function git(root: string, args: string[], input?: Buffer): Promise<Buffer> {
  if (Object.keys(process.env).some(key => /^(GIT_CONFIG(?:_|$)|GIT_ATTR_(?:NOSYSTEM|SOURCE)$)/.test(key))) throw new Error("Unsupported Git configuration/attribute environment override; remove it rather than silently changing normalization");
  // Object inspection must never turn a missing promisor object into a fetch/helper.
  // The empty protocol allowlist is defense in depth if Git attempts any transport.
  const env = { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && !["GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "GIT_NO_REPLACE_OBJECTS", "GIT_NO_LAZY_FETCH", "GIT_ALLOW_PROTOCOL"].includes(key)) delete (env as Record<string, string | undefined>)[key];
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.quotePath=false", "-c", "diff.external=", "-C", root, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let size = 0; const output: Buffer[] = []; const errors: Buffer[] = []; let failed = false;
    const fail = (error: Error) => { if (!failed) { failed = true; child.kill(); reject(error); } };
    const timer = setTimeout(() => fail(new Error("Git query timeout")), 30000);
    child.on("error", fail);
    child.stdout.on("data", (bytes: Buffer) => { size += bytes.length; if (size > LIMIT) fail(new Error("Git query exceeds bounded output")); else output.push(bytes); });
    child.stderr.on("data", (bytes: Buffer) => { if (errors.reduce((n, b) => n + b.length, 0) < 8192) errors.push(bytes); });
    child.stdin.on("error", fail);
    child.on("close", code => { clearTimeout(timer); if (!failed) code === 0 ? resolveResult(Buffer.concat(output)) : reject(new Error(`Git ${args[0]} failed (${code}): ${Buffer.concat(errors).toString().trim()}`)); });
    child.stdin.end(input);
  });
}
export const textGit = async (root: string, args: string[]) => (await git(root, args)).toString("utf8").trim();
export const names = (bytes: Buffer): string[] => {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value).equals(bytes)) throw new Error("Non-UTF8 Git paths are unsupported");
  return value.split("\0").filter(Boolean).map(path => { safeName(path); return path; });
};
export async function canonicalDirectory(path: string): Promise<string> {
  const absolute = resolve(path); const canonical = await realpath(absolute);
  // Root itself must not be a symlink; canonical ancestor aliases (e.g. macOS /tmp) are resolved.
  if ((await lstat(absolute)).isSymbolicLink() || !(await lstat(canonical)).isDirectory()) throw new Error("Unsafe repository directory");
  return canonical;
}
export interface RawRead { bytes: Buffer | null; mode: string; kind: "file" | "symlink" | "missing" }
export async function readRaw(root: string, path: string, onRead?: (path: string) => void): Promise<RawRead> {
  safeName(path);
  const full = await resolveContainedPath(root, path, { allowMissing: true, allowLeafSymlink: true });
  let before;
  try { before = await lstat(full, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await resolveContainedPath(root, path, { allowMissing: true, allowLeafSymlink: true });
    try { await lstat(full); } catch (again) { if ((again as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null, mode: "", kind: "missing" }; throw again; }
    throw new Error("Concurrent file appearance");
  }
  if (before.isSymbolicLink()) {
    const bytes = Buffer.from(await readlink(full)); const after = await lstat(full, { bigint: true });
    if (stamp(before) !== stamp(after) || !bytes.equals(Buffer.from(await readlink(full))) || await resolveContainedPath(root, path, { allowLeafSymlink: true }) !== full) throw new Error("Concurrent symlink modification");
    onRead?.(path); return { bytes, mode: "120000", kind: "symlink" };
  }
  if (!before.isFile() || before.size > BigInt(LIMIT)) throw new Error(`Unsupported or oversized working-tree file: ${path}`);
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (stamp(before) !== stamp(await handle.stat({ bigint: true }))) throw new Error("Concurrent file replacement");
    onRead?.(path); const bytes = await handle.readFile();
    const second = Buffer.alloc(bytes.length + 1); let length = 0;
    while (length < second.length) { const read = await handle.read(second, length, second.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    if (bytes.length > LIMIT || length !== bytes.length || !bytes.equals(second.subarray(0, length)) || stamp(before) !== stamp(await handle.stat({ bigint: true })) || stamp(before) !== stamp(await lstat(full, { bigint: true })) || await resolveContainedPath(root, path) !== full) throw new Error("Concurrent file modification");
    return { bytes, mode: (before.mode & 0o111n) ? "100755" : "100644", kind: "file" };
  } finally { await handle.close(); }
}
function stamp(s: { dev: bigint; ino: bigint; mode: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string { return [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(":"); }
export function blobIdentity(bytes: Buffer, mode: string, format: "sha1" | "sha256"): ContentIdentity {
  const oid = createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  return { kind: mode === "120000" ? "symlink" : "file", mode, oid, domain: `git-${format}` };
}
export interface Snapshot { head: string; tree: string; index: string; dirty: string[]; untracked: string[]; entries: Record<string, ContentIdentity>; rules: string; autocrlf: string; format: "sha1" | "sha256" }
export async function treeEntries(root: string, tree: string, format: "sha1" | "sha256"): Promise<Record<string, ContentIdentity>> {
  const result: Record<string, ContentIdentity> = Object.create(null);
  const raw = await git(root, ["ls-tree", "-rz", "--full-tree", tree]);
  for (const entry of raw.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("Unsupported tree entry (submodules are not supported)");
    const [, mode, oid, path] = match; safeName(path!);
    result[path!] = { kind: mode === "120000" ? "symlink" : "file", mode: mode!, oid: oid!, domain: `git-${format}` };
  }
  if (!Buffer.from(raw.toString("utf8")).equals(raw)) throw new Error("Non-UTF8 Git paths are unsupported");
  const objects = [...new Set(Object.values(result).map(identity => (identity as Exclude<ContentIdentity, { kind: "missing" }>).oid))];
  if (objects.length) {
    const checked = (await git(root, ["cat-file", "--batch-check"], Buffer.from(objects.join("\n") + "\n"))).toString().trim().split("\n");
    if (checked.length !== objects.length || checked.some((line, i) => !line.startsWith(objects[i] + " blob ") || !/ blob \d+$/.test(line))) throw new Error("Missing or unreadable Git blob object");
  }
  return result;
}
export async function attributes(root: string, paths: string[]): Promise<Record<string, Record<string, string>>> {
  const result: Record<string, Record<string, string>> = Object.create(null);
  if (!paths.length) return result;
  const parts = (await git(root, ["check-attr", "-z", "--stdin", "text", "eol", "filter", "working-tree-encoding", "ident"], Buffer.from(paths.join("\0") + "\0"))).toString().split("\0");
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const [path, key, value] = parts.slice(i, i + 3) as [string, string, string];
    (result[path] ??= Object.create(null))[key] = value;
    if (["filter", "working-tree-encoding", "ident"].includes(key) && !["unspecified", "unset"].includes(value)) throw new Error(`Unsupported Git ${key} on ${path}`);
    if (key === "text" && !["unspecified", "unset", "set", "auto"].includes(value)) throw new Error(`Unsupported text attribute on ${path}`);
    if (key === "eol" && !["unspecified", "unset", "lf", "crlf"].includes(value)) throw new Error(`Unsupported eol attribute on ${path}`);
  }
  return result;
}
export function normalize(bytes: Buffer, attrs: Record<string, string>, autocrlf: string, original?: Buffer): Buffer {
  if (attrs.text === "unset") return bytes;
  const explicit = attrs.text === "set" || (attrs.text === "unspecified" && ["lf", "crlf"].includes(attrs.eol!));
  const auto = attrs.text === "auto" || (attrs.text === "unspecified" && !explicit && autocrlf !== "false");
  if (!explicit && !auto) return bytes;
  // Git auto does not normalize binary/bare-CR files or an already-CRLF tracked blob.
  if (auto) {
    let printable = 0, nonPrintable = 0;
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i]!;
      if (c === 0 || (c === 13 && bytes[i + 1] !== 10)) return bytes;
      if (c === 13) { i++; continue; }
      if (c === 10 || c === 26 && i === bytes.length - 1) continue;
      if (c >= 32 && c !== 127 || [8, 9, 12, 27].includes(c)) printable++; else nonPrintable++;
    }
    if ((printable >> 7) < nonPrintable || original?.includes(Buffer.from("\r\n"))) return bytes;
  }
  const output = Buffer.allocUnsafe(bytes.length); let n = 0;
  for (let i = 0; i < bytes.length; i++) if (!(bytes[i] === 13 && bytes[i + 1] === 10)) output[n++] = bytes[i]!;
  return output.subarray(0, n);
}
/** Metadata enumeration is intentionally separate from bounded content reads. */
export async function snapshot(root: string, extra: string[], onRead?: (path: string) => void): Promise<Snapshot> {
  const format = await textGit(root, ["rev-parse", "--show-object-format"]);
  if (format !== "sha1" && format !== "sha256") throw new Error("Unsupported object format");
  const head = await textGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const tree = await textGit(root, ["rev-parse", "--verify", "HEAD^{tree}"]);
  const indexBytes = await git(root, ["ls-files", "--stage", "-z"]);
  for (const item of indexBytes.toString().split("\0").filter(Boolean)) if (!/^(100644|100755|120000) [0-9a-f]+ 0\t/.test(item)) throw new Error("Unsupported submodule or unmerged index");
  const flags = (await git(root, ["ls-files", "-v", "-z"])).toString().split("\0").filter(Boolean);
  if (flags.some(item => item[0] !== "H")) throw new Error("Unsupported sparse/skip-worktree/assume-unchanged index");
  const configBytes = await git(root, ["config", "--null", "--list"]);
  const config: Record<string, string> = Object.create(null);
  for (const row of configBytes.toString().split("\0").filter(Boolean)) { const split = row.indexOf("\n"); config[row.slice(0, split)] = row.slice(split + 1); }
  const falseValues = ["false", "0", "no", "off"];
  const isFalse = (value: string | undefined) => value !== undefined && falseValues.includes(value.toLowerCase());
  if (config["core.sparsecheckout"] !== undefined && !isFalse(config["core.sparsecheckout"])) throw new Error("Unsupported sparse checkout");
  if (isFalse(config["core.filemode"]) || isFalse(config["core.symlinks"]) || isFalse(config["core.trustctime"]) || config["core.ignorestat"] !== undefined && !isFalse(config["core.ignorestat"]) || config["core.checkstat"] !== undefined && config["core.checkstat"] !== "default") throw new Error("Unsupported Git stat/mode/symlink configuration can hide working-tree changes");
  const autocrlf = config["core.autocrlf"] ?? "false";
  if (!["true", "false", "input"].includes(autocrlf)) throw new Error("Unsupported core.autocrlf");
  const entries = await treeEntries(root, tree, format);
  const untracked = names(await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
  const all = [...new Set([...Object.keys(entries), ...flags.map(f => f.slice(2)), ...untracked, ...extra])].sort();
  await attributes(root, all);
  // Plumbing name discovery only: porcelain diff refreshes the index and can execute clean
  // filters even with --no-ext-diff. diff-files does not refresh or compare working-tree bytes.
  const dirty = names(await git(root, ["diff-files", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--"]));
  dirty.push(...names(await git(root, ["diff-index", "--cached", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "HEAD", "--"])));
  const rulePaths = new Set<string>([".gitattributes"]);
  for (const path of all) { safeName(path); const components = path.split("/"); components.pop(); while (components.length) { rulePaths.add(components.join("/") + "/.gitattributes"); components.pop(); } }
  const ruleData: unknown[] = [];
  for (const path of [...rulePaths].sort()) { const value = await readRaw(root, path, onRead); if (value.kind === "symlink") throw new Error("Symlink attributes unsupported"); if (value.bytes) ruleData.push([path, digest(value.bytes)]); }
  // Effective external attributes files are read explicitly, not executed. Reject symlink files.
  const info = await textGit(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/attributes"]);
  // Git resolves its compiled system prefix and effective global attributes path. Older Git
  // without these variables is explicitly unsupported rather than silently missing rule drift.
  const systemAttributes = await textGit(root, ["var", "GIT_ATTR_SYSTEM"]);
  const globalAttributes = await textGit(root, ["var", "GIT_ATTR_GLOBAL"]);
  const external = [info, systemAttributes, globalAttributes].filter(Boolean).map(path => resolve(root, path));
  for (const path of external) { const canonicalParent = await realpath(resolve(path, ".." )).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; }); if (!canonicalParent) continue; const value = await readRaw(canonicalParent, relative(resolve(path, ".."), path), onRead); if (value.kind === "symlink") throw new Error("Symlink external attributes unsupported"); if (value.bytes) ruleData.push([path, digest(value.bytes)]); }
  const effectiveConfig = Object.entries(config).filter(([key]) => ["core.autocrlf", "core.eol", "core.safecrlf", "core.attributesfile", "core.filemode", "core.symlinks", "core.ignorecase", "core.trustctime", "core.ignorestat", "core.checkstat"].includes(key)).sort();
  return { head, tree, index: digest(indexBytes), dirty: [...new Set(dirty)].sort(), untracked: untracked.sort(), entries, rules: digest(JSON.stringify([effectiveConfig, ruleData])), autocrlf, format };
}
