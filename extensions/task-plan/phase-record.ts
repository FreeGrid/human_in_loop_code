import type { PhaseRecord } from "./phase-contracts.ts";

const PREFIX = "<!-- pi-plan:phase:";
const HEADER = /^### (T\d{3}) — .+ \[(?: |x|X)\]$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => [...required, ...optional].includes(k));
const text = (v: unknown, max = 2000): v is string => typeof v === "string" && !!v.trim() && v.length <= max;
const refs = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 128 && v.every(x => text(x, 500)) && new Set(v).size === v.length;
function decision(v: unknown, actions: string[]): boolean {
  return object(v) && keys(v, ["action", "source", "input_id", "text"]) && typeof v.action === "string" && actions.includes(v.action) && typeof v.source === "string" && ["interactive", "rpc", "slash"].includes(v.source) && text(v.input_id, 300) && text(v.text);
}
function serialize(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function validatePhaseRecord(v: unknown): v is PhaseRecord {
  if (!object(v) || !keys(v, ["version", "context", "definition_hash", "baseline", "authorization", "docsync", "acceptance"], ["last_finalize", "finalized"]) || v.version !== 1) return false;
  const c = v.context;
  if (!object(c) || !keys(c, ["execute_id", "phase_id", "round", "plan_path", "target_root", "governance_root"]) || !text(c.execute_id, 128) || typeof c.phase_id !== "string" || !/^T\d{3}$/.test(c.phase_id) || !Number.isSafeInteger(c.round) || Number(c.round) < 0 || ![c.plan_path, c.target_root, c.governance_root].every(x => text(x, 4096) && !/[\x00-\x1f]/.test(x))) return false;
  if (typeof v.definition_hash !== "string" || !/^[a-f0-9]{64}$/.test(v.definition_hash)) return false;
  if (!object(v.baseline) || !keys(v.baseline, ["id", "initial_version"]) || !text(v.baseline.id, 500) || !text(v.baseline.initial_version, 500)) return false;
  if (!decision(v.authorization, ["execute"])) return false;
  const d = v.docsync;
  if (!object(d) || !keys(d, ["enabled"], ["decision"]) || typeof d.enabled !== "boolean" || (d.decision !== undefined && !decision(d.decision, [d.enabled ? "docsync_on" : "docsync_off"])) || (!d.enabled && !d.decision)) return false;
  if (!Array.isArray(v.acceptance) || v.acceptance.length > 128 || !v.acceptance.every(a => object(a) && keys(a, ["id", "satisfied", "summary"]) && typeof a.id === "string" && new RegExp(`^${c.phase_id}\\.A\\d{3}$`).test(a.id) && typeof a.satisfied === "boolean" && text(a.summary)) || new Set(v.acceptance.map(a => a.id)).size !== v.acceptance.length) return false;
  if (v.last_finalize !== undefined && (!object(v.last_finalize) || !keys(v.last_finalize, ["summary", "outcome"]) || v.last_finalize.outcome !== "blocked" || !text(v.last_finalize.summary))) return false;
  const f = v.finalized;
  if (f !== undefined && (!object(f) || !keys(f, ["check", "summary", "content_version", "debt_refs", "human_exceptions"]) || typeof f.check !== "string" || !["passed", "with_debt", "with_exceptions", "skipped"].includes(f.check) || !text(f.summary) || !text(f.content_version, 500) || !refs(f.debt_refs) || !refs(f.human_exceptions) || (f.check === "skipped") !== !d.enabled || (f.check === "passed" && (f.debt_refs.length > 0 || f.human_exceptions.length > 0)) || (f.check === "with_debt" && !f.debt_refs.length) || (f.check === "with_exceptions" && !f.human_exceptions.length))) return false;
  return serialize(v).length <= 300000;
}

/** Only bounded canonical data at the very end of a phase's Depends On field is excluded. */
export function inspectPhaseRecords(markdown: string): { definition: string; records: Record<string, PhaseRecord>; errors: string[] } {
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(eol);
  const kept: string[] = [], errors: string[] = [];
  const records: Record<string, PhaseRecord> = {};
  let phase = "", field = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const header = line.match(HEADER);
    if (header) { phase = header[1]!; field = ""; }
    else if (/^#{1,4} /.test(line)) { field = line === "#### Depends On" ? "depends" : ""; if (!line.startsWith("#### ")) phase = ""; }
    if (line.includes(PREFIX)) {
      let value: unknown;
      try { value = JSON.parse(lines[i + 1] ?? ""); } catch { /* retain invalid data in definition */ }
      let next = i + 3;
      while (next < lines.length && /^[ \t]*$/.test(lines[next]!)) next++;
      const boundary = next === lines.length || HEADER.test(lines[next]!) || /^<!-- pi-plan:tasks:end -->$/.test(lines[next]!) || /^#{1,2} /.test(lines[next]!);
      const dependencyStart = lines.slice(0, i).lastIndexOf("#### Depends On");
      const hasDependencies = dependencyStart >= 0 && lines.slice(dependencyStart + 1, i).some(l => !!l.trim() && !l.includes(PREFIX));
      const valid = phase && field === "depends" && hasDependencies && !records[phase] && line === `${PREFIX}${phase}:start -->` && lines[i + 2] === `${PREFIX}${phase}:end -->` && boundary && validatePhaseRecord(value) && value.context.phase_id === phase && lines[i + 1] === serialize(value);
      if (valid) { records[phase] = value as PhaseRecord; i += 2; continue; }
      errors.push(`Invalid or misplaced phase record at line ${i + 1}`);
    }
    kept.push(line);
  }
  return { definition: kept.join(eol), records, errors };
}

export function upsertPhaseRecord(markdown: string, phaseId: string, record: PhaseRecord): string {
  if (!validatePhaseRecord(record) || record.context.phase_id !== phaseId) throw new Error("Invalid phase record");
  const inspected = inspectPhaseRecords(markdown);
  if (inspected.errors.length) throw new Error(inspected.errors.join("; "));
  const records = { ...inspected.records, [phaseId]: record };
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = inspected.definition.split(eol);
  const inserts = new Map<number, string[]>();
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i]!.match(HEADER);
    if (!h || !records[h[1]!]) continue;
    let end = i + 1;
    while (end < lines.length && !/^#{1,3} /.test(lines[end]!) && lines[end] !== "<!-- pi-plan:tasks:end -->") end++;
    let last = end - 1;
    while (last > i && /^[ \t]*$/.test(lines[last]!)) last--;
    const fields = lines.slice(i + 1, last + 1).filter(l => /^#### /.test(l));
    if (fields.at(-1) !== "#### Depends On" || lines[last] === "#### Depends On") throw new Error("Phase record requires a final Depends On field");
    const id = h[1]!;
    inserts.set(last, [`${PREFIX}${id}:start -->`, serialize(records[id]), `${PREFIX}${id}:end -->`]);
    if (id === phaseId) { if (found) throw new Error("Duplicate phase"); found = true; }
  }
  if (!found) throw new Error(`Unknown phase: ${phaseId}`);
  return lines.flatMap((line, i) => [line, ...(inserts.get(i) ?? [])]).join(eol);
}
