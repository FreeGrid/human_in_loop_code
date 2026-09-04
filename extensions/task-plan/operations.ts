import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { canonicalSectionHash, canonicalTasksDefinitionHash, createPlanSkeleton, findUnfinishedHarnessPlans, readPlanDocument, replaceFrontmatter, sha256, writeIfDocumentHash } from "./plan-file.ts";
import { replaceSection } from "./sections.ts";
import { currentRoundTasks, parseTasks } from "./tasks.ts";
import { approvePlan, approveWhatWhy, authorizeExecution, closePlan, markTasksReviewed, reconcileState, rollForward, abandonPlan } from "./state.ts";
import type { PlanDocument, PlanMetadata, PlanStage, SectionName, TaskBlock, ValidationIssue } from "./types.ts";
import { validateFrontmatter, validatePlan, validateProgress, validateSections, validateTasks, validateWhatWhy } from "./validators.ts";
import type { PlanOperationResult } from "./operation-result.ts";

export interface TaskBinding {
  task_id: string;
  plan_path: string;
  round: number;
  task_definition_hash: string;
  contract: TaskBlock;
}

export interface TaskPlanSessionState {
  currentPlanPath?: string;
  binding?: TaskBinding;
  reportedThisTurn?: boolean;
}

export class TaskPlanService {
  constructor(private readonly cwd: string, private readonly sessionState: TaskPlanSessionState = {}) {}

  async start(goal: string): Promise<PlanOperationResult> {
    if (!goal.trim()) return validation("Plan goal is required", []);
    try {
      const doc = await createPlanSkeleton(this.cwd, goal.trim());
      this.sessionState.currentPlanPath = doc.path;
      return { ...ok("created", "Created Harness Plan skeleton", doc), snapshot: snapshot(doc, this.sessionState.binding) };
    } catch (error) {
      return conflict(String((error as Error).message ?? error));
    }
  }

  async get(planPath?: string): Promise<PlanOperationResult> {
    const loaded = await this.load(planPath);
    if ("status" in loaded) return loaded;
    const reconciled = reconcileState(loaded);
    if (reconciled.changed) {
      const write = await writeIfDocumentHash(loaded.path, loaded.document_hash, reconciled.text);
      if (!write.ok) return conflict(write.conflict);
      const next = await readPlanDocument(loaded.path);
      return { ...ok("state_changed", `Reconciled state: ${reconciled.reason}`, next), snapshot: snapshot(next, this.sessionState.binding) };
    }
    return { ...ok("ok", "Read Harness Plan", loaded), snapshot: snapshot(loaded, this.sessionState.binding) };
  }

  async status(planPath?: string): Promise<PlanOperationResult> { return this.get(planPath); }

  async submitSection(params: { expected_document_hash: string; content: string; planPath?: string }): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    const reconciled = reconcileState(loaded);
    if (reconciled.changed) return this.persistStateChange(loaded, reconciled.text, reconciled.reason);
    const section = sectionForStage(loaded.metadata.stage);
    if (!section) return validation(`Cannot submit section while stage is ${loaded.metadata.stage}`, []);
    const candidateIssues = validateCandidate(section, params.content, loaded.metadata).issues;
    if (candidateIssues.some((i) => i.severity === "error")) return validation("Section validation failed", candidateIssues);
    let text = replaceSection(loaded.text, section, params.content);
    const metadata = { ...loaded.metadata, stage_status: "ready_for_review" as const };
    if (section === "tasks" && ["awaiting_execution_approval", "executing", "awaiting_round_decision"].includes(loaded.metadata.stage)) {
      metadata.stage = "tasks";
      metadata.stage_status = "ready_for_review";
      delete metadata.reviewed_tasks_hash;
    }
    text = replaceFrontmatter(text, metadata);
    return this.write(loaded, text, "Submitted current section");
  }

  async advance(params: { expected_document_hash: string; action?: "next" | "execute" | "next_round" | "complete"; reason?: string; planPath?: string }): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    const reconciled = reconcileState(loaded);
    if (reconciled.changed) return this.persistStateChange(loaded, reconciled.text, reconciled.reason);
    if (loaded.metadata.stage_status === "drafting") return validation("Drafting content cannot be advanced; submit or review it first", []);
    let metadata: PlanMetadata;
    if (loaded.metadata.stage === "what_why") {
      const v = validateWhatWhy(loaded.sections.what_why); if (!v.ok) return validation("What / Why validation failed", v.issues);
      metadata = approveWhatWhy(loaded.metadata, loaded.sections.what_why);
    } else if (loaded.metadata.stage === "plan") {
      if (!loaded.metadata.approved_what_why_hash) return validation("What / Why is not approved", []);
      const v = validatePlan(loaded.sections.plan, loaded.metadata.round); if (!v.ok) return validation("Plan validation failed", v.issues);
      metadata = approvePlan(loaded.metadata, loaded.sections.plan);
    } else if (loaded.metadata.stage === "awaiting_execution_approval") {
      if (params.action && params.action !== "execute" && params.action !== "next") return validation("Use execute to authorize current round", []);
      const v = validateExecutionReadiness(loaded); if (!v.ok) return validation("Execution readiness validation failed", v.issues);
      metadata = authorizeExecution(loaded.metadata);
    } else if (loaded.metadata.stage === "awaiting_round_decision") {
      const progress = validateProgress(loaded); if (!progress.ok) return validation("Current round is not complete", progress.issues);
      if (params.action === "next_round") metadata = rollForward(loaded.metadata);
      else if (params.action === "complete") {
        if (hasFutureHorizon(loaded.sections.plan) && !params.reason?.trim()) return validation("Completion with future horizons requires a closure reason", []);
        metadata = closePlan(loaded.metadata, params.reason?.trim() || "Completed by Human decision");
      } else return validation("Awaiting round decision requires next_round or complete action", []);
    } else {
      return validation(`Cannot advance from ${loaded.metadata.stage}`, []);
    }
    return this.write(loaded, replaceFrontmatter(loaded.text, metadata), `Advanced to ${metadata.stage}`);
  }

  async review(params: { expected_document_hash: string; candidate_tasks?: string; summary?: string; planPath?: string }): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    const reconciled = reconcileState(loaded);
    if (reconciled.changed) return this.persistStateChange(loaded, reconciled.text, reconciled.reason);
    if (loaded.metadata.stage === "what_why") {
      const v = validateWhatWhy(loaded.sections.what_why); if (!v.ok) return validation("What / Why review failed", v.issues);
      return this.write(loaded, replaceFrontmatter(loaded.text, { ...loaded.metadata, stage_status: "ready_for_review" }), "What / Why ready for Human review");
    }
    if (loaded.metadata.stage === "plan") {
      const v = validatePlan(loaded.sections.plan, loaded.metadata.round); if (!v.ok) return validation("Plan review failed", v.issues);
      return this.write(loaded, replaceFrontmatter(loaded.text, { ...loaded.metadata, stage_status: "ready_for_review" }), "Plan ready for Human review");
    }
    if (loaded.metadata.stage !== "tasks") return this.get(loaded.path);
    const nextTasks = params.candidate_tasks ?? loaded.sections.tasks;
    const v = validateTasks(nextTasks, loaded.metadata.round, { requireCurrentOpen: true, historicalCompleted: true });
    if (!v.ok) return validation("Tasks review failed", v.issues);
    let text = replaceSection(loaded.text, "tasks", nextTasks);
    text = replaceSection(text, "review", upsertReview(loaded.sections.review, loaded.metadata.round, params.summary ?? "Status: passed\n\nChanges:\n\n- No deterministic changes required.\n\nRemaining Warnings:\n\n- None."));
    text = replaceFrontmatter(text, markTasksReviewed(loaded.metadata, nextTasks));
    return this.write(loaded, text, "Tasks reviewed; awaiting execution approval");
  }

  async bindTask(params: { expected_document_hash: string; task_id: string; planPath?: string }): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    if (loaded.metadata.stage !== "executing") return validation("Task binding requires executing stage", []);
    const ready = validateExecutionReadiness(loaded); if (!ready.ok) return validation("Task binding validation failed", ready.issues);
    const task = currentRoundTasks(loaded.sections.tasks, loaded.metadata.round).find((candidate) => candidate.id === params.task_id);
    if (!task) return validation(`Task ${params.task_id} is not in current round`, []);
    if (task.completed) return validation(`Task ${params.task_id} is already complete`, []);
    const binding = { task_id: task.id, plan_path: loaded.path, round: loaded.metadata.round, task_definition_hash: canonicalTasksDefinitionHash(task.definition), contract: task };
    this.sessionState.binding = binding;
    this.sessionState.reportedThisTurn = false;
    return { ...ok("ok", `Bound ${task.id}`, loaded), snapshot: { binding } };
  }

  async reportTaskResult(params: { task_id: string; result: "in_progress" | "blocked" | "completed"; summary: string; acceptance_results?: Array<{ item: string; satisfied: boolean }> }): Promise<PlanOperationResult> {
    const binding = this.sessionState.binding;
    if (!binding || binding.task_id !== params.task_id) return validation("Report must match the current task binding", []);
    const loaded = await readPlanDocument(binding.plan_path);
    const task = currentRoundTasks(loaded.sections.tasks, binding.round).find((candidate) => candidate.id === binding.task_id);
    if (!task || canonicalTasksDefinitionHash(task.definition) !== binding.task_definition_hash) return conflict("task_binding_stale");
    this.sessionState.reportedThisTurn = true;
    if (params.result === "in_progress") return ok("ok", `Task ${params.task_id} remains in progress`, loaded);
    if (params.result === "blocked") { delete this.sessionState.binding; return ok("ok", `Task ${params.task_id} blocked; binding cleared`, loaded); }
    const accepted = new Map((params.acceptance_results ?? []).map((entry) => [entry.item, entry.satisfied]));
    if (!task.acceptanceItems.every((item) => accepted.get(item) === true)) return validation("Completed report must satisfy every Acceptance item", []);
    return this.setTaskCompletion(loaded, task, true, `Task ${task.id} completed by bound Agent report`, true);
  }

  async setTaskStatus(params: { expected_document_hash: string; task_id: string; status: "open" | "completed"; planPath?: string }): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    const task = currentRoundTasks(loaded.sections.tasks, loaded.metadata.round).find((candidate) => candidate.id === params.task_id);
    if (!task) return validation(`Task ${params.task_id} is not in current round`, []);
    if (params.status === "completed" && loaded.metadata.stage !== "executing") return validation("Human completion requires executing stage", []);
    if (params.status === "open" && !["executing", "awaiting_round_decision"].includes(loaded.metadata.stage)) return validation("Human reopen requires executing or awaiting_round_decision stage", []);
    return this.setTaskCompletion(loaded, task, params.status === "completed", `Task ${task.id} marked ${params.status} by Human`, false);
  }

  async abandon(params: { expected_document_hash: string; reason?: string; planPath?: string }): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    if (["completed", "abandoned"].includes(loaded.metadata.stage)) return validation("Terminal plans cannot be abandoned again", []);
    const reason = params.reason?.trim() || "No reason provided.";
    return this.write(loaded, replaceFrontmatter(loaded.text, abandonPlan(loaded.metadata, reason)), "Plan abandoned");
  }

  async updateClosureReason(params: { expected_document_hash: string; reason: string; planPath?: string }): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    if (loaded.metadata.stage !== "abandoned" && loaded.metadata.stage !== "completed") return validation("Closure reason can only be updated on a terminal plan", []);
    const reason = params.reason.trim();
    if (!reason) return validation("Closure reason update requires non-empty text", []);
    return this.write(loaded, replaceFrontmatter(loaded.text, { ...loaded.metadata, closure_reason: reason }), "Updated closure reason");
  }

  private async setTaskCompletion(loaded: PlanDocument, task: TaskBlock, complete: boolean, message: string, clearBinding: boolean): Promise<PlanOperationResult> {
    const nextDefinition = task.definition.replace(/^(### T\d{3} — .+?) \[(?: |x|X)\]$/m, `$1 [${complete ? "x" : " "}]`);
    let text = loaded.text.replace(task.definition, nextDefinition);
    const nextTasksText = loaded.sections.tasks.replace(task.definition, nextDefinition);
    const current = parseTasks(nextTasksText).filter((candidate) => candidate.round === loaded.metadata.round);
    let metadata = { ...loaded.metadata };
    if (complete && current.length > 0 && current.every((candidate) => candidate.completed)) metadata = { ...metadata, stage: "awaiting_round_decision", stage_status: "awaiting_human" };
    if (!complete && loaded.metadata.stage === "awaiting_round_decision") metadata = { ...metadata, stage: "executing", stage_status: "in_progress" };
    text = replaceFrontmatter(text, metadata);
    if (clearBinding) delete this.sessionState.binding;
    return this.write(loaded, text, message);
  }

  private async load(planPath?: string): Promise<PlanDocument | PlanOperationResult> {
    const path = planPath ? resolvePath(this.cwd, planPath) : await this.defaultPlanPath();
    if (!path) return conflict("No unfinished Harness Plan found");
    try { const doc = await readPlanDocument(path); this.sessionState.currentPlanPath = doc.path; return doc; }
    catch (error) { return conflict(String((error as Error).message ?? error)); }
  }

  private async defaultPlanPath(): Promise<string | undefined> {
    if (this.sessionState.currentPlanPath) return this.sessionState.currentPlanPath;
    const unfinished = await findUnfinishedHarnessPlans(this.cwd);
    return unfinished.length === 1 ? unfinished[0] : undefined;
  }

  private async persistStateChange(loaded: PlanDocument, text: string, reason?: string): Promise<PlanOperationResult> { return this.write(loaded, text, `State changed during reconciliation: ${reason}` as string, "state_changed"); }

  private async write(loaded: PlanDocument, text: string, message: string, status: PlanOperationResult["status"] = "applied"): Promise<PlanOperationResult> {
    const write = await writeIfDocumentHash(loaded.path, loaded.document_hash, text);
    if (!write.ok) return conflict(write.conflict);
    const next = await readPlanDocument(loaded.path);
    return { ...ok(status, message, next), snapshot: snapshot(next, this.sessionState.binding) };
  }
}

export async function isCurrentHarnessPlanPath(cwd: string, targetPath: string, state: TaskPlanSessionState): Promise<boolean> {
  const path = resolvePath(cwd, targetPath);
  const candidates = new Set<string>();
  if (state.currentPlanPath) candidates.add(resolve(state.currentPlanPath));
  for (const p of await findUnfinishedHarnessPlans(cwd)) candidates.add(resolve(p));
  return candidates.has(path);
}

function sectionForStage(stage: PlanStage): SectionName | undefined {
  if (stage === "what_why") return "what_why";
  if (stage === "plan") return "plan";
  if (stage === "tasks" || stage === "awaiting_execution_approval") return "tasks";
  return undefined;
}

function validateCandidate(section: SectionName, content: string, metadata: PlanMetadata) {
  if (section === "what_why") return validateWhatWhy(content);
  if (section === "plan") return validatePlan(content, metadata.round);
  if (section === "tasks") return validateTasks(content, metadata.round, { historicalCompleted: true });
  return { ok: true, issues: [] };
}

function validateExecutionReadiness(document: PlanDocument) {
  const issues = [
    ...validateFrontmatter(document).issues,
    ...validateSections(document.text).issues,
    ...validateTasks(document.sections.tasks, document.metadata.round, { historicalCompleted: true }).issues,
  ];
  if (!document.metadata.approved_what_why_hash || document.metadata.approved_what_why_hash !== canonicalSectionHash(document.sections.what_why)) issues.push({ severity: "error" as const, code: "what_why_not_approved", message: "What / Why hash is not approved" });
  if (!document.metadata.approved_plan_hash || document.metadata.approved_plan_hash !== canonicalSectionHash(document.sections.plan)) issues.push({ severity: "error" as const, code: "plan_not_approved", message: "Plan hash is not approved" });
  if (!document.metadata.reviewed_tasks_hash || document.metadata.reviewed_tasks_hash !== canonicalTasksDefinitionHash(document.sections.tasks)) issues.push({ severity: "error" as const, code: "tasks_not_reviewed", message: "Tasks hash is not reviewed" });
  return { ok: issues.every((i) => i.severity !== "error"), issues };
}

function upsertReview(existing: string, round: number, summary: string): string {
  const heading = `### R${String(round).padStart(3, "0")} — T+0 Task Review`;
  const entry = `${heading}\n\n${summary.trim()}`;
  const re = new RegExp(`^${escapeRegExp(heading)}[\\s\\S]*?(?=^### R\\d{3} — T\\+0 Task Review|$)`, "m");
  return re.test(existing) ? existing.replace(re, entry) : `${existing.trim() === "Not run." ? "" : existing.trim() + "\n\n"}${entry}`;
}

function hasFutureHorizon(plan: string): boolean { return /^### T\+[1-9]\d* — /m.test(plan); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function snapshot(document: PlanDocument, binding?: TaskBinding) { return { path: document.path, document_hash: document.document_hash, metadata: document.metadata, sections: document.sections, binding }; }
function ok(status: PlanOperationResult["status"], message: string, document: PlanDocument): PlanOperationResult { return { status, message, path: document.path, document_hash: document.document_hash }; }
function conflict(message: string): PlanOperationResult { return { status: "conflict", message, conflicts: [{ message }] }; }
function validation(message: string, issues: ValidationIssue[]): PlanOperationResult { return { status: "validation_error", message, issues }; }
function resolvePath(cwd: string, path: string): string { return isAbsolute(path) ? resolve(path) : resolve(cwd, path); }
