import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { canonicalJson, consumeHumanCapability, type AuthorityContext, type HumanCapability, type AuthorizationReceipt } from "./authority.ts";

/** These factories belong to the trusted Controller composition root, never model tool schemas.
 * A receipt hash detects changes; only the separate keyed seal authenticates its producer.
 * Preserve the signing key in a runtime-owned keystore across restart. Missing keys fail closed.
 */
export type VerificationKind = "deterministic_test" | "static_check" | "clean_reproduction" | "artifact_inspection" | "independent_review" | "manual_acceptance";
export type EvidenceResult = "passed" | "failed" | "invalidated";
export type Risk = "low" | "medium" | "high" | "unknown";
export interface ArtifactRef { path: string; sha256: string }
export interface VerificationInput {
  acceptance_id: string; contract_hash: string; content_version: string;
  command_or_method: string; inputs: string[]; expected: string;
}
export interface VerificationFacts {
  verification_kind: VerificationKind; actual: string; exit_code: number | null;
  artifact_refs: ArtifactRef[]; result: EvidenceResult;
}
export interface VerificationReceipt extends VerificationInput, VerificationFacts {
  version: 1; receipt_id: string; verifier_role: "controller" | "reproducer" | "human";
  verifier_session_id: string; authorization_ref: string | null; created_at: string; receipt_hash: string;
}
export interface ReviewInput { node_id: string; contract_hash: string; risk: Risk }
export interface ReviewFacts {
  review_type: "deterministic" | "independent"; result: EvidenceResult | "disputed";
  summary: string; evidence_refs: string[];
}
export interface ReviewEvidence extends ReviewFacts {
  version: 1; receipt_id: string; node_id: string; contract_hash: string;
  reviewer_session_id: string; implementer_session_id: string; fresh: boolean;
  created_at: string; receipt_hash: string;
}
export interface SealedEvidence<T> { receipt: T; seal: string }
declare const signerBrand: unique symbol;
export interface ReceiptSigner { readonly [signerBrand]: true }
declare const verifierBrand: unique symbol;
export interface VerificationAuthority { readonly [verifierBrand]: true }
declare const reviewerBrand: unique symbol;
export interface ReviewAuthority { readonly [reviewerBrand]: true }
const signerKeys = new WeakMap<ReceiptSigner, Buffer>();
const verifiers = new WeakMap<VerificationAuthority, { role: "controller" | "reproducer"; session_id: string; signer: ReceiptSigner; run: (input: Readonly<VerificationInput>) => Promise<VerificationFacts> }>();
const reviewers = new WeakMap<ReviewAuthority, { session_id: string; implementer_session_id: string; fresh: boolean; signer: ReceiptSigner; run: (input: Readonly<ReviewInput>) => Promise<ReviewFacts> }>();
const HASH = /^[0-9a-f]{64}$/;
const VERIFICATION_KINDS = ["deterministic_test", "static_check", "clean_reproduction", "artifact_inspection", "independent_review", "manual_acceptance"];
const VERIFICATION_KEYS = ["version", "receipt_id", "acceptance_id", "contract_hash", "content_version", "verification_kind", "verifier_role", "verifier_session_id", "command_or_method", "inputs", "expected", "actual", "exit_code", "artifact_refs", "result", "authorization_ref", "created_at", "receipt_hash"];
const REVIEW_KEYS = ["version", "receipt_id", "node_id", "contract_hash", "review_type", "result", "reviewer_session_id", "implementer_session_id", "fresh", "summary", "evidence_refs", "created_at", "receipt_hash"];
function fail(reason: string): never { throw new Error(`invalid_evidence:${reason}`); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("object");
  const result = value as Record<string, unknown>;
  if (Reflect.ownKeys(result).length !== keys.length || Object.keys(result).sort().join("|") !== [...keys].sort().join("|")) fail("fields");
  if (Object.values(Object.getOwnPropertyDescriptors(result)).some(d => !Object.hasOwn(d, "value"))) fail("accessor");
  return result;
}
function string(value: unknown, max = 16384): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > max || /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail("string");
}
function hash(value: unknown): asserts value is string { if (typeof value !== "string" || !HASH.test(value)) fail("hash"); }
function choice(value: unknown, values: readonly unknown[]): void { if (!values.includes(value)) fail("enum"); }
function strings(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 256) fail("array");
  canonicalJson(value); value.forEach(v => string(v));
}
function timestamp(value: unknown): void {
  string(value, 24);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail("timestamp");
}
function artifacts(value: unknown): asserts value is ArtifactRef[] {
  if (!Array.isArray(value) || value.length > 256) fail("artifacts");
  const seen = new Set<string>();
  for (const item of value) {
    const a = record(item, ["path", "sha256"]); string(a.path, 4096); hash(a.sha256);
    if (seen.has(a.path)) fail("duplicate_artifact"); seen.add(a.path);
  }
}
export const canonicalEvidenceJson = canonicalJson;

function digest(value: unknown): string { return createHash("sha256").update(canonicalEvidenceJson(value)).digest("hex"); }
function receiptBody(value: Record<string, unknown>): Record<string, unknown> { const { receipt_hash: _, ...body } = value; return body; }
function input(value: unknown): asserts value is VerificationInput {
  const v = record(value, ["acceptance_id", "contract_hash", "content_version", "command_or_method", "inputs", "expected"]);
  string(v.acceptance_id, 256); hash(v.contract_hash); string(v.content_version, 4096);
  string(v.command_or_method); strings(v.inputs); string(v.expected);
}
export function parseVerificationReceipt(value: unknown): VerificationReceipt {
  const v = record(value, VERIFICATION_KEYS);
  input(Object.fromEntries(["acceptance_id", "contract_hash", "content_version", "command_or_method", "inputs", "expected"].map(k => [k, v[k]])));
  choice(v.version, [1]); string(v.receipt_id, 256); choice(v.verification_kind, VERIFICATION_KINDS);
  choice(v.verifier_role, ["controller", "reproducer", "human"]); string(v.verifier_session_id, 256);
  string(v.actual, 1048576); choice(v.result, ["passed", "failed", "invalidated"]);
  if (v.exit_code !== null && (typeof v.exit_code !== "number" || !Number.isSafeInteger(v.exit_code) || v.exit_code < 0 || v.exit_code > 255)) fail("exit_code");
  if (["deterministic_test", "static_check", "clean_reproduction"].includes(v.verification_kind as string) && v.exit_code === null) fail("missing_exit_code");
  if (v.result === "passed" && v.exit_code !== null && v.exit_code !== 0) fail("contradictory_exit_code");
  if (v.verification_kind === "manual_acceptance" ? v.verifier_role !== "human" : v.verifier_role === "human") fail("manual_authority");
  if (v.verification_kind === "clean_reproduction" && v.verifier_role !== "reproducer") fail("reproducer_authority");
  if (v.verification_kind === "manual_acceptance") { hash(v.authorization_ref); if (v.exit_code !== null) fail("manual_exit_code"); }
  else if (v.authorization_ref !== null) fail("unexpected_authorization_ref");
  artifacts(v.artifact_refs); timestamp(v.created_at); hash(v.receipt_hash);
  if (digest(receiptBody(v)) !== v.receipt_hash) fail("receipt_hash");
  return structuredClone(v) as unknown as VerificationReceipt;
}
export function parseReviewEvidence(value: unknown): ReviewEvidence {
  const v = record(value, REVIEW_KEYS);
  choice(v.version, [1]); string(v.receipt_id, 256); string(v.node_id, 256); hash(v.contract_hash);
  choice(v.review_type, ["deterministic", "independent"]); choice(v.result, ["passed", "failed", "disputed", "invalidated"]);
  string(v.reviewer_session_id, 256); string(v.implementer_session_id, 256);
  if (typeof v.fresh !== "boolean") fail("fresh");
  if (v.review_type === "independent" && (!v.fresh || v.reviewer_session_id === v.implementer_session_id)) fail("review_independence");
  string(v.summary); strings(v.evidence_refs); timestamp(v.created_at); hash(v.receipt_hash);
  if (digest(receiptBody(v)) !== v.receipt_hash) fail("receipt_hash");
  return structuredClone(v) as unknown as ReviewEvidence;
}
export function createReceiptSigner(secret: Uint8Array): ReceiptSigner {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32 || secret.byteLength > 4096) fail("signing_key");
  const signer = Object.freeze({}) as ReceiptSigner; signerKeys.set(signer, Buffer.from(secret)); return signer;
}
function seal(signer: ReceiptSigner, kind: "verification" | "review" | "finalize", receipt: unknown): string {
  const key = signerKeys.get(signer); if (!key) fail("signer_identity");
  return createHmac("sha256", key).update(`task-plan-evidence:v1:${kind}\n`).update(canonicalEvidenceJson(receipt)).digest("hex");
}
function verifySeal(value: unknown, signer: ReceiptSigner, kind: "verification" | "review" | "finalize"): Record<string, unknown> {
  const v = record(value, ["receipt", "seal"]); hash(v.seal);
  const expected = seal(signer, kind, v.receipt);
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v.seal, "hex"))) fail("untrusted_origin");
  return v;
}
export function configureVerificationAuthority(config: { role: "controller" | "reproducer"; session_id: string; signer: ReceiptSigner; run: (input: Readonly<VerificationInput>) => Promise<VerificationFacts> }): VerificationAuthority {
  choice(config.role, ["controller", "reproducer"]); string(config.session_id, 256);
  if (!signerKeys.has(config.signer) || typeof config.run !== "function") fail("verifier_configuration");
  const handle = Object.freeze({}) as VerificationAuthority; verifiers.set(handle, { ...config }); return handle;
}
export async function runVerification(handle: VerificationAuthority, request: VerificationInput): Promise<SealedEvidence<VerificationReceipt>> {
  const authority = verifiers.get(handle); if (!authority) fail("verifier_identity"); input(request);
  const bound = structuredClone(request); Object.freeze(bound.inputs); Object.freeze(bound);
  const facts = await authority.run(bound);
  record(facts, ["verification_kind", "actual", "exit_code", "artifact_refs", "result"]);
  if (["manual_acceptance", "independent_review"].includes(facts.verification_kind)) fail("specialized_authority_required");
  const body = { ...bound, ...facts, version: 1 as const, receipt_id: randomUUID(), verifier_role: authority.role, verifier_session_id: authority.session_id, authorization_ref: null, created_at: new Date().toISOString() };
  const receipt = parseVerificationReceipt({ ...body, receipt_hash: digest(body) });
  return { receipt, seal: seal(authority.signer, "verification", receipt) };
}
export function configureReviewAuthority(config: { session_id: string; implementer_session_id: string; fresh: boolean; signer: ReceiptSigner; run: (input: Readonly<ReviewInput>) => Promise<ReviewFacts> }): ReviewAuthority {
  string(config.session_id, 256); string(config.implementer_session_id, 256);
  if (typeof config.fresh !== "boolean" || !signerKeys.has(config.signer) || typeof config.run !== "function") fail("reviewer_configuration");
  const handle = Object.freeze({}) as ReviewAuthority; reviewers.set(handle, { ...config }); return handle;
}
function reviewInput(value: unknown): asserts value is ReviewInput {
  const v = record(value, ["node_id", "contract_hash", "risk"]); string(v.node_id, 256); hash(v.contract_hash); choice(v.risk, ["low", "medium", "high", "unknown"]);
}
function riskGate(receipt: ReviewEvidence, risk: Risk): void {
  choice(risk, ["low", "medium", "high", "unknown"]);
  if (risk !== "low" && receipt.review_type !== "independent") fail("independent_review_required");
}
export async function runReview(handle: ReviewAuthority, request: ReviewInput): Promise<SealedEvidence<ReviewEvidence>> {
  const authority = reviewers.get(handle); if (!authority) fail("reviewer_identity"); reviewInput(request);
  const bound = Object.freeze(structuredClone(request)); const facts = await authority.run(bound);
  record(facts, ["review_type", "result", "summary", "evidence_refs"]);
  const body = { ...facts, version: 1 as const, receipt_id: randomUUID(), node_id: bound.node_id, contract_hash: bound.contract_hash, reviewer_session_id: authority.session_id, implementer_session_id: authority.implementer_session_id, fresh: authority.fresh, created_at: new Date().toISOString() };
  const receipt = parseReviewEvidence({ ...body, receipt_hash: digest(body) }); riskGate(receipt, bound.risk);
  return { receipt, seal: seal(authority.signer, "review", receipt) };
}
export function authenticateVerificationEvidence(value: unknown, signer: ReceiptSigner, expected: VerificationInput): VerificationReceipt {
  input(expected); const receipt = parseVerificationReceipt(verifySeal(value, signer, "verification").receipt);
  for (const key of Object.keys(expected) as (keyof VerificationInput)[]) if (canonicalEvidenceJson(receipt[key]) !== canonicalEvidenceJson(expected[key])) fail(`binding:${key}`);
  return receipt;
}
export function assertVerificationEvidence(value: unknown, signer: ReceiptSigner, expected: VerificationInput): VerificationReceipt {
  const receipt = authenticateVerificationEvidence(value, signer, expected);
  if (receipt.result !== "passed") fail("verification_not_passed"); return receipt;
}
export function authenticateReviewEvidence(value: unknown, signer: ReceiptSigner, expected: ReviewInput & { implementer_session_id: string }): ReviewEvidence {
  reviewInput({ node_id: expected.node_id, contract_hash: expected.contract_hash, risk: expected.risk }); string(expected.implementer_session_id, 256);
  const receipt = parseReviewEvidence(verifySeal(value, signer, "review").receipt);
  if (receipt.node_id !== expected.node_id || receipt.contract_hash !== expected.contract_hash || receipt.implementer_session_id !== expected.implementer_session_id) fail("review_binding");
  riskGate(receipt, expected.risk); return receipt;
}
export function assertReviewEvidence(value: unknown, signer: ReceiptSigner, expected: ReviewInput & { implementer_session_id: string }): ReviewEvidence {
  const receipt = authenticateReviewEvidence(value, signer, expected);
  if (receipt.result !== "passed") fail("review_not_passed"); return receipt;
}
export async function verifyArtifactContents(receipt: VerificationReceipt): Promise<void> {
  const valid = parseVerificationReceipt(receipt);
  for (const artifact of valid.artifact_refs) {
    if (!isAbsolute(artifact.path)) fail("artifact_absolute_path_required");
    if (createHash("sha256").update(await readFile(artifact.path)).digest("hex") !== artifact.sha256) fail("artifact_changed");
  }
}
/** Fixed commands are supplied only from an approved contract by the Controller.
 * execFile avoids a shell; this helper does NOT establish a sandbox or limit filesystem/network access.
 */
export function configureProcessVerificationAuthority(config: {
  role: "controller" | "reproducer"; session_id: string; signer: ReceiptSigner;
  approved_input: VerificationInput; executable: string; args: string[]; cwd: string;
  kind: "deterministic_test" | "static_check" | "clean_reproduction"; artifact_paths?: string[];
  timeout_ms?: number; env?: Record<string, string>;
}): VerificationAuthority {
  input(config.approved_input); string(config.executable, 4096); string(config.cwd, 4096); strings(config.args);
  if (!isAbsolute(config.executable) || !isAbsolute(config.cwd)) fail("absolute_process_paths_required");
  choice(config.kind, ["deterministic_test", "static_check", "clean_reproduction"]);
  const fixed = structuredClone({ approved_input: config.approved_input, executable: config.executable, args: config.args, cwd: config.cwd, kind: config.kind, artifact_paths: config.artifact_paths ?? [], timeout_ms: config.timeout_ms ?? 60000, env: config.env ?? {} });
  strings(fixed.artifact_paths); if (fixed.artifact_paths.some(p => !isAbsolute(p))) fail("artifact_absolute_path_required");
  if (!Number.isSafeInteger(fixed.timeout_ms) || fixed.timeout_ms < 1 || fixed.timeout_ms > 300000) fail("timeout");
  return configureVerificationAuthority({ role: config.role, session_id: config.session_id, signer: config.signer, run: async request => {
    if (canonicalEvidenceJson(request) !== canonicalEvidenceJson(fixed.approved_input)) fail("approved_command_binding");
    const facts = await new Promise<{ actual: string; exit_code: number }>((resolve, reject) => {
      execFile(fixed.executable, fixed.args, { cwd: fixed.cwd, env: fixed.env, timeout: fixed.timeout_ms, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error && (typeof error.code !== "number" || error.killed || error.signal)) { reject(new Error("verification_process_unavailable", { cause: error })); return; }
        resolve({ actual: JSON.stringify({ stdout, stderr }), exit_code: error ? Number(error.code) : 0 });
      });
    });
    const artifact_refs = await Promise.all(fixed.artifact_paths.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") })));
    return { ...facts, verification_kind: fixed.kind, artifact_refs, result: facts.exit_code === 0 ? "passed" : "failed" };
  }});
}

/** A fresh launcher, not a model-supplied boolean, must configure review identity above.
 * Manual configuration likewise occurs before Human confirmation with the exact displayed item.
 * Persist the returned authorization and sealed evidence in the same Controller transaction.
 */
declare const manualBrand: unique symbol;
export interface ManualVerificationAuthority { readonly [manualBrand]: true }
export interface ManualAcceptancePayload { approved_input: VerificationInput; actual: string; artifact_refs: ArtifactRef[] }
/** Bind exactly what the Human sees. Provenance text is never parsed as authorization. */
export function manualAcceptanceContext(base: AuthorityContext, payload: ManualAcceptancePayload): AuthorityContext {
  record(payload, ["approved_input", "actual", "artifact_refs"]);
  input(payload.approved_input); string(payload.actual, 1048576); artifacts(payload.artifact_refs);
  if (base.contract_hash !== payload.approved_input.contract_hash) fail("manual_contract_binding");
  const payload_hash = digest({ purpose: "task-plan-manual-acceptance:v1", ...payload });
  if (base.payload_hash !== undefined && base.payload_hash !== payload_hash) fail("manual_payload_binding");
  return { ...base, payload_hash };
}
interface ManualConfig {
  signer: ReceiptSigner; session_id: string; approved_input: VerificationInput;
  context: AuthorityContext; actual: string; artifact_refs: ArtifactRef[];
}
const manualAuthorities = new WeakMap<ManualVerificationAuthority, ManualConfig>();
export function configureManualVerificationAuthority(config: ManualConfig): ManualVerificationAuthority {
  if (!signerKeys.has(config.signer)) fail("signer_identity");
  string(config.session_id, 256); input(config.approved_input); string(config.actual, 1048576); artifacts(config.artifact_refs);
  if (config.context.contract_hash !== config.approved_input.contract_hash) fail("manual_contract_binding");
  const context = manualAcceptanceContext(config.context, { approved_input: config.approved_input, actual: config.actual, artifact_refs: config.artifact_refs });
  const handle = Object.freeze({}) as ManualVerificationAuthority;
  manualAuthorities.set(handle, { ...structuredClone({ session_id: config.session_id, approved_input: config.approved_input, context, actual: config.actual, artifact_refs: config.artifact_refs }), signer: config.signer });
  return handle;
}
export function runManualAcceptance(handle: ManualVerificationAuthority, capability: HumanCapability): { evidence: SealedEvidence<VerificationReceipt>; authorization: AuthorizationReceipt } {
  const authority = manualAuthorities.get(handle); if (!authority) fail("manual_identity");
  // Both item handle and Human capability are one-shot, including rejected attempts.
  manualAuthorities.delete(handle);
  const authorization = consumeHumanCapability(capability, "manual_accept", authority.context);
  const body = { ...authority.approved_input, version: 1 as const, receipt_id: randomUUID(), verifier_role: "human" as const, verifier_session_id: authority.session_id, verification_kind: "manual_acceptance" as const, actual: authority.actual, exit_code: null, artifact_refs: authority.artifact_refs, result: "passed" as const, authorization_ref: authorization.receipt_hash, created_at: new Date().toISOString() };
  const receipt = parseVerificationReceipt({ ...body, receipt_hash: digest(body) });
  return { evidence: { receipt, seal: seal(authority.signer, "verification", receipt) }, authorization };
}


export interface FinalizeDependencyRef { node_id: string; finalize_hash: string }
export interface FinalizeReceipt {
  version: 1; receipt_id: string; plan_id: string; node_id: string;
  contract_hash: string; content_version: string; verification_refs: string[];
  review_ref: string; dependency_refs: FinalizeDependencyRef[]; authorization_ref: string;
  docsync_check: "passed" | "with_debt" | "with_exceptions" | "skipped";
  result: "accepted" | "invalidated"; created_at: string; receipt_hash: string;
}
export type FinalizeInput = Omit<FinalizeReceipt, "version" | "receipt_id" | "result" | "created_at" | "receipt_hash"> & { result?: FinalizeReceipt["result"] };
const FINALIZE_INPUT_KEYS = ["plan_id", "node_id", "contract_hash", "content_version", "verification_refs", "review_ref", "dependency_refs", "authorization_ref", "docsync_check"];
function dependencyRefs(value: unknown): asserts value is FinalizeDependencyRef[] {
  if (!Array.isArray(value) || value.length > 256) fail("dependency_refs");
  canonicalJson(value);
  const nodes = new Set<string>(), hashes = new Set<string>();
  for (const item of value) {
    const ref = record(item, ["node_id", "finalize_hash"]); string(ref.node_id, 256); hash(ref.finalize_hash);
    if (nodes.has(ref.node_id) || hashes.has(ref.finalize_hash)) fail("duplicate_dependency");
    nodes.add(ref.node_id); hashes.add(ref.finalize_hash);
  }
}
function finalizeFields(v: Record<string, unknown>): void {
  string(v.plan_id, 256); string(v.node_id, 256); hash(v.contract_hash); string(v.content_version, 4096);
  strings(v.verification_refs);
  if (!v.verification_refs.length || new Set(v.verification_refs).size !== v.verification_refs.length) fail("verification_refs");
  v.verification_refs.forEach(hash); hash(v.review_ref); hash(v.authorization_ref); dependencyRefs(v.dependency_refs);
  if (v.dependency_refs.some(ref => ref.node_id === v.node_id)) fail("self_dependency");
  choice(v.docsync_check, ["passed", "with_debt", "with_exceptions", "skipped"]);
}
export function parseFinalizeReceipt(value: unknown): FinalizeReceipt {
  const v = record(value, [...FINALIZE_INPUT_KEYS, "version", "receipt_id", "result", "created_at", "receipt_hash"]);
  finalizeFields(v); choice(v.version, [1]); string(v.receipt_id, 256); choice(v.result, ["accepted", "invalidated"]);
  timestamp(v.created_at); hash(v.receipt_hash);
  if (digest(receiptBody(v)) !== v.receipt_hash) fail("receipt_hash");
  return structuredClone(v) as unknown as FinalizeReceipt;
}
/** Trusted Controller only: call after all actual verification/review/dependency/Human gates pass.
 * Supplying receipt references is not itself gate verification. Never expose this factory as a model tool.
 */
export function sealFinalizeEvidence(signer: ReceiptSigner, request: FinalizeInput): SealedEvidence<FinalizeReceipt> {
  const v = record(request, [...FINALIZE_INPUT_KEYS, ...(Object.hasOwn(request, "result") ? ["result"] : [])]);
  finalizeFields(v); if (Object.hasOwn(v, "result")) choice(v.result, ["accepted", "invalidated"]);
  const body = { ...structuredClone(request), version: 1 as const, receipt_id: randomUUID(), result: request.result ?? "accepted", created_at: new Date().toISOString() };
  const receipt = parseFinalizeReceipt({ ...body, receipt_hash: digest(body) });
  return { receipt, seal: seal(signer, "finalize", receipt) };
}
export function assertFinalizeEvidence(value: unknown, signer: ReceiptSigner, expected: { plan_id: string; node_id: string; contract_hash: string; dependency_refs?: FinalizeDependencyRef[] }): FinalizeReceipt {
  const v = record(expected, ["plan_id", "node_id", "contract_hash", ...(Object.hasOwn(expected, "dependency_refs") ? ["dependency_refs"] : [])]);
  string(v.plan_id, 256); string(v.node_id, 256); hash(v.contract_hash);
  const receipt = parseFinalizeReceipt(verifySeal(value, signer, "finalize").receipt);
  if (receipt.plan_id !== expected.plan_id || receipt.node_id !== expected.node_id || receipt.contract_hash !== expected.contract_hash) fail("finalize_binding");
  if (Object.hasOwn(expected, "dependency_refs")) {
    dependencyRefs(expected.dependency_refs);
    const ordered = (refs: FinalizeDependencyRef[]) => [...refs].sort((a, b) => a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0);
    if (canonicalJson(ordered(receipt.dependency_refs)) !== canonicalJson(ordered(expected.dependency_refs!))) fail("finalize_dependency_binding");
  }
  if (receipt.result !== "accepted") fail("finalize_not_accepted"); return receipt;
}
