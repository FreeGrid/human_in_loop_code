import { createHash } from "node:crypto";
import { isAlias, isCollection, isMap, isScalar, parseAllDocuments, visit } from "yaml";
import type { ConfigurationState, DocSyncConfig, DocumentTarget } from "./contracts.ts";
import { readContainedBytes, targetKey, validateRelativePath, validateSectionId } from "./targets.ts";

const unsafeNames = new Set(["__proto__", "prototype", "constructor"]);
function text(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Expected bounded non-empty string");
  return value;
}
function object(value: unknown, allowed?: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected mapping");
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) if (unsafeNames.has(key) || (allowed && !allowed.includes(key))) throw new Error(`Unknown or unsafe key: ${key}`);
  return result;
}
function pattern(value: unknown): string {
  const p = text(value);
  validateRelativePath(p);
  if (/[!{}\[\]()|]/.test(p) || p.split("/").some(s => s.includes("**") && s !== "**")) throw new Error(`Unsupported matching pattern: ${p}`);
  return p;
}
/** Literal segments, segment-local * and ?, and whole-segment ** (zero or more segments).
 * No dotfile exclusion. Matching is case-sensitive on every platform. */
export function matchesPath(value: string, path: string): boolean {
  const segments = pattern(value).split("/");
  validateRelativePath(path);
  const parts = path.split("/");
  let previous = Array<boolean>(parts.length + 1).fill(false); previous[0] = true;
  for (const segment of segments) {
    const next = Array<boolean>(parts.length + 1).fill(false);
    if (segment === "**") {
      next[0] = previous[0];
      for (let j = 1; j <= parts.length; j++) next[j] = previous[j] || next[j - 1];
    } else {
      for (let j = 1; j <= parts.length; j++) next[j] = previous[j - 1] && matchesSegment(segment, parts[j - 1]);
    }
    previous = next;
  }
  return previous[parts.length];
}
// Greedy wildcard matching avoids regex backtracking on untrusted patterns.
function matchesSegment(pattern: string, value: string): boolean {
  const p = [...pattern], v = [...value];
  let i = 0, j = 0, star = -1, retry = 0;
  while (j < v.length) {
    if (p[i] === "?" || p[i] === v[j]) { i++; j++; }
    else if (p[i] === "*") { star = i++; retry = j; }
    else if (star !== -1) { i = star + 1; j = ++retry; }
    else return false;
  }
  while (p[i] === "*") i++;
  return i === p.length;
}
function target(value: unknown): DocumentTarget {
  if (typeof value === "string") { validateRelativePath(text(value)); return value; }
  const obj = object(value, ["path", "section_id"]);
  const path = text(obj.path), section_id = text(obj.section_id);
  validateRelativePath(path); validateSectionId(section_id);
  return { path, section_id };
}
function normalize(value: unknown): DocSyncConfig {
  const obj = object(value, ["version", "concepts", "hard_rules", "readme", "classification"]);
  if (obj.version !== 1) throw new Error("Unsupported configuration version");
  let count = 0;
  const list = <T>(v: unknown, convert: (x: unknown) => T): T[] => {
    if (!Array.isArray(v)) throw new Error("Expected array");
    if (convert === pattern) count += v.length;
    if (count > 1024) throw new Error("Configuration exceeds 1024 matching pattern entries");
    return v.map(convert);
  };
  const concept = (v: unknown) => {
    const c = object(v, ["sources", "docs"]);
    const sources = list(c.sources, pattern), docs = list(c.docs, target);
    if (!sources.length || !docs.length) throw new Error("Concept requires non-empty sources and docs");
    return { sources, docs };
  };
  const concepts: DocSyncConfig["concepts"] = Object.create(null);
  for (const [name, value] of Object.entries(object(obj.concepts))) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) throw new Error("Invalid concept name");
    concepts[name] = concept(value);
  }
  if (!Array.isArray(obj.hard_rules)) throw new Error("Expected hard_rules array");
  const ids = new Set<string>();
  const hard_rules = obj.hard_rules.map(v => {
    const rule = object(v, ["id", "sources", "docs", "user_visible"]);
    const id = text(rule.id);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id) || unsafeNames.has(id) || ids.has(id)) throw new Error("Invalid or duplicate hard rule ID");
    ids.add(id);
    if (rule.user_visible !== undefined && typeof rule.user_visible !== "boolean") throw new Error("user_visible must be boolean");
    const sources = list(rule.sources, pattern), docs = list(rule.docs, target);
    if (!sources.length || !docs.length) throw new Error("Hard rule requires non-empty sources and docs");
    return { id, sources, docs, user_visible: rule.user_visible as boolean | undefined ?? false };
  });
  // Conservative defaults: classify nothing as tests/docs; unmatched files remain unknown,
  // so candidate construction asks about their documentation impact instead of exempting them.
  const classification = { code: [] as string[], tests: [] as string[], docs: [] as string[] };
  if (obj.classification !== undefined) {
    const c = object(obj.classification, ["code", "tests", "docs"]);
    for (const key of ["code", "tests", "docs"] as const) if (c[key] !== undefined) classification[key] = list(c[key], pattern);
  }
  const readme = target(obj.readme === undefined ? "README.md" : obj.readme);
  return { version: 1, concepts, hard_rules, readme, classification };
}
/** Absent/invalid policy is a versioned fact. Only actual IO/security/integrity failures throw. */
export async function readConfiguration(governanceRoot: string): Promise<ConfigurationState> {
  const bytes = await readContainedBytes(governanceRoot, ".harness/docsync.yml");
  if (bytes === null) return { version: "missing", errors: ["Missing .harness/docsync.yml"] };
  const version = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  try {
    if (bytes.length > 256 * 1024) throw new Error("Configuration exceeds 256 KiB");
    const input = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const documents = parseAllDocuments(input, { strict: true, uniqueKeys: true, version: "1.2", schema: "core", merge: false });
    if (documents.length !== 1) throw new Error("Expected exactly one YAML document");
    const document = documents[0];
    if (document.errors.length || document.warnings.length) throw new Error([...document.errors, ...document.warnings].map(e => e.message).join("; "));
    visit(document, (_key, node, path) => {
      if (isAlias(node) || (node && typeof node === "object" && "tag" in node && node.tag)) throw new Error("YAML aliases and explicit tags are unsupported");
      if (node && typeof node === "object" && "anchor" in node && node.anchor) throw new Error("YAML anchors are unsupported");
      if (isCollection(node) && path.filter(isCollection).length + 1 > 16) throw new Error("YAML container depth exceeds 16");
      if (isMap(node)) for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.value === "<<" || unsafeNames.has(pair.key.value)) throw new Error("Unsafe YAML mapping key");
      }
    });
    return { version, config: normalize(document.toJS({ maxAliasCount: 0 })), errors: [] };
  } catch (error) { return { version, errors: [(error as Error).message] }; }
}
export function configurationTargets(config: DocSyncConfig): DocumentTarget[] {
  const targets = new Map<string, DocumentTarget>();
  for (const t of [...Object.values(config.concepts).flatMap(c => c.docs), ...config.hard_rules.flatMap(r => r.docs), config.readme]) targets.set(targetKey(t), t);
  return [...targets.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, t]) => t);
}
