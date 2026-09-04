import { resolve } from "node:path";
import { SessionManager, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ControlCommandContext } from "./commands/shared.js";

type SessionNavigationContext = ControlCommandContext & Partial<Pick<
  ExtensionCommandContext,
  "sessionManager" | "switchSession"
>>;

export type ControlNavigationResult = "already-current" | "switched" | "unavailable" | "cancelled";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function restartCommand(controlPath: string): string {
  return `cd ${shellQuote(controlPath)} && pi`;
}

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
      `Restart from the control repository: ${restartCommand(controlPath)}`,
    ].join("\n"), "warning");
    return "unavailable";
  }

  let continuedSessionFile: string;
  try {
    const continued = SessionManager.forkFrom(currentSessionFile, controlPath);
    const createdSessionFile = continued.getSessionFile();
    if (!createdSessionFile) throw new Error("Pi did not create a persisted continuation session.");
    continuedSessionFile = createdSessionFile;
  } catch (error) {
    ctx.ui.notify([
      `Workspace initialized successfully at: ${controlPath}`,
      `Pi could not prepare a control-repository session: ${error instanceof Error ? error.message : String(error)}`,
      `Restart from the control repository: ${restartCommand(controlPath)}`,
    ].join("\n"), "warning");
    return "unavailable";
  }

  try {
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
  } catch {
    // switchSession may reject after invalidating ctx. The Pi host reports the
    // replacement failure; touching the old command context here is unsafe.
    return "unavailable";
  }
}
