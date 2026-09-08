import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { blobIdentity, canonicalDirectory, digest, git, missing, names, readRaw, same, textGit } from "./git.ts";
import type { ContentIdentity } from "./contracts.ts";
import { validateRelativePath } from "./targets.ts";

export interface DeliveryScopeInput {
  root: string;
  ranges: Array<{ base: string; head: string; mode?: "endpoints" | "merge-base"; label?: string }>;
  /** Exact repository-relative filenames; applies only to committed changes. */
  paths?: string[];
  /** Explicit local selection, including ignored/untracked files when named. */
  localPaths?: string[];
}
export interface DeliveryScope {
  root: string;
  ranges: Array<{ base: string; head: string; comparisonBase: string; mode: "endpoints" | "merge-base"; label?: string }>;
  /** Origins are one-based range:N references and/or local. */
  changes: Array<{ path: string; origins: string[] }>;
  localPaths: string[];
  version: string;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function selected(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > 128) throw new Error(`${name} requires 1–128 literal paths`);
  for (const path of value) validateRelativePath(path);
  return [...new Set(value as string[])].sort(compare);
}
function ref(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.startsWith("-") || /[\x00-\x20\x7f]/.test(value)) throw new Error("Invalid commit reference");
}
const resolveCommit = async (root: string, value: string) => {
  ref(value);
  const oid = await textGit(root, ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`]);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error("Invalid resolved commit");
  return oid;
};
async function repository(root: string): Promise<string> {
  const canonical = await canonicalDirectory(root);
  if (await textGit(canonical, ["rev-parse", "--show-toplevel"]) !== canonical) throw new Error("Target must be the Git worktree root");
  if ((await lstat(join(canonical, ".git"))).isSymbolicLink()) throw new Error("Symlink .git is unsupported");
  const within = (parent: string, path: string) => {
    const suffix = relative(parent, path);
    return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
  };
  for (const option of ["--absolute-git-dir", "--git-common-dir"]) {
    const metadata = await textGit(canonical, ["rev-parse", "--path-format=absolute", option]);
    if (await canonicalDirectory(metadata) !== metadata) throw new Error("Symlink Git directory is unsupported");
    if (within(canonical, metadata) && !within(join(canonical, ".git"), metadata)) throw new Error("Unsupported embedded Git metadata directory");
  }
  return canonical;
}
async function headIdentity(root: string, head: string, path: string, format: "sha1" | "sha256"): Promise<ContentIdentity> {
  // Literal pathspec prevents wildcard filenames from selecting other entries.
  const raw = await git(root, ["ls-tree", "-z", "--full-tree", head, "--", `:(literal)${path}`]);
  if (!raw.length) return missing;
  const text = raw.toString("utf8");
  if (!Buffer.from(text).equals(raw)) throw new Error("Non-UTF8 Git paths are unsupported");
  const rows = text.split("\0").filter(Boolean);
  const match = rows.length === 1 && /^(100644|100755|120000) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(rows[0]!);
  if (!match || match[3] !== path) throw new Error(`Unsupported selected Git entry: ${path}`);
  return { kind: match[1] === "120000" ? "symlink" : "file", mode: match[1]!, oid: match[2]!, domain: `git-${format}` };
}
async function currentIdentity(root: string, path: string, format: "sha1" | "sha256"): Promise<ContentIdentity> {
  const raw = await readRaw(root, path);
  return raw.bytes === null ? missing : blobIdentity(raw.bytes, raw.mode, format);
}

/** Read-only delivery facts. No Plan, initialization, policy, or acceptance state is required. */
export async function inspectDeliveryScope(input: DeliveryScopeInput): Promise<DeliveryScope> {
  if (!Array.isArray(input.ranges) || input.ranges.length > 8) throw new Error("Delivery scope supports at most 8 ranges");
  const paths = selected(input.paths, "paths"), localPaths = selected(input.localPaths, "localPaths") ?? [];
  if (!input.ranges.length && !localPaths.length) throw new Error("Select at least one range or explicit localPaths");
  // Copy caller inputs before yielding so mutable arguments cannot alter the selected scope.
  const requested = input.ranges.map(range => {
    if (!range || typeof range !== "object") throw new Error("Invalid delivery range");
    ref(range.base); ref(range.head);
    const mode = range.mode ?? "endpoints";
    if (mode !== "endpoints" && mode !== "merge-base") throw new Error("Invalid range mode");
    if (range.label !== undefined && (typeof range.label !== "string" || !range.label.length || range.label.length > 128 || /[\x00-\x1f\x7f]/.test(range.label))) throw new Error("Invalid range label");
    return { base: range.base, head: range.head, mode, ...(range.label === undefined ? {} : { label: range.label }) };
  });
  const root = await repository(input.root);
  const ranges: DeliveryScope["ranges"] = [];
  const changed = new Map<string, Set<string>>();
  const add = (path: string, origin: string) => {
    validateRelativePath(path);
    if (!changed.has(path)) changed.set(path, new Set());
    changed.get(path)!.add(origin);
    if (changed.size > 512) throw new Error("Delivery scope exceeds 512 changed paths; select a narrower scope");
  };
  for (const [index, range] of requested.entries()) {
    const base = await resolveCommit(root, range.base), head = await resolveCommit(root, range.head);
    let comparisonBase = base;
    if (range.mode === "merge-base") {
      const bases = (await textGit(root, ["merge-base", "--all", base, head])).split("\n").filter(Boolean);
      if (bases.length !== 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(bases[0]!)) throw new Error("Range requires a unique merge base");
      comparisonBase = bases[0]!;
    }
    ranges.push({ ...range, base, head, comparisonBase });
    const discovered = names(await git(root, ["diff-tree", "--no-ext-diff", "--no-textconv", "--no-renames", "-r", "--name-only", "-z", comparisonBase, head, "--"]));
    for (const path of discovered) if (paths === undefined || paths.includes(path)) add(path, `range:${index + 1}`);
  }
  const localFacts: Array<{ path: string; before: ContentIdentity; after: ContentIdentity }> = [];
  let localHead: string | undefined;
  if (localPaths.length) {
    localHead = await resolveCommit(root, "HEAD");
    const format = await textGit(root, ["rev-parse", "--show-object-format"]);
    if (format !== "sha1" && format !== "sha256") throw new Error("Unsupported object format");
    for (const path of localPaths) {
      const before = await headIdentity(root, localHead, path, format), after = await currentIdentity(root, path, format);
      localFacts.push({ path, before, after });
      if (!same(before, after)) add(path, "local");
    }
    // Detect selected content/HEAD drift over collection; this is not an OS transaction.
    for (const fact of localFacts) if (!same(fact.after, await currentIdentity(root, fact.path, format))) throw new Error("Selected local content changed during inspection");
    if (await resolveCommit(root, "HEAD") !== localHead) throw new Error("HEAD changed during inspection");
  }
  const changes = [...changed].sort(([a], [b]) => compare(a, b)).map(([path, origins]) => ({ path, origins: [...origins].sort(compare) }));
  return { root, ranges, changes, localPaths, version: `sha256:${digest(JSON.stringify({ root, ranges, paths: paths ?? null, localPaths, localHead, localFacts, changes }))}` };
}
