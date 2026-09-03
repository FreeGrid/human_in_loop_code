export type PlanningStage = "spec" | "plan" | "tasks";

export type ArtifactStatus = "draft" | "approved";

export interface ArtifactMetadata {
  harness: "task-plan/v1";
  work_id: string;
  stage: PlanningStage;
  status: ArtifactStatus;
}

export interface ActiveWork {
  id: string;
  directory: string;
  specPath: string;
  planPath: string;
  tasksPath: string;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
  taskId?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export type GenerationOperation = "specify" | "plan" | "tasks" | "converge" | "revise";
