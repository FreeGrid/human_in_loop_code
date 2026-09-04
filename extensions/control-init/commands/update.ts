import { runUpdateWizard } from "../wizard.js";
import type { ControlCommandContext } from "./shared.js";
import { commandFailure } from "./shared.js";

export async function handleControlUpdate(args: string, ctx: ControlCommandContext): Promise<void> {
  try {
    await runUpdateWizard(ctx, args.trim() || ctx.cwd);
  } catch (error) {
    commandFailure(ctx, "Control workspace update", error);
  }
}
