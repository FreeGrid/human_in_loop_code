import { buildSpecifyPrompt } from "../prompts.js";
import { renderSpecTemplate } from "../templates.js";
import type { CommandContext, CommandServices } from "./shared.js";
import { notifyFailure, sendPlanningPrompt } from "./shared.js";

export async function handlePlanNew(args: string, ctx: CommandContext, services: CommandServices): Promise<void> {
  const goal = args.trim();
  if (!goal) {
    notifyFailure(ctx, "No planning work was created because the goal is empty.", "planning/.current", "Run /plan:new <goal> with a concrete goal.");
    return;
  }
  if (!ctx.isIdle()) {
    notifyFailure(ctx, "No planning work was created because the agent is busy.", "planning/.current", "Wait for Pi to become idle, then retry /plan:new.");
    return;
  }

  try {
    const work = await services.workspace.createWork(goal, (created) => renderSpecTemplate(created.id, goal));
    try {
      await sendPlanningPrompt(services, work.specPath, "specify", buildSpecifyPrompt(work));
      ctx.ui.notify(`Created ${work.id}. Pi is drafting ${work.specPath}.`, "info");
    } catch (error) {
      notifyFailure(
        ctx,
        "The work was created, but Pi could not start the specification turn.",
        work.specPath,
        "Run /plan:revise <instruction> to retry specification generation.",
        error,
      );
    }
  } catch (error) {
    notifyFailure(ctx, "Planning work could not be created.", "planning/.current", "Inspect the pointer and filesystem permissions, then retry /plan:new.", error);
  }
}
