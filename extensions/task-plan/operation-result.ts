export interface PlanOperationResult {
  status: "ok" | "created" | "applied" | "conflict" | "validation_error" | "state_changed";
  message: string;
  path?: string;
  document_hash?: string;
  operation_id?: string;
  observed_document_hash?: string;
  snapshot?: unknown;
  issues?: unknown[];
  conflicts?: unknown[];
  batch?:{atomic:true;idempotency_key:string;replayed?:boolean;items:Array<{work_item_id:string;status:"applied"|"rejected"|"not_applied"|"recovery_required";report_id?:string;message?:string}>};
}

export function toolResponse(result: PlanOperationResult) {
  return { content: [{ type: "text" as const, text: renderPlanOperationResult(result) }], details: result };
}

export function renderPlanOperationResult(result: PlanOperationResult): string {
  const lines = [`${result.status}: ${result.message}`];
  if (result.path) lines.push(`path: ${result.path}`);
  if (result.document_hash) lines.push(`document_hash: ${result.document_hash}`);
  if (result.operation_id) lines.push(`operation_id: ${result.operation_id}`);
  if (result.observed_document_hash) lines.push(`observed_document_hash: ${result.observed_document_hash}`);
  if(result.batch)lines.push(`batch: ${JSON.stringify(result.batch)}`);
  if (result.issues?.length) lines.push(`issues: ${JSON.stringify(result.issues)}`);
  if (result.conflicts?.length) lines.push(`conflicts: ${JSON.stringify(result.conflicts)}`);
  return lines.join("\n");
}
