import { readNodeApprovals, selectedNode, requireNodeApproval } from "./node-approval.ts";
import { nodeContractHash, assertAllFinalizedHistory, requireNodeReview, type EvidenceRuntime } from "./receipt-state.ts";
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

export function reconcileState(document: PlanDocument, runtime?:EvidenceRuntime): ReconcileResult {
  if(document.metadata.identity_policy === "node-v1") return reconcileNodes(document,runtime);
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
    delete next.approved_contract_hash;
    return changed(document, next, "what_why_hash_mismatch");
  }

  if (next.approved_plan_hash && next.approved_plan_hash !== planHash) {
    next.stage = "plan";
    next.stage_status = validatePlan(document.sections.plan, next.round).ok ? "ready_for_review" : "drafting";
    delete next.approved_plan_hash;
    delete next.reviewed_tasks_hash;
    delete next.approved_contract_hash;
    return changed(document, next, "plan_hash_mismatch");
  }

  if (next.reviewed_tasks_hash && next.reviewed_tasks_hash !== tasksHash && isExecutionRelated(next.stage)) {
    next.stage = "tasks";
    next.stage_status = validateTasks(document.sections.tasks, next.round).ok ? "ready_for_review" : "drafting";
    delete next.reviewed_tasks_hash;
    delete next.approved_contract_hash;
    return changed(document, next, "tasks_hash_mismatch");
  }

  const currentRoundTasks = parseTasks(document.sections.tasks).filter((task) => task.round === next.round);
  if (["executing", "awaiting_round_decision"].includes(next.stage)) {
    const records = inspectPhaseRecords(document.sections.tasks);
    if (records.errors.length) return { changed: false, metadata: current, text: document.text, conflict: "invalid_phase_record" };
    for (const task of parseTasks(document.sections.tasks)) {
      const record = records.records[task.id];
      if (task.completed && (!record?.finalized?.evidence || record.finalized.evidence.receipt.contract_hash !== nodeContractHash(document,task.id) || record.context.round !== task.round || task.workItems.some((item) => !item.completed) || task.acceptance.some((item) => !item.completed))) {
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

  const issues = [...validateApprovalHashes(document).issues,...validateProgress(document).issues];
  const errors = issues.filter(issue => issue.severity === "error");
  return { changed: false, metadata: current, text: document.text, ...(errors.length ? {conflict:`invalid_plan_state: ${errors.map(issue=>issue.code).join(", ")}`} : {}) };
}

export function approveWhatWhy(metadata: PlanMetadata, whatWhy: string): PlanMetadata {
  return { ...metadata, approved_contract_hash: undefined, approved_plan_hash: undefined, reviewed_tasks_hash: undefined, approved_what_why_hash: canonicalSectionHash(whatWhy), stage: "plan", stage_status: "drafting" };
}

export function approvePlan(metadata: PlanMetadata, plan: string): PlanMetadata {
  return { ...metadata, approved_contract_hash: undefined, reviewed_tasks_hash: undefined, approved_plan_hash: canonicalSectionHash(plan), stage: "tasks", stage_status: "drafting" };
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
  delete next.approved_contract_hash;
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

/** Pure diagnostic proposal. Unrelated node edits never erase a running node's authority. */
function reconcileNodes(document:PlanDocument,runtime?:EvidenceRuntime):ReconcileResult {
  const metadata={...document.metadata}, unchanged=()=>({changed:false,metadata,text:document.text});
  if(metadata.approved_what_why_hash && metadata.approved_what_why_hash!==canonicalSectionHash(document.sections.what_why)) {
    delete metadata.approved_what_why_hash; delete metadata.approved_plan_hash; delete metadata.node_approvals;
    delete metadata.selected_node;delete metadata.pending_node;
    metadata.stage="what_why";metadata.stage_status="ready_for_review";
    return changed(document,metadata,"what_why_hash_mismatch");
  }
  if(!["tasks","awaiting_execution_approval","executing","awaiting_round_decision"].includes(metadata.stage))return unchanged();
  const records=inspectPhaseRecords(document.sections.tasks);
  if(records.errors.length)return {...unchanged(),conflict:"invalid_phase_record"};
  if(!runtime && (metadata.selected_node || metadata.pending_node || Object.keys(records.records).length))return {...unchanged(),conflict:"capability_unavailable: trusted runtime required to diagnose node evidence"};
  try {
    assertAllFinalizedHistory(document,runtime);
    const approvals=readNodeApprovals(metadata);
    let invalidated=false;
    for(const id of Object.keys(approvals)) {
      try{requireNodeApproval(document,id,runtime,!!approvals[id]?.execution_authorization_ref);}
      catch {
        delete approvals[id];invalidated=true;
        if(metadata.selected_node===id || metadata.pending_node===id){delete metadata.selected_node;delete metadata.pending_node;metadata.stage="tasks";metadata.stage_status="ready_for_review";}
      }
    }
    if(metadata.stage==="awaiting_execution_approval") {
      try{requireNodeReview(document,selectedNode(document),runtime);}
      catch {delete metadata.pending_node;delete metadata.selected_node;metadata.stage="tasks";metadata.stage_status="ready_for_review";invalidated=true;}
    }
    if(metadata.stage==="executing") {const id=selectedNode(document);requireNodeApproval(document,id,runtime);requireNodeReview(document,id,runtime);}
    if(invalidated){metadata.node_approvals=JSON.stringify(approvals);return changed(document,metadata,"node_contract_invalidated");}
    const issues=validateProgress(document).issues.filter(i=>i.severity==="error");
    if(issues.length)return {...unchanged(),conflict:`invalid_plan_state: ${issues.map(i=>i.code).join(", ")}`};
    return unchanged();
  } catch(error) {return {...unchanged(),conflict:String((error as Error).message)};}
}
