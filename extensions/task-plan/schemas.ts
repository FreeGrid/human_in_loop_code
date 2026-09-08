import { StringEnum, Type, type Static } from "@mariozechner/pi-ai";

export const PlanPath = Type.Optional(Type.String({ description: "Optional Harness Plan path. Defaults to the only unfinished Harness Plan in the current workspace." }));
export const ExpectedHash = Type.String({ description: "document_hash from the latest plan_get/plan_status/previous mutating tool result." });

export const PlanStartParameters = Type.Object({
  goal: Type.String(),
  title: Type.Optional(Type.String({ description: "Optional concise model-summarized plan title used for the Markdown heading and filename. The full goal is still preserved in Original Request." })),
});
export type PlanStartParams = Static<typeof PlanStartParameters>;

export const PlanGetParameters = Type.Object({ planPath: PlanPath });
export type PlanGetParams = Static<typeof PlanGetParameters>;

export const PlanSubmitSectionParameters = Type.Object({ expected_document_hash: ExpectedHash, content: Type.String(), planPath: PlanPath });
export type PlanSubmitSectionParams = Static<typeof PlanSubmitSectionParameters>;

export const PlanAdvanceParameters = Type.Object({ expected_document_hash: ExpectedHash, action: Type.Optional(StringEnum(["next", "execute", "next_round", "complete"] as const)), reason: Type.Optional(Type.String()), planPath: PlanPath });
export type PlanAdvanceParams = Static<typeof PlanAdvanceParameters>;

export const PlanReviewParameters = Type.Object({ expected_document_hash: ExpectedHash, candidate_tasks: Type.Optional(Type.String()), summary: Type.Optional(Type.String()), planPath: PlanPath });
export type PlanReviewParams = Static<typeof PlanReviewParameters>;

export const PlanBindTaskParameters = Type.Object({ expected_document_hash: ExpectedHash, task_id: Type.String({ pattern: "^T\\d{3}$" }), planPath: PlanPath });
export type PlanBindTaskParams = Static<typeof PlanBindTaskParameters>;

export const PlanReportTaskResultParameters = Type.Object({
  task_id: Type.String({ pattern: "^T\\d{3}$" }),
  work_item_id: Type.Optional(Type.String({ pattern: "^T\\d{3}\\.W\\d{3}$" })),
  files: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 32 })),
  change_types: Type.Optional(Type.Array(StringEnum(["api", "cli", "config", "extension", "code", "docs", "test", "other"] as const), { maxItems: 8 })),
  result: StringEnum(["in_progress", "blocked", "completed"] as const),
  summary: Type.String(),
  acceptance_results: Type.Optional(Type.Array(Type.Object({ item: Type.String(), satisfied: Type.Boolean() }))),
});
export type PlanReportTaskResultParams = Static<typeof PlanReportTaskResultParameters>;

export const PlanSetTaskStatusParameters = Type.Object({ expected_document_hash: ExpectedHash, task_id: Type.String({ pattern: "^T\\d{3}$" }), status: StringEnum(["open", "completed"] as const), planPath: PlanPath });
export type PlanSetTaskStatusParams = Static<typeof PlanSetTaskStatusParameters>;

export const PlanExecuteParameters = Type.Object({ expected_document_hash: ExpectedHash, planPath: PlanPath, task_id: Type.Optional(Type.String({ pattern: "^T\\d{3}$" })), target_root: Type.Optional(Type.String()), governance_root: Type.Optional(Type.String()) });
export const PlanFinalizeParameters = Type.Object({ expected_document_hash: ExpectedHash, planPath: PlanPath, task_id: Type.String({ pattern: "^T\\d{3}$" }) });
export const PlanDocSyncParameters = Type.Object({ expected_document_hash: ExpectedHash, planPath: PlanPath, task_id: Type.String({ pattern: "^T\\d{3}$" }), enabled: Type.Boolean() });

export const PlanAbandonParameters = Type.Object({ expected_document_hash: ExpectedHash, reason: Type.Optional(Type.String()), planPath: PlanPath });
export type PlanAbandonParams = Static<typeof PlanAbandonParameters>;
