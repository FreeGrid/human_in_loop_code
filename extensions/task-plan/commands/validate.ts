import { formatValidation, validateForStage } from "../validators.js";
import type { CommandContext, CommandServices } from "./shared.js";
import { activePlanningStage, contentForStage, notifyFailure, notifyIssues } from "./shared.js";

export async function handlePlanValidate(_args: string, ctx: CommandContext, services: CommandServices): Promise<void> {
  try {
    const work = await services.workspace.getActiveWork();
    if (!work) {
      notifyFailure(ctx, "There is no active planning work to validate.", services.workspace.paths.currentPointer, "Run /plan:new <goal>.");
      return;
    }
    const inspection = await services.workspace.inspect(work);
    if (inspection.issues.length > 0) {
      notifyIssues(ctx, inspection.issues);
      return;
    }
    const stage = activePlanningStage(inspection);
    if (!stage) {
      notifyFailure(ctx, `The workspace is in non-editable stage '${inspection.stage}'.`, work.directory, "Run /plan:status and repair the incomplete transition.");
      return;
    }
    const content = contentForStage(inspection, stage);
    if (content === undefined) {
      notifyFailure(ctx, "The current artifact is missing.", work.directory, "Restore the current artifact, then retry /plan:validate.");
      return;
    }
    const artifact = stage === "spec" ? inspection.spec : stage === "plan" ? inspection.plan : inspection.tasks;
    const validation = validateForStage(content, stage, work.id, artifact.path);
    ctx.ui.notify(formatValidation(validation), validation.valid ? "info" : "error");
  } catch (error) {
    notifyFailure(ctx, "Validation could not be completed.", services.workspace.paths.root, "Repair the reported file or permissions, then retry /plan:validate.", error);
  }
}
