import { renderOperationResult } from "../operation-result.js";
import { ControlWorkspaceService } from "../operations.js";
import { preferredControlPath, type ControlWorkspaceSessionState } from "../session-state.js";
import type { ControlCommandContext } from "./shared.js";
import { commandFailure } from "./shared.js";

export async function handleControlStatus(
  args: string,
  ctx: ControlCommandContext,
  sessionState?: ControlWorkspaceSessionState,
): Promise<void> {
  try {
    const result = await new ControlWorkspaceService(ctx.cwd).status(preferredControlPath(args, sessionState));
    ctx.ui.notify(renderOperationResult(result), result.status === "conflict" ? "error" : "info");
  } catch (error) {
    commandFailure(ctx, "Control workspace status", error);
  }
}
