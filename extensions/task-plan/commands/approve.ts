import { buildPlanPrompt, buildTasksPrompt } from "../prompts.js";
import { renderPlanTemplate, renderTasksTemplate } from "../templates.js";
import { formatValidation, validateForStage } from "../validators.js";
import type { PlanningStage } from "../types.js";
import type { CommandContext, CommandServices } from "./shared.js";
import {
  activePlanningStage,
  contentForStage,
  notifyFailure,
  notifyIssues,
  sendPlanningPrompt,
} from "./shared.js";

export async function handlePlanApprove(_args: string, ctx: CommandContext, services: CommandServices): Promise<void> {
  if (!ctx.isIdle()) {
    notifyFailure(ctx, "Approval was not started because the agent is busy.", services.workspace.paths.root, "Wait for Pi to become idle, then retry /plan:approve.");
    return;
  }
  if (!ctx.hasUI) {
    notifyFailure(ctx, "Approval requires an interactive Human UI; non-interactive approval is forbidden.", services.workspace.paths.root, "Open Pi in interactive TUI mode and run /plan:approve.");
    return;
  }

  try {
    const work = await services.workspace.getActiveWork();
    if (!work) {
      notifyFailure(ctx, "There is no active planning work to approve.", services.workspace.paths.currentPointer, "Run /plan:new <goal>.");
      return;
    }
    const inspection = await services.workspace.inspect(work);
    if (inspection.issues.length > 0) {
      notifyIssues(ctx, inspection.issues);
      return;
    }
    const stage = activePlanningStage(inspection);
    if (!stage) {
      notifyFailure(ctx, `Stage '${inspection.stage}' cannot be approved.`, work.directory, "Run /plan:status and repair the transition before retrying.");
      return;
    }
    const content = contentForStage(inspection, stage);
    const artifact = stage === "spec" ? inspection.spec : stage === "plan" ? inspection.plan : inspection.tasks;
    if (content === undefined) {
      notifyFailure(ctx, "The artifact selected for approval is missing.", artifact.path, "Restore it and run /plan:validate.");
      return;
    }

    const validation = validateForStage(content, stage, work.id, artifact.path, { forApproval: true });
    if (!validation.valid) {
      ctx.ui.notify(`${formatValidation(validation)}\nNext: fix the errors and run /plan:validate before approval.`, "error");
      return;
    }
    const warnings = validation.issues.filter((issue) => issue.severity === "warning").length;
    const confirmed = await ctx.ui.confirm(
      stage === "tasks" ? "Final task approval" : `Approve ${stage}`,
      `Artifact: ${artifact.path}\nWarnings: ${warnings}\n\nApprove this artifact and advance the workflow?`,
    );
    if (!confirmed) {
      ctx.ui.notify(`Approval cancelled. ${artifact.path} remains draft.`, "warning");
      return;
    }

    if (stage === "spec") {
      await approveAndStartNext(services, ctx, work, stage, renderPlanTemplate(work.id));
    } else if (stage === "plan") {
      await approveAndStartNext(services, ctx, work, stage, renderTasksTemplate(work.id));
    } else {
      if (inspection.spec.status !== "approved" || inspection.plan.status !== "approved") {
        notifyFailure(ctx, "Tasks cannot be approved because upstream artifacts are not approved.", artifact.path, "Repair spec.md and plan.md approval state first.");
        return;
      }
      const completed = await services.workspace.approveTasksAndComplete(work);
      ctx.ui.notify(`Planning work completed.\nFinal tasks: ${completed.tasksPath}`, "info");
    }
  } catch (error) {
    services.guard.clear();
    notifyFailure(ctx, "Approval failed and the workflow did not advance cleanly.", services.workspace.paths.root, "Run /plan:status, inspect the named artifacts, and retry only after repairing the error.", error);
  }
}

async function approveAndStartNext(
  services: CommandServices,
  ctx: CommandContext,
  work: NonNullable<Awaited<ReturnType<CommandServices["workspace"]["getActiveWork"]>>>,
  stage: Exclude<PlanningStage, "tasks">,
  nextContent: string,
): Promise<void> {
  const currentPath = stage === "spec" ? work.specPath : work.planPath;
  const nextPath = stage === "spec" ? work.planPath : work.tasksPath;
  await services.workspace.approveAndCreateNext(currentPath, nextPath, nextContent);
  const operation = stage === "spec" ? "plan" : "tasks";
  const prompt = stage === "spec" ? buildPlanPrompt(work) : buildTasksPrompt(work);
  try {
    await sendPlanningPrompt(services, nextPath, operation, prompt);
    ctx.ui.notify(`Approved ${currentPath}. Pi is drafting ${nextPath}.`, "info");
  } catch (error) {
    notifyFailure(ctx, `Approved ${currentPath}, but Pi could not start the next generation turn.`, nextPath, `Run /plan:revise <instruction> to generate the draft ${stage === "spec" ? "plan" : "tasks"}.`, error);
  }
}
