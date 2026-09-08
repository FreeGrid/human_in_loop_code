import { randomUUID } from "node:crypto";
import { canonicalHash, canonicalJson, consumeHumanCapability, type AuthorityAction, type AuthorityContext, type HumanCapability } from "./authority.ts";
import { assertFinalizeEvidence, assertReviewEvidence, assertVerificationEvidence, runReview, runVerification, sealFinalizeEvidence, verificationProcessSandbox, verifyArtifactContents, type FinalizeDependencyRef, type ReceiptSigner, type ReviewAuthority, type VerificationAuthority, type VerificationInput } from "./evidence.ts";
import { runSandboxedProcess, type ExecutionSandbox, type SandboxedProcessRequest, type SandboxedProcessResult } from "./execution-sandbox.ts";
import { currentReadableTask, parseReadablePlan, renderReadablePlan, type ReadablePlan } from "./v3-format.ts";
import { readReadablePlan, writeReadablePlan, type ReadablePlanSnapshot } from "./v3-file.ts";
import { prepareReadableContract, readableContractMatches, textV3, v3Fail, type ReadableContract, type ReadableCriterion, type ReadableExecutionPolicy } from "./v3-contract.ts";
import { v3BytesHash, v3ProjectionKind, type V3ExecutionRevision, type V3Projection, type V3Runtime, type V3RuntimeSnapshot, type V3RuntimeState } from "./v3-runtime.ts";
import { assertV3Sandbox, captureV3Baseline, inspectV3Scope, v3ContentVersion } from "./v3-scope.ts";
import type { TaskPlanModelPreset } from "./model-switch.ts";

export type V3GovernedAction = "approve_contract" | "authorize_execution" | "finalize" | "recover";
export interface V3GovernedConfiguration {
  runtime: V3Runtime;
  signer: ReceiptSigner;
  implementer_session_id: string;
  policy: (plan: ReadablePlan) => ReadableExecutionPolicy | Promise<ReadableExecutionPolicy>;
  sandbox: (contract: ReadableContract) => ExecutionSandbox | Promise<ExecutionSandbox>;
  verification: (request: { contract: ReadableContract; criterion: ReadableCriterion; input: VerificationInput; sandbox: ExecutionSandbox }) => VerificationAuthority | Promise<VerificationAuthority>;
  /** Trusted host must honor the optional model request when launching its independent reviewer. */
  reviewer: (request: { contract: ReadableContract; verification_refs: string[]; content_version: string; implementer_session_id: string; model?: TaskPlanModelPreset }) => ReviewAuthority | Promise<ReviewAuthority>;
}
export interface V3GovernedStatus {
  mode: "optional_governed";
  stage: V3ExecutionRevision["stage"] | "not_prepared";
  contract: ReadableContract | null;
  revision_id: string | null;
  execute_id: string | null;
  projection: V3Projection["status"] | null;
  ordinary_completed_ids: string[];
  /** Authenticated governed receipts only; ordinary checkboxes never populate this list. */
  verified_completed_ids: string[];
}
export class V3Governed {
  readonly #config: V3GovernedConfiguration;
  constructor(config: V3GovernedConfiguration) { textV3(config.implementer_session_id, 256); this.#config = { ...config }; }
  get planPath(): string { return this.#config.runtime.plan_path; }
  private async source(): Promise<ReadablePlanSnapshot> {
    const source = await readReadablePlan(this.#config.runtime.plan_path);
    if (source.path !== this.#config.runtime.plan_path) v3Fail("plan_path_changed"); return source;
  }
  private async unchanged(source: ReadablePlanSnapshot): Promise<void> { if ((await this.source()).document_hash !== source.document_hash) v3Fail("plan_cas_conflict"); }
  private active(state: V3RuntimeState, plan: ReadablePlan, requireCurrent = true): V3ExecutionRevision {
    const revision = state.revisions.find(item => item.revision_id === state.active_revision) ?? v3Fail("contract_not_prepared");
    if (revision.implementer_session_id !== this.#config.implementer_session_id) v3Fail("execution_session_changed_requires_revision");
    if (state.invalidated_revisions.includes(revision.revision_id) || !readableContractMatches(plan, revision.contract)) v3Fail("contract_revision_required");
    if (requireCurrent && currentReadableTask(plan)?.id !== revision.contract.node_id) v3Fail("current_task_changed");
    return revision;
  }
  private async bound(snapshot: V3RuntimeSnapshot, source: ReadablePlanSnapshot, save: (state: V3RuntimeState, expected: V3RuntimeSnapshot) => Promise<V3RuntimeSnapshot>): Promise<{ state: V3RuntimeState; revision: V3ExecutionRevision }> {
    const state = snapshot.state ?? v3Fail("runtime_missing");
    if (state.plan_id !== source.plan.plan_id) v3Fail("runtime_plan_mismatch");
    if (state.projection?.status === "pending") v3Fail("projection_recovery_required");
    const priorRevocations = state.invalidated_revisions.length;
    for (const observed of state.revisions) if (!readableContractMatches(source.plan, observed.contract) && !state.invalidated_revisions.includes(observed.revision_id)) {
      state.invalidated_revisions.push(observed.revision_id);
      if (observed.stage !== "finalized") observed.stage = "invalidated";
    }
    if (state.invalidated_revisions.length !== priorRevocations) Object.assign(snapshot, await save(state, snapshot));
    const revision = this.active(state, source.plan);
    const policy = await this.#config.policy(structuredClone(source.plan));
    if (prepareReadableContract(source.plan, policy).contract_hash !== revision.contract.contract_hash) {
      state.invalidated_revisions.push(revision.revision_id); revision.stage = "invalidated";
      Object.assign(snapshot, await save(state, snapshot)); v3Fail("policy_revision_required");
    }
    return { state, revision };
  }
  private authority(action: V3GovernedAction, source: ReadablePlanSnapshot, snapshot: V3RuntimeSnapshot, revision: V3ExecutionRevision): AuthorityContext {
    const runtime = this.#config.runtime;
    return { plan_id: source.plan.plan_id, node_id: revision.contract.node_id, document_hash: source.document_hash, contract_hash: revision.contract.contract_hash, target_root: runtime.target_root, governance_root: runtime.governance_root,
      payload_hash: canonicalHash({ action, revision_id: revision.revision_id, execute_id: revision.execute_id, ...(action === "recover" ? { state_hash: snapshot.hash, projection: snapshot.state?.projection ?? null } : {}) }) };
  }
  async context(action: V3GovernedAction): Promise<AuthorityContext> {
    if (!["approve_contract", "authorize_execution", "finalize", "recover"].includes(action)) v3Fail("unknown_governed_action");
    const inspect = async (tx: { read(): Promise<V3RuntimeSnapshot>; save(state: V3RuntimeState, expected: V3RuntimeSnapshot): Promise<V3RuntimeSnapshot> }): Promise<AuthorityContext> => {
      const source = await this.source(), snapshot = await tx.read();
      const revision = action === "recover" ? snapshot.state?.revisions.find(item => item.revision_id === (snapshot.state?.projection?.revision_id ?? snapshot.state?.active_revision)) ?? v3Fail("no_runtime_state_to_recover") : (await this.bound(snapshot, source, tx.save)).revision;
      if (action === "finalize") {
        // Present a concrete, ready action to the Human. Finalize repeats these
        // checks after confirmation so this preview cannot grant stale authority.
        const content = await this.content(revision);
        await this.dependencies(snapshot.state!, source.plan, revision);
        this.reviewRef(revision, await this.verificationRefs(revision, content));
        if (await this.content(revision) !== content) v3Fail("finalize_inputs_changed");
        await this.unchanged(source);
      }
      return this.authority(action, source, snapshot, revision);
    };
    // Recovery inspection must remain possible while a dead process owns the lock.
    if (action === "recover") return inspect({ read: () => this.#config.runtime.inspectRecovery(), save: async () => v3Fail("unexpected_recovery_mutation") });
    return this.#config.runtime.transaction(inspect);
  }
  async prepare(): Promise<V3GovernedStatus> {
    const runtime = this.#config.runtime;
    await runtime.transaction(async tx => {
      const source = await this.source(), snapshot = await tx.read();
      if (snapshot.state?.projection?.status === "pending") v3Fail("projection_recovery_required");
      const contract = prepareReadableContract(source.plan, await this.#config.policy(structuredClone(source.plan)));
      const state: V3RuntimeState = snapshot.state ? structuredClone(snapshot.state) : { version: 1, plan_path: runtime.plan_path, plan_id: source.plan.plan_id, target_root: runtime.target_root, governance_root: runtime.governance_root, revisions: [], active_revision: null, invalidated_revisions: [], projection: null, recovery: [] };
      if (state.plan_id !== source.plan.plan_id) v3Fail("runtime_plan_mismatch");
      for (const revision of state.revisions) if (!readableContractMatches(source.plan, revision.contract) && !state.invalidated_revisions.includes(revision.revision_id)) state.invalidated_revisions.push(revision.revision_id);
      const previous = state.revisions.find(item => item.revision_id === state.active_revision);
      if (previous?.implementer_session_id === this.#config.implementer_session_id && previous.contract.contract_hash === contract.contract_hash && !state.invalidated_revisions.includes(previous.revision_id) && previous.stage !== "finalized" && previous.stage !== "invalidated") {
        if (canonicalJson(state) !== canonicalJson(snapshot.state)) { await this.unchanged(source); await tx.save(state, snapshot); }
        return;
      }
      if (previous && previous.stage !== "finalized") { previous.stage = "invalidated"; if (!state.invalidated_revisions.includes(previous.revision_id)) state.invalidated_revisions.push(previous.revision_id); }
      const revision: V3ExecutionRevision = { revision_id: randomUUID(), execute_id: randomUUID(), implementer_session_id: this.#config.implementer_session_id, contract, stage: "prepared", approval: null, authorization: null, finalize_authorization: null, baseline: null, verification: [], review: null, finalized: null };
      state.revisions.push(revision); state.active_revision = revision.revision_id;
      await this.unchanged(source); await tx.save(state, snapshot);
    });
    return this.status();
  }
  async status(): Promise<V3GovernedStatus> {
    const source = await this.source();
    // Observed material changes retire evidence permanently, even if text is later restored.
    const snapshot = await this.#config.runtime.transaction(async tx => {
      const observed = await tx.read(), state = observed.state;
      if (!state) return observed;
      let changed = false;
      for (const revision of state.revisions) if (!readableContractMatches(source.plan, revision.contract) && !state.invalidated_revisions.includes(revision.revision_id)) {
        state.invalidated_revisions.push(revision.revision_id); if (revision.stage !== "finalized") revision.stage = "invalidated"; changed = true;
      }
      return changed ? tx.save(state, observed) : observed;
    });
    const state = snapshot.state;
    const active = state?.revisions.find(item => item.revision_id === state.active_revision);
    const verified: string[] = [];
    if (state) for (const task of source.plan.tasks.filter(item => item.completed)) {
      try { await this.dependency(state, source.plan, task.id, new Set()); verified.push(task.id); } catch { /* A checkbox is still ordinary completion when governed evidence is absent/stale. */ }
    }
    return { mode: "optional_governed", stage: active ? state!.invalidated_revisions.includes(active.revision_id) || !readableContractMatches(source.plan, active.contract) ? "invalidated" : active.stage : "not_prepared", contract: active ? structuredClone(active.contract) : null, revision_id: active?.revision_id ?? null, execute_id: active?.execute_id ?? null, projection: state?.projection?.status ?? null, ordinary_completed_ids: source.plan.tasks.filter(task => task.completed).map(task => task.id), verified_completed_ids: verified };
  }
  async approve(capability: HumanCapability): Promise<V3GovernedStatus> {
    await this.#config.runtime.transaction(async tx => {
      const source = await this.source(), snapshot = await tx.read(), { state, revision } = await this.bound(snapshot, source, tx.save);
      const receipt = consumeHumanCapability(capability, "approve_contract", this.authority("approve_contract", source, snapshot, revision));
      if (revision.stage !== "prepared") v3Fail("approval_transition_denied");
      revision.approval = receipt; revision.stage = "approved";
      await this.unchanged(source); await tx.save(state, snapshot);
    }); return this.status();
  }
  async authorize(capability: HumanCapability): Promise<V3GovernedStatus> {
    await this.#config.runtime.transaction(async tx => {
      const source = await this.source(), snapshot = await tx.read(), { state, revision } = await this.bound(snapshot, source, tx.save);
      const receipt = consumeHumanCapability(capability, "authorize_execution", this.authority("authorize_execution", source, snapshot, revision));
      if (revision.stage !== "approved" || !revision.approval) v3Fail("execution_authority_requires_approval");
      await this.dependencies(state, source.plan, revision);
      const sandbox = await this.#config.sandbox(structuredClone(revision.contract)); await assertV3Sandbox(this.#config.runtime, revision.contract, this.#config.signer, sandbox);
      revision.baseline = await captureV3Baseline(this.#config.runtime, revision.contract, this.#config.signer);
      revision.authorization = receipt; revision.stage = "authorized";
      await this.unchanged(source); await tx.save(state, snapshot);
    }); return this.status();
  }
  private authorized(revision: V3ExecutionRevision): void { if (revision.stage !== "authorized" || !revision.approval || !revision.authorization || !revision.baseline) v3Fail("execution_not_authorized"); }
  private input(revision: V3ExecutionRevision, criterion: ReadableCriterion, content_version: string): VerificationInput {
    return { acceptance_id: criterion.id, contract_hash: revision.contract.contract_hash, content_version, command_or_method: criterion.command_or_method, inputs: [...criterion.inputs], expected: criterion.source.quote };
  }
  private async content(revision: V3ExecutionRevision): Promise<string> { this.authorized(revision); return inspectV3Scope(this.#config.runtime, revision.contract, this.#config.signer, revision.baseline!); }
  private async dependency(state: V3RuntimeState, plan: ReadablePlan, nodeId: string, visiting: Set<string>): Promise<FinalizeDependencyRef> {
    if (visiting.has(nodeId)) v3Fail("dependency_cycle"); visiting.add(nodeId);
    const revision = [...state.revisions].reverse().find(item => item.contract.node_id === nodeId);
    if (!revision || state.invalidated_revisions.includes(revision.revision_id) || revision.stage !== "finalized" || !revision.finalized || !revision.baseline || !plan.tasks.some(task => task.id === nodeId && task.completed) || !readableContractMatches(plan, revision.contract)) v3Fail("governed_dependency_receipt_required");
    const refs: FinalizeDependencyRef[] = [];
    for (const prior of revision.contract.policy.dependencies) refs.push(await this.dependency(state, plan, prior, visiting));
    visiting.delete(nodeId);
    const receipt = assertFinalizeEvidence(revision.finalized, this.#config.signer, { plan_id: plan.plan_id, node_id: nodeId, contract_hash: revision.contract.contract_hash, dependency_refs: refs });
    const current = await captureV3Baseline(this.#config.runtime, revision.contract, this.#config.signer);
    if (v3ContentVersion(revision.contract, revision.baseline, current) !== receipt.content_version) v3Fail("dependency_evidence_stale");
    return { node_id: nodeId, finalize_hash: receipt.receipt_hash };
  }
  private async dependencies(state: V3RuntimeState, plan: ReadablePlan, revision: V3ExecutionRevision): Promise<FinalizeDependencyRef[]> {
    const result: FinalizeDependencyRef[] = [];
    for (const id of revision.contract.policy.dependencies) result.push(await this.dependency(state, plan, id, new Set([revision.contract.node_id])));
    return result;
  }
  async run(request: SandboxedProcessRequest, abortSignal?: AbortSignal): Promise<SandboxedProcessResult> {
    abortSignal?.throwIfAborted();
    return this.#config.runtime.transaction(async tx => {
      const source = await this.source(); let snapshot = await tx.read(); const { state, revision } = await this.bound(snapshot, source, tx.save);
      this.authorized(revision); await this.dependencies(state, source.plan, revision); await this.content(revision);
      const sandbox = await this.#config.sandbox(structuredClone(revision.contract)); await assertV3Sandbox(this.#config.runtime, revision.contract, this.#config.signer, sandbox);
      revision.verification = []; revision.review = null; snapshot = await tx.save(state, snapshot);
      const result = await runSandboxedProcess(sandbox, request, abortSignal);
      await this.content(revision); await this.unchanged(source);
      return result;
    });
  }
  async verify(): Promise<V3GovernedStatus> {
    await this.#config.runtime.transaction(async tx => {
      const source = await this.source(); let snapshot = await tx.read(); const { state, revision } = await this.bound(snapshot, source, tx.save);
      this.authorized(revision); await this.dependencies(state, source.plan, revision);
      const content = await this.content(revision), sandbox = await this.#config.sandbox(structuredClone(revision.contract));
      await assertV3Sandbox(this.#config.runtime, revision.contract, this.#config.signer, sandbox);
      revision.verification = []; revision.review = null; snapshot = await tx.save(state, snapshot);
      for (const criterion of revision.contract.policy.criteria) {
        const input = this.input(revision, criterion, content), verifier = await this.#config.verification({ contract: structuredClone(revision.contract), criterion: structuredClone(criterion), input: structuredClone(input), sandbox });
        if (verificationProcessSandbox(verifier) !== sandbox) v3Fail("verifier_sandbox_mismatch");
        const evidence = await runVerification(verifier, input);
        // Failed evidence is durable, but can never satisfy review/finalize.
        revision.verification.push(evidence);
        snapshot = await tx.save(state, snapshot);
        assertVerificationEvidence(evidence, this.#config.signer, input);
        if (await this.content(revision) !== content) { revision.verification = []; revision.review = null; await tx.save(state, snapshot); v3Fail("verification_inputs_changed"); }
      }
      await this.unchanged(source);
    }); return this.status();
  }
  private async verificationRefs(revision: V3ExecutionRevision, content: string): Promise<string[]> {
    if (revision.verification.length !== revision.contract.policy.criteria.length) v3Fail("verification_incomplete");
    const refs: string[] = [];
    for (const criterion of revision.contract.policy.criteria) {
      const matches = revision.verification.filter(item => item.receipt.acceptance_id === criterion.id);
      if (matches.length !== 1) v3Fail("verification_criterion_binding");
      const receipt = assertVerificationEvidence(matches[0], this.#config.signer, this.input(revision, criterion, content)); await verifyArtifactContents(receipt); refs.push(receipt.receipt_hash);
    } return refs;
  }
  async review(model?: TaskPlanModelPreset): Promise<V3GovernedStatus> {
    const requestedModel = model === undefined ? undefined : structuredClone(model);
    await this.#config.runtime.transaction(async tx => {
      const source = await this.source(); let snapshot = await tx.read(); const { state, revision } = await this.bound(snapshot, source, tx.save);
      const content = await this.content(revision); await this.dependencies(state, source.plan, revision); const refs = await this.verificationRefs(revision, content);
      revision.review = null; snapshot = await tx.save(state, snapshot);
      const reviewer = await this.#config.reviewer({ contract: structuredClone(revision.contract), verification_refs: [...refs], content_version: content, implementer_session_id: revision.implementer_session_id, ...(requestedModel === undefined ? {} : { model: requestedModel }) });
      const review = await runReview(reviewer, { node_id: revision.contract.node_id, contract_hash: revision.contract.contract_hash, risk: "high" });
      revision.review = review; snapshot = await tx.save(state, snapshot);
      this.reviewRef(revision, refs);
      if (await this.content(revision) !== content) { revision.review = null; await tx.save(state, snapshot); v3Fail("review_inputs_changed"); } await this.unchanged(source);
    }); return this.status();
  }
  private reviewRef(revision: V3ExecutionRevision, refs: string[]): string {
    const receipt = assertReviewEvidence(revision.review, this.#config.signer, { node_id: revision.contract.node_id, contract_hash: revision.contract.contract_hash, risk: "high", implementer_session_id: revision.implementer_session_id });
    if (canonicalJson([...receipt.evidence_refs].sort()) !== canonicalJson([...refs].sort())) v3Fail("review_evidence_binding");
    return receipt.receipt_hash;
  }
  async finalize(capability: HumanCapability): Promise<V3GovernedStatus> {
    await this.#config.runtime.transaction(async tx => {
      const source = await this.source(); let snapshot = await tx.read(); const { state, revision } = await this.bound(snapshot, source, tx.save);
      const authorization = consumeHumanCapability(capability, "finalize", this.authority("finalize", source, snapshot, revision));
      const content = await this.content(revision), dependencies = await this.dependencies(state, source.plan, revision), refs = await this.verificationRefs(revision, content), review_ref = this.reviewRef(revision, refs);
      if (await this.content(revision) !== content) v3Fail("finalize_inputs_changed"); await this.unchanged(source);
      revision.finalized = sealFinalizeEvidence(this.#config.signer, { plan_id: source.plan.plan_id, node_id: revision.contract.node_id, contract_hash: revision.contract.contract_hash, content_version: content, verification_refs: refs, review_ref, dependency_refs: dependencies, authorization_ref: authorization.receipt_hash, docsync_check: "skipped" });
      revision.finalize_authorization = authorization; revision.stage = "finalized";
      const candidate = structuredClone(source.plan), task = candidate.tasks.find(item => item.id === revision.contract.node_id)!;
      for (const child of task.subtasks) child.completed = true;
      task.completed = true;
      const rendered = renderReadablePlan(candidate), candidate_text = source.text.includes("\r\n") && !/(?<!\r)\n/.test(source.text) ? rendered.replace(/\n/g, "\r\n") : rendered;
      state.projection = { revision_id: revision.revision_id, source_text: source.text, source_hash: source.document_hash, candidate_text, candidate_hash: v3BytesHash(candidate_text), status: "pending" };
      // Acceptance and exact projection intent are durable before a single readable byte changes.
      snapshot = await tx.save(state, snapshot);
      await this.project(state, snapshot, tx.save);
    }); return this.status();
  }
  private async project(state: V3RuntimeState, snapshot: V3RuntimeSnapshot, save: (state: V3RuntimeState, expected: V3RuntimeSnapshot) => Promise<V3RuntimeSnapshot>): Promise<void> {
    const projection = state.projection ?? v3Fail("projection_missing"), current = await this.source();
    if (state.invalidated_revisions.includes(projection.revision_id) || projection.status === "conflict" || projection.status === "projected" && current.document_hash !== projection.candidate_hash || state.active_revision !== projection.revision_id) {
      projection.status = "conflict"; await save(state, snapshot); v3Fail("projection_cas_conflict_manual_edit_preserved");
    }
    if (current.document_hash === projection.candidate_hash) { projection.status = "projected"; await save(state, snapshot); return; }
    if (current.document_hash !== projection.source_hash) { projection.status = "conflict"; await save(state, snapshot); v3Fail("projection_cas_conflict_manual_edit_preserved"); }
    const revision = state.revisions.find(item => item.revision_id === projection.revision_id)!;
    if (v3ProjectionKind(projection, revision.contract) === "legacy_pruned") {
      projection.status = "conflict"; await save(state, snapshot); v3Fail("projection_legacy_pruning_requires_revision");
    }
    const result = await writeReadablePlan(this.#config.runtime.plan_path, projection.source_hash, parseReadablePlan(projection.candidate_text));
    if (result.document_hash !== projection.candidate_hash) v3Fail("projection_candidate_mismatch");
    await this.#config.runtime.checkpoint("projection_written");
    projection.status = "projected"; await save(state, snapshot);
  }
  async recoverProjection(capability: HumanCapability): Promise<V3GovernedStatus> {
    const source = await this.source(), observed = await this.#config.runtime.inspectRecovery();
    const revision = observed.state?.revisions.find(item => item.revision_id === (observed.state?.projection?.revision_id ?? observed.state?.active_revision)) ?? v3Fail("no_runtime_state_to_recover");
    const authorization = consumeHumanCapability(capability, "recover", this.authority("recover", source, observed, revision));
    await this.#config.runtime.transaction(async tx => {
      let snapshot = await tx.read(); if (snapshot.hash !== observed.hash || snapshot.generation !== observed.generation) v3Fail("recovery_state_changed");
      await this.unchanged(source); const state = snapshot.state!;
      if (state.projection) assertFinalizeEvidence(revision.finalized, this.#config.signer, { plan_id: source.plan.plan_id, node_id: revision.contract.node_id, contract_hash: revision.contract.contract_hash });
      state.recovery.push(authorization); snapshot = await tx.save(state, snapshot);
      if (state.projection) await this.project(state, snapshot, tx.save);
    }, true); return this.status();
  }
}
export const createV3Governed = (configuration: V3GovernedConfiguration): V3Governed => new V3Governed(configuration);
