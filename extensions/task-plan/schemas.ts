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

export const PlanSubmitSectionParameters = Type.Object({ expected_document_hash: ExpectedHash, section:Type.Optional(StringEnum(["plan","tasks"] as const)), content: Type.String(), planPath: PlanPath });
export type PlanSubmitSectionParams = Static<typeof PlanSubmitSectionParameters>;

export const PlanAdvanceParameters = Type.Object({ expected_document_hash: ExpectedHash, action: Type.Optional(StringEnum(["next", "approve_contract", "execute", "next_round", "complete"] as const)), reason: Type.Optional(Type.String()), planPath: PlanPath });
export type PlanAdvanceParams = Static<typeof PlanAdvanceParameters>;

export const PlanReviewParameters = Type.Object({ expected_document_hash: ExpectedHash, task_id:Type.Optional(Type.String({pattern:"^T\\d{3}$"})), candidate_tasks: Type.Optional(Type.String()), summary: Type.Optional(Type.String()), planPath: PlanPath });
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
});
export type PlanReportTaskResultParams = Static<typeof PlanReportTaskResultParameters>;

export const PlanSetTaskStatusParameters = Type.Object({ expected_document_hash: ExpectedHash, task_id: Type.String({ pattern: "^T\\d{3}$" }), status: StringEnum(["open", "completed"] as const), planPath: PlanPath });
export type PlanSetTaskStatusParams = Static<typeof PlanSetTaskStatusParameters>;

export const PlanExecuteParameters = Type.Object({ expected_document_hash: ExpectedHash, planPath: PlanPath, task_id: Type.Optional(Type.String({ pattern: "^T\\d{3}$" })), target_root: Type.Optional(Type.String()), governance_root: Type.Optional(Type.String()) });
export const PlanStartAndBindParameters = PlanExecuteParameters;
export const PlanReportTaskResultsParameters = Type.Object({
  expected_document_hash:ExpectedHash,
  idempotency_key:Type.String({pattern:"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"}),
  task_id: Type.String({ pattern: "^T\\d{3}$" }),
  reports: Type.Array(Type.Object({
    work_item_id: Type.Optional(Type.String({ pattern: "^T\\d{3}\\.W\\d{3}$" })),
    files: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 32 })),
    change_types: Type.Optional(Type.Array(StringEnum(["api", "cli", "config", "extension", "code", "docs", "test", "other"] as const), { maxItems: 8 })),
    result: StringEnum(["in_progress", "blocked", "completed"] as const),
    summary: Type.String(),
  }), { minItems: 1, maxItems: 64 }),
});
export const PlanFinalizeParameters = Type.Object({ expected_document_hash: ExpectedHash, planPath: PlanPath, task_id: Type.String({ pattern: "^T\\d{3}$" }) });
export const PlanDocSyncParameters = Type.Object({ expected_document_hash: ExpectedHash, planPath: PlanPath, task_id: Type.String({ pattern: "^T\\d{3}$" }), enabled: Type.Boolean() });

export type PlanStartAndBindParams = Static<typeof PlanStartAndBindParameters>;
export type PlanReportTaskResultsParams = Static<typeof PlanReportTaskResultsParameters>;

export const PlanAbandonParameters = Type.Object({ expected_document_hash: ExpectedHash, reason: Type.Optional(Type.String()), planPath: PlanPath });
export type PlanAbandonParams = Static<typeof PlanAbandonParameters>;

export const PlanVerifyAcceptanceParameters = Type.Object({expected_document_hash:ExpectedHash,planPath:PlanPath,task_id:Type.String({pattern:"^T\\d{3}$"}),acceptance_id:Type.String({pattern:"^T\\d{3}\\.A\\d{3}$"})});

export const PlanReconcileParameters = Type.Object({expected_document_hash:ExpectedHash,planPath:PlanPath});

export const PlanRecoveryStatusParameters = Type.Object({operation_id:Type.Optional(Type.String({format:"uuid"})),planPath:PlanPath});
export const PlanRecoverParameters = Type.Object({operation_id:Type.String({format:"uuid"}),expected_document_hash:ExpectedHash,expected_journal_head:Type.String({pattern:"^[a-f0-9]{64}$"}),planPath:PlanPath});

export const PlanSubmitNodeParameters = Type.Object({expected_document_hash:ExpectedHash,node_id:Type.String({pattern:"^T\\d{3}$"}),content:Type.String(),planPath:PlanPath});
