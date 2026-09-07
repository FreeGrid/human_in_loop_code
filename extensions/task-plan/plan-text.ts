import { isAbsolute } from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";
import { assertAuthorizationReceipt } from "./authority.ts";
import { parseReviewEvidence } from "./evidence.ts";
import { HARNESS, STAGE_STATUS, type PlanMetadata } from "./types.ts";

export const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const HASH = /^[a-f0-9]{64}$/;
const KNOWN = new Set(["harness", "operation_runtime", "format", "plan_id", "round", "stage", "stage_status", "approved_what_why_hash", "approved_plan_hash", "reviewed_tasks_hash", "approved_contract_hash", "authority_receipts", "review_receipts", "closure_reason", "identity_policy", "selected_node", "pending_node", "node_approvals"]);

/** Reject scalar values that a UTF-8/JSON writer can silently alter or conceal. */
export function assertSafeUnicode(value: unknown): void {
  const stack = new Set<object>();
  function visit(v: unknown, depth: number): void {
    if (depth > 64) throw new Error("plan_data_too_deep");
    if (typeof v === "string") {
      if (/\u0000|\p{Surrogate}/u.test(v)) throw new Error("invalid_plan_unicode: NUL and lone surrogates are forbidden");
    } else if (v && typeof v === "object") {
      if (stack.has(v)) throw new Error("cyclic_plan_data");
      stack.add(v);
      for (const [key, item] of Object.entries(v)) { visit(key, depth + 1); visit(item, depth + 1); }
      stack.delete(v);
    }
  }
  visit(value, 0);
}
export function decodePlanUtf8(bytes: Uint8Array): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("invalid_plan_utf8"); }
  assertSafeUnicode(text);
  return text;
}
export function assertNoReservedPlanMarkup(value: string, field = "text"): void {
  assertSafeUnicode(value);
  if (/<!--\s*pi-plan:/i.test(value)) throw new Error(`reserved_plan_markup: ${field}`);
}

/** JSON grammar plus duplicate-key detection at every object depth. */
export function parseStrictJson(raw: string): unknown {
  const value: unknown = JSON.parse(raw);
  const checked = parseDocument(raw, { version: "1.2", strict: true, uniqueKeys: true, customTags: [] });
  if (checked.errors.length || checked.warnings.length) throw new Error("invalid_or_duplicate_json_key");
  assertSafeUnicode(value);
  return value;
}

/** Syntax only: V2 proposal readers can use this without a V1 metadata envelope. */
export function parseFrontmatter(text: string): { metadata: PlanMetadata; body: string } {
  assertSafeUnicode(text);
  const match = text.match(FRONTMATTER);
  if (!match) throw new Error("Plan document is missing frontmatter");
  const raw = match[1]!;
  if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error("frontmatter_too_large");
  if (/\r(?!\n)|[\u2028\u2029]/u.test(raw)) throw new Error("invalid_frontmatter_whitespace");
  const doc = parseDocument(raw, { version: "1.2", strict: true, uniqueKeys: true, customTags: [] });
  if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) throw new Error("invalid_frontmatter_yaml");
  const metadata: Record<string, unknown> = Object.create(null);
  for (const pair of doc.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string" || !isScalar(pair.value)) throw new Error("frontmatter_requires_scalar_fields");
    const key = pair.key.value;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key) || Object.hasOwn(metadata, key)) throw new Error("invalid_frontmatter_key");
    for (const scalar of [pair.key, pair.value]) {
      if (scalar.anchor || scalar.tag || !scalar.range || /[\r\n]/.test(raw.slice(scalar.range[0], scalar.range[1]))) throw new Error("unsupported_frontmatter_scalar");
    }
    const value: unknown = pair.value.value;
    if (!(typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isSafeInteger(value))) throw new Error("invalid_frontmatter_scalar");
    assertSafeUnicode(value);
    metadata[key] = value;
  }
  return { metadata: metadata as PlanMetadata, body: text.slice(match[0].length) };
}

export function validatePlanMetadata(m: PlanMetadata): void {
  if (![HARNESS, "pi-plan/v2"].includes(m.harness) || typeof m.plan_id !== "string" || !/^P\d{3}$/.test(m.plan_id)) throw new Error("invalid_plan_identity");
  if (!Number.isSafeInteger(m.round) || m.round < 0) throw new Error("invalid_plan_round");
  if (typeof m.stage !== "string" || !Object.hasOwn(STAGE_STATUS, m.stage) || !STAGE_STATUS[m.stage].includes(m.stage_status)) throw new Error("invalid_plan_stage");
  if (m.operation_runtime !== undefined && (typeof m.operation_runtime !== "string" || !isAbsolute(m.operation_runtime) || m.operation_runtime.length > 4096 || /[\r\n]/.test(m.operation_runtime))) throw new Error("invalid_operation_runtime");
  if (m.format !== undefined && m.format !== "pi-plan/v2") throw new Error("invalid_plan_format");
  if ((m.harness === "pi-plan/v2") !== (m.format === "pi-plan/v2")) throw new Error("contradictory_plan_format");
  if (m.identity_policy !== undefined && m.identity_policy !== "node-v1") throw new Error("invalid_identity_policy");
  if (m.format === "pi-plan/v2" && m.identity_policy !== "node-v1") throw new Error("native_identity_policy_required");
  for (const key of ["selected_node", "pending_node"]) if (m[key] !== undefined && (typeof m[key] !== "string" || !/^T\d{3}$/.test(m[key] as string))) throw new Error(`invalid_${key}`);
  if (m.identity_policy === undefined && ["selected_node", "pending_node", "node_approvals"].some(key => m[key] !== undefined)) throw new Error("scoped_state_requires_identity_policy");

  if (m.node_approvals !== undefined) {
    if (typeof m.node_approvals !== "string" || m.node_approvals.length > 1048576) throw new Error("invalid_node_approvals");
    const approvals = parseStrictJson(m.node_approvals);
    if (!approvals || typeof approvals !== "object" || Array.isArray(approvals) || Object.keys(approvals).length > 256 || JSON.stringify(approvals) !== m.node_approvals) throw new Error("invalid_node_approvals");
    for (const [id, entry] of Object.entries(approvals)) {
      if (!/^T\d{3}$/.test(id) || !entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid_node_approvals");
      const value = entry as Record<string, unknown>;
      const keys = Object.keys(value).sort().join();
      if (!["contract_authorization_ref,contract_hash", "contract_authorization_ref,contract_hash,execution_authorization_ref"].includes(keys) || Object.values(value).some(v => typeof v !== "string" || !HASH.test(v))) throw new Error("invalid_node_approvals");
    }
  }
  for (const key of ["approved_what_why_hash", "approved_plan_hash", "reviewed_tasks_hash", "approved_contract_hash"]) {
    if (m[key] !== undefined && m[key] !== "" && (typeof m[key] !== "string" || !HASH.test(m[key] as string))) throw new Error(`invalid_${key}`);
  }
  if (m.closure_reason !== undefined && (typeof m.closure_reason !== "string" || m.closure_reason.length > 65536)) throw new Error("invalid_closure_reason");
  if (typeof m.closure_reason === "string") assertNoReservedPlanMarkup(m.closure_reason, "closure_reason");
  const unknown = Object.keys(m).filter(key => !KNOWN.has(key));
  if (unknown.length > 32 || unknown.some(key => typeof m[key] === "string" && (m[key] as string).length > 4096)) throw new Error("frontmatter_extension_limit");
  if (m.authority_receipts !== undefined) {
    if (typeof m.authority_receipts !== "string") throw new Error("invalid_authority_receipts");
    const receipts: unknown = parseStrictJson(m.authority_receipts);
    if (!Array.isArray(receipts) || receipts.length > 4096) throw new Error("invalid_authority_receipts");
    if (JSON.stringify(receipts) !== m.authority_receipts) throw new Error("noncanonical_authority_receipts");
    receipts.forEach(assertAuthorizationReceipt);
  }
  if (m.review_receipts !== undefined) {
    if (typeof m.review_receipts !== "string" || m.review_receipts.length > 1048576) throw new Error("invalid_review_receipts");
    const receipts: unknown = parseStrictJson(m.review_receipts);
    if (!receipts || typeof receipts !== "object" || Array.isArray(receipts) || Object.keys(receipts).length > 256) throw new Error("invalid_review_receipts");
    if (JSON.stringify(receipts) !== m.review_receipts) throw new Error("noncanonical_review_receipts");
    for (const [id, envelope] of Object.entries(receipts)) {
      if (!/^T\d{3}$/.test(id) || !envelope || typeof envelope !== "object" || Object.keys(envelope).sort().join() !== "receipt,seal" || !HASH.test(envelope.seal)) throw new Error("invalid_review_receipts");
      if (parseReviewEvidence(envelope.receipt).node_id !== id) throw new Error("invalid_review_receipts");
    }
  }
}

export function renderFrontmatter(metadata: PlanMetadata): string {
  assertSafeUnicode(metadata);
  const ordered = ["harness", "plan_id", "round", "stage", "stage_status", "approved_what_why_hash", "approved_plan_hash", "reviewed_tasks_hash", "closure_reason"];
  const keys = [...ordered.filter(k => metadata[k] !== undefined && metadata[k] !== ""), ...Object.keys(metadata).filter(k => !ordered.includes(k) && metadata[k] !== undefined).sort()];
  function scalar(value: unknown): string {
    if (typeof value === "string") return /^[A-Za-z_][A-Za-z0-9_/-]*$/.test(value) && !/^(?:null|true|false)$/i.test(value) ? value : JSON.stringify(value);
    if (typeof value === "boolean" || typeof value === "number" && Number.isSafeInteger(value)) return String(value);
    throw new Error("invalid_frontmatter_scalar");
  }
  const result = `---\n${keys.map(key => `${key}: ${scalar(metadata[key])}`).join("\n")}\n---\n`;
  const reread = parseFrontmatter(result).metadata;
  for (const key of keys) if (reread[key] !== metadata[key]) throw new Error("frontmatter_roundtrip_failed");
  return result;
}
