import { nodeExecutionPolicy } from "./scope-policy.ts";
import { assertOperationWritable, listPlanOperationIds, inspectOperationRecovery, recoverPlanOperation, PLAN_RUNTIME_ROOT } from "./operation-journal.ts";
import { runReview, configureReviewAuthority, authenticateReviewEvidence } from "./evidence.ts";
import { assertNodeReviewPolicy, nodeContractHash, requireNodeReview, effectiveNodeRisk, writeReviewEvidence, dependencyFinalizations, assertAllFinalizedHistory, assertReopenRecoverable } from "./receipt-state.ts";
import { consumeDocumentAuthority, appendAuthorization } from "./authority-context.ts";
import type { AuthorityAction, HumanCapability } from "./authority.ts";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { canonicalSectionHash, canonicalTasksDefinitionHash, phaseExecutionDefinitionHash, parseFrontmatter, createPlanSkeleton, findUnfinishedHarnessPlans, readPlanDocument, replaceFrontmatter, sha256, writeIfDocumentHash } from "./plan-file.ts";
import { replaceLogicalSection, editNativeNode, domainFor } from "./plan-domain.ts";
import { parsePlanCandidate } from "./plan-integrity.ts";
import { readNodeApprovals, requireNodeApproval, selectedNode } from "./node-approval.ts";
import type { PlanCreationOptions } from "./plan-file.ts";
import { currentRoundTasks, parseTasks } from "./tasks.ts";
import { approvePlan, approveWhatWhy, authorizeExecution, closePlan, markTasksReviewed, reconcileState, rollForward, abandonPlan } from "./state.ts";
import type { TaskPlanModelSwitchState } from "./model-switch.ts";
import type { PlanDocument, PlanMetadata, PlanStage, SectionName, TaskBlock, ValidationIssue } from "./types.ts";
import { validateApprovalHashes, validateFrontmatter, validatePlan, validateProgress, validateSections, validateTasks, validateWhatWhy } from "./validators.ts";
import type { PlanOperationResult } from "./operation-result.ts";
import { PhaseExecutionService } from "./phase-execution.ts";
import { inspectPhaseRecords, upsertPhaseRecord } from "./phase-record.ts";
import { inspectExecutionNotes, upsertExecutionNote, type ExecutionNote } from "./execution-notes.ts";
import type { PhaseDependencies, HumanDecisionToken } from "./phase-contracts.ts";
import { phaseSwitchHelp } from "./phase-input.ts";
import { readPlanNodes, validatePlanNodeMapping } from "./nodes.ts";

export interface TaskBinding {
  task_id: string;
  plan_path: string;
  round: number;
  task_definition_hash: string;
  contract: TaskBlock;
}

export interface TaskPlanSessionState {
  currentPlanPath?: string;
  creationOptions?: PlanCreationOptions;
  binding?: TaskBinding;
  reportedThisTurn?: boolean;
  modelSwitch?: TaskPlanModelSwitchState;
  phaseDependencies?: PhaseDependencies;
  humanDecision?: HumanDecisionToken; // Legacy proposals confer no authority.
  humanCapability?: HumanCapability;
  phaseTaskId?: string;
}

export class TaskPlanService {
  constructor(private readonly cwd: string, private readonly sessionState: TaskPlanSessionState = {}) {}

  async start(goal: string, titleOverride?: string): Promise<PlanOperationResult> {
    if (!goal.trim()) return validation("Plan goal is required", []);
    try {
      const doc = await createPlanSkeleton(this.cwd, goal.trim(), titleOverride, this.sessionState.creationOptions);
      this.sessionState.currentPlanPath = doc.path;
      return { ...ok("created", "Created Harness Plan skeleton", doc), snapshot: snapshot(doc, this.sessionState.binding) };
    } catch (error) {
      return conflict(String((error as Error).message ?? error));
    }
  }

  async get(planPath?: string): Promise<PlanOperationResult> {
    const loaded = await this.load(planPath,true);
    if ("status" in loaded) return loaded;
    const proposed = reconcileState(loaded,this.sessionState.phaseDependencies?.evidence);
    const issues = [...validateFrontmatter(loaded).issues,...validateApprovalHashes(loaded).issues,...validateProgress(loaded).issues];
    if (proposed.conflict) issues.push({severity:"error",code:"reconciliation_conflict",message:proposed.conflict});
    try { await assertOperationWritable(await realpath(loaded.path)); } catch(error) { issues.push({severity:"error",code:"operation_recovery_required",message:String((error as Error).message)}); }
    if (loaded.metadata.operation_runtime && loaded.metadata.operation_runtime !== PLAN_RUNTIME_ROOT) issues.push({severity:"error",code:"operation_runtime_mismatch",message:"Restore the originally bound Controller runtime before mutations"});
    return {...ok("ok",proposed.changed ? `Read Harness Plan; explicit reconciliation required: ${proposed.reason}` : "Read Harness Plan without modifying it",loaded),issues,snapshot:{...snapshot(loaded,this.sessionState.binding),issues,proposed_reconciliation:proposed.changed ? {expected_document_hash:loaded.document_hash,reason:proposed.reason,metadata:proposed.metadata} : null}};
  }

  async status(planPath?: string): Promise<PlanOperationResult> { return this.get(planPath); }

  /** Explicit Controller transaction: invalidates stale state; never grants Human approval. */
  async reconcile(params: {expected_document_hash:string; planPath?:string}): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath,true);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    const proposed = reconcileState(loaded,this.sessionState.phaseDependencies?.evidence);
    if (proposed.conflict) return conflict(proposed.conflict);
    if (!proposed.changed && loaded.metadata.operation_runtime !== undefined) return {...ok("ok","No reconciliation required",loaded),snapshot:snapshot(loaded,this.sessionState.binding)};
    if (!loaded.metadata.operation_runtime && Object.keys(inspectPhaseRecords(loaded.sections.tasks).records).length) return conflict("runtime_binding_required: legacy execution needs explicit baseline-preserving operator recovery");
    if (proposed.metadata.stage === "awaiting_round_decision") {
      try { assertAllFinalizedHistory(loaded,this.sessionState.phaseDependencies?.evidence); } catch(error) { return validation(String((error as Error).message),[]); }
    }
    const result = await this.write(loaded,proposed.text,`Reconciled state: ${proposed.reason ?? "bound Controller operation runtime"}`,"state_changed");
    if (result.status === "state_changed") { delete this.sessionState.binding; delete this.sessionState.humanCapability; }
    return result;
  }

  async recoveryStatus(params:{operation_id?:string;planPath?:string}):Promise<PlanOperationResult> {
    try {
      const path=params.planPath?resolvePath(this.cwd,params.planPath):await this.defaultPlanPath();
      if(!path)return conflict("Explicit Plan path required for recovery inspection");
      if(!params.operation_id){const ids=await listPlanOperationIds(path);return {status:"ok",path,message:`Known operation IDs (latest 20): ${ids.slice(-20).join(", ") || "none; unknown pre-intent locks require offline recovery"}`,snapshot:{operation_ids:ids}};}
      const inspection=await inspectOperationRecovery(path,params.operation_id);
      return {status:"ok",path,operation_id:inspection.operation_id,document_hash:inspection.current_document_hash??undefined,message:`Recovery inspection: ${inspection.outcome}`,snapshot:inspection};
    }catch(error){return conflict(String((error as Error).message));}
  }

  async recover(params:{operation_id:string;expected_document_hash:string;expected_journal_head:string;planPath?:string}):Promise<PlanOperationResult> {
    const capability=this.takeCapability();
    try {
      const path=params.planPath?resolvePath(this.cwd,params.planPath):await this.defaultPlanPath();
      if(!path)return conflict("Explicit Plan path required for recovery");
      const inspection=await inspectOperationRecovery(path,params.operation_id);
      if(inspection.authority_context.document_hash!==params.expected_document_hash || inspection.journal_head!==params.expected_journal_head)return conflict("stale_recovery_inspection");
      const result=await recoverPlanOperation(inspection,capability!);
      return {status:"applied",path,operation_id:result.operation_id,document_hash:result.current_document_hash??undefined,message:`Recovery recorded: ${inspection.outcome}; no gate or baseline capture replayed`,snapshot:result};
    }catch(error){return conflict(String((error as Error).message));}
  }

  async submitSection(params: { expected_document_hash: string; content: string; section?: "plan" | "tasks"; planPath?: string }): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    const reconciled = reconcileState(loaded,this.sessionState.phaseDependencies?.evidence);
    if (reconciled.changed) return conflict(`reconciliation_required: ${reconciled.reason}`);
    const activeV1=loaded.format === "v1" && loaded.metadata.identity_policy === "node-v1" && loaded.metadata.stage === "executing";
    const section = activeV1 ? params.section ?? "tasks" : sectionForStage(loaded.metadata.stage);
    if(params.section && !activeV1 && params.section!==section)return validation("section_not_current",[]);
    if (!section) return validation(`Cannot submit section while stage is ${loaded.metadata.stage}`, []);
    if(loaded.format === "v2" && section === "tasks")return validation("native_node_edit_required: submit one canonical node",[]);
    if (section === "tasks" && !preservesExecutionState(loaded.sections.tasks, params.content)) return conflict("reserved_execution_state_changed: Tasks editing cannot add, modify or delete execution records/notes");
    const candidateIssues = (loaded.format === "v2" && section === "plan" ? {issues:[]} : validateCandidate(section, params.content, loaded.metadata)).issues;
    if (candidateIssues.some((i) => i.severity === "error")) return validation("Section validation failed", candidateIssues);
    let text = replaceLogicalSection(loaded, section, params.content);
    if(activeV1) {
      try {
        const candidate=parsePlanCandidate(loaded.path,text);
        for(const id of Object.keys(inspectPhaseRecords(loaded.sections.tasks).records))if(nodeContractHash(loaded,id,this.sessionState.phaseDependencies?.evidence)!==nodeContractHash(candidate,id,this.sessionState.phaseDependencies?.evidence))return conflict("active_contract_edit_requires_recovery");
        const mapping=validatePlanNodeMapping(candidate.sections.plan,candidate.sections.tasks,{currentNodeId:selectedNode(loaded)}).filter(i=>i.severity==="error");
        if(mapping.length)return validation("Plan/Tasks contract mapping failed",mapping);
        return this.write(loaded,text,"Submitted unrelated future definition; active node authority preserved");
      }catch(error){return validation(String((error as Error).message),[]);}
    }
    const metadata = { ...loaded.metadata, stage_status: "ready_for_review" as const };
    if (section === "tasks" && ["awaiting_execution_approval", "executing", "awaiting_round_decision"].includes(loaded.metadata.stage)) {
      metadata.stage = "tasks";
      metadata.stage_status = "ready_for_review";
      delete metadata.reviewed_tasks_hash;
      delete metadata.approved_contract_hash;
    }
    text = replaceFrontmatter(text, metadata);
    return this.write(loaded, text, "Submitted current section");
  }

  async submitNode(params:{expected_document_hash:string;node_id:string;content:string;planPath?:string}):Promise<PlanOperationResult> {
    const loaded=await this.load(params.planPath,true);
    if("status" in loaded)return loaded;
    if(loaded.document_hash!==params.expected_document_hash)return conflict("stale_document_hash");
    if(!["plan","tasks","awaiting_execution_approval","executing"].includes(loaded.metadata.stage))return validation("Native node editing requires plan/tasks/execution stage",[]);
    try {
      if(domainFor(loaded).nodes.find(n=>n.id===params.node_id)?.progress==="completed")return validation("reopen_required: finalized contract cannot be edited",[]);
      let text=editNativeNode(loaded,params.node_id,params.content);
      const candidate=parsePlanCandidate(loaded.path,text);
      if(inspectPhaseRecords(loaded.sections.tasks).records[params.node_id] && nodeContractHash(loaded,params.node_id,this.sessionState.phaseDependencies?.evidence)!==nodeContractHash(candidate,params.node_id,this.sessionState.phaseDependencies?.evidence))return conflict("active_contract_edit_requires_recovery: preserve the original execution contract and baseline");
      const proposed=reconcileState(candidate,this.sessionState.phaseDependencies?.evidence);
      if(proposed.conflict && loaded.metadata.stage === "executing")return conflict(proposed.conflict);
      if(proposed.changed)text=proposed.text;
      const metadata=parseFrontmatter(text).metadata;
      if(["plan","tasks"].includes(metadata.stage))text=replaceFrontmatter(text,{...metadata,stage_status:"ready_for_review"});
      return this.write(loaded,text,"Submitted canonical node candidate");
    }catch(error){return validation(String((error as Error).message),[]);}
  }

  async advance(params: { expected_document_hash: string; action?: "next" | "approve_contract" | "execute" | "next_round" | "complete"; reason?: string; planPath?: string }): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    const reconciled = reconcileState(loaded,this.sessionState.phaseDependencies?.evidence);
    if (reconciled.changed) return conflict(`reconciliation_required: ${reconciled.reason}`);
    if (loaded.metadata.stage_status === "drafting") return validation("Drafting content cannot be advanced; submit or review it first", []);
    let metadata: PlanMetadata;
    let authorityAction: AuthorityAction;
    let authorityNode="$plan";
    if (loaded.metadata.stage === "what_why") {
      const v = validateWhatWhy(loaded.sections.what_why); if (!v.ok) return validation("What / Why validation failed", v.issues);
      authorityAction = "approve_what_why";
      metadata = approveWhatWhy(loaded.metadata, loaded.sections.what_why);
    } else if (loaded.metadata.stage === "plan") {
      if (!loaded.metadata.approved_what_why_hash) return validation("What / Why is not approved", []);
      const v = validateDocumentPlan(loaded); if (!v.ok) return validation("Plan validation failed", v.issues);
      authorityAction = "approve_plan";
      metadata = approvePlan(loaded.metadata, loaded.sections.plan);
    } else if (loaded.metadata.stage === "awaiting_execution_approval") {
      const v = this.executionReadiness(loaded); if (!v.ok) return validation("Execution readiness validation failed", v.issues);
      if(loaded.metadata.identity_policy === "node-v1")authorityNode=selectedNode(loaded);
      if (params.action === "execute") {
        if(loaded.metadata.identity_policy === "node-v1") {
          try{requireNodeApproval(loaded,authorityNode,this.sessionState.phaseDependencies?.evidence,false);}catch(error){return validation(String((error as Error).message),[]);}
        } else if (loaded.metadata.approved_contract_hash !== phaseExecutionDefinitionHash(loaded)) return validation("contract_approval_required: approve the detailed contract separately", []);
        authorityAction = "authorize_execution";
        metadata = authorizeExecution(loaded.metadata);
      } else if (!params.action || params.action === "next" || params.action === "approve_contract") {
        authorityAction = "approve_contract";
        metadata = loaded.metadata.identity_policy === "node-v1" ? {...loaded.metadata} : { ...loaded.metadata, approved_contract_hash: phaseExecutionDefinitionHash(loaded) };
      } else return validation("Explicit contract approval or execution authorization required", []);
    } else if (loaded.metadata.stage === "awaiting_round_decision") {
      try { assertAllFinalizedHistory(loaded,this.sessionState.phaseDependencies?.evidence); } catch(error) { return validation(String((error as Error).message),[]); }
      const progress = validateProgress(loaded); if (!progress.ok) return validation("Current round is not complete", progress.issues);
      if (params.action === "next_round") { authorityAction = "next_round"; metadata = rollForward(loaded.metadata); }
      else if (params.action === "complete") {
        if (hasFutureHorizon(loaded.sections.plan) && !params.reason?.trim()) return validation("Completion with future horizons requires a closure reason", []);
        authorityAction = "complete";
        metadata = closePlan(loaded.metadata, params.reason?.trim() || "Completed by Human decision");
      } else return validation("Awaiting round decision requires next_round or complete action", []);
    } else {
      return validation(`Cannot advance from ${loaded.metadata.stage}`, []);
    }
    return this.authorizedWrite(loaded, replaceFrontmatter(loaded.text, metadata), `Advanced to ${metadata.stage}`, authorityAction, authorityNode);
  }

  async review(params: { expected_document_hash: string; candidate_tasks?: string; task_id?:string; summary?: string; planPath?: string }): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    const reconciled = reconcileState(loaded,this.sessionState.phaseDependencies?.evidence);
    if (reconciled.changed) return conflict(`reconciliation_required: ${reconciled.reason}`);
    if (loaded.metadata.stage === "what_why") {
      const v = validateWhatWhy(loaded.sections.what_why); if (!v.ok) return validation("What / Why review failed", v.issues);
      return this.write(loaded, replaceFrontmatter(loaded.text, { ...loaded.metadata, stage_status: "ready_for_review" }), "What / Why ready for Human review");
    }
    if (loaded.metadata.stage === "plan") {
      const v = validateDocumentPlan(loaded); if (!v.ok) return validation("Plan review failed", v.issues);
      return this.write(loaded, replaceFrontmatter(loaded.text, { ...loaded.metadata, stage_status: "ready_for_review" }), "Plan ready for Human review");
    }
    if (loaded.metadata.stage !== "tasks") return this.get(loaded.path);
    if(loaded.format === "v2" && params.candidate_tasks!==undefined)return validation("native_node_edit_required",[]);
    const nextTasks = params.candidate_tasks ?? loaded.sections.tasks;
    if (!preservesExecutionState(loaded.sections.tasks, nextTasks)) return conflict("reserved_execution_state_changed: Review cannot add, modify or delete execution records/notes");
    const v = validateTasks(nextTasks, loaded.metadata.round, { requireCurrentOpen: loaded.metadata.identity_policy !== "node-v1", historicalCompleted: true });
    if (!v.ok) return validation("Tasks review failed", v.issues);
    const mapping = validatePlanNodeMapping(loaded.sections.plan, nextTasks, {currentNodeId:currentRoundTasks(nextTasks,loaded.metadata.round)[0]?.id}).filter(i=>i.severity === "error");
    if (mapping.length) return validation("Plan/Tasks contract mapping failed", mapping);
    const runtime = this.sessionState.phaseDependencies?.evidence;
    if (!runtime) return validation("capability_unavailable: trusted reviewer and receipt signer required", []);
    try {
      let text = replaceLogicalSection(loaded, "tasks", nextTasks);
      const candidate = parsePlanCandidate(loaded.path,text);
      const summaries: string[] = [];
      let passed = true;
      const open=currentRoundTasks(nextTasks,loaded.metadata.round).filter(t=>!t.completed);
      const node=loaded.metadata.identity_policy === "node-v1" ? (params.task_id ? open.find(t=>t.id===params.task_id) : open.length===1 ? open[0] : undefined) : undefined;
      if(loaded.metadata.identity_policy === "node-v1" && !node)return validation("phase_selection_required: review one open node",[]);
      for (const task of node ? [node] : currentRoundTasks(nextTasks,loaded.metadata.round)) {
        if(node){nodeExecutionPolicy(candidate,task.id);dependencyFinalizations(candidate,task.id,runtime);}
        const risk = effectiveNodeRisk(task,runtime);
        const reviewer = runtime.reviewer ?? (risk === "low" && !domainFor(candidate).nodes.find(n=>n.id===task.id)?.reviewPolicy?.independent ? configureReviewAuthority({signer:runtime.signer,session_id:`controller-structural:${runtime.implementer_session_id}`,implementer_session_id:runtime.implementer_session_id,fresh:false,run:async()=>({review_type:"deterministic",result:"passed",summary:"Task structure and Plan mapping passed deterministic validation",evidence_refs:["task-plan:structural-review/v1"]})}) : undefined);
        if (!reviewer) return validation("capability_unavailable: fresh independent review required for unknown/medium/high risk", []);
        const evidence = await runReview(reviewer,{node_id:task.id,contract_hash:nodeContractHash(candidate,task.id,runtime),risk});
        authenticateReviewEvidence(evidence,runtime.signer,{node_id:task.id,contract_hash:nodeContractHash(candidate,task.id,runtime),risk,implementer_session_id:runtime.implementer_session_id});
        assertNodeReviewPolicy(candidate,task.id,evidence.receipt);
        text = writeReviewEvidence(text,task.id,evidence);
        summaries.push(`${task.id}: ${evidence.receipt.result} — ${evidence.receipt.summary}`);
        passed &&= evidence.receipt.result === "passed";
      }
      // Model summaries are candidate commentary; only the configured review result is authoritative.
      text = replaceLogicalSection(parsePlanCandidate(loaded.path,text),"review",upsertReview(loaded.sections.review,loaded.metadata.round,summaries.join("\n\n")));
      const metadata = parseFrontmatter(text).metadata;
      if (passed) text = replaceFrontmatter(text,node ? {...metadata,pending_node:node.id,selected_node:undefined,stage:"awaiting_execution_approval",stage_status:"awaiting_human"} : markTasksReviewed(metadata,nextTasks));
      else {
        delete metadata.reviewed_tasks_hash;
        delete metadata.approved_contract_hash;
        text = replaceFrontmatter(text,{...metadata,stage:"tasks",stage_status:"ready_for_review"});
      }
      const result = await this.write(loaded,text,passed ? "Trusted Review passed; awaiting separate Human contract approval" : "Review did not pass; execution remains blocked");
      return !passed && result.status === "applied" ? {...result,status:"validation_error"} : result;
    } catch (error) { return validation(String((error as Error).message),[]); }
  }

  async bindTask(params: { expected_document_hash: string; task_id: string; planPath?: string }): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    if (loaded.metadata.stage !== "executing") return validation("Task binding requires executing stage", []);
    const ready = this.executionReadiness(loaded); if (!ready.ok) return validation("Task binding validation failed", ready.issues);
    const task = currentRoundTasks(loaded.sections.tasks, loaded.metadata.round).find((candidate) => candidate.id === params.task_id);
    if (!task) return validation(`Task ${params.task_id} is not in current round`, []);
    if (task.completed) return validation(`Task ${params.task_id} is already complete`, []);
    if(loaded.metadata.identity_policy === "node-v1" && task.id!==selectedNode(loaded))return validation("node_not_authorized",[]);
    try { dependencyFinalizations(loaded,task.id,this.sessionState.phaseDependencies?.evidence); } catch(error) { return validation(String((error as Error).message),[]); }
    const binding = { task_id: task.id, plan_path: loaded.path, round: loaded.metadata.round, task_definition_hash: canonicalTasksDefinitionHash(task.definition), contract: task };
    this.sessionState.binding = binding;
    this.sessionState.reportedThisTurn = false;
    return { ...ok("ok", `Bound ${task.id}`, loaded), snapshot: { binding } };
  }

  /** Start a phase and bind its first/current task as one operation. */
  async startAndBind(params: { expected_document_hash: string; task_id?: string; target_root?: string; governance_root?: string; planPath?: string }): Promise<PlanOperationResult> {
    return this.executePhase(params);
  }

  async executePhase(params: { expected_document_hash: string; task_id?: string; target_root?: string; governance_root?: string; planPath?: string }): Promise<PlanOperationResult> {
    const decision = this.sessionState.humanCapability;
    delete this.sessionState.humanCapability;
    delete this.sessionState.humanDecision;
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    const ready = this.executionReadiness(loaded); if (!ready.ok) return validation("Phase readiness validation failed", ready.issues);
    const result = await new PhaseExecutionService(this.sessionState.phaseDependencies).start(loaded, { ...params, decision });
    if (result.status === "applied" || result.status === "ok") {
      let next:PlanDocument;
      try{next=await readPlanDocument(loaded.path);}catch(error){delete this.sessionState.binding;delete this.sessionState.phaseTaskId;return {...result,status:"conflict",message:`post_start_binding_conflict: phase commit is durable; restore the readable Plan and resume its existing execution (${error instanceof Error?error.message:String(error)})`};}
      if(next.document_hash!==result.document_hash){delete this.sessionState.binding;return {...result,status:"conflict",message:"post_start_binding_conflict: phase commit is durable; resume its existing execution",observed_document_hash:next.document_hash};}
      const active = Object.values(inspectPhaseRecords(next.sections.tasks).records).find((r) => !r.finalized && r.context.round === next.metadata.round && (!params.task_id || r.context.phase_id === params.task_id));
      if (active) {
        this.sessionState.phaseTaskId = active.context.phase_id;
        const task=currentRoundTasks(next.sections.tasks,next.metadata.round).find(t=>t.id===active.context.phase_id)!;
        this.sessionState.binding={task_id:task.id,plan_path:next.path,round:next.metadata.round,task_definition_hash:canonicalTasksDefinitionHash(task.definition),contract:task};
        this.sessionState.reportedThisTurn=false;
        return { ...result, message: `${result.message}\n${phaseSwitchHelp(active.docsync.enabled)}`, snapshot: snapshot(next, this.sessionState.binding) };
      }
    }
    return { ...result, message: `${result.message}\n${phaseSwitchHelp()}` };
  }

  async setPhaseDocSync(params: { expected_document_hash: string; task_id: string; enabled: boolean; planPath?: string }): Promise<PlanOperationResult> {
    const decision = this.sessionState.humanCapability;
    delete this.sessionState.humanCapability;
    delete this.sessionState.humanDecision;
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    const ready = this.executionReadiness(loaded); if (!ready.ok) return validation("DocSync readiness validation failed", ready.issues);
    const result = await new PhaseExecutionService(this.sessionState.phaseDependencies).setDocSync(loaded, params.task_id, params.enabled, decision);
    if (result.status === "applied" || result.status === "ok") return { ...result, snapshot: snapshot(await readPlanDocument(loaded.path), this.sessionState.binding) };
    return result;
  }

  async finalizePhase(params: { expected_document_hash: string; task_id: string; planPath?: string }): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    const ready = this.executionReadiness(loaded); if (!ready.ok) return validation("Finalize readiness validation failed", ready.issues);
    const result = await new PhaseExecutionService(this.sessionState.phaseDependencies).finalize(loaded, params.task_id, this.takeCapability());
    if (result.status === "applied") {
      const next = await readPlanDocument(loaded.path);
      const record = inspectPhaseRecords(next.sections.tasks).records[params.task_id];
      if (record?.finalized) { delete this.sessionState.binding; delete this.sessionState.phaseTaskId; }
      return { ...result, snapshot: snapshot(next, this.sessionState.binding) };
    }
    return result;
  }

  async verifyAcceptance(params: {expected_document_hash:string; task_id:string; acceptance_id:string; planPath?:string}): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    const ready = this.executionReadiness(loaded); if (!ready.ok) return validation("Verification readiness failed",ready.issues);
    const result = await new PhaseExecutionService(this.sessionState.phaseDependencies).verifyAcceptance(loaded,params.task_id,params.acceptance_id);
    if (result.document_hash) return {...result,snapshot:snapshot(await readPlanDocument(loaded.path),this.sessionState.binding)};
    return result;
  }

  async reportTaskResult(params: { task_id: string; work_item_id?: string; result: "in_progress" | "blocked" | "completed"; summary: string; files?: string[]; change_types?: ExecutionNote["change_types"]; acceptance_results?: Array<{ item: string; satisfied: boolean }> }): Promise<PlanOperationResult> {
    const binding = this.sessionState.binding;
    if (!binding || binding.task_id !== params.task_id) return validation("Report must match the current task binding", []);
    const loaded = await readPlanDocument(binding.plan_path);
    const ready = this.executionReadiness(loaded); if (!ready.ok) return validation("Report readiness validation failed", ready.issues);
    if (loaded.metadata.stage !== "executing" || loaded.metadata.round !== binding.round) return conflict("task_binding_stale");
    const task = currentRoundTasks(loaded.sections.tasks, binding.round).find((candidate) => candidate.id === binding.task_id);
    if (!task || canonicalTasksDefinitionHash(task.definition) !== binding.task_definition_hash) return conflict("task_binding_stale");
    const result = await new PhaseExecutionService(this.sessionState.phaseDependencies).report(loaded, params);
    if (result.status === "applied" || result.status === "ok") {
      this.sessionState.reportedThisTurn = true;
      const next = await readPlanDocument(loaded.path);
      const fresh = currentRoundTasks(next.sections.tasks, binding.round).find((item) => item.id === binding.task_id);
      if (fresh) binding.contract = fresh;
      return { ...result, snapshot: snapshot(next, binding) };
    }
    return result;
  }

  async reportTaskResults(params:{expected_document_hash:string;idempotency_key:string;task_id:string;reports:Array<Omit<Parameters<TaskPlanService["reportTaskResult"]>[0],"task_id">>}):Promise<PlanOperationResult> {
    const binding=this.sessionState.binding;
    if(!binding||binding.task_id!==params.task_id)return validation("Report must match the current task binding",[]);
    const loaded=await readPlanDocument(binding.plan_path);
    if(loaded.metadata.round!==binding.round)return conflict("task_binding_stale");
    const task=currentRoundTasks(loaded.sections.tasks,binding.round).find(t=>t.id===binding.task_id);
    if(!task||canonicalTasksDefinitionHash(task.definition)!==binding.task_definition_hash)return conflict("task_binding_stale");
    const result=await new PhaseExecutionService(this.sessionState.phaseDependencies).reportBatch(loaded,params);
    if(result.status==="applied"||result.status==="ok")this.sessionState.reportedThisTurn=true;
    return result;
  }

  async setTaskStatus(params: { expected_document_hash: string; task_id: string; status: "open" | "completed"; planPath?: string }): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath, params.status === "open");
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    const task = currentRoundTasks(loaded.sections.tasks, loaded.metadata.round).find((candidate) => candidate.id === params.task_id);
    if (!task) return validation(`Task ${params.task_id} is not in current round`, []);
    if (params.status === "completed" && loaded.metadata.stage !== "executing") return validation("Human completion requires executing stage", []);
    if (params.status === "open" && !["executing", "awaiting_round_decision", ...(loaded.metadata.identity_policy === "node-v1" ? ["tasks","awaiting_execution_approval"] : [])].includes(loaded.metadata.stage)) return validation("Human reopen requires an execution or node selection stage", []);
    if (params.status === "completed") return this.finalizePhase(params);
    try {
      if(loaded.metadata.identity_policy === "node-v1") {
        if(!inspectPhaseRecords(loaded.sections.tasks).records[task.id])throw new Error("reopen_execution_required: an unstarted node has no execution to reopen");
        requireNodeApproval(loaded,task.id,this.sessionState.phaseDependencies?.evidence);
        requireNodeReview(loaded,task.id,this.sessionState.phaseDependencies?.evidence);
      }
      assertReopenRecoverable(loaded,task.id);
    } catch(error) { return validation(String((error as Error).message),[]); }
    // Reopening invalidates all previous evidence, but preserves execution identity/baseline.
    let definition = task.definition.replace(/^(### T\d{3} — .+?) \[(?: |x|X)\]$/m, "$1 [ ]")
      .replace(/^([ \t]*- )\[(?: |x|X)\]/gm, "$1[ ]")
      .replace(/^([ \t]*- .+?) \[(?: |x|X)\]([ \t]*)$/gm, "$1 [ ]$2");
    const record = inspectPhaseRecords(definition).records[task.id];
    if (record) {
      if((record.generation??0)>=Number.MAX_SAFE_INTEGER)return validation("execution_generation_exhausted",[]);
      record.generation=(record.generation??0)+1;
      delete record.finalized;
      delete record.last_finalize;
      record.acceptance = [];
      record.verification = [];
      definition = upsertPhaseRecord(definition, task.id, record);
      for (const work of task.workItems) definition = upsertExecutionNote(definition, work.id, { version: 1, status: "in_progress", summary: "Reopened by Human; previous evidence invalidated", files: [], change_types: [] });
    }
    const tasks = loaded.sections.tasks.replace(task.definition, definition);
    const text = replaceFrontmatter(replaceLogicalSection(loaded, "tasks", tasks), { ...loaded.metadata, stage: "executing", stage_status: "in_progress", ...(loaded.metadata.identity_policy === "node-v1" ? {selected_node:task.id,pending_node:undefined} : {}) });
    delete this.sessionState.binding;
    return this.authorizedWrite(loaded, text, `Task ${task.id} reopened; previous acceptance invalidated`, "reopen", task.id);
  }

  async abandon(params: { expected_document_hash: string; reason?: string; planPath?: string }): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    if (["completed", "abandoned"].includes(loaded.metadata.stage)) return validation("Terminal plans cannot be abandoned again", []);
    const reason = params.reason?.trim() || "No reason provided.";
    return this.authorizedWrite(loaded, replaceFrontmatter(loaded.text, abandonPlan(loaded.metadata, reason)), "Plan abandoned", "abandon");
  }

  async updateClosureReason(params: { expected_document_hash: string; reason: string; planPath?: string }): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    if (loaded.metadata.stage !== "abandoned" && loaded.metadata.stage !== "completed") return validation("Closure reason can only be updated on a terminal plan", []);
    const reason = params.reason.trim();
    if (!reason) return validation("Closure reason update requires non-empty text", []);
    return this.authorizedWrite(loaded, replaceFrontmatter(loaded.text, { ...loaded.metadata, closure_reason: reason }), "Updated closure reason", "update_closure");
  }

  private async load(planPath?: string, allowCompletionConflict = false): Promise<PlanDocument | PlanOperationResult> {
    try {
      const path = planPath ? resolvePath(this.cwd, planPath) : await this.defaultPlanPath();
      if (!path) return conflict("No unfinished Harness Plan found");
      const doc = await readPlanDocument(path);
      this.sessionState.currentPlanPath = doc.path;
      const reconciled = reconcileState(doc,this.sessionState.phaseDependencies?.evidence);
      if (!allowCompletionConflict && reconciled.conflict) return conflict(reconciled.conflict);
      if (!allowCompletionConflict && reconciled.changed) return conflict(`reconciliation_required: ${reconciled.reason}`);
      return doc;
    }
    catch (error) { return conflict(String((error as Error).message ?? error)); }
  }

  private async defaultPlanPath(): Promise<string | undefined> {
    if (this.sessionState.currentPlanPath) return this.sessionState.currentPlanPath;
    const unfinished = await findUnfinishedHarnessPlans(this.cwd);
    return unfinished.length === 1 ? unfinished[0] : undefined;
  }

  private executionReadiness(document: PlanDocument) {
    const result = validateExecutionReadiness(document);
    try {
      const modern=document.metadata.identity_policy === "node-v1";
      const id=modern ? selectedNode(document) : undefined;
      for (const task of currentRoundTasks(document.sections.tasks,document.metadata.round).filter(t=>!t.completed && (!modern || t.id===id))) {
        if(modern && document.metadata.stage === "executing")requireNodeApproval(document,task.id,this.sessionState.phaseDependencies?.evidence);
        requireNodeReview(document,task.id,this.sessionState.phaseDependencies?.evidence);
        // Dependency readiness is evaluated when a node is actually bound/executed, not when reviewing future work.
      }
    } catch(error) { result.issues.push({severity:"error",code:"review_authority_required",message:String((error as Error).message)}); }
    return {...result,ok:result.issues.every(i=>i.severity !== "error")};
  }

  private takeCapability(): HumanCapability | undefined {
    const token = this.sessionState.humanCapability;
    delete this.sessionState.humanCapability;
    delete this.sessionState.humanDecision;
    return token;
  }

  private async authorizedWrite(loaded: PlanDocument, text: string, message: string, action: AuthorityAction, nodeId = "$plan"): Promise<PlanOperationResult> {
    try {
      const receipt = await consumeDocumentAuthority(loaded, this.takeCapability(), action, nodeId,{},this.sessionState.phaseDependencies?.evidence);
      if(loaded.metadata.identity_policy === "node-v1" && ["approve_contract","authorize_execution"].includes(action)) {
        const metadata=parseFrontmatter(text).metadata, approvals=readNodeApprovals(metadata);
        if(action==="approve_contract")approvals[nodeId]={contract_hash:receipt.context.contract_hash,contract_authorization_ref:receipt.receipt_hash};
        else {
          requireNodeApproval(loaded,nodeId,this.sessionState.phaseDependencies?.evidence,false);
          approvals[nodeId]={...approvals[nodeId]!,execution_authorization_ref:receipt.receipt_hash};
          metadata.selected_node=nodeId;delete metadata.pending_node;
        }
        text=replaceFrontmatter(text,{...metadata,node_approvals:JSON.stringify(approvals)});
      }
      return this.write(loaded, appendAuthorization(text, receipt), message);
    } catch (error) { return validation(String((error as Error).message), []); }
  }

  private async write(loaded: PlanDocument, text: string, message: string, status: PlanOperationResult["status"] = "applied"): Promise<PlanOperationResult> {
    const write = await writeIfDocumentHash(loaded.path, loaded.document_hash, text, {kind:status === "state_changed" ? "reconcile" : "mutation"});
    if (!write.ok) return {...conflict(write.conflict),operation_id:write.operation_id,observed_document_hash:write.observed_document_hash};
    const next = await readPlanDocument(loaded.path);
    return { ...ok(status, message, next), operation_id:write.operation_id, snapshot: snapshot(next, this.sessionState.binding) };
  }
}

export async function isCurrentHarnessPlanPath(cwd: string, targetPath: string, state: TaskPlanSessionState): Promise<boolean> {
  const normalize = async (path: string) => { try { return await realpath(path); } catch(error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(path); throw error; } };
  const path = await normalize(resolvePath(cwd, targetPath));
  const candidates = new Set<string>();
  if (state.currentPlanPath) candidates.add(await normalize(resolve(state.currentPlanPath)));
  for (const p of await findUnfinishedHarnessPlans(cwd)) candidates.add(await normalize(resolve(p)));
  return candidates.has(path);
}

function preservesExecutionState(before: string, after: string): boolean {
  const saved = (markdown: string) => {
    const phases = inspectPhaseRecords(markdown);
    const notes = inspectExecutionNotes(phases.definition);
    if (phases.errors.length || notes.errors.length) return undefined;
    return JSON.stringify([Object.entries(phases.records).sort(([a], [b]) => a.localeCompare(b)), Object.entries(notes.notes).sort(([a], [b]) => a.localeCompare(b))]);
  };
  const original = saved(before), candidate = saved(after);
  return original !== undefined && candidate !== undefined && original === candidate;
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
    ...validateProgress(document).issues,
    ...validateSections(document.text).issues,
    ...validatePlanNodeMapping(document.sections.plan,document.sections.tasks,{currentNodeId:String(document.metadata.selected_node ?? document.metadata.pending_node ?? currentRoundTasks(document.sections.tasks,document.metadata.round).find(t=>!t.completed)?.id ?? "")}),
    ...validateTasks(document.sections.tasks, document.metadata.round, { historicalCompleted: true }).issues,
  ];
  if (!document.metadata.approved_what_why_hash || document.metadata.approved_what_why_hash !== canonicalSectionHash(document.sections.what_why)) issues.push({ severity: "error" as const, code: "what_why_not_approved", message: "What / Why hash is not approved" });
  if(document.metadata.identity_policy === "node-v1")return {ok:issues.every(i=>i.severity!=="error"),issues};
  if (!document.metadata.approved_plan_hash || document.metadata.approved_plan_hash !== canonicalSectionHash(document.sections.plan)) issues.push({ severity: "error" as const, code: "plan_not_approved", message: "Plan hash is not approved" });
  if (!document.metadata.reviewed_tasks_hash || document.metadata.reviewed_tasks_hash !== canonicalTasksDefinitionHash(document.sections.tasks)) issues.push({ severity: "error" as const, code: "tasks_not_reviewed", message: "Tasks hash is not reviewed" });
  return { ok: issues.every((i) => i.severity !== "error"), issues };
}

function upsertReview(existing: string, round: number, summary: string): string {
  const prefix = `### R${String(round).padStart(3,"0")} — `;
  const entry = `${prefix}Current Stage Task Review\n\n${summary.trim()}`;
  const lines = existing.replace(/\r\n/g,"\n").split("\n");
  const heading = /^### R\d{3} — (?:Current Stage|T\+0) Task Review$/;
  const start = lines.findIndex(line => line.startsWith(prefix) && heading.test(line));
  if (start < 0) return existing.trim() === "Not run." ? entry : `${existing.trim()}\n\n${entry}`;
  const next = lines.findIndex((line,index)=>index>start && heading.test(line));
  return [...lines.slice(0,start),entry,"",...lines.slice(next<0?lines.length:next)].join("\n").trim();
}

function hasFutureHorizon(plan: string): boolean { return /^### T(?:00[2-9]|0[1-9]\d|[1-9]\d{2}) — /m.test(plan); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function snapshot(document: PlanDocument, binding?: TaskBinding) {
  return {
    path: document.path,
    document_hash: document.document_hash,
    metadata: document.metadata,
    sections: document.sections,
    format:document.format ?? "v1",
    domain:document.domain,
    nodes: document.format === "v2" ? domainFor(document).nodes : readPlanNodes(document.sections.plan, document.sections.tasks),
    node_mapping_issues: validatePlanNodeMapping(document.sections.plan, document.sections.tasks, { currentNodeId: currentNodeId(document) }),
    binding,
  };
}
function currentNodeId(document: PlanDocument): string | undefined {
  if (["executing", "awaiting_round_decision", "awaiting_execution_approval"].includes(document.metadata.stage)) {
    return currentRoundTasks(document.sections.tasks, document.metadata.round)[0]?.id;
  }
  return document.sections.plan.match(/^### (T\\d{3}) — /m)?.[1];
}
function ok(status: PlanOperationResult["status"], message: string, document: PlanDocument): PlanOperationResult { return { status, message, path: document.path, document_hash: document.document_hash }; }
function conflict(message: string): PlanOperationResult { return { status: "conflict", message, conflicts: [{ message }] }; }
function validation(message: string, issues: ValidationIssue[]): PlanOperationResult { return { status: "validation_error", message, issues }; }
function resolvePath(cwd: string, path: string): string { return isAbsolute(path) ? resolve(path) : resolve(cwd, path); }

function validateDocumentPlan(document:PlanDocument) {
  if(document.format!=="v2")return validatePlan(document.sections.plan,document.metadata.round);
  const domain=domainFor(document), issues:ValidationIssue[]=[];
  for(const name of ["Strategy","Key Decisions","Risks / Unknowns","Replan Conditions"])if(!domain.strategy.includes(`### ${name}`))issues.push({severity:"error",code:"missing_plan_field",message:`Missing shared ${name}`});
  if(!domain.nodes.length || domain.nodes.some(n=>!n.outcome.trim()))issues.push({severity:"error",code:"missing_node_outcome",message:"Plan needs nodes with defined outcomes"});
  return {ok:!issues.length,issues};
}
