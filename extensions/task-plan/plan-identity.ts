import { createHash } from "node:crypto";
import { domainFor } from "./plan-domain.ts";
import type { PlanDocument } from "./types.ts";

/** Stable object ordering; runtime policy and authenticated dependencies are added by the trusted resolver. */
export function declaredIdentityHash(value: unknown): string {
  function normalize(v: unknown): unknown { return Array.isArray(v) ? v.map(normalize) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,normalize(x)])) : typeof v === "string" ? v.replace(/\r\n/g,"\n") : v; }
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}
export function nodeDeclaredOutline(document: PlanDocument, id: string) {
  const d=domainFor(document), node=d.nodes.find(n=>n.id===id);
  if(!node)throw new Error("unknown_contract_node");
  return {schema:"pi-plan/outline/node-v1",plan_id:document.metadata.plan_id,node_id:id,title:node.title,outcome:node.outcome,outline:node.outline,depends_on:[...node.dependsOn].sort()};
}
export function nodeOutlineHash(document: PlanDocument,id:string):string{return declaredIdentityHash(nodeDeclaredOutline(document,id));}
export function nodeDeclaredContract(document: PlanDocument, id: string) {
  const d=domainFor(document), node=d.nodes.find(n=>n.id===id);
  if(!node)throw new Error("unknown_contract_node");
  const uncheck=(text:string)=>text.replace(/^(- )\[(?: |x|X)\]/gm,"$1[#]").replace(/^(.*) \[(?: |x|X)\]$/gm,"$1 [#]");
  return {schema:"pi-plan/contract/node-v1",plan_id:document.metadata.plan_id,node_id:id,outline:nodeDeclaredOutline(document,id),round:node.round,what_why:d.whatWhy,strategy:d.strategy,work:uncheck(node.work),acceptance:uncheck(node.acceptance),depends_on:[...node.dependsOn].sort(),verification:node.verification,scopes:node.scopes,forbidden:node.forbidden,non_goals:node.nonGoals,review_policy:node.reviewPolicy,...(node.legacyDefinition?{legacy_definition:node.legacyDefinition}:{})};
}
export function nodeDeclaredContractHash(document:PlanDocument,id:string):string{return declaredIdentityHash(nodeDeclaredContract(document,id));}
