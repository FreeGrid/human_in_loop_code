import { runReview, configureReviewAuthority, authenticateReviewEvidence } from "./evidence.ts";
import { nodeContractHash, requireNodeReview, effectiveNodeRisk, writeReviewEvidence, dependencyFinalizations, assertAllFinalizedHistory, assertReopenRecoverable } from "./receipt-state.ts";
import { consumeDocumentAuthority, appendAuthorization } from "./authority-context.ts";
import type { AuthorityAction, HumanCapability } from "./authority.ts";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { canonicalSectionHash, canonicalTasksDefinitionHash, phaseExecutionDefinitionHash, parseFrontmatter, createPlanSkeleton, findUnfinishedHarnessPlans, readPlanDocument, replaceFrontmatter, sha256, writeIfDocumentHash } from "./plan-file.ts";
import { replaceSection } from "./sections.ts";
import { currentRoundTasks, parseTasks } from "./tasks.ts";
import { approvePlan, approveWhatWhy, authorizeExecution, closePlan, markTasksReviewed, reconcileState, rollForward, abandonPlan } from "./state.ts";
import type { TaskPlanModelSwitchState } from "./model-switch.ts";
import type { PlanDocument, PlanMetadata, PlanStage, SectionName, TaskBlock, ValidationIssue } from "./types.ts";
import { validateFrontmatter, validatePlan, validateProgress, validateSections, validateTasks, validateWhatWhy } from "./validators.ts";
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
      const doc = await createPlanSkeleton(this.cwd, goal.trim(), titleOverride);
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
    if (reconciled.conflict) return conflict(reconciled.conflict);
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
    if (section === "tasks" && !preservesExecutionState(loaded.sections.tasks, params.content)) return conflict("reserved_execution_state_changed: Tasks editing cannot add, modify or delete execution records/notes");
    const candidateIssues = validateCandidate(section, params.content, loaded.metadata).issues;
    if (candidateIssues.some((i) => i.severity === "error")) return validation("Section validation failed", candidateIssues);
    let text = replaceSection(loaded.text, section, params.content);
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

  async advance(params: { expected_document_hash: string; action?: "next" | "approve_contract" | "execute" | "next_round" | "complete"; reason?: string; planPath?: string }): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath);
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    const reconciled = reconcileState(loaded);
    if (reconciled.changed) return this.persistStateChange(loaded, reconciled.text, reconciled.reason);
    if (loaded.metadata.stage_status === "drafting") return validation("Drafting content cannot be advanced; submit or review it first", []);
    let metadata: PlanMetadata;
    let authorityAction: AuthorityAction;
    if (loaded.metadata.stage === "what_why") {
      const v = validateWhatWhy(loaded.sections.what_why); if (!v.ok) return validation("What / Why validation failed", v.issues);
      authorityAction = "approve_what_why";
      metadata = approveWhatWhy(loaded.metadata, loaded.sections.what_why);
    } else if (loaded.metadata.stage === "plan") {
      if (!loaded.metadata.approved_what_why_hash) return validation("What / Why is not approved", []);
      const v = validatePlan(loaded.sections.plan, loaded.metadata.round); if (!v.ok) return validation("Plan validation failed", v.issues);
      authorityAction = "approve_plan";
      metadata = approvePlan(loaded.metadata, loaded.sections.plan);
    } else if (loaded.metadata.stage === "awaiting_execution_approval") {
      const v = this.executionReadiness(loaded); if (!v.ok) return validation("Execution readiness validation failed", v.issues);
      if (params.action === "execute") {
        if (loaded.metadata.approved_contract_hash !== phaseExecutionDefinitionHash(loaded)) return validation("contract_approval_required: approve the detailed contract separately", []);
        authorityAction = "authorize_execution";
        metadata = authorizeExecution(loaded.metadata);
      } else if (!params.action || params.action === "next" || params.action === "approve_contract") {
        authorityAction = "approve_contract";
        metadata = { ...loaded.metadata, approved_contract_hash: phaseExecutionDefinitionHash(loaded) };
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
    return this.authorizedWrite(loaded, replaceFrontmatter(loaded.text, metadata), `Advanced to ${metadata.stage}`, authorityAction);
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
    if (!preservesExecutionState(loaded.sections.tasks, nextTasks)) return conflict("reserved_execution_state_changed: Review cannot add, modify or delete execution records/notes");
    const v = validateTasks(nextTasks, loaded.metadata.round, { requireCurrentOpen: true, historicalCompleted: true });
    if (!v.ok) return validation("Tasks review failed", v.issues);
    const mapping = validatePlanNodeMapping(loaded.sections.plan, nextTasks, {currentNodeId:currentRoundTasks(nextTasks,loaded.metadata.round)[0]?.id}).filter(i=>i.severity === "error");
    if (mapping.length) return validation("Plan/Tasks contract mapping failed", mapping);
    const runtime = this.sessionState.phaseDependencies?.evidence;
    if (!runtime) return validation("capability_unavailable: trusted reviewer and receipt signer required", []);
    try {
      let text = replaceSection(loaded.text, "tasks", nextTasks);
      const candidate = {...loaded,text,sections:{...loaded.sections,tasks:nextTasks}};
      const summaries: string[] = [];
      let passed = true;
      for (const task of currentRoundTasks(nextTasks,loaded.metadata.round)) {
        const risk = effectiveNodeRisk(task,runtime);
        const reviewer = runtime.reviewer ?? (risk === "low" ? configureReviewAuthority({signer:runtime.signer,session_id:`controller-structural:${runtime.implementer_session_id}`,implementer_session_id:runtime.implementer_session_id,fresh:false,run:async()=>({review_type:"deterministic",result:"passed",summary:"Task structure and Plan mapping passed deterministic validation",evidence_refs:["task-plan:structural-review/v1"]})}) : undefined);
        if (!reviewer) return validation("capability_unavailable: fresh independent review required for unknown/medium/high risk", []);
        const evidence = await runReview(reviewer,{node_id:task.id,contract_hash:nodeContractHash(candidate,task.id),risk});
        authenticateReviewEvidence(evidence,runtime.signer,{node_id:task.id,contract_hash:nodeContractHash(candidate,task.id),risk,implementer_session_id:runtime.implementer_session_id});
        text = writeReviewEvidence(text,task.id,evidence);
        summaries.push(`${task.id}: ${evidence.receipt.result} — ${evidence.receipt.summary}`);
        passed &&= evidence.receipt.result === "passed";
      }
      // Model summaries are candidate commentary; only the configured review result is authoritative.
      text = replaceSection(text,"review",upsertReview(loaded.sections.review,loaded.metadata.round,summaries.join("\n\n")));
      const metadata = parseFrontmatter(text).metadata;
      if (passed) text = replaceFrontmatter(text,markTasksReviewed(metadata,nextTasks));
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
      const next = await readPlanDocument(loaded.path);
      const active = Object.values(inspectPhaseRecords(next.sections.tasks).records).find((r) => !r.finalized && r.context.round === next.metadata.round && (!params.task_id || r.context.phase_id === params.task_id));
      if (active) {
        this.sessionState.phaseTaskId = active.context.phase_id;
        await this.bindTask({ expected_document_hash: next.document_hash, task_id: active.context.phase_id, planPath: next.path });
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

  async reportTaskResults(params: { task_id: string; reports: Array<Omit<Parameters<TaskPlanService["reportTaskResult"]>[0], "task_id">> }): Promise<PlanOperationResult> {
    const results: PlanOperationResult[] = [];
    for (const report of params.reports) {
      const result = await this.reportTaskResult({ ...report, task_id: params.task_id });
      results.push(result);
      if (result.status !== "applied" && result.status !== "ok") return { ...result, message: `Batch report stopped after ${results.length} item(s)` };
    }
    const last = results[results.length - 1];
    return last ? { ...last, message: `Batch reported ${results.length} item(s)` } : validation("At least one report is required", []);
  }

  async setTaskStatus(params: { expected_document_hash: string; task_id: string; status: "open" | "completed"; planPath?: string }): Promise<PlanOperationResult> {
    const loaded = await this.load(params.planPath, params.status === "open");
    if ("status" in loaded) return loaded;
    if (loaded.document_hash !== params.expected_document_hash) return conflict("stale_document_hash");
    const task = currentRoundTasks(loaded.sections.tasks, loaded.metadata.round).find((candidate) => candidate.id === params.task_id);
    if (!task) return validation(`Task ${params.task_id} is not in current round`, []);
    if (params.status === "completed" && loaded.metadata.stage !== "executing") return validation("Human completion requires executing stage", []);
    if (params.status === "open" && !["executing", "awaiting_round_decision"].includes(loaded.metadata.stage)) return validation("Human reopen requires executing or awaiting_round_decision stage", []);
    if (params.status === "completed") return this.finalizePhase(params);
    try { assertReopenRecoverable(loaded,task.id); } catch(error) { return validation(String((error as Error).message),[]); }
    // Reopening invalidates all previous evidence, but preserves execution identity/baseline.
    let definition = task.definition.replace(/^(### T\d{3} — .+?) \[(?: |x|X)\]$/m, "$1 [ ]")
      .replace(/^([ \t]*- )\[(?: |x|X)\]/gm, "$1[ ]")
      .replace(/^([ \t]*- .+?) \[(?: |x|X)\]([ \t]*)$/gm, "$1 [ ]$2");
    const record = inspectPhaseRecords(definition).records[task.id];
    if (record) {
      delete record.finalized;
      delete record.last_finalize;
      record.acceptance = [];
      record.verification = [];
      definition = upsertPhaseRecord(definition, task.id, record);
      for (const work of task.workItems) definition = upsertExecutionNote(definition, work.id, { version: 1, status: "in_progress", summary: "Reopened by Human; previous evidence invalidated", files: [], change_types: [] });
    }
    const tasks = loaded.sections.tasks.replace(task.definition, definition);
    const text = replaceFrontmatter(replaceSection(loaded.text, "tasks", tasks), { ...loaded.metadata, stage: "executing", stage_status: "in_progress" });
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
    const path = planPath ? resolvePath(this.cwd, planPath) : await this.defaultPlanPath();
    if (!path) return conflict("No unfinished Harness Plan found");
    try {
      const doc = await readPlanDocument(path);
      this.sessionState.currentPlanPath = doc.path;
      const reconciled = reconcileState(doc);
      if (reconciled.conflict && !allowCompletionConflict) return conflict(reconciled.conflict);
      return doc;
    }
    catch (error) { return conflict(String((error as Error).message ?? error)); }
  }

  private async defaultPlanPath(): Promise<string | undefined> {
    if (this.sessionState.currentPlanPath) return this.sessionState.currentPlanPath;
    const unfinished = await findUnfinishedHarnessPlans(this.cwd);
    return unfinished.length === 1 ? unfinished[0] : undefined;
  }

  private async persistStateChange(loaded: PlanDocument, text: string, reason?: string): Promise<PlanOperationResult> { return this.write(loaded, text, `State changed during reconciliation: ${reason}` as string, "state_changed"); }

  private executionReadiness(document: PlanDocument) {
    const result = validateExecutionReadiness(document);
    try {
      for (const task of currentRoundTasks(document.sections.tasks,document.metadata.round).filter(t=>!t.completed)) {
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
      const receipt = await consumeDocumentAuthority(loaded, this.takeCapability(), action, nodeId);
      return this.write(loaded, appendAuthorization(text, receipt), message);
    } catch (error) { return validation(String((error as Error).message), []); }
  }

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
    ...validatePlanNodeMapping(document.sections.plan,document.sections.tasks,{currentNodeId:currentRoundTasks(document.sections.tasks,document.metadata.round)[0]?.id}),
    ...validateTasks(document.sections.tasks, document.metadata.round, { historicalCompleted: true }).issues,
  ];
  if (!document.metadata.approved_what_why_hash || document.metadata.approved_what_why_hash !== canonicalSectionHash(document.sections.what_why)) issues.push({ severity: "error" as const, code: "what_why_not_approved", message: "What / Why hash is not approved" });
  if (!document.metadata.approved_plan_hash || document.metadata.approved_plan_hash !== canonicalSectionHash(document.sections.plan)) issues.push({ severity: "error" as const, code: "plan_not_approved", message: "Plan hash is not approved" });
  if (!document.metadata.reviewed_tasks_hash || document.metadata.reviewed_tasks_hash !== canonicalTasksDefinitionHash(document.sections.tasks)) issues.push({ severity: "error" as const, code: "tasks_not_reviewed", message: "Tasks hash is not reviewed" });
  return { ok: issues.every((i) => i.severity !== "error"), issues };
}

function upsertReview(existing: string, round: number, summary: string): string {
  const heading = `### R${String(round).padStart(3, "0")} — Current Stage Task Review`;
  const entry = `${heading}\n\n${summary.trim()}`;
  const re = new RegExp(`^${escapeRegExp(heading)}[\\s\\S]*?(?=^### R\\d{3} — T\\+0 Task Review|$)`, "m");
  return re.test(existing) ? existing.replace(re, entry) : `${existing.trim() === "Not run." ? "" : existing.trim() + "\n\n"}${entry}`;
}

function hasFutureHorizon(plan: string): boolean { return /^### T(?:00[2-9]|0[1-9]\d|[1-9]\d{2}) — /m.test(plan); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function snapshot(document: PlanDocument, binding?: TaskBinding) {
  return {
    path: document.path,
    document_hash: document.document_hash,
    metadata: document.metadata,
    sections: document.sections,
    nodes: readPlanNodes(document.sections.plan, document.sections.tasks),
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
