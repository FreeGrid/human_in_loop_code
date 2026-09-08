import { createHash } from "node:crypto";
import { validateExecutionNote, type ExecutionNote } from "../execution-notes.ts";
import type { CandidateResult, CandidateTrigger, DocumentationCandidate, DocumentTarget, RepositoryFacts } from "./contracts.ts";
import { configurationTargets, matchesPath } from "./configuration.ts";
import { targetKey } from "./targets.ts";

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort(compare).map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const blocked = (...errors: string[]): CandidateResult => ({ status: "blocked", errors: [...new Set(errors)].sort(compare) });

/** Pure construction of obligations, never a DocSyncGate or a disposition/acceptance authority. */
export function buildCandidates(facts: RepositoryFacts, notes: Record<string, ExecutionNote> = {}): CandidateResult {
  if (facts.configuration.errors.length || !facts.configuration.config) return blocked(...facts.configuration.errors, ...(!facts.configuration.config && !facts.configuration.errors.length ? ["configuration_unavailable"] : []));
  if (!notes || typeof notes !== "object" || Array.isArray(notes) || Object.keys(notes).length > 128 || Object.entries(notes).some(([id, note]) => !/^T\d{3}\.W\d{3}$/.test(id) || !id.startsWith(`${facts.context.phase_id}.W`) || id.endsWith("W000") || !validateExecutionNote(note))) return blocked("invalid_execution_notes");
  const config = facts.configuration.config;
  for (const target of configurationTargets(config)) {
    const evidence = facts.documents[targetKey(target)];
    if (!evidence || evidence.error || targetKey(evidence.target) !== targetKey(target)) return blocked(evidence?.error ?? `document_start_unavailable: ${targetKey(target)}`);
  }
  const notesVersion = digest(notes);
  const sourceVersion = digest([...facts.changes].sort((a, b) => compare(a.path, b.path)));
  const candidates = new Map<string, DocumentationCandidate>();
  const uncovered = new Map<string, string>();
  const errors: string[] = [];
  const scope = { target_root: facts.context.target_root, governance_root: facts.context.governance_root };
  const add = (target: DocumentTarget, kind: DocumentationCandidate["kind"], trigger: CandidateTrigger, hard = false) => {
    const key = targetKey(target);
    const identity = `${kind}:${key}`;
    const evidence = facts.documents[key];
    if (!evidence || evidence.error || targetKey(evidence.target) !== key) {
      errors.push(evidence?.error ?? `document_start_unavailable: ${key}`);
      return;
    }
    let candidate = candidates.get(identity);
    if (!candidate) {
      candidate = { id: `candidate:${digest({ scope, kind, target })}`, evidence_id: "", kind, target, urgency: hard ? "hard" : "normal", resolution: "pending", triggers: [], evidence };
      if (kind === "readme_narrative") candidate.question = "Does this change affect the README's explanation of value, capability relationships or usage? Supply a narrative disposition and rationale; touching the file alone is not proof.";
      candidates.set(identity, candidate);
    }
    if (hard) candidate.urgency = "hard";
    if (!candidate.triggers.some(item => item.kind === trigger.kind && item.source === trigger.source)) candidate.triggers.push(trigger);
  };
  // A narrative obligation stays distinct from a file obligation but inherits an explicitly
  // targeted README hard rule; unrelated user-visible rules merely propose normal narrative work.
  const readmeKey = targetKey(config.readme);
  let readmeHard = false;
  const changes = [...facts.changes].sort((a, b) => compare(a.path, b.path));
  for (const change of changes) {
    let covered = false;
    for (const [name, concept] of Object.entries(config.concepts).sort(([a], [b]) => compare(a, b))) {
      if (!concept.sources.some(pattern => matchesPath(pattern, change.path))) continue;
      covered = true;
      for (const target of concept.docs) add(target, "document", { kind: "concept", source: `${name}:${change.path}` });
    }
    for (const rule of config.hard_rules) {
      if (!rule.sources.some(pattern => matchesPath(pattern, change.path))) continue;
      covered = true;
      for (const target of rule.docs) {
        add(target, "document", { kind: "hard_rule", source: `${rule.id}:${change.path}` }, true);
        if (targetKey(target) === readmeKey) readmeHard = true;
      }
      if (rule.user_visible) add(config.readme, "readme_narrative", { kind: "hard_rule", source: `${rule.id}:${change.path}` });
    }
    const classes = (Object.entries(config.classification) as Array<[string, string[]]>).filter(([, patterns]) => patterns.some(pattern => matchesPath(pattern, change.path))).map(([name]) => name);
    const classification = classes.length === 1 ? classes[0] : "unknown";
    if (classification === "code" || classification === "unknown") {
      if (!covered || classification === "unknown") uncovered.set(change.path, classification === "unknown" ? "Classification is absent or ambiguous; ask about documentation impact and necessary associations." : "No dependency covers this code change; request an explicit documentation association.");
      add(config.readme, "readme_narrative", { kind: classification === "unknown" ? "unknown_classification" : "code_fallback", source: change.path });
    }
  }
  for (const [id, note] of Object.entries(notes).sort(([a], [b]) => compare(a, b))) {
    for (const type of note.change_types) if (["api", "cli", "config", "extension"].includes(type)) add(config.readme, "readme_narrative", { kind: "change_type", source: `${id}:${type}` });
  }
  for (const candidate of candidates.values()) {
    if (candidate.kind === "readme_narrative" && readmeHard) candidate.urgency = "hard";
    candidate.triggers.sort((a, b) => compare(canonical(a), canonical(b)));
    candidate.evidence_id = `evidence:${digest({ execute_id: facts.context.execute_id, baseline: facts.baseline, content_version: facts.content_version, configuration_version: facts.configuration.version, notes_version: notesVersion, source_version: sourceVersion, id: candidate.id, urgency: candidate.urgency, triggers: candidate.triggers, evidence: candidate.evidence })}`;
  }
  if (errors.length) return blocked(...errors);
  // Even an untriggered malformed configured target must not be silently ignored as policy-ready.
  const targetErrors = Object.values(facts.documents).flatMap(evidence => evidence.error ? [evidence.error] : []);
  if (targetErrors.length) return blocked(...targetErrors);
  return structuredClone({ status: "ready", execute_id: facts.context.execute_id, content_version: facts.content_version, configuration_version: facts.configuration.version, notes_version: notesVersion, candidates: [...candidates.values()].sort((a, b) => compare(a.id, b.id)), uncovered: [...uncovered].sort(([a], [b]) => compare(a, b)).map(([path, reason]) => ({ path, reason })) });
}
