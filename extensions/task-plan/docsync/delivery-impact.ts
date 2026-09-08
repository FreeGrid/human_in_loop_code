import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { matchesPath, readConfiguration } from "./configuration.ts";
import { inspectDeliveryScope, type DeliveryScope, type DeliveryScopeInput } from "./delivery-scope.ts";
import { digest, git, names, textGit } from "./git.ts";
import { resolveContainedPath, targetPath } from "./targets.ts";

export interface DeliveryImpactInput extends DeliveryScopeInput {
  mappings?: Array<{ sources: string[]; docs: string[] }>;
  terms?: string[];
  codePaths?: string[];
  docPaths?: string[];
  governanceRoot?: string;
}
export interface DeliveryImpact {
  scope: DeliveryScope;
  version: string;
  context: "current-worktree";
  contextHead: string;
  candidates: Array<{ path: string; reasons: string[] }>;
  references: Array<{ path: string; line: number; term: string; snippet: string }>;
  unresolved: string[];
}
const FILE_LIMIT = 256 * 1024, TOTAL_LIMIT = 2 * 1024 * 1024;
const stamp = (s: import("node:fs").BigIntStats) => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(":");
function patterns(value: string[], label: string): string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${label} supports at most 64 patterns`);
  for (const p of value) matchesPath(p, "validation");
  return [...value];
}
async function read(root: string, path: string, budget: number): Promise<{ identity: string; bytes: Buffer | null; issue?: string }> {
  const full = await resolveContainedPath(root, path, { allowMissing: true });
  let before;
  try { before = await lstat(full, { bigint: true }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { identity: "missing", bytes: null, issue: `Missing target: ${path}` };
    throw e;
  }
  const identity = stamp(before);
  if (!before.isFile()) throw new Error(`Not a regular file: ${path}`);
  if (before.size > BigInt(FILE_LIMIT) || before.size > BigInt(budget)) return { identity, bytes: null, issue: `Inspection byte limit exceeded: ${path}` };
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (identity !== stamp(await handle.stat({ bigint: true }))) throw new Error(`File changed during inspection: ${path}`);
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const r = await handle.read(bytes, count, bytes.length - count, count);
      if (!r.bytesRead) break;
      count += r.bytesRead;
    }
    if (count !== Number(before.size) || identity !== stamp(await handle.stat({ bigint: true })) || identity !== stamp(await lstat(full, { bigint: true })) || full !== await resolveContainedPath(root, path)) throw new Error(`File changed during inspection: ${path}`);
    return { identity: `${identity}:${digest(bytes.subarray(0, count))}`, bytes: bytes.subarray(0, count) };
  } finally { await handle.close(); }
}

/** Bounded navigation evidence only: a touched document or empty search never certifies synchronization. */
export async function inspectDocumentationImpact(input: DeliveryImpactInput): Promise<DeliveryImpact> {
  input = structuredClone(input);
  const codePaths = patterns(input.codePaths ?? [], "codePaths"), docPaths = patterns(input.docPaths ?? ["README.md", "docs/**"], "docPaths");
  if (!Array.isArray(input.mappings ?? []) || (input.mappings?.length ?? 0) > 64) throw new Error("At most 64 mappings are supported");
  const mappings = (input.mappings ?? []).map(m => {
    const sources = patterns(m.sources, "sources"), docs = patterns(m.docs, "docs");
    if (!sources.length || !docs.length) throw new Error("Mappings require non-empty sources and docs");
    return { sources, docs };
  });
  const terms = [...(input.terms ?? [])];
  if (!Array.isArray(input.terms ?? []) || terms.length > 16 || terms.some(t => typeof t !== "string" || !t.length || t.length > 128 || /[\x00-\x1f\x7f]/.test(t))) throw new Error("Use at most 16 non-empty literal terms of at most 128 characters");
  const governanceRoot = input.governanceRoot;
  const scope = await inspectDeliveryScope(input), root = scope.root;
  const contextHead = await textGit(root, ["rev-parse", "--verify", "HEAD"]);
  const unresolved: string[] = [];
  if (scope.ranges.length && scope.ranges.at(-1)!.head !== contextHead) unresolved.push("Search context is the current worktree; HEAD differs from the final selected range head");
  const policy = governanceRoot === undefined ? undefined : await readConfiguration(governanceRoot);
  if (policy) unresolved.push(...policy.errors.map(e => `Policy unresolved: ${e}`));
  const enumerate = async () => [...new Set(names(await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])))].sort();
  const enumeration = await enumerate();
  const candidates = new Map<string, Set<string>>(), targets = new Set<string>();
  const add = (path: string, reason: string) => {
    if (!candidates.has(path)) {
      if (candidates.size >= 128) { unresolved.push("Candidate limit exceeded: narrow mappings/search; omitted targets remain unchecked"); return; }
      candidates.set(path, new Set());
    }
    if (candidates.get(path)!.size < 8) candidates.get(path)!.add(reason);
    else unresolved.push("Candidate reason limit exceeded: additional triggering changes require review");
    targets.add(path);
  };
  const match = (ps: string[], path: string) => ps.some(p => matchesPath(p, path));
  const rules = policy?.config ? [...Object.entries(policy.config.concepts).map(([name, r]) => ({ ...r, name: `concept:${name}` })), ...policy.config.hard_rules.map(r => ({ ...r, name: `rule:${r.id}` }))] : [];
  for (const change of scope.changes) {
    let mapped = false;
    for (const [index, mapping] of mappings.entries()) if (match(mapping.sources, change.path)) {
      mapped = true;
      for (const pattern of mapping.docs) {
        const paths = /[*?]/.test(pattern) ? enumeration.filter(p => matchesPath(pattern, p)) : [pattern];
        if (!paths.length) unresolved.push(`Mapping ${index + 1} has no document match: ${pattern}`);
        for (const path of paths) add(path, `mapping:${index + 1} from ${change.path}`);
      }
    }
    for (const rule of rules) if (match(rule.sources, change.path)) {
      mapped = true;
      for (const target of rule.docs) add(targetPath(target), `${rule.name} from ${change.path}${typeof target === "string" ? "" : ` section:${target.section_id}`}`);
    }
    if (match(docPaths, change.path) || match(policy?.config?.classification.docs ?? [], change.path)) add(change.path, "document touched; semantic review still required");
    else if (!mapped) unresolved.push(`Unmapped changed path requires documentation impact review: ${change.path}`);
  }
  const isDoc = (path: string) => match(docPaths, path) || targets.has(path) || match(policy?.config?.classification.docs ?? [], path);
  const searchDomains = [...codePaths, ...docPaths, ...policy?.config?.classification.docs ?? []];
  const selected = [...new Set([...targets, ...enumeration.filter(p => match(searchDomains, p)), ...scope.localPaths.filter(p => match(searchDomains, p))])].sort();
  if (selected.length > 128) unresolved.push(`Inspection file limit exceeded: ${selected.length} selected; only 128 inspected`);
  const facts: Array<{ path: string; identity: string; budget: number }> = [];
  const references: DeliveryImpact["references"] = [];
  let remaining = TOTAL_LIMIT, truncated = false;
  for (const path of selected.slice(0, 128)) {
    const budget = remaining, result = await read(root, path, budget);
    facts.push({ path, identity: result.identity, budget });
    if (result.issue) unresolved.push(result.issue);
    if (!result.bytes) continue;
    remaining -= result.bytes.length;
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes); } catch { unresolved.push(`Non-UTF8 file not searched: ${path}`); continue; }
    if (content.includes("\0")) { unresolved.push(`Binary file not searched: ${path}`); continue; }
    for (const [i, line] of content.split("\n").entries()) for (const term of terms) {
      const offset = line.indexOf(term);
      if (offset < 0) continue;
      if (isDoc(path)) add(path, `literal reference: ${term}`);
      if (references.length >= 64) { truncated = true; continue; }
      const start = Math.max(0, offset - 60);
      references.push({ path, line: i + 1, term, snippet: line.slice(start, start + 240) });
    }
  }
  if (truncated) unresolved.push("Reference match limit exceeded: only 64 references returned");
  for (const fact of facts) if ((await read(root, fact.path, fact.budget)).identity !== fact.identity) throw new Error(`Selected content changed during inspection: ${fact.path}`);
  if (JSON.stringify(await enumerate()) !== JSON.stringify(enumeration)) throw new Error("File enumeration changed during inspection");
  if (contextHead !== await textGit(root, ["rev-parse", "--verify", "HEAD"])) throw new Error("HEAD changed during inspection");
  if (governanceRoot !== undefined && (await readConfiguration(governanceRoot)).version !== policy!.version) throw new Error("Policy changed during inspection");
  if ((await inspectDeliveryScope(input)).version !== scope.version) throw new Error("Delivery scope changed during inspection");
  const issues = [...new Set(unresolved)];
  const report = { scope, context: "current-worktree" as const, contextHead, candidates: [...candidates].sort(([a], [b]) => a.localeCompare(b)).map(([path, reasons]) => ({ path, reasons: [...reasons].sort() })), references, unresolved: issues.length > 64 ? [...issues.slice(0, 63), `${issues.length - 63} additional unresolved questions omitted; narrow the scope`] : issues };
  const domains = [...searchDomains, ...mappings.flatMap(m => m.docs)];
  const relevantEnumeration = enumeration.filter(p => match(domains, p) || targets.has(p));
  return { ...report, version: `sha256:${digest(JSON.stringify({ report, mappings, terms, codePaths, docPaths, governanceRoot, policy, enumeration: relevantEnumeration, selected, facts }))}` };
}
