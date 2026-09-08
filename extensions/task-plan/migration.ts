import { readPlanDocument, writeIfDocumentHash } from "./plan-file.ts";
import { prepareV1Migration, renderV2PlanDocument } from "./v2-plan.ts";

export type MigrationResult =
  | { status: "applied"; source_document_hash: string; document_hash: string; path: string }
  | { status: "blocked" | "conflict"; reason: string; path?: string };

/** Apply a V1→V2 migration only after an explicit Human decision and CAS check. */
export async function applyV1Migration(params: {
  path: string;
  expected_document_hash: string;
  human_confirmed: boolean;
}): Promise<MigrationResult> {
  if (!params.human_confirmed) return { status: "blocked", reason: "human_confirmation_required", path: params.path };
  const document = await readPlanDocument(params.path);
  if (document.document_hash !== params.expected_document_hash) return { status: "conflict", reason: "stale_document_hash", path: params.path };
  if (document.metadata.stage === "executing") return { status: "blocked", reason: "active_execution_cannot_be_migrated", path: params.path };
  const proposal = prepareV1Migration(document.text);
  const candidate = renderV2PlanDocument({
    plan_id: proposal.source_plan_id,
    status: "draft",
    source_format: "pi-plan/v1",
    source_document_hash: proposal.source_document_hash,
    migration_requires_review: true,
  }, proposal.nodes);
  const write = await writeIfDocumentHash(params.path, params.expected_document_hash, candidate);
  if (!write.ok) return { status: "conflict", reason: write.conflict, path: params.path };
  return { status: "applied", source_document_hash: proposal.source_document_hash, document_hash: write.document_hash, path: params.path };
}
