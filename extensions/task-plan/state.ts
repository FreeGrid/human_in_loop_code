import { canonicalSectionHash, canonicalTasksDefinitionHash, phaseExecutionDefinitionHash, replaceFrontmatter } from "./plan-file.ts";
import { parseTasks } from "./tasks.ts";
import { inspectPhaseRecords } from "./phase-record.ts";
import { type PlanDocument, type PlanMetadata } from "./types.ts";
import { validateApprovalHashes, validatePlan, validateProgress, validateTasks, validateWhatWhy } from "./validators.ts";

export interface ReconcileResult {
  changed: boolean;
  reason?: string;
  conflict?: string;
  metadata: PlanMetadata;
  text: string;
}

export function reconcileState(document: PlanDocument): ReconcileResult {
  const current = { ...document.metadata };
  const next = { ...current };
  const whatWhyHash = canonicalSectionHash(document.sections.what_why);
  const planHash = canonicalSectionHash(document.sections.plan);
  const tasksHash = canonicalTasksDefinitionHash(document.sections.tasks);

  if (next.approved_what_why_hash && next.approved_what_why_hash !== whatWhyHash) {
    next.stage = "what_why";
    next.stage_status = validateWhatWhy(document.sections.what_why).ok ? "ready_for_review" : "drafting";
    delete next.approved_what_why_hash;
    delete next.approved_plan_hash;
    delete next.reviewed_tasks_hash;
    return changed(document, next, "what_why_hash_mismatch");
  }

  if (next.approved_plan_hash && next.approved_plan_hash !== planHash) {
    next.stage = "plan";
    next.stage_status = validatePlan(document.sections.plan, next.round).ok ? "ready_for_review" : "drafting";
    delete next.approved_plan_hash;
    delete next.reviewed_tasks_hash;
    return changed(document, next, "plan_hash_mismatch");
  }

  if (next.reviewed_tasks_hash && next.reviewed_tasks_hash !== tasksHash && isExecutionRelated(next.stage)) {
    next.stage = "tasks";
    next.stage_status = validateTasks(document.sections.tasks, next.round).ok ? "ready_for_review" : "drafting";
    delete next.reviewed_tasks_hash;
    return changed(document, next, "tasks_hash_mismatch");
  }

  const currentRoundTasks = parseTasks(document.sections.tasks).filter((task) => task.round === next.round);
  if (["executing", "awaiting_round_decision"].includes(next.stage)) {
    const records = inspectPhaseRecords(document.sections.tasks);
    if (records.errors.length) return { changed: false, metadata: current, text: document.text, conflict: "invalid_phase_record" };
    for (const task of currentRoundTasks) {
      const record = records.records[task.id];
      if (task.completed && (!record?.finalized || record.definition_hash !== phaseExecutionDefinitionHash(document) || record.context.round !== next.round || task.workItems.some((item) => !item.completed) || task.acceptance.some((item) => !item.completed))) {
        return { changed: false, metadata: current, text: document.text, conflict: "completion_evidence_missing" };
      }
      if (!task.completed && (record?.finalized || task.workItems.some((item) => item.completed) || task.acceptance.some((item) => item.completed))) return { changed: false, metadata: current, text: document.text, conflict: "completion_record_conflict" };
    }
  }
  if (next.stage === "executing" && currentRoundTasks.length > 0 && currentRoundTasks.every((task) => task.completed)) {
    next.stage = "awaiting_round_decision";
    next.stage_status = "awaiting_human";
    return changed(document, next, "current_round_complete");
  }

  if (next.stage === "awaiting_round_decision" && currentRoundTasks.some((task) => !task.completed)) {
    next.stage = "executing";
    next.stage_status = "in_progress";
    return changed(document, next, "current_round_reopened");
  }

  validateApprovalHashes(document);
  validateProgress(document);
  return { changed: false, metadata: current, text: document.text };
}

export function approveWhatWhy(metadata: PlanMetadata, whatWhy: string): PlanMetadata {
  return { ...metadata, approved_what_why_hash: canonicalSectionHash(whatWhy), stage: "plan", stage_status: "drafting" };
}

export function approvePlan(metadata: PlanMetadata, plan: string): PlanMetadata {
  return { ...metadata, approved_plan_hash: canonicalSectionHash(plan), stage: "tasks", stage_status: "drafting" };
}

export function markTasksReviewed(metadata: PlanMetadata, tasks: string): PlanMetadata {
  return { ...metadata, reviewed_tasks_hash: canonicalTasksDefinitionHash(tasks), stage: "awaiting_execution_approval", stage_status: "awaiting_human" };
}

export function authorizeExecution(metadata: PlanMetadata): PlanMetadata {
  return { ...metadata, stage: "executing", stage_status: "in_progress" };
}

export function rollForward(metadata: PlanMetadata): PlanMetadata {
  const next = { ...metadata, round: metadata.round + 1, stage: "plan" as const, stage_status: "drafting" as const };
  delete next.approved_plan_hash;
  delete next.reviewed_tasks_hash;
  return next;
}

export function closePlan(metadata: PlanMetadata, reason: string): PlanMetadata {
  return { ...metadata, stage: "completed", stage_status: "closed", closure_reason: reason };
}

export function abandonPlan(metadata: PlanMetadata, reason: string): PlanMetadata {
  return { ...metadata, stage: "abandoned", stage_status: "closed", closure_reason: reason };
}

function isExecutionRelated(stage: PlanMetadata["stage"]): boolean {
  return stage === "awaiting_execution_approval" || stage === "executing" || stage === "awaiting_round_decision";
}

function changed(document: PlanDocument, metadata: PlanMetadata, reason: string): ReconcileResult {
  return { changed: true, reason, metadata, text: replaceFrontmatter(document.text, metadata) };
}
