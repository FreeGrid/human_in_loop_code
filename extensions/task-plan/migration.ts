
export type MigrationResult =
  | { status: "applied"; source_document_hash: string; document_hash: string; path: string }
  | { status: "blocked" | "conflict"; reason: string; path?: string };

/** Apply a V1→V2 migration only after an explicit Human decision and CAS check. */
export async function applyV1Migration(params: {
  path: string;
  expected_document_hash: string;
  human_confirmed: boolean;
}): Promise<MigrationResult> {
  return { status: "blocked", reason: "migration_apply_disabled: native dual-read execution conformance and context-bound Human authorization are required; generate a proposal only", path: params.path };
}
