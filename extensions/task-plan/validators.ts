import { canonicalSectionHash, canonicalTasksDefinitionHash } from "./plan-file.ts";
import { extractAllSections } from "./sections.ts";
import { parseTasks, taskRequiredFields } from "./tasks.ts";
import { HARNESS, STAGE_STATUS, type PlanDocument, type ValidationIssue, type ValidationResult } from "./types.ts";

function result(issues: ValidationIssue[]): ValidationResult { return { ok: issues.every((i) => i.severity !== "error"), issues }; }
function error(code: string, message: string): ValidationIssue { return { severity: "error", code, message }; }
function warn(code: string, message: string): ValidationIssue { return { severity: "warning", code, message }; }

export function validateFrontmatter(document: PlanDocument): ValidationResult {
  const m = document.metadata;
  const issues: ValidationIssue[] = [];
  if (m.harness !== HARNESS) issues.push(error("invalid_harness", `harness must be ${HARNESS}`));
  if (!/^P\d{3}$/.test(String(m.plan_id ?? ""))) issues.push(error("invalid_plan_id", "plan_id must use PNNN"));
  if (!Number.isInteger(m.round) || m.round < 0) issues.push(error("invalid_round", "round must be an integer >= 0"));
  if (!(m.stage in STAGE_STATUS)) issues.push(error("invalid_stage", "stage is not recognized"));
  else if (!STAGE_STATUS[m.stage].includes(m.stage_status)) issues.push(error("invalid_stage_status", `${m.stage}/${m.stage_status} is not allowed`));
  if ((m.stage === "completed" || m.stage === "abandoned") && !m.closure_reason) issues.push(warn("missing_closure_reason", "terminal plans should record closure_reason"));
  return result(issues);
}

export function validateSections(text: string): ValidationResult {
  try { extractAllSections(text); return result([]); } catch (e) { return result([error("invalid_sections", (e as Error).message)]); }
}

export function validateWhatWhy(markdown: string): ValidationResult {
  const required = ["Goal", "Desired Outcome", "Scope", "In", "Out", "Constraints", "Why", "Success", "Non-Goals", "Open Questions"];
  const issues = required.filter((h) => !new RegExp(`^#{3,4} ${escapeRegExp(h)}\\s*$`, "m").test(markdown)).map((h) => error("missing_what_why_field", `Missing What / Why heading: ${h}`));
  if (/\bT\d{3}\b/.test(markdown)) issues.push(error("what_why_contains_task_id", "What / Why must not contain Task IDs"));
  return result(issues);
}

export function validatePlan(markdown: string, round: number): ValidationResult {
  const issues: ValidationIssue[] = [];
  for (const h of ["Strategy", "T+0 — Current Horizon", "Key Decisions", "Risks / Unknowns", "Replan Conditions"]) {
    if (!new RegExp(`^### ${escapeRegExp(h)}\\s*$`, "m").test(markdown)) issues.push(error("missing_plan_field", `Missing Plan heading: ${h}`));
  }
  const horizons = [...markdown.matchAll(/^### T\+(\d+) — (.+)$/gm)].map((m) => ({ n: Number(m[1]), title: m[2] }));
  if (!horizons.some((h) => h.n === 0)) issues.push(error("missing_t0", "Plan must include T+0"));
  const seen = new Set<number>();
  for (const h of horizons) {
    if (seen.has(h.n)) issues.push(error("duplicate_horizon", `Duplicate T+${h.n}`));
    seen.add(h.n);
  }
  if (horizons.length) {
    const sorted = [...seen].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) if (sorted[i] !== i) issues.push(error("non_contiguous_horizon", "Horizons must be contiguous from T+0"));
  }
  if (!Number.isInteger(round) || round < 0) issues.push(error("invalid_round", "round must start at 0 and stay non-negative"));
  if (/^### T\d{3} — /m.test(markdown) || /^#### (Acceptance|Depends On)\s*$/m.test(markdown)) issues.push(error("plan_contains_task_structure", "Plan must not contain executable Task structure"));
  const t0 = sectionForHorizon(markdown, 0);
  for (const h of ["Outcome", "Work Areas", "Ordering", "Exit Condition"]) if (t0 && !new RegExp(`^#### ${escapeRegExp(h)}\\s*$`, "m").test(t0)) issues.push(error("missing_t0_field", `T+0 missing ${h}`));
  const t1 = sectionForHorizon(markdown, 1);
  for (const h of ["Expected Outcome", "Dependencies on T+0", "Candidate Work", "Promotion Condition"]) if (t1 && !new RegExp(`^#### ${escapeRegExp(h)}\\s*$`, "m").test(t1)) issues.push(error("missing_t1_field", `T+1 missing ${h}`));
  for (const h of horizons.filter((h) => h.n >= 2)) {
    const section = sectionForHorizon(markdown, h.n) ?? "";
    for (const field of ["Goal", "Conditional Direction", "Dependencies / Assumptions", "Replan Triggers"]) if (!new RegExp(`^#### ${escapeRegExp(field)}\\s*$`, "m").test(section)) issues.push(error("missing_later_horizon_field", `T+${h.n} missing ${field}`));
  }
  return result(issues);
}

export function validateTasks(markdown: string, currentRound: number, options: { requireCurrentOpen?: boolean; historicalCompleted?: boolean } = {}): ValidationResult {
  const issues: ValidationIssue[] = [];
  const tasks = parseTasks(markdown);
  if (tasks.length === 0) issues.push(error("missing_tasks", "Tasks section must contain at least one Task"));
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) issues.push(error("duplicate_task_id", `Duplicate ${task.id}`));
    ids.add(task.id);
    for (const field of taskRequiredFields()) if (!new RegExp(`^#### ${escapeRegExp(field)}\\s*$`, "m").test(task.definition)) issues.push(error("missing_task_field", `${task.id} missing ${field}`));
    if (task.round < 0) issues.push(error("invalid_task_round", `${task.id} has invalid Round`));
    const completionBoxes = task.definition.match(/- \[(?: |x|X)\] Task completed/g) ?? [];
    if (completionBoxes.length !== 1) issues.push(error("invalid_completion", `${task.id} must have exactly one Task completed checkbox`));
    if (task.acceptanceItems.length < 1) issues.push(error("missing_acceptance_checkbox", `${task.id} Acceptance needs at least one checkbox`));
    if (task.dependsOn.includes(task.id)) issues.push(error("self_dependency", `${task.id} depends on itself`));
    if (options.requireCurrentOpen && task.round === currentRound && task.completed) issues.push(error("current_round_precompleted", `${task.id} must be open before execution`));
    if (options.historicalCompleted && task.round < currentRound && !task.completed) issues.push(error("historical_task_open", `${task.id} belongs to history and must remain complete`));
  }
  for (const task of tasks) for (const dep of task.dependsOn) if (!ids.has(dep)) issues.push(error("unknown_dependency", `${task.id} depends on missing ${dep}`));
  issues.push(...dependencyCycleIssues(tasks));
  const numeric = tasks.map((t) => Number(t.id.slice(1))).sort((a, b) => a - b);
  for (let i = 1; i < numeric.length; i++) if (numeric[i] === numeric[i - 1] || numeric[i]! <= numeric[i - 1]!) issues.push(error("invalid_task_order", "Task IDs must be globally increasing"));
  return result(issues);
}

export function validateApprovalHashes(document: PlanDocument): ValidationResult {
  const issues: ValidationIssue[] = [];
  const { metadata: m, sections } = document;
  if (m.approved_what_why_hash && m.approved_what_why_hash !== canonicalSectionHash(sections.what_why)) issues.push(error("what_why_hash_mismatch", "What / Why changed after approval"));
  if (m.approved_plan_hash && m.approved_plan_hash !== canonicalSectionHash(sections.plan)) issues.push(error("plan_hash_mismatch", "Plan changed after approval"));
  if (m.reviewed_tasks_hash && m.reviewed_tasks_hash !== canonicalTasksDefinitionHash(sections.tasks)) issues.push(error("tasks_hash_mismatch", "Task definitions changed after review"));
  return result(issues);
}

export function validateProgress(document: PlanDocument): ValidationResult {
  const issues: ValidationIssue[] = [];
  const tasks = parseTasks(document.sections.tasks).filter((t) => t.round === document.metadata.round);
  if (document.metadata.stage === "executing") {
    if (tasks.length === 0) issues.push(error("no_current_round_tasks", "executing requires current round Tasks"));
    if (tasks.every((t) => t.completed)) issues.push(error("executing_all_done", "executing cannot have all current round Tasks complete"));
  }
  if (document.metadata.stage === "awaiting_round_decision") {
    if (tasks.length === 0) issues.push(error("no_current_round_tasks", "awaiting_round_decision requires current round Tasks"));
    if (tasks.some((t) => !t.completed)) issues.push(error("awaiting_decision_open_tasks", "awaiting_round_decision requires all current round Tasks complete"));
  }
  return result(issues);
}

function dependencyCycleIssues(tasks: ReturnType<typeof parseTasks>): ValidationIssue[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const issues: ValidationIssue[] = [];
  function visit(id: string, path: string[]) {
    if (visiting.has(id)) { issues.push(error("dependency_cycle", `Dependency cycle: ${[...path, id].join(" -> ")}`)); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep)) visit(dep, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of tasks) visit(task.id, []);
  return issues;
}

function sectionForHorizon(markdown: string, n: number): string | undefined {
  const re = new RegExp(`^### T\\+${n} — .*$`, "m");
  const match = markdown.match(re);
  if (!match || match.index === undefined) return undefined;
  const rest = markdown.slice(match.index);
  const next = rest.slice(1).search(/^### T\+\d+ — /m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
