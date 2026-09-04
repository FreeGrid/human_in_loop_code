import { renderOperationResult } from "../operation-result.js";
import { ControlWorkspaceService } from "../operations.js";
import { continueSessionInControlRepository } from "../session-navigation.js";
import { preferredControlPath, type ControlWorkspaceSessionState } from "../session-state.js";
import type { ControlCommandContext } from "./shared.js";
import { commandFailure } from "./shared.js";

export async function handleControlEnter(
  args: string,
  ctx: ControlCommandContext,
  sessionState?: ControlWorkspaceSessionState,
): Promise<void> {
  try {
    const requestedPath = preferredControlPath(args, sessionState) || ctx.cwd;
    const status = await new ControlWorkspaceService(ctx.cwd).status(requestedPath);
    if (status.status !== "applied") {
      ctx.ui.notify([
        renderOperationResult(status),
        "Run /control:enter /exact/path/to/name_control, or initialize a workspace first.",
      ].join("\n"), status.status === "conflict" ? "error" : "warning");
      return;
    }
    const control = status.summary.repositories?.find((repository) => repository.kind === "control");
    if (!control) {
      ctx.ui.notify("The initialized workspace does not contain a control repository binding.", "error");
      return;
    }
    if (sessionState) sessionState.activeControlPath = control.absolutePath;
    const navigation = await continueSessionInControlRepository(ctx, control.absolutePath);
    if (navigation === "already-current") {
      ctx.ui.notify(`Pi is already working in the control repository: ${control.absolutePath}`, "info");
    }
  } catch (error) {
    commandFailure(ctx, "Enter control repository", error);
  }
}
