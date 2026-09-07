import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { assertTransitionAllowed, consumeHumanCapability, type AuthorityAction, type AuthorityContext, type AuthorizationReceipt, type HumanCapability } from "./authority.ts";
import { executionDefinitionHash, phaseExecutionDefinitionHash, parseFrontmatter, replaceFrontmatter } from "./plan-file.ts";
import { inspectPhaseRecords } from "./phase-record.ts";
import type { PlanDocument } from "./types.ts";

/** The trusted adapter must resolve this BEFORE showing the Human the proposed action. */
export async function documentAuthorityContext(document: PlanDocument, node_id = "$plan", roots: { target_root?: string; governance_root?: string } = {}): Promise<AuthorityContext> {
  const existing = inspectPhaseRecords(document.sections.tasks).records[node_id]?.context;
  const governance_root = await realpath(roots.governance_root ?? existing?.governance_root ?? dirname(dirname(document.path)));
  const target_root = await realpath(roots.target_root ?? existing?.target_root ?? governance_root);
  return { plan_id: document.metadata.plan_id, node_id, document_hash: document.document_hash,
    contract_hash: node_id === "$plan" ? phaseExecutionDefinitionHash(document) : executionDefinitionHash(document, node_id), target_root, governance_root };
}

export async function consumeDocumentAuthority(document: PlanDocument, token: HumanCapability | undefined, action: AuthorityAction, node_id = "$plan", roots: { target_root?: string; governance_root?: string } = {}): Promise<AuthorizationReceipt> {
  assertTransitionAllowed(document.metadata.stage, action);
  return consumeHumanCapability(token, action, await documentAuthorityContext(document, node_id, roots));
}

/** Receipt and state transition share the same CAS; capability is never serialized. */
export function appendAuthorization(text: string, receipt: AuthorizationReceipt): string {
  const { metadata } = parseFrontmatter(text);
  const receipts = metadata.authority_receipts === undefined ? [] : JSON.parse(String(metadata.authority_receipts));
  if (!Array.isArray(receipts) || receipts.length >= 4096) throw new Error("invalid_authority_receipts");
  return replaceFrontmatter(text, { ...metadata, authority_receipts: JSON.stringify([...receipts, receipt]) });
}
