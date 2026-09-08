import { parseStrictJson } from "./plan-text.ts";
import { canonicalHash } from "./authority.ts";
import { assertFinalizeEvidence, assertVerificationEvidence, assertReviewEvidence, type FinalizeDependencyRef, type ReceiptSigner, type ReviewAuthority, type ReviewEvidence, type Risk, type SealedEvidence, type VerificationAuthority, type VerificationInput } from "./evidence.ts";
import { canonicalTaskDefinition, parseTasks, taskField } from "./tasks.ts";
import { inspectPhaseRecords } from "./phase-record.ts";
import { parseFrontmatter, replaceFrontmatter } from "./plan-file.ts";
import type { PlanDocument, TaskBlock } from "./types.ts";
import type { PhaseContext } from "./phase-contracts.ts";

export interface VerificationMethod { command_or_method: string; inputs: string[]; expected: string }
export interface NodeEvidencePolicy { risk: Risk; verification: Record<string, VerificationMethod> }
/** These handles are configured by the trusted Controller, never by model tool arguments. */
export interface EvidenceRuntime {
  signer: ReceiptSigner;
  implementer_session_id: string;
  reviewer?: ReviewAuthority;
  minimum_risk?: Risk;
  verificationAuthority?: (request: Readonly<VerificationInput>, context: Readonly<PhaseContext>) => Promise<VerificationAuthority>;
}
const risks: Risk[] = ["low", "medium", "high", "unknown"];
function fail(message: string): never { throw new Error(message); }
const text = (s: unknown, max = 8192): s is string => typeof s === "string" && !!s.trim() && s.length <= max && !/[\u0000]|\p{Surrogate}/u.test(s);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string,unknown>, expected: string[]) => Object.keys(v).sort().join() === [...expected].sort().join();

/** Optional for legacy reading; execution verification fails closed if a method is absent. */
export function nodeEvidencePolicy(task: TaskBlock): NodeEvidencePolicy {
  const raw = taskField(inspectPhaseRecords(task.definition).definition, "Verification").trim();
  if (!raw) return { risk: "unknown", verification: {} };
  if (raw.length > 131072) fail("verification_policy_too_large");
  const value: unknown = parseStrictJson(raw);
  if (!object(value) || !keys(value,["risk","verification"]) || !risks.includes(value.risk as Risk) || !object(value.verification)) fail("invalid_verification_policy");
  const v = value as unknown as NodeEvidencePolicy;
  if (Object.keys(v.verification).length > 128) fail("too_many_verification_methods");
  for (const [id,method] of Object.entries(v.verification)) {
    if (!task.acceptance.some(a => a.id === id) || !object(method) || !keys(method,["command_or_method","inputs","expected"]) || !text(method.command_or_method) || !text(method.expected) || !Array.isArray(method.inputs) || method.inputs.length > 128 || method.inputs.some(s => !text(s))) fail("invalid_verification_method");
  }
  return v;
}
export function nodeContractHash(document: PlanDocument, nodeId: string): string {
  const task = parseTasks(document.sections.tasks).find(t => t.id === nodeId) ?? fail("unknown_contract_node");
  nodeEvidencePolicy(task); // Reject malformed policy before deriving identity.
  return canonicalHash({ plan_id: document.metadata.plan_id, node_id: nodeId, definition: canonicalTaskDefinition(task.definition) });
}
export function effectiveNodeRisk(task: TaskBlock, runtime: EvidenceRuntime): Risk {
  const declared = nodeEvidencePolicy(task).risk;
  const floor = runtime.minimum_risk ?? "unknown";
  if (!risks.includes(floor)) fail("invalid_runtime_risk_floor");
  return risks[Math.max(risks.indexOf(declared),risks.indexOf(floor))]!;
}
export function verificationInputFor(document: PlanDocument, nodeId: string, acceptanceId: string, contentVersion: string): VerificationInput {
  const task = parseTasks(document.sections.tasks).find(t => t.id === nodeId) ?? fail("unknown_contract_node");
  const method = nodeEvidencePolicy(task).verification[acceptanceId] ?? fail("verification_plan_required: every Acceptance needs an approved verification method");
  return { acceptance_id: acceptanceId, contract_hash: nodeContractHash(document,nodeId), content_version: contentVersion, ...method };
}
export function readReviewEvidence(document: PlanDocument): Record<string, SealedEvidence<ReviewEvidence>> {
  const raw = document.metadata.review_receipts;
  if (raw === undefined) return {};
  if (typeof raw !== "string" || raw.length > 1048576) fail("invalid_review_receipts");
  const value: unknown = parseStrictJson(raw);
  if (!object(value) || Object.keys(value).length > 256) fail("invalid_review_receipts");
  return value as Record<string,SealedEvidence<ReviewEvidence>>;
}
export function writeReviewEvidence(text: string, nodeId: string, evidence: SealedEvidence<ReviewEvidence>): string {
  const { metadata } = parseFrontmatter(text);
  const previous = metadata.review_receipts === undefined ? {} : parseStrictJson(String(metadata.review_receipts));
  if (!object(previous)) fail("invalid_review_receipts");
  return replaceFrontmatter(text,{...metadata,review_receipts:JSON.stringify({...previous,[nodeId]:evidence})});
}
export function requireNodeReview(document: PlanDocument, nodeId: string, runtime: EvidenceRuntime | undefined): ReviewEvidence {
  if (!runtime) fail("capability_unavailable: trusted evidence runtime is required");
  const task = parseTasks(document.sections.tasks).find(t => t.id === nodeId) ?? fail("unknown_contract_node");
  const record = inspectPhaseRecords(document.sections.tasks).records[nodeId];
  return assertReviewEvidence(readReviewEvidence(document)[nodeId],runtime.signer,{node_id:nodeId,contract_hash:nodeContractHash(document,nodeId),risk:effectiveNodeRisk(task,runtime),implementer_session_id:record?.implementer_session_id ?? runtime.implementer_session_id});
}
/** Walk all transitive edges, not just the current round's checkbox projection. */
export function dependencyFinalizations(document: PlanDocument, nodeId: string, runtime: EvidenceRuntime | undefined): FinalizeDependencyRef[] {
  const tasks = parseTasks(document.sections.tasks), records = inspectPhaseRecords(document.sections.tasks).records;
  const visiting = new Set<string>(), result = new Map<string,FinalizeDependencyRef>();
  function visit(id: string): void {
    if (visiting.has(id)) fail("dependency_cycle");
    if (result.has(id)) return;
    const task = tasks.find(t => t.id === id) ?? fail("unknown_dependency");
    visiting.add(id);
    for (const dep of task.dependsOn) visit(dep);
    const transitive = new Set<string>();
    function collect(dependency: string): void { if (transitive.has(dependency)) return; transitive.add(dependency); for (const child of tasks.find(t=>t.id===dependency)!.dependsOn) collect(child); }
    for (const dep of task.dependsOn) collect(dep);
    if (!runtime || !task.completed || !records[id]?.finalized?.evidence) fail("dependency_finalize_required: checkbox or legacy unsealed receipt is insufficient");
    const receipt = authenticateFinalizedNode(document,id,runtime,[...transitive].sort().map(dep=>result.get(dep)!));
    result.set(id,{node_id:id,finalize_hash:receipt.receipt_hash});
    visiting.delete(id);
  }
  const current = tasks.find(t => t.id === nodeId) ?? fail("unknown_contract_node");
  for (const dep of current.dependsOn) visit(dep);
  return [...result.values()].sort((a,b)=>a.node_id.localeCompare(b.node_id));
}

/** Closing/rolling a plan must authenticate every historical completion, including disconnected nodes. */
export function assertAllFinalizedHistory(document: PlanDocument, runtime: EvidenceRuntime | undefined): void {
  const records = inspectPhaseRecords(document.sections.tasks).records;
  for (const task of parseTasks(document.sections.tasks).filter(t => t.completed)) {
    if (!runtime || !records[task.id]?.finalized?.evidence) fail("finalize_evidence_required");
    authenticateFinalizedNode(document,task.id,runtime,dependencyFinalizations(document,task.id,runtime));
  }
}
/** V1 preserves baseline records on reopen. Reject a change that would strand another record. */
export function assertReopenRecoverable(document: PlanDocument, nodeId: string): void {
  const tasks = parseTasks(document.sections.tasks), records = inspectPhaseRecords(document.sections.tasks).records;
  function depends(id: string, seen = new Set<string>()): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    return (tasks.find(t => t.id === id)?.dependsOn ?? []).some(dep => dep === nodeId || depends(dep,seen));
  }
  for (const task of tasks) {
    if (task.id === nodeId) continue;
    if ((task.completed || records[task.id]) && depends(task.id)) fail("reopen_has_started_dependents: reopen requires a future coherent dependency recovery transaction");
    if (records[task.id] && !records[task.id]!.finalized) fail("reopen_another_phase_active: finish the active phase before reopening another");
  }
}

/** Current authenticated evidence must still be exactly the evidence accepted at finalize. */
export function authenticateFinalizedNode(document: PlanDocument, nodeId: string, runtime: EvidenceRuntime, dependencies: FinalizeDependencyRef[]) {
  const record = inspectPhaseRecords(document.sections.tasks).records[nodeId];
  const task = parseTasks(document.sections.tasks).find(t => t.id === nodeId) ?? fail("unknown_contract_node");
  if (!task.completed || !record?.finalized?.evidence) fail("finalize_evidence_required");
  const finalized = assertFinalizeEvidence(record.finalized.evidence,runtime.signer,{plan_id:document.metadata.plan_id,node_id:nodeId,contract_hash:nodeContractHash(document,nodeId),dependency_refs:dependencies});
  if (finalized.review_ref !== requireNodeReview(document,nodeId,runtime).receipt_hash) fail("finalize_review_invalidated");
  const refs = task.acceptance.map(item => {
    const evidence = record.verification?.find(e => e.receipt.acceptance_id === item.id);
    return assertVerificationEvidence(evidence,runtime.signer,verificationInputFor(document,nodeId,item.id,finalized.content_version)).receipt_hash;
  });
  if (canonicalHash([...refs].sort()) !== canonicalHash([...finalized.verification_refs].sort())) fail("finalize_verification_invalidated");
  return finalized;
}
