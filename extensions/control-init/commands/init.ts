import { runInitWizard } from "../wizard.js";
import type { ControlCommandContext } from "./shared.js";
import { commandFailure } from "./shared.js";

export async function handleControlInit(_args: string, ctx: ControlCommandContext): Promise<void> {
  try {
    await runInitWizard(ctx);
  } catch (error) {
    commandFailure(ctx, "Control workspace initialization", error);
  }
}
