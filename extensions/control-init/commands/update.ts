import { runUpdateWizard } from "../wizard.js";
import { preferredControlPath, type ControlWorkspaceSessionState } from "../session-state.js";
import type { ControlCommandContext } from "./shared.js";
import { commandFailure } from "./shared.js";

export async function handleControlUpdate(
  args: string,
  ctx: ControlCommandContext,
  sessionState?: ControlWorkspaceSessionState,
): Promise<void> {
  try {
    await runUpdateWizard(ctx, preferredControlPath(args, sessionState) || ctx.cwd);
  } catch (error) {
    commandFailure(ctx, "Control workspace update", error);
  }
}
