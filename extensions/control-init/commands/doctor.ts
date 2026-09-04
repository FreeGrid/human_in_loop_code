import { renderDoctorReport } from "../operation-result.js";
import { ControlWorkspaceService } from "../operations.js";
import { preferredControlPath, type ControlWorkspaceSessionState } from "../session-state.js";
import type { ControlCommandContext } from "./shared.js";
import { commandFailure } from "./shared.js";

export async function handleControlDoctor(
  args: string,
  ctx: ControlCommandContext,
  sessionState?: ControlWorkspaceSessionState,
): Promise<void> {
  try {
    const report = await new ControlWorkspaceService(ctx.cwd).doctor(preferredControlPath(args, sessionState));
    ctx.ui.notify(renderDoctorReport(report), report.ok ? "info" : "error");
  } catch (error) {
    commandFailure(ctx, "Control workspace doctor", error);
  }
}
