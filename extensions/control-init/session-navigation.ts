import { resolve } from "node:path";
import { SessionManager, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ControlCommandContext } from "./commands/shared.js";

type SessionNavigationContext = ControlCommandContext & Partial<Pick<
  ExtensionCommandContext,
  "sessionManager" | "switchSession"
>>;

export type ControlNavigationResult = "already-current" | "switched" | "unavailable" | "cancelled";

export async function continueSessionInControlRepository(
  ctx: SessionNavigationContext,
  controlPath: string,
): Promise<ControlNavigationResult> {
  if (resolve(ctx.cwd) === resolve(controlPath)) return "already-current";

  const currentSessionFile = ctx.sessionManager?.getSessionFile();
  if (!currentSessionFile || !ctx.switchSession) {
    ctx.ui.notify([
      `Workspace initialized successfully at: ${controlPath}`,
      "Pi could not switch directories automatically because this session is not persisted.",
      `Restart from the control repository: cd ${JSON.stringify(controlPath)} && pi`,
    ].join("\n"), "warning");
    return "unavailable";
  }

  try {
    const continued = SessionManager.forkFrom(currentSessionFile, controlPath);
    const continuedSessionFile = continued.getSessionFile();
    if (!continuedSessionFile) throw new Error("Pi did not create a persisted continuation session.");
    const switched = await ctx.switchSession(continuedSessionFile, {
      withSession: async (nextCtx) => {
        nextCtx.ui.notify([
          "Control workspace initialized successfully.",
          `Pi is now working in: ${nextCtx.cwd}`,
        ].join("\n"), "info");
      },
    });
    if (switched.cancelled) {
      ctx.ui.notify([
        `Workspace initialized successfully at: ${controlPath}`,
        "Pi directory switching was cancelled. Start a new Pi session from the control repository to continue.",
      ].join("\n"), "warning");
      return "cancelled";
    }
    return "switched";
  } catch (error) {
    ctx.ui.notify([
      `Workspace initialized successfully at: ${controlPath}`,
      `Pi could not switch to the control repository: ${error instanceof Error ? error.message : String(error)}`,
      `Restart from the control repository: cd ${JSON.stringify(controlPath)} && pi`,
    ].join("\n"), "warning");
    return "unavailable";
  }
}
