import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { GenerationGuard } from "../generation-guard.js";
import type { GenerationOperation, PlanningStage, ValidationIssue } from "../types.js";
import { artifactPathForStage, WorkspaceService, type WorkInspection } from "../workspace.js";

export interface CommandServices {
  pi: Pick<ExtensionAPI, "sendUserMessage">;
  workspace: WorkspaceService;
  guard: GenerationGuard;
}

export type CommandContext = Pick<ExtensionCommandContext, "cwd" | "hasUI" | "isIdle" | "ui">;

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function notifyFailure(
  ctx: CommandContext,
  summary: string,
  path: string,
  next: string,
  error?: unknown,
): void {
  const detail = error === undefined ? "" : `\nDetail: ${errorText(error)}`;
  ctx.ui.notify(`${summary}\nFile: ${path}\nNext: ${next}${detail}`, "error");
}

export function notifyIssues(ctx: CommandContext, issues: ValidationIssue[], heading = "Planning workspace is invalid"): void {
  const lines = issues.map((issue) => `- ${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`);
  ctx.ui.notify(`${heading}\n${lines.join("\n")}\nNext: repair the named planning artifact, then run /plan:validate.`, "error");
}

export async function sendPlanningPrompt(
  services: CommandServices,
  targetPath: string,
  operation: GenerationOperation,
  prompt: string,
): Promise<void> {
  await services.guard.activate(targetPath, operation);
  try {
    services.pi.sendUserMessage(prompt);
  } catch (error) {
    services.guard.clear();
    throw error;
  }
}

export function activePlanningStage(inspection: WorkInspection): PlanningStage | null {
  if (inspection.stage === "spec" || inspection.stage === "plan" || inspection.stage === "tasks") return inspection.stage;
  return null;
}

export function contentForStage(inspection: WorkInspection, stage: PlanningStage): string | undefined {
  if (stage === "spec") return inspection.spec.content;
  if (stage === "plan") return inspection.plan.content;
  return inspection.tasks.content;
}

export function pathForStage(services: CommandServices, workId: string, stage: PlanningStage): string {
  const directory = `${services.workspace.paths.activeRoot}/${workId}`;
  return artifactPathForStage(
    {
      id: workId,
      directory,
      specPath: `${directory}/spec.md`,
      planPath: `${directory}/plan.md`,
      tasksPath: `${directory}/tasks.md`,
    },
    stage,
  );
}
