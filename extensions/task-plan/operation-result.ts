export interface PlanOperationResult {
  status: "ok" | "created" | "applied" | "conflict" | "validation_error" | "state_changed";
  message: string;
  path?: string;
  document_hash?: string;
  snapshot?: unknown;
  issues?: unknown[];
  conflicts?: unknown[];
}

export function toolResponse(result: PlanOperationResult) {
  return { content: [{ type: "text" as const, text: renderPlanOperationResult(result) }], details: result };
}

export function renderPlanOperationResult(result: PlanOperationResult): string {
  const lines = [`${result.status}: ${result.message}`];
  if (result.path) lines.push(`path: ${result.path}`);
  if (result.document_hash) lines.push(`document_hash: ${result.document_hash}`);
  if (result.issues?.length) lines.push(`issues: ${JSON.stringify(result.issues)}`);
  if (result.conflicts?.length) lines.push(`conflicts: ${JSON.stringify(result.conflicts)}`);
  return lines.join("\n");
}
