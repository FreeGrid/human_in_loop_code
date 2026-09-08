import { readFile } from "node:fs/promises";
import { extractAllSections } from "./sections.ts";
import { parseFrontmatter, sha256 } from "./plan-file.ts";
import { migrateV1Nodes, parseCanonicalNodes, type CanonicalPlanNode } from "./nodes.ts";

export const V2_FORMAT = "pi-plan/v2";

export interface V2PlanDocument {
  format: typeof V2_FORMAT;
  metadata: Record<string, unknown>;
  nodes: CanonicalPlanNode[];
  document_hash: string;
}

export interface V2MigrationProposal {
  source_document_hash: string;
  source_plan_id: string;
  nodes: CanonicalPlanNode[];
  requires_human_confirmation: true;
  warnings: string[];
}

export function parseV2PlanDocument(text: string): V2PlanDocument {
  const { metadata, body } = parseFrontmatter(text);
  if (metadata.format !== V2_FORMAT) throw new Error(`Expected ${V2_FORMAT} format`);
  const nodes = parseCanonicalNodes(body);
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) throw new Error(`Duplicate canonical node ${node.id}`);
    seen.add(node.id);
    if (!node.outcome && !node.work) throw new Error(`${node.id} must define Outcome or Work`);
  }
  return { format: V2_FORMAT, metadata, nodes, document_hash: sha256(text) };
}

export async function readV2PlanFile(path: string): Promise<V2PlanDocument> {
  return parseV2PlanDocument(await readFile(path, "utf8"));
}

export function renderV2PlanDocument(metadata: Record<string, unknown>, nodes: CanonicalPlanNode[]): string {
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) throw new Error(`Duplicate canonical node ${node.id}`);
    seen.add(node.id);
    if (!/^T\d{3}$/.test(node.id)) throw new Error(`Invalid canonical node ${node.id}`);
  }
  const fields = { format: V2_FORMAT, ...metadata };
  const frontmatter = Object.entries(fields).filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${formatScalar(value)}`).join("\n");
  return `---\n${frontmatter}\n---\n\n${nodes.map(renderNode).join("\n\n")}\n`;
}

function renderNode(node: CanonicalPlanNode): string {
  const fields: Array<[string, string]> = [["Outcome", node.outcome], ["Work", node.work], ["Acceptance", node.acceptance], ["Depends On", node.dependsOn], ["Progress", node.progress]];
  return [`### ${node.id} — ${node.title}`, ...fields.filter(([, value]) => value.trim()).flatMap(([name, value]) => [`#### ${name}`, "", value.trim(), ""])].join("\n").trimEnd();
}

function formatScalar(value: unknown): string {
  if (typeof value === "string") return value.includes(":") || value.includes("#") ? JSON.stringify(value) : value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/** Prepare, but never apply, a V1-to-V2 migration. */
export function prepareV1Migration(text: string): V2MigrationProposal {
  const { metadata } = parseFrontmatter(text);
  const sections = extractAllSections(text);
  return {
    source_document_hash: sha256(text),
    source_plan_id: String(metadata.plan_id ?? ""),
    nodes: migrateV1Nodes(sections.plan, sections.tasks),
    requires_human_confirmation: true,
    warnings: ["Migration is a proposal only; source file, baseline and execution records are unchanged."],
  };
}
