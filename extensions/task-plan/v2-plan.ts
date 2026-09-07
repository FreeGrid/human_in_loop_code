import { readFile } from "node:fs/promises";
import { parsePlanCandidate } from "./plan-integrity.ts";
import { parseFrontmatter } from "./plan-text.ts";
import { domainFor, renderNativeDocument, validateDomain, sourceHash, type DomainNode, type PlanDomain } from "./plan-domain.ts";
import { validatePlanNodeMapping } from "./nodes.ts";
import type { PlanDocument, PlanMetadata } from "./types.ts";

export const V2_FORMAT = "pi-plan/v2";
export interface V2PlanDocument extends PlanDocument { format: "v2"; domain: PlanDomain; nodes: DomainNode[] }
export interface V2MigrationProposal {
  source_document_hash: string;
  source_plan_id: string;
  nodes: DomainNode[];
  domain: PlanDomain;
  requires_human_confirmation: true;
  warnings: string[];
}
/** Runnable native format; sketches lacking the complete envelope cannot enter runtime. */
export function parseV2PlanDocument(text: string): V2PlanDocument {
  const parsed = parsePlanCandidate("", text);
  if(parsed.format!=="v2"||!parsed.domain)throw new Error(`Expected ${V2_FORMAT} format`);
  return {...parsed,format:"v2",domain:parsed.domain,nodes:parsed.domain.nodes};
}
export async function readV2PlanFile(path: string): Promise<V2PlanDocument> {
  const parsed=parseV2PlanDocument(await readFile(path,"utf8"));return {...parsed,path};
}
export function renderV2PlanDocument(metadata: PlanMetadata, domain: PlanDomain): string {
  const text=renderNativeDocument(metadata,domain);parseV2PlanDocument(text);return text;
}
/** Proposal only. No conversion of executable history or silently omitted fields. */
export function prepareV1Migration(text: string): V2MigrationProposal {
  const {metadata}=parseFrontmatter(text);
  if(metadata.harness!=="pi-plan/v1"||metadata.format!==undefined)throw new Error("migration_requires_v1_source");
  const source=parsePlanCandidate("",text),domain=domainFor(source);
  const mapping=validatePlanNodeMapping(source.sections.plan,source.sections.tasks).filter(i=>i.severity==="error");
  if(mapping.length)throw new Error(`migration_mapping_failed: ${mapping.map(i=>i.code).join(",")}`);
  if(domain.nodes.some(n=>n.phase||Object.keys(n.notes).length)||metadata.authority_receipts||metadata.review_receipts||metadata.node_approvals)throw new Error("migration_unmapped_execution_records_notes_or_authority");
  if(Object.keys(metadata).some(k=>/baseline|execution/i.test(k)))throw new Error("migration_unmapped_baseline_identity");
  for(const task of source.sections.tasks.matchAll(/^#### (.+)$/gm))if(!["Tasks","Acceptance","Depends On","Round","Verification","Scopes","Forbidden","Non-Goals","Review Policy"].includes(task[1]!))throw new Error(`migration_unmapped_task_field: ${task[1]}`);
  // Every byte inside a V1 node must have a represented field owner. Legacy reading
  // is deliberately permissive; a migration proposal must not inherit that lossy boundary.
  for (const region of [source.sections.plan, source.sections.tasks]) {
    const blocks = [...region.matchAll(/^### T\d{3} — .+$/gm)];
    for (const [index, heading] of blocks.entries()) {
      const raw = region.slice(heading.index! + heading[0].length, blocks[index + 1]?.index ?? region.length);
      const first = raw.search(/^#### /m);
      const prefix = (first < 0 ? raw : raw.slice(0, first)).replace(/^<!-- pi-plan:round:R\d{3} -->$/gm, "").trim();
      if (prefix) throw new Error("migration_unmapped_node_prose");
      const fields = [...raw.matchAll(/^#### (.+)$/gm)].map(m => m[1]);
      if (new Set(fields).size !== fields.length) throw new Error("migration_duplicate_node_field");
    }
  }
  const afterReview = text.slice(text.indexOf("<!-- pi-plan:review:end -->") + "<!-- pi-plan:review:end -->".length);
  if (afterReview.trim()) throw new Error("migration_unmapped_trailing_content");
  validateDomain(domain);
  const native = {...domain, nodes: domain.nodes.map(({legacyDefinition: _legacy, ...node}) => node)};
  renderNativeDocument({...metadata,harness:V2_FORMAT,format:V2_FORMAT,identity_policy:"node-v1"},native);
  return {source_document_hash:sourceHash(text),source_plan_id:metadata.plan_id,nodes:domain.nodes,domain,requires_human_confirmation:true,warnings:["Migration is a proposal only; source file, baseline and execution records are unchanged. Apply remains disabled."]};
}
