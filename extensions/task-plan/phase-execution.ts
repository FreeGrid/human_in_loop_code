import { beginPlanOperation, recordOperationFailure, type OperationContext } from "./operation-journal.ts";
import { validatePlanNodeMapping } from "./nodes.ts";
import { assertVerificationEvidence, authenticateVerificationEvidence, manualAcceptanceContext, runManualAcceptance, runVerification, sealFinalizeEvidence, verifyArtifactContents, type ManualVerificationAuthority, type VerificationInput } from "./evidence.ts";
import { authenticateFinalizedNode, dependencyFinalizations, nodeContractHash, requireNodeReview, verificationInputFor } from "./receipt-state.ts";
import { appendAuthorization, consumeDocumentAuthority, documentAuthorityContext } from "./authority-context.ts";
import { canonicalJson, type AuthorizationReceipt, type HumanCapability } from "./authority.ts";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";
import { inspectExecutionNotes, upsertExecutionNote, validateExecutionNote, type ExecutionNote } from "./execution-notes.ts";
import { type PhaseDependencies, type PhaseRecord } from "./phase-contracts.ts";
import { inspectPhaseRecords, upsertPhaseRecord, validatePhaseRecord } from "./phase-record.ts";
import { acquirePhaseFinalizeLock, canonicalSectionHash, canonicalTasksDefinitionHash, executionDefinitionHash, readPlanDocument, replaceFrontmatter, writeIfDocumentHash } from "./plan-file.ts";
import { replaceLogicalSection } from "./plan-domain.ts";
import { selectedNode, requireNodeApproval } from "./node-approval.ts";
import { parseTasks } from "./tasks.ts";
import type { PlanDocument, TaskBlock } from "./types.ts";
import type { PlanOperationResult } from "./operation-result.ts";
import { validateFrontmatter, validateTasks } from "./validators.ts";

const exec = promisify(execFile);
const fail = (message: string): never => { throw new Error(message); };
const SWITCH_HELP = "DocSync: /docsync off · /docsync on. Human may also explicitly say ‘turn off DocSync’ or ‘turn on DocSync’.";
type PhaseWriteOptions = {operation?:OperationContext;completion?:"success"|"blocked_projection"};
type Report = { task_id: string; work_item_id?: string; result: "in_progress" | "blocked" | "completed"; summary: string; files?: string[]; change_types?: ExecutionNote["change_types"]; acceptance_results?: Array<{ item: string; satisfied: boolean }> };

/** Plan owns progress; providers own only baseline/runtime facts and the documentation decision. */
export class PhaseExecutionService {
  constructor(private readonly dependencies: PhaseDependencies = {}) {}

  async start(document: PlanDocument, params: { task_id?: string; target_root?: string; governance_root?: string; decision?: HumanCapability }): Promise<PlanOperationResult> {
    let starting: OperationContext | undefined;
    return this.operation(document, async () => {
      const d = await this.current(document);
      const { task, records } = this.select(d, params.task_id);
      let record = records[task.id];
      if (record) {
        await this.verify(d, task, record);
        if (params.target_root && await realpath(params.target_root) !== record.context.target_root) fail("root_mismatch: target root differs from original execution");
        if (params.governance_root && await realpath(params.governance_root) !== record.context.governance_root) fail("root_mismatch: governance root differs from original execution");
        return { status: "ok", path: d.path, document_hash: d.document_hash, message: `Resumed ${task.id}, execute ${record.context.execute_id}; DocSync ${record.docsync.enabled ? "on" : "off"}. ${SWITCH_HELP}`, snapshot: record };
      }
      const receipt = await consumeDocumentAuthority(d, params.decision, "execute", task.id, params,this.dependencies.evidence);
      const authorization = { ...receipt.provenance, action: "execute" as const };
      if (!params.target_root || !params.governance_root) fail("roots_required: explicitly supply target Git root and governance root");
      if (![params.target_root, params.governance_root].every(p => typeof p === "string" && isAbsolute(p))) fail("invalid_roots: explicitly supply absolute roots");
      if (task.workItems.some(w => w.note)) fail("baseline_missing: existing progress cannot acquire a replacement baseline");
      const context = { execute_id: randomUUID(), phase_id: task.id, round: d.metadata.round, plan_path: await realpath(d.path), target_root: await realpath(params.target_root!), governance_root: await realpath(params.governance_root!) };
      await this.roots(context);
      const provider = this.dependencies.baseline ?? fail("capability_unavailable: BaselineProvider is not configured");
      starting = await beginPlanOperation(d,{kind:"phase_start",node_id:task.id,execute_id:context.execute_id,target_root:context.target_root,governance_root:context.governance_root,authority_ref:receipt.receipt_hash,contract_hash:this.contract(d,task.id)});
      const baseline = await provider.capture({ ...context });
      record = { version: 1, implementer_session_id: this.dependencies.evidence!.implementer_session_id, verification: [], context, definition_hash: this.contract(d, task.id), baseline, authorization, docsync: { enabled: true }, acceptance: [] };
      if (!validatePhaseRecord(record)) fail("baseline_invalid: provider returned an invalid baseline reference");
      await this.verify(d, task, record);
      const saved = await this.save(d, upsertPhaseRecord(d.sections.tasks, task.id, record), `Started ${task.id}, execute ${context.execute_id}; DocSync on. ${SWITCH_HELP}`, record, receipt,{operation:starting});
      if(saved.status !== "applied") {
        if(saved.message.includes("operation_recovery_required")) return {...saved,operation_id:starting.operation_id};
        await recordOperationFailure(starting,{code:"phase_start_not_committed",checkpoint:"after_capture",side_effects_possible:true});
        return {...saved,operation_id:starting.operation_id,message:`${saved.message}; operation_recovery_required: captured baseline is preserved`};
      }
      return saved;
    },async message=>{
      if(!starting)return undefined;
      if(message.includes("operation_recovery_required"))return {status:"conflict",path:document.path,operation_id:starting.operation_id,message};
      await recordOperationFailure(starting,{code:"phase_start_failed",checkpoint:"capture_or_save",side_effects_possible:true});
      return {status:"conflict",path:document.path,operation_id:starting.operation_id,message:`${message}; operation_recovery_required: inspect the original capture attempt`};
    });
  }

  async report(document: PlanDocument, params: Report): Promise<PlanOperationResult> {
    return this.operation(document, async () => {
      const d = await this.current(document);
      const { task, records } = this.select(d, params.task_id);
      const record = records[task.id] ?? fail("execution_missing: start the phase before reporting");
      await this.verify(d, task, record);
      const itemId = params.work_item_id ?? (task.workItems.length === 1 ? task.workItems[0]!.id : fail("work_item_required: select a stable work_item_id"));
      if (!task.workItems.some(w => w.id === itemId)) fail("unknown_work_item");
      const note: ExecutionNote = { version: 1, status: params.result === "completed" ? "pending_finalize" : params.result, summary: params.summary, files: params.files ?? [], change_types: params.change_types ?? [] };
      if (!validateExecutionNote(note)) fail("invalid_execution_note");
      if (params.acceptance_results !== undefined) fail("candidate_evidence_only: model Acceptance booleans cannot issue verification evidence");
      delete record.last_finalize;
      // The note helper sees only task definitions and notes, never phase-record JSON.
      const phases = inspectPhaseRecords(d.sections.tasks);
      let markdown = upsertExecutionNote(phases.definition, itemId, note);
      phases.records[task.id] = record;
      for (const [id, r] of Object.entries(phases.records)) markdown = upsertPhaseRecord(markdown, id, r);
      return this.save(d, markdown, `${itemId}: ${note.status}; completion markers unchanged`, record);
    });
  }

  /** Model-facing callers supply IDs only; the trusted runtime resolves the approved command. */
  async verifyAcceptance(document: PlanDocument, task_id: string, acceptance_id: string): Promise<PlanOperationResult> {
    return this.operation(document, async () => {
      const d = await this.current(document);
      const { task, records } = this.select(d, task_id);
      const record = records[task.id] ?? fail("execution_missing");
      const version = await this.verify(d, task, record);
      if (!task.acceptance.some(item => item.id === acceptance_id)) fail("unknown_acceptance");
      const runtime = this.dependencies.evidence ?? fail("capability_unavailable: trusted evidence runtime is required");
      const producer = runtime.verificationAuthority ?? fail("capability_unavailable: trusted verification authority is not configured");
      const request = verificationInputFor(d, task.id, acceptance_id, version,this.dependencies.evidence);
      if (request.command_or_method === "manual") fail("manual_gate_requires_human: use the explicit Human acceptance adapter");
      const handle = await producer(Object.freeze(structuredClone(request)), Object.freeze(structuredClone(record.context)));
      const evidence = await runVerification(handle, request);
      const receipt = authenticateVerificationEvidence(evidence, runtime.signer, request);
      await verifyArtifactContents(receipt);
      await this.current(d);
      if (await this.verify(d, task, record) !== version) fail("acceptance_stale: repository changed during verification");
      record.verification = [...(record.verification ?? []).filter(entry => entry.receipt.acceptance_id !== acceptance_id), evidence];
      delete record.last_finalize;
      const saved = await this.save(d, upsertPhaseRecord(d.sections.tasks, task.id, record), `${acceptance_id}: verification ${receipt.result}; completion markers unchanged`, record);
      return receipt.result === "passed" || saved.status !== "applied" ? saved : { ...saved, status: "validation_error", message: `${acceptance_id}: verification_not_passed; failed evidence saved` };
    });
  }

  /** Read-only preparation for a concrete Human manual-acceptance prompt. */
  async prepareManualAcceptance(document: PlanDocument, task_id: string, acceptance_id: string): Promise<VerificationInput> {
    const d = await this.current(document);
    const { task, records } = this.select(d, task_id);
    const record = records[task.id] ?? fail("execution_missing");
    const version = await this.verify(d, task, record);
    const request = verificationInputFor(d, task.id, acceptance_id, version,this.dependencies.evidence);
    if (request.command_or_method !== "manual") fail("manual_gate_not_in_contract");
    return request;
  }

  /** Trusted Human adapter only: the opaque handle fixes the displayed item before confirmation. */
  async acceptManual(document: PlanDocument, task_id: string, authority: ManualVerificationAuthority, capability: HumanCapability): Promise<PlanOperationResult> {
    return this.operation(document, async () => {
      const d = await this.current(document);
      const { task, records } = this.select(d, task_id);
      const record = records[task.id] ?? fail("execution_missing");
      const version = await this.verify(d, task, record);
      const runtime = this.dependencies.evidence ?? fail("capability_unavailable: trusted evidence runtime is required");
      const { evidence, authorization } = runManualAcceptance(authority, capability);
      const expected = verificationInputFor(d, task.id, evidence.receipt.acceptance_id, version,this.dependencies.evidence);
      if (expected.command_or_method !== "manual") fail("manual_gate_not_in_contract");
      const expectedContext = manualAcceptanceContext(await documentAuthorityContext(d, task.id,{},this.dependencies.evidence), { approved_input: expected, actual: evidence.receipt.actual, artifact_refs: evidence.receipt.artifact_refs });
      if (canonicalJson(authorization.context) !== canonicalJson(expectedContext)) fail("manual_authorization_context_mismatch");
      const receipt = assertVerificationEvidence(evidence, runtime.signer, expected);
      if (receipt.authorization_ref !== authorization.receipt_hash) fail("manual_authorization_reference_mismatch");
      await verifyArtifactContents(receipt);
      await this.current(d);
      if (await this.verify(d, task, record) !== version) fail("acceptance_stale: repository changed during manual verification");
      record.verification = [...(record.verification ?? []).filter(entry => entry.receipt.acceptance_id !== receipt.acceptance_id), evidence];
      delete record.last_finalize;
      return this.save(d, upsertPhaseRecord(d.sections.tasks, task.id, record), `${receipt.acceptance_id}: Human manual verification passed; completion markers unchanged`, record, authorization);
    });
  }

  async setDocSync(document: PlanDocument, task_id: string, enabled: boolean, decision?: HumanCapability): Promise<PlanOperationResult> {
    return this.operation(document, async () => {
      if (typeof enabled !== "boolean") fail("invalid_docsync_switch");
      const d = await this.current(document);
      const { task, records } = this.select(d, task_id);
      const record = records[task.id] ?? fail("execution_missing");
      await this.verify(d, task, record);
      const receipt = await consumeDocumentAuthority(d, decision, enabled ? "docsync_on" : "docsync_off", task.id,{},this.dependencies.evidence);
      record.docsync = { enabled, decision: { ...receipt.provenance, action: enabled ? "docsync_on" : "docsync_off" } };
      delete record.last_finalize;
      return this.save(d, upsertPhaseRecord(d.sections.tasks, task.id, record), `DocSync ${enabled ? "on" : "off"}. ${SWITCH_HELP}`, record, receipt);
    });
  }

  async finalize(document: PlanDocument, task_id: string, decision?: HumanCapability): Promise<PlanOperationResult> {
    return this.operation(document, async () => {
      const release = await acquirePhaseFinalizeLock(document.path, task_id);
      try {
        const current = await this.current(document);
        const receipt = await consumeDocumentAuthority(current, decision, "finalize", task_id,{},this.dependencies.evidence);
        return await this.finalizeLocked(current, task_id, receipt);
      } finally { await release(); }
    });
  }

  private async finalizeLocked(document: PlanDocument, task_id: string, authorization: AuthorizationReceipt): Promise<PlanOperationResult> {
    let attempt: { document: PlanDocument; record: PhaseRecord } | undefined;
    let operation: OperationContext | undefined;
    return this.operation(document, async () => {
      const d = await this.current(document);
      const { task, records } = this.select(d, task_id);
      const record = records[task.id] ?? fail("execution_missing");
      attempt = { document: d, record: structuredClone(record) };
      const version = await this.verify(d, task, record);
      if (task.workItems.some(w => w.note?.status !== "pending_finalize")) fail("work_pending: every work item must be pending_finalize");
      const runtime = this.dependencies.evidence ?? fail("capability_unavailable: trusted evidence runtime is required");
      const review = requireNodeReview(d, task.id, runtime);
      const dependencies = dependencyFinalizations(d, task.id, runtime);
      const verification = [];
      for (const item of task.acceptance) {
        const evidence = record.verification?.find(entry => entry.receipt.acceptance_id === item.id) ?? fail("acceptance_incomplete: every Acceptance requires a trusted verification receipt");
        const receipt = assertVerificationEvidence(evidence, runtime.signer, verificationInputFor(d, task.id, item.id, version,this.dependencies.evidence));
        await verifyArtifactContents(receipt);
        verification.push(receipt);
      }
      if (await this.verify(d, task, record) !== version) fail("acceptance_stale: repository changed while checking verification artifacts");
      operation = await beginPlanOperation(d,{kind:"phase_finalize",node_id:task.id,execute_id:record.context.execute_id,baseline_id:record.baseline.id,target_root:record.context.target_root,governance_root:record.context.governance_root,authority_ref:authorization.receipt_hash,contract_hash:nodeContractHash(d,task.id,this.dependencies.evidence),content_version:version});
      let finalized: NonNullable<PhaseRecord["finalized"]>;
      if (!record.docsync.enabled) {
        finalized = { check: "skipped", summary: "Documentation check explicitly disabled by Human; Task Acceptance verified.", content_version: version, debt_refs: [], human_exceptions: [] };
      } else {
        const gate = this.dependencies.docsync ?? fail("capability_unavailable: DocSyncGate is not configured; no completion written");
        const notes: Record<string, ExecutionNote> = {};
        for (const w of task.workItems) notes[w.id] = w.note!;
        const result = await gate.check(structuredClone({ context: record.context, baseline: record.baseline, content_version: version, notes }));
        if (!result || result.status === "blocked") throw new Error(`docsync_blocked: ${result?.summary ?? "missing gate result"}`);
        if (Object.keys(result).sort().join(",") !== "debt_refs,human_exceptions,status,summary,verified_version") fail("invalid_docsync_result");
        finalized = { check: result.status, summary: result.summary, content_version: result.verified_version, debt_refs: result.debt_refs, human_exceptions: result.human_exceptions };
      }
      record.finalized = finalized;
      delete record.last_finalize;
      if (!validatePhaseRecord(record)) fail("invalid_docsync_result: malformed result or missing durable debt/exception references");
      // Documentation edits invalidate pre-gate Acceptance; they must be actually reverified.
      const after = await this.verify(d, task, { ...record, finalized: undefined });
      if (after !== version) fail("acceptance_stale_after_docsync: documentation changed verified content; rerun every Acceptance");
      if (after !== finalized.content_version) fail("content_changed: repository changed after documentation verification");
      for (const receipt of verification) await verifyArtifactContents(receipt);
      finalized.evidence = sealFinalizeEvidence(runtime.signer, { plan_id: d.metadata.plan_id, node_id: task.id, contract_hash: nodeContractHash(d, task.id,this.dependencies.evidence), content_version: after, verification_refs: verification.map(receipt => receipt.receipt_hash), review_ref: review.receipt_hash, dependency_refs: dependencies, authorization_ref: authorization.receipt_hash, docsync_check: finalized.check });
      if (!validatePhaseRecord(record)) fail("invalid_finalize_evidence");
      await this.current(d); // Recheck Plan contract and document version after asynchronous gate work.
      let markdown = inspectPhaseRecords(d.sections.tasks).definition;
      const start = markdown.indexOf(task.completionLine);
      const tail = markdown.slice(start + task.completionLine.length);
      const next = tail.search(/^### T\d{3} — /m);
      const end = next < 0 ? markdown.length : start + task.completionLine.length + next;
      const block = markdown.slice(start, end).split("\n");
      let field = "";
      const completed = block.map((line, i) => {
        if (i === 0) return line.replace(/ \[ \]$/, " [x]");
        if (/^#### /.test(line)) field = line.trimEnd();
        if (field === "#### Tasks" && /^[ \t]*- .+ \[ \][ \t]*$/.test(line)) return line.replace(/ \[ \]([ \t]*)$/, " [x]$1");
        if (field === "#### Acceptance" && /^[ \t]*- \[ \] /.test(line)) return line.replace("- [ ] ", "- [x] ");
        return line;
      }).join("\n");
      markdown = markdown.slice(0, start) + completed + markdown.slice(end);
      records[task.id] = record;
      for (const [id, r] of Object.entries(records)) markdown = upsertPhaseRecord(markdown, id, r);
      const completedTask = parseTasks(markdown).find(item => item.id === task.id);
      if (!completedTask?.completed || completedTask.workItems.some(item => !item.completed) || completedTask.acceptance.some(item => !item.completed) || (d.metadata.identity_policy !== "node-v1" && canonicalTasksDefinitionHash(markdown) !== d.metadata.reviewed_tasks_hash) || !validateTasks(markdown, d.metadata.round).ok) fail("incomplete_batch: refusing a partial or definition-changing completion write");
      const allDone = parseTasks(markdown).filter(t => t.round === d.metadata.round).every(t => t.completed);
      let text = replaceLogicalSection(d, "tasks", markdown);
      text = replaceFrontmatter(text, { ...d.metadata, stage: allDone ? "awaiting_round_decision" : d.metadata.identity_policy === "node-v1" ? "tasks" : "executing", stage_status: allDone ? "awaiting_human" : d.metadata.identity_policy === "node-v1" ? "ready_for_review" : "in_progress", ...(d.metadata.identity_policy === "node-v1" ? {selected_node:undefined,pending_node:undefined} : {}) });
      // No implicit next-phase start. One CAS contains every target checkbox and the receipt.
      const finalVersion = await this.dependencies.baseline!.verify(structuredClone(record.context), structuredClone(record.baseline));
      if (finalVersion !== finalized.content_version) fail("content_changed: repository changed before completion write");
      return this.write(d, appendAuthorization(text, authorization), `${task.id} finalized: ${finalized.check}${finalized.debt_refs.length ? `; debt: ${finalized.debt_refs.join(", ")}` : ""}${finalized.human_exceptions.length ? `; Human exceptions: ${finalized.human_exceptions.join(", ")}` : ""}. ${allDone ? "Awaiting Human round decision." : "Other phases remain open."}`, record,{operation});
    }, async message => {
      if (message.includes("operation_recovery_required")) return {status:"conflict",path:document.path,operation_id:operation?.operation_id,message};
      if (!attempt) return undefined;
      if (operation) await recordOperationFailure(operation,{code:"phase_finalize_failed",checkpoint:"gate_or_finalize",side_effects_possible:attempt.record.docsync.enabled});
      const { document: d, record } = attempt;
      // Only append failure evidence to the same inspected Plan version. Never persist
      // a gate-mutated receipt, replace its baseline, or overwrite a concurrent edit.
      record.last_finalize = { outcome: "blocked", summary: message.slice(0, 2000) || "Finalize failed" };
      const markdown = upsertPhaseRecord(d.sections.tasks, record.context.phase_id, record);
      const saved = await this.save(d, markdown, message, record,undefined,{operation,completion:"blocked_projection"});
      return saved.status === "applied" ? { ...saved, status: "validation_error", message } : { ...saved, message: `${message}; failure receipt not saved: ${saved.message}` };
    });
  }

  private async current(document: PlanDocument): Promise<PlanDocument> {
    const d = await readPlanDocument(document.path);
    if (d.document_hash !== document.document_hash) fail("stale_document_hash: reread the Plan");
    if (d.metadata.stage !== "executing") fail("invalid_stage: phase operations require executing");
    if (!validateFrontmatter(d).ok) fail("invalid_plan_metadata");
    const phases = inspectPhaseRecords(d.sections.tasks);
    if (phases.errors.length || !validateTasks(d.sections.tasks, d.metadata.round).ok) fail("invalid_tasks_or_phase_records");
    if (inspectExecutionNotes(phases.definition).errors.length) fail("invalid_execution_notes");
    if(d.metadata.identity_policy === "node-v1") {requireNodeApproval(d,selectedNode(d),this.dependencies.evidence);return d;}
    if (!d.metadata.approved_what_why_hash || d.metadata.approved_what_why_hash !== canonicalSectionHash(d.sections.what_why) || !d.metadata.approved_plan_hash || d.metadata.approved_plan_hash !== canonicalSectionHash(d.sections.plan) || !d.metadata.reviewed_tasks_hash || d.metadata.reviewed_tasks_hash !== canonicalTasksDefinitionHash(d.sections.tasks)) fail("stale_approval_contract: approved/reviewed definitions are required");
    return d;
  }

  private select(d: PlanDocument, id?: string): { task: TaskBlock; records: Record<string, PhaseRecord> } {
    if(d.metadata.identity_policy === "node-v1" && id && id!==selectedNode(d))fail("node_not_authorized: requested node differs from selected authority");
    id ??= d.metadata.identity_policy === "node-v1" ? selectedNode(d) : undefined;
    const tasks = parseTasks(d.sections.tasks);
    const records = inspectPhaseRecords(d.sections.tasks).records;
    const available = tasks.filter(t => t.round === d.metadata.round && !t.completed);
    const task = id ? available.find(t => t.id === id) : available.length === 1 ? available[0] : undefined;
    if (!task) fail("phase_selection_required: select one open current-round task_id");
    const mapping = validatePlanNodeMapping(d.sections.plan, d.sections.tasks, { currentNodeId: task!.id }).filter(issue => issue.severity === "error");
    if (mapping.length) fail(`plan_node_mapping_invalid: ${mapping.map(issue => issue.code).join(", ")}`);
    if (Object.values(records).some(record => !record.finalized && record.context.phase_id !== task!.id)) fail("another_phase_active: finish the original phase before starting another");
    const runtime = this.dependencies.evidence ?? fail("capability_unavailable: trusted evidence runtime is required");
    for (const t of tasks) {
      if (t.completed) {
        if (!records[t.id]?.finalized?.evidence) fail("completion_receipt_missing: handwritten completion and legacy unsealed receipts are not trusted");
        authenticateFinalizedNode(d, t.id, runtime, dependencyFinalizations(d, t.id, runtime));
      }
      if (!t.completed && (t.workItems.some(w => w.completed) || t.acceptance.some(a => a.completed) || records[t.id]?.finalized)) fail("completion_marker_conflict: only finalize may mark phase items complete");
    }
    dependencyFinalizations(d, task!.id, runtime);
    requireNodeReview(d, task!.id, runtime);
    return { task: task!, records };
  }

private contract(d: PlanDocument, nodeId: string): string {
    return d.metadata.identity_policy === "node-v1" ? nodeContractHash(d,nodeId,this.dependencies.evidence) : executionDefinitionHash(d, nodeId);
  }

  private async roots(c: PhaseRecord["context"]): Promise<void> {
    if (![c.target_root, c.governance_root, c.plan_path].every(isAbsolute)) fail("invalid_roots: canonical absolute paths required");
    for (const path of [c.target_root, c.governance_root, c.plan_path]) if (await realpath(path) !== path) fail("root_mismatch: canonical path changed");
    if (!(await stat(c.governance_root)).isDirectory()) fail("invalid_governance_root");
    const rel = relative(c.governance_root, c.plan_path);
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) fail("plan_outside_governance_root");
    const gitRoot = (await exec("git", ["-C", c.target_root, "rev-parse", "--show-toplevel"])).stdout.trim();
    if (await realpath(gitRoot) !== c.target_root) fail("target_not_git_root");
  }

  private async verify(d: PlanDocument, task: TaskBlock, record: PhaseRecord): Promise<string> {
    if (!validatePhaseRecord(record)) fail("invalid_phase_record");
    if (!record.implementer_session_id) fail("implementer_identity_missing: legacy records cannot assume the current runtime identity");
    requireNodeReview(d, task.id, this.dependencies.evidence);
    if (record.finalized) fail("already_finalized");
    if (record.definition_hash !== this.contract(d, task.id) || record.context.phase_id !== task.id || record.context.round !== d.metadata.round || record.context.plan_path !== await realpath(d.path)) fail("stale_execution_contract: original phase binding changed");
    if (record.acceptance.some(a => !task.acceptance.some(item => item.id === a.id)) || record.verification?.some(e => !task.acceptance.some(item => item.id === e.receipt.acceptance_id))) fail("unknown_acceptance_record");
    await this.roots(record.context);
    const provider = this.dependencies.baseline ?? fail("capability_unavailable: BaselineProvider is not configured");
    const version = await provider.verify(structuredClone(record.context), structuredClone(record.baseline));
    if (typeof version !== "string" || !version.trim() || version.length > 500) fail("baseline_unavailable: invalid content identity");
    return version;
  }

  private async save(d: PlanDocument, tasks: string, message: string, record: PhaseRecord, receipt?: AuthorizationReceipt, options:PhaseWriteOptions = {}): Promise<PlanOperationResult> {
    const text = replaceLogicalSection(d, "tasks", tasks);
    return this.write(d, receipt ? appendAuthorization(text, receipt) : text, message, record,options);
  }
  private async write(d: PlanDocument, text: string, message: string, record: PhaseRecord,options:PhaseWriteOptions = {}): Promise<PlanOperationResult> {
    const result = await writeIfDocumentHash(d.path, d.document_hash, text,options);
    return result.ok ? { status: "applied", path: d.path, document_hash: result.document_hash, operation_id:result.operation_id, message, snapshot: record } : { status: "conflict", path: d.path, message: result.conflict,operation_id:result.operation_id,observed_document_hash:result.observed_document_hash };
  }
  private async operation(document: PlanDocument, action: () => Promise<PlanOperationResult>, onFailure?: (message: string) => Promise<PlanOperationResult | undefined>): Promise<PlanOperationResult> {
    try { return await action(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (onFailure) {
        try { const recorded = await onFailure(message); if (recorded) return recorded; }
        catch { /* Preserve the original failure; inability to save evidence never passes. */ }
      }
      return { status: "validation_error", path: document.path, message };
    }
  }
}
