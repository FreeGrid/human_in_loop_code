import { buildConvergePrompt } from "../prompts.js";
import { validateTasks } from "../validators.js";
import type { CommandContext, CommandServices } from "./shared.js";
import { notifyFailure, notifyIssues, sendPlanningPrompt } from "./shared.js";

export async function handlePlanConverge(_args: string, ctx: CommandContext, services: CommandServices): Promise<void> {
  if (!ctx.isIdle()) {
    notifyFailure(ctx, "Convergence was not started because the agent is busy.", services.workspace.paths.root, "Wait for Pi to become idle, then retry /plan:converge.");
    return;
  }
  try {
    const work = await services.workspace.getActiveWork();
    if (!work) {
      notifyFailure(ctx, "There is no active task list to converge.", services.workspace.paths.currentPointer, "Run /plan:new <goal> and complete the Spec and Plan approvals first.");
      return;
    }
    const inspection = await services.workspace.inspect(work);
    if (inspection.issues.length > 0) {
      notifyIssues(ctx, inspection.issues);
      return;
    }
    if (
      inspection.stage !== "tasks" ||
      inspection.spec.status !== "approved" ||
      inspection.plan.status !== "approved" ||
      inspection.tasks.status !== "draft" ||
      inspection.tasks.content === undefined
    ) {
      notifyFailure(ctx, "Convergence requires approved spec.md and plan.md plus a draft tasks.md.", work.directory, "Finish the preceding approvals or restore tasks.md, then retry /plan:converge.");
      return;
    }

    const initial = validateTasks(inspection.tasks.content, work.id, work.tasksPath);
    const errorCount = initial.issues.filter((issue) => issue.severity === "error").length;
    await sendPlanningPrompt(services, work.tasksPath, "converge", buildConvergePrompt(work));
    ctx.ui.notify(
      `Pi is converging ${work.tasksPath}. Initial deterministic validation found ${errorCount} error(s).\nAfter generation, review the diff, run /plan:validate, then /plan:approve.`,
      "info",
    );
  } catch (error) {
    services.guard.clear();
    notifyFailure(ctx, "The convergence turn could not be started.", services.workspace.paths.root, "Inspect task state and retry /plan:converge.", error);
  }
}
