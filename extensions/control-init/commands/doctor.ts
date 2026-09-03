import { renderDoctorReport } from "../operation-result.js";
import { ControlWorkspaceService } from "../operations.js";
import type { ControlCommandContext } from "./shared.js";
import { commandFailure } from "./shared.js";

export async function handleControlDoctor(args: string, ctx: ControlCommandContext): Promise<void> {
  try {
    const report = await new ControlWorkspaceService(ctx.cwd).doctor(args.trim() || undefined);
    ctx.ui.notify(renderDoctorReport(report), report.ok ? "info" : "error");
  } catch (error) {
    commandFailure(ctx, "Control workspace doctor", error);
  }
}
