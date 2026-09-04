import { runInitWizard } from "../wizard.js";
import type { ControlWorkspaceSessionState } from "../session-state.js";
import { continueSessionInControlRepository } from "../session-navigation.js";
import type { ControlCommandContext } from "./shared.js";
import { commandFailure } from "./shared.js";

export async function handleControlInit(
  _args: string,
  ctx: ControlCommandContext,
  sessionState?: ControlWorkspaceSessionState,
): Promise<void> {
  try {
    const controlPath = await runInitWizard(ctx);
    if (controlPath) {
      if (sessionState) sessionState.activeControlPath = controlPath;
      await continueSessionInControlRepository(ctx, controlPath);
    }
  } catch (error) {
    commandFailure(ctx, "Control workspace initialization", error);
  }
}
