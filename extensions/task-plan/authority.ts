import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { PlanStage } from "./types.ts";

export const AUTHORITY_ACTIONS = ["approve_what_why", "approve_plan", "approve_contract", "authorize_execution", "execute", "docsync_on", "docsync_off", "finalize", "reopen", "abandon", "complete", "next_round", "update_closure", "migrate", "manual_accept"] as const;
export type AuthorityAction = typeof AUTHORITY_ACTIONS[number];
export interface AuthorityContext {
  plan_id: string;
  node_id: string;
  document_hash: string;
  contract_hash: string;
  target_root: string;
  governance_root: string;
  /** Exact displayed action payload, required for newly issued manual acceptance. */
  payload_hash?: string;
}
export interface HumanProvenance { source: "interactive" | "rpc" | "slash"; input_id: string; text: string }
/** Only the trusted Human input adapter may issue this process-local handle. Never a tool argument schema. */
export interface HumanCapability { readonly __humanCapability: unique symbol }
export interface AuthorizationReceipt {
  version: 1;
  id: string;
  action: AuthorityAction;
  context: AuthorityContext;
  provenance: HumanProvenance;
  issued_at: string;
  consumed_at: string;
  nonce: string;
  receipt_hash: string;
}
export type AuthorityErrorCode = "authority_required" | "context_mismatch" | "replay_or_expired" | "invalid_authority_input" | "invalid_authorization_receipt" | "transition_denied";
export class AuthorityError extends Error {
  constructor(public readonly code: AuthorityErrorCode, message: string) { super(`${code}: ${message}`); this.name = "AuthorityError"; }
}
const MAX_AGE_MS = 10 * 60 * 1000;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CONTEXT_KEYS = ["plan_id", "node_id", "document_hash", "contract_hash", "target_root", "governance_root"] as const;
const PROVENANCE_KEYS = ["source", "input_id", "text"] as const;
function invalid(message: string): never { throw new AuthorityError("invalid_authority_input", message); }
function record(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid("Expected a plain record");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !descriptors[key] || !("value" in descriptors[key]) || !descriptors[key]!.enumerable)) invalid("Unexpected, missing or accessor fields");
}
function validString(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 65536 || /\p{Surrogate}/u.test(value) || value.includes("\0")) invalid("Expected a nonempty Unicode string without NUL");
}
function action(value: unknown): asserts value is AuthorityAction {
  if (!AUTHORITY_ACTIONS.includes(value as AuthorityAction)) invalid("Unknown authority action");
}
function context(value: unknown): asserts value is AuthorityContext {
  record(value, [...CONTEXT_KEYS, ...(value && typeof value === "object" && Object.hasOwn(value, "payload_hash") ? ["payload_hash"] : [])]);
  if (Object.hasOwn(value, "payload_hash") && (typeof value.payload_hash !== "string" || !HASH.test(value.payload_hash))) invalid("Expected a SHA-256 action payload hash");
  for (const key of CONTEXT_KEYS) validString(value[key]);
  if (!/^P\d{3,}$/.test(value.plan_id as string) || !/^(?:T\d{3,}|\$plan)$/.test(value.node_id as string)) invalid("Expected a Plan ID and node ID or $plan");
  if (!HASH.test(value.document_hash as string) || !HASH.test(value.contract_hash as string)) invalid("Expected lowercase SHA-256 hashes");
  if (!isAbsolute(value.target_root as string) || !isAbsolute(value.governance_root as string)) invalid("Authority roots must be absolute");
}
function provenance(value: unknown): asserts value is HumanProvenance {
  record(value, PROVENANCE_KEYS);
  for (const key of PROVENANCE_KEYS) validString(value[key]);
  if (!["interactive", "rpc", "slash"].includes(value.source as string)) invalid("Unknown Human input source");
}

/** Deterministic JSON for strict JSON values; rejects values JSON.stringify silently changes. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "string") {
      if (/\p{Surrogate}/u.test(item)) invalid("Unpaired Unicode surrogate");
      return JSON.stringify(item);
    }
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (!item || typeof item !== "object" || ancestors.has(item)) invalid("Expected acyclic JSON values");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        const descriptors = Object.getOwnPropertyDescriptors(item);
        if (Reflect.ownKeys(item).length !== item.length + 1 || Array.from({ length: item.length }, (_, index) => index).some(index => !descriptors[index] || !("value" in descriptors[index]!) || !descriptors[index]!.enumerable)) invalid("Sparse, accessor or extended arrays are not JSON records");
        return `[${Array.from({ length: item.length }, (_, index) => encode(descriptors[index]!.value)).join(",")}]`;
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) invalid("Expected a plain JSON object");
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Reflect.ownKeys(item).length !== Object.keys(descriptors).length || Object.values(descriptors).some(entry => !entry.enumerable || !("value" in entry))) invalid("JSON object contains hidden or accessor fields");
      return `{${Object.keys(descriptors).sort().map(key => `${encode(key)}:${encode(descriptors[key]!.value)}`).join(",")}}`;
    } finally { ancestors.delete(item); }
  }
  return encode(value);
}
export function canonicalHash(value: unknown): string { return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"); }

interface PendingCapability {
  action: AuthorityAction; context: Readonly<AuthorityContext>; provenance: Readonly<HumanProvenance>; issued_at: string; issued_ms: number; nonce: string;
}
const pending = new WeakMap<HumanCapability, PendingCapability>();
const issued = new WeakSet<HumanCapability>();

/** Trusted input boundary only. Copy and freeze caller data to prevent later mutation of authority. */
export function issueHumanCapability(requestedAction: AuthorityAction, boundContext: AuthorityContext, human: HumanProvenance): HumanCapability {
  action(requestedAction); context(boundContext); provenance(human);
  if (requestedAction === "manual_accept" && !boundContext.payload_hash) invalid("Manual acceptance requires an exact displayed payload hash");
  const now = Date.now();
  const token = Object.freeze({}) as HumanCapability;
  pending.set(token, { action: requestedAction, context: Object.freeze({ ...boundContext }), provenance: Object.freeze({ ...human }), issued_at: new Date(now).toISOString(), issued_ms: now, nonce: randomUUID() });
  issued.add(token);
  return token;
}

/** Adapter orchestration only; inspecting never extends validity or grants authority. */
export function peekHumanCapability(token: HumanCapability | undefined): Readonly<Pick<PendingCapability, "action" | "context" | "provenance" | "issued_at">> | undefined {
  if (!token || typeof token !== "object") return undefined;
  const entry = pending.get(token);
  if (!entry) return undefined;
  const age = Date.now() - entry.issued_ms;
  if (age < 0 || age >= MAX_AGE_MS) { pending.delete(token); return undefined; }
  return Object.freeze({ action: entry.action, context: entry.context, provenance: entry.provenance, issued_at: entry.issued_at });
}

/** Consumes before validation: a wrong-context attempt burns the capability, as does a failed transaction. */
export function consumeHumanCapability(token: HumanCapability | undefined, requestedAction: AuthorityAction, actualContext: AuthorityContext): AuthorizationReceipt {
  if (!token || typeof token !== "object" || !issued.has(token)) throw new AuthorityError("authority_required", "A trusted Human capability is required");
  const entry = pending.get(token);
  pending.delete(token);
  const now = Date.now();
  if (!entry || now < entry.issued_ms || now - entry.issued_ms >= MAX_AGE_MS) throw new AuthorityError("replay_or_expired", "Capability has already been consumed or expired");
  action(requestedAction); context(actualContext);
  if (requestedAction === "manual_accept" && !actualContext.payload_hash) invalid("Manual acceptance requires an exact displayed payload hash");
  if (entry.action !== requestedAction || CONTEXT_KEYS.some(key => entry.context[key] !== actualContext[key]) || entry.context.payload_hash !== actualContext.payload_hash) throw new AuthorityError("context_mismatch", "Capability does not authorize this action and context");
  const unsigned = { version: 1 as const, id: randomUUID(), action: entry.action, context: entry.context, provenance: entry.provenance, issued_at: entry.issued_at, consumed_at: new Date(now).toISOString(), nonce: entry.nonce };
  return Object.freeze({ ...unsigned, receipt_hash: canonicalHash(unsigned) });
}

/** Checks stored record integrity, not issuer authenticity; only the transition writer may persist receipts. */
export function assertAuthorizationReceipt(value: unknown): asserts value is AuthorizationReceipt {
  try {
    record(value, ["version", "id", "action", "context", "provenance", "issued_at", "consumed_at", "nonce", "receipt_hash"]);
    if (value.version !== 1 || typeof value.id !== "string" || !UUID.test(value.id) || typeof value.nonce !== "string" || !UUID.test(value.nonce)) invalid("Invalid receipt identity");
    action(value.action); context(value.context); provenance(value.provenance);
    for (const field of ["issued_at", "consumed_at"] as const) {
      validString(value[field]);
      const time = Date.parse(value[field]);
      if (!Number.isFinite(time) || new Date(time).toISOString() !== value[field]) invalid("Invalid canonical receipt timestamp");
    }
    const age = Date.parse(value.consumed_at as string) - Date.parse(value.issued_at as string);
    if (age < 0 || age >= MAX_AGE_MS) invalid("Invalid receipt lifetime");
    const { receipt_hash, ...unsigned } = value;
    if (typeof receipt_hash !== "string" || !HASH.test(receipt_hash) || canonicalHash(unsigned) !== receipt_hash) invalid("Authorization receipt hash mismatch");
  } catch (error) { throw new AuthorityError("invalid_authorization_receipt", error instanceof Error ? error.message : "Invalid authorization receipt"); }
}

export interface AuthorityTransition {
  current_states: readonly PlanStage[];
  requested_action: AuthorityAction;
  required_actor: "human";
  required_authorization: "context_bound_one_shot_capability";
  required_receipts: readonly string[];
  next_state: PlanStage | "unchanged" | "executing_or_awaiting_round_decision";
  invalidates: readonly string[];
  enabled: boolean;
}
const ACTIVE: PlanStage[] = ["what_why", "plan", "tasks", "awaiting_execution_approval", "executing", "awaiting_round_decision"];
function transition(states: PlanStage[], requested_action: AuthorityAction, next_state: AuthorityTransition["next_state"], required_receipts: string[], invalidates: string[] = [], enabled = true): AuthorityTransition {
  return Object.freeze({ current_states: Object.freeze(states), requested_action, required_actor: "human", required_authorization: "context_bound_one_shot_capability", required_receipts: Object.freeze(required_receipts), next_state, invalidates: Object.freeze(invalidates), enabled });
}
/** Policy contract. Consumers must additionally enforce state-specific structure and receipt validity. */
export const AUTHORITY_TRANSITION_MATRIX: readonly AuthorityTransition[] = Object.freeze([
  transition(["what_why"], "approve_what_why", "plan", ["structural_review:passed"], ["plan_approval", "contract_approval", "review", "verification"]),
  transition(["plan"], "approve_plan", "tasks", ["what_why_approval", "structural_review:passed"], ["contract_approval", "review", "verification"]),
  transition(["awaiting_execution_approval"], "approve_contract", "unchanged", ["what_why_approval", "plan_approval", "review:passed"]),
  transition(["awaiting_execution_approval"], "authorize_execution", "executing", ["contract_approval", "review:passed"]),
  transition(["executing"], "execute", "unchanged", ["execution_authorization", "dependency_finalize:accepted"]),
  transition(["executing"], "docsync_on", "unchanged", ["execution_authorization"]),
  transition(["executing"], "docsync_off", "unchanged", ["execution_authorization"]),
  transition(["executing"], "finalize", "executing_or_awaiting_round_decision", ["execution_authorization", "verification:accepted", "review:passed", "dependency_finalize:accepted", "scope_verification:passed"]),
  transition(["executing", "awaiting_round_decision"], "reopen", "executing", [], ["verification", "finalize", "dependent_execution"]),
  transition([...ACTIVE], "abandon", "abandoned", [], ["pending_capabilities", "execution_binding"]),
  transition(["awaiting_round_decision"], "complete", "completed", ["all_current_nodes_finalize:accepted"]),
  transition(["awaiting_round_decision"], "next_round", "plan", ["all_current_nodes_finalize:accepted"], ["plan_approval", "contract_approval", "review"]),
  transition(["completed", "abandoned"], "update_closure", "unchanged", []),
  transition([], "migrate", "unchanged", ["dual_read_conformance:passed", "migration_equivalence:passed"], ["review", "contract_approval", "execution_authorization"], false),
  transition(["executing"], "manual_accept", "unchanged", ["execution_authorization", "contract_manual_gate"]),
]);

/** The action/state gate is necessary but does not replace receipt and structure checks. */
export function assertTransitionAllowed(stage: PlanStage, requestedAction: AuthorityAction): AuthorityTransition {
  action(requestedAction);
  const rule = AUTHORITY_TRANSITION_MATRIX.find(entry => entry.requested_action === requestedAction);
  if (!rule?.enabled || !rule.current_states.includes(stage)) throw new AuthorityError("transition_denied", `${requestedAction} is forbidden in ${stage}`);
  return rule;
}
