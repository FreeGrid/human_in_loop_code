import { relative } from "node:path";
import { validateForStage } from "../validators.js";
import type { ArtifactSnapshot, WorkInspection } from "../workspace.js";
import type { CommandContext, CommandServices } from "./shared.js";
import { activePlanningStage, contentForStage, notifyFailure, notifyIssues } from "./shared.js";

function artifactStatus(artifact: ArtifactSnapshot): string {
  if (!artifact.exists) return "missing";
  if (artifact.error) return `invalid (${artifact.error})`;
  return artifact.status ?? "invalid";
}

function nextCommand(inspection: WorkInspection, directory: string): string {
  if (inspection.stage === "spec") return `review ${directory}/spec.md, then run /plan:approve`;
  if (inspection.stage === "plan") return `review ${directory}/plan.md, then run /plan:approve`;
  if (inspection.stage === "tasks") return `run /plan:converge, review ${directory}/tasks.md, then run /plan:approve`;
  if (inspection.stage === "preparing-plan") return "repair the missing plan.md transition, then run /plan:status";
  if (inspection.stage === "preparing-tasks") return "repair the missing tasks.md transition, then run /plan:status";
  if (inspection.stage === "completed") return "move the completed work out of active and clear planning/.current";
  return "repair the reported workspace errors, then run /plan:validate";
}

export async function handlePlanStatus(_args: string, ctx: CommandContext, services: CommandServices): Promise<void> {
  let work;
  try {
    work = await services.workspace.getActiveWork();
  } catch (error) {
    notifyFailure(ctx, "The active planning pointer is invalid.", services.workspace.paths.currentPointer, "Repair or remove the pointer after checking the active work directory.", error);
    return;
  }
  if (!work) {
    ctx.ui.notify("No active planning work.\nStart with /plan:new <goal>", "info");
    return;
  }

  const inspection = await services.workspace.inspect(work);
  if (inspection.issues.length > 0) notifyIssues(ctx, inspection.issues);
  const stage = activePlanningStage(inspection);
  let validationSummary = "not available";
  if (stage) {
    const content = contentForStage(inspection, stage);
    if (content !== undefined) {
      const artifact = stage === "spec" ? inspection.spec : stage === "plan" ? inspection.plan : inspection.tasks;
      const validation = validateForStage(content, stage, work.id, artifact.path);
      const errors = validation.issues.filter((issue) => issue.severity === "error").length;
      validationSummary = `${errors} error(s), ${validation.issues.length - errors} warning(s)`;
    }
  }
  const directory = relative(ctx.cwd, work.directory) || work.directory;
  ctx.ui.notify(
    [
      `Work: ${work.id}`,
      `Directory: ${directory}`,
      `Stage: ${inspection.stage}`,
      `spec.md: ${artifactStatus(inspection.spec)}`,
      `plan.md: ${artifactStatus(inspection.plan)}`,
      `tasks.md: ${artifactStatus(inspection.tasks)}`,
      `Validation: ${validationSummary}`,
      "",
      `Next: ${nextCommand(inspection, directory)}`,
    ].join("\n"),
    inspection.issues.length > 0 ? "warning" : "info",
  );
}
