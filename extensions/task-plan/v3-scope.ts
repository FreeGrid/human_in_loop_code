import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { canonicalHash, canonicalJson } from "./authority.ts";
import { describeExecutionSandbox, type ExecutionSandbox } from "./execution-sandbox.ts";
import { receiptSignerProtectedPaths, type ReceiptSigner } from "./evidence.ts";
import { parseV3Scope, v3Fail, v3PathMatches, type ReadableContract } from "./v3-contract.ts";
import { assertV3Baseline, type V3Baseline, type V3RawEntry, type V3Runtime } from "./v3-runtime.ts";
const exec = promisify(execFile);
const within = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);
const normalized = (path: string): string => path.normalize("NFC").toLowerCase();
function protectedPaths(runtime: V3Runtime, signer: ReceiptSigner): string[] { return [runtime.plan_path, runtime.root, ...runtime.protected_key_paths, ...receiptSignerProtectedPaths(signer)]; }
async function canonicalFuture(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return resolve(await canonicalFuture(dirname(path)), path.slice(dirname(path).length + 1)); }
}
export async function assertV3Sandbox(runtime: V3Runtime, contract: ReadableContract, signer: ReceiptSigner, sandbox: ExecutionSandbox): Promise<void> {
  const config = describeExecutionSandbox(sandbox), policy = contract.policy;
  const sorted = (list: readonly string[]): string => canonicalJson([...list].sort());
  if (config.target_root !== runtime.target_root || sorted(config.read_scope) !== sorted(policy.read_scope) || sorted(config.write_scope) !== sorted(policy.write_scope) || sorted(config.allowed_executables) !== sorted(policy.allowed_executables)) v3Fail("sandbox_contract_mismatch");
  const common = await realpath((await exec("git", ["-C", runtime.target_root, "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim());
  if (config.common_git_root !== common) v3Fail("sandbox_git_mismatch");
  for (const path of [...protectedPaths(runtime, signer), ...policy.forbidden_scope.map(rule => resolve(runtime.target_root, parseV3Scope(rule).path))]) {
    const canonical = await canonicalFuture(path);
    if (!config.protected_roots.some(root => within(root, canonical))) v3Fail("sandbox_protection_required");
  }
}
/** A raw bounded inventory includes ignored files. It never trusts model-supplied pass/fail facts. */
async function inventory(runtime: V3Runtime, contract: ReadableContract, signer: ReceiptSigner): Promise<V3Baseline> {
  const root = runtime.target_root, policy = contract.policy, protectedRoots = protectedPaths(runtime, signer);
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) v3Fail("target_changed");
  const entries: V3RawEntry[] = []; let remaining = 100000, bytes = 0;
  for (const rule of [...policy.read_scope, ...policy.write_scope]) {
    const path = resolve(root, parseV3Scope(rule).path);
    if (await canonicalFuture(path) !== path || protectedRoots.some(protectedRoot => within(path, protectedRoot) || within(protectedRoot, path)) || policy.forbidden_scope.some(forbidden => v3PathMatches(normalized(parseV3Scope(rule).path), normalized(forbidden)))) v3Fail("scope_protected_or_alias");
    try { if ((await lstat(path)).isDirectory() !== parseV3Scope(rule).recursive) v3Fail("scope_kind_mismatch"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  async function visit(path: string): Promise<void> {
    if (--remaining < 0) v3Fail("raw_inventory_budget");
    const absolute = resolve(root, path);
    if (normalized(path).split("/").includes(".git")) return;
    const protection = protectedRoots.find(protectedRoot => within(normalized(protectedRoot), normalized(absolute)));
    if (protection) { if (!within(protection, absolute)) v3Fail("protected_path_alias"); return; }
    const info = await lstat(absolute, { bigint: true });
    const inScope = [...policy.read_scope, ...policy.write_scope].some(rule => v3PathMatches(path, rule));
    if (info.isSymbolicLink()) {
      if (inScope) v3Fail("scope_alias_denied");
      entries.push({ path, kind: "symlink", mode: Number(info.mode & 0o7777n), hash: canonicalHash(await readlink(absolute)) }); return;
    }
    if (await realpath(absolute) !== absolute) v3Fail("raw_inventory_alias");
    if (info.isDirectory()) {
      entries.push({ path, kind: "directory", mode: Number(info.mode & 0o7777n), hash: canonicalHash("directory") });
      for (const child of (await readdir(absolute)).sort()) await visit(`${path}/${child}`);
      const after = await lstat(absolute, { bigint: true });
      if (after.dev !== info.dev || after.ino !== info.ino || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) v3Fail("raw_inventory_changed");
      return;
    }
    if (!info.isFile() || info.nlink !== 1n) v3Fail("raw_inventory_alias");
    if (info.size > 67108864n) v3Fail("raw_inventory_budget");
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true }); if (!before.isFile() || before.nlink !== 1n || before.dev !== info.dev || before.ino !== info.ino) v3Fail("raw_inventory_changed");
      const hash = createHash("sha256"), buffer = Buffer.alloc(65536); let total = 0;
      while (true) { const read = await file.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break; total += read.bytesRead; bytes += read.bytesRead; if (total > 67108864 || bytes > 268435456) v3Fail("raw_inventory_budget"); hash.update(buffer.subarray(0, read.bytesRead)); }
      const after = await file.stat({ bigint: true }), current = await lstat(absolute, { bigint: true });
      if (BigInt(total) !== info.size || after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs || current.dev !== info.dev || current.ino !== info.ino || current.nlink !== 1n) v3Fail("raw_inventory_changed");
      entries.push({ path, kind: "file", mode: Number(info.mode & 0o7777n), hash: hash.digest("hex") });
    } finally { await file.close(); }
  }
  const before = await lstat(root, { bigint: true });
  for (const name of (await readdir(root)).sort()) await visit(name);
  const after = await lstat(root, { bigint: true });
  if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) v3Fail("raw_inventory_changed");
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const result = { root, entries, hash: canonicalHash({ root, entries }) }; assertV3Baseline(result); return result;
}
export async function captureV3Baseline(runtime: V3Runtime, contract: ReadableContract, signer: ReceiptSigner): Promise<V3Baseline> {
  const first = await inventory(runtime, contract, signer), second = await inventory(runtime, contract, signer);
  if (first.hash !== second.hash) v3Fail("raw_inventory_changed"); return second;
}
export async function inspectV3Scope(runtime: V3Runtime, contract: ReadableContract, signer: ReceiptSigner, baseline: V3Baseline): Promise<string> {
  assertV3Baseline(baseline); if (baseline.root !== runtime.target_root) v3Fail("foreign_baseline");
  const current = await captureV3Baseline(runtime, contract, signer), before = new Map(baseline.entries.map(entry => [entry.path, entry])), after = new Map(current.entries.map(entry => [entry.path, entry]));
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (canonicalJson(before.get(path) ?? null) === canonicalJson(after.get(path) ?? null)) continue;
    if (before.get(path)?.kind === "symlink" || after.get(path)?.kind === "symlink" || !contract.policy.write_scope.some(rule => v3PathMatches(path, rule)) || contract.policy.forbidden_scope.some(rule => v3PathMatches(normalized(path), normalized(rule)))) v3Fail(`write_scope_violation:${path}`);
  }
  return v3ContentVersion(contract, baseline, current);
}

export function v3ContentVersion(contract: ReadableContract, baseline: V3Baseline, current: V3Baseline): string {
  const selected = current.entries.filter(entry => [...contract.policy.read_scope, ...contract.policy.write_scope].some(rule => v3PathMatches(entry.path, rule)));
  return `v3-raw:${canonicalHash({ baseline: baseline.hash, selected })}`;
}
