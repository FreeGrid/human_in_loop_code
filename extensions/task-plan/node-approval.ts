import { assertAuthorizationReceipt, type AuthorizationReceipt } from "./authority.ts";
import { nodeContractHash, type EvidenceRuntime } from "./receipt-state.ts";
import { parseStrictJson } from "./plan-text.ts";
import type { PlanDocument, PlanMetadata } from "./types.ts";

export interface NodeApproval { contract_hash:string; contract_authorization_ref:string; execution_authorization_ref?:string }
export function readNodeApprovals(metadata:PlanMetadata):Record<string,NodeApproval> {
  return metadata.node_approvals === undefined ? {} : parseStrictJson(String(metadata.node_approvals)) as Record<string,NodeApproval>;
}
export function selectedNode(document:PlanDocument):string {
  const id=document.metadata.selected_node ?? document.metadata.pending_node;
  if(typeof id!=="string" || !/^T\d{3}$/.test(id)) throw new Error("phase_selection_required: review one node before Human approval");
  return id;
}
export function requireNodeApproval(document:PlanDocument,nodeId:string,runtime:EvidenceRuntime|undefined,execution=true):NodeApproval {
  const approval=readNodeApprovals(document.metadata)[nodeId];
  if(!approval || approval.contract_hash!==nodeContractHash(document,nodeId,runtime)) throw new Error("contract_approval_required: selected node contract is not approved");
  const receipts=(document.metadata.authority_receipts===undefined?[]:parseStrictJson(String(document.metadata.authority_receipts))) as AuthorizationReceipt[];
  const check=(ref:string|undefined,action:string)=>{
    const receipt=receipts.find(r=>r.receipt_hash===ref);
    if(!receipt)throw new Error("node_authorization_receipt_required");
    assertAuthorizationReceipt(receipt);
    if(receipt.action!==action||receipt.context.plan_id!==document.metadata.plan_id||receipt.context.node_id!==nodeId||receipt.context.contract_hash!==approval.contract_hash)throw new Error("node_authorization_context_mismatch");
    return receipt;
  };
  const contract=check(approval.contract_authorization_ref,"approve_contract");
  if(execution){const authorize=check(approval.execution_authorization_ref,"authorize_execution");if(authorize.context.target_root!==contract.context.target_root||authorize.context.governance_root!==contract.context.governance_root)throw new Error("node_authorization_roots_mismatch");}
  return approval;
}
