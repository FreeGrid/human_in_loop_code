import { buildRevisionPrompt } from "../prompts.js";
import type { CommandContext, CommandServices } from "./shared.js";
import { activePlanningStage, notifyFailure, notifyIssues, sendPlanningPrompt } from "./shared.js";

export async function handlePlanRevise(args: string, ctx: CommandContext, services: CommandServices): Promise<void> {
  const instruction = args.trim();
  if (!instruction) {
    notifyFailure(ctx, "The artifact was not revised because the instruction is empty.", services.workspace.paths.root, "Run /plan:revise <instruction>.");
    return;
  }
  if (!ctx.isIdle()) {
    notifyFailure(ctx, "The artifact was not revised because the agent is busy.", services.workspace.paths.root, "Wait for Pi to become idle, then retry /plan:revise.");
    return;
  }

  try {
    const work = await services.workspace.getActiveWork();
    if (!work) {
      notifyFailure(ctx, "There is no active planning work to revise.", services.workspace.paths.currentPointer, "Run /plan:new <goal>.");
      return;
    }
    const inspection = await services.workspace.inspect(work);
    if (inspection.issues.length > 0) {
      notifyIssues(ctx, inspection.issues);
      return;
    }
    const stage = activePlanningStage(inspection);
    if (!stage) {
      notifyFailure(ctx, "The current artifact is approved or unavailable and cannot be revised in V1.", work.directory, "Run /plan:status; approved artifacts require a new work item.");
      return;
    }
    const artifact = stage === "spec" ? inspection.spec : stage === "plan" ? inspection.plan : inspection.tasks;
    if (artifact.status !== "draft") {
      notifyFailure(ctx, "The current artifact is approved and frozen.", artifact.path, "Create a new planning work item; V1 does not reopen approved artifacts.");
      return;
    }
    await sendPlanningPrompt(services, artifact.path, "revise", buildRevisionPrompt(work, stage, instruction));
    ctx.ui.notify(`Pi is revising ${artifact.path}. Approval status remains draft.`, "info");
  } catch (error) {
    services.guard.clear();
    notifyFailure(ctx, "The revision turn could not be started.", services.workspace.paths.root, "Inspect the active artifact, then retry /plan:revise.", error);
  }
}
