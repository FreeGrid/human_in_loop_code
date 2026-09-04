export const HARNESS = "pi-plan/v1";

export type PlanStage =
  | "what_why"
  | "plan"
  | "tasks"
  | "awaiting_execution_approval"
  | "executing"
  | "awaiting_round_decision"
  | "completed"
  | "abandoned";

export type StageStatus = "drafting" | "ready_for_review" | "awaiting_human" | "in_progress" | "closed";

export type SectionName = "what_why" | "plan" | "tasks" | "review";

export interface PlanMetadata {
  harness: typeof HARNESS;
  plan_id: string;
  round: number;
  stage: PlanStage;
  stage_status: StageStatus;
  approved_what_why_hash?: string;
  approved_plan_hash?: string;
  reviewed_tasks_hash?: string;
  closure_reason?: string;
  [key: string]: unknown;
}

export interface PlanDocument {
  path: string;
  text: string;
  document_hash: string;
  metadata: PlanMetadata;
  body: string;
  sections: Record<SectionName, string>;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export interface TaskBlock {
  id: string;
  title: string;
  round: number;
  completed: boolean;
  completionLine: string;
  acceptanceItems: string[];
  dependsOn: string[];
  definition: string;
}

export const STAGE_STATUS: Record<PlanStage, readonly StageStatus[]> = {
  what_why: ["drafting", "ready_for_review"],
  plan: ["drafting", "ready_for_review"],
  tasks: ["drafting", "ready_for_review"],
  awaiting_execution_approval: ["awaiting_human"],
  executing: ["in_progress"],
  awaiting_round_decision: ["awaiting_human"],
  completed: ["closed"],
  abandoned: ["closed"],
};

export function isTerminalStage(stage: PlanStage): boolean {
  return stage === "completed" || stage === "abandoned";
}
