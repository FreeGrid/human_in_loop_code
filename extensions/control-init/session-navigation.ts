import { resolve } from "node:path";
import { open } from "node:fs/promises";
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
    const source = ctx.sessionManager;
    // Pi allocates a session pathname before its first assistant message flushes
    // anything to disk. Also preserve buffered entries and the selected branch,
    // rather than assuming the disk file is the current conversation.
    const liveBranch = typeof source?.getHeader === "function" && typeof source.getBranch === "function" && source.getHeader()
      ? structuredClone(source.getBranch()) : undefined;
    const continued = liveBranch === undefined
      ? SessionManager.forkFrom(currentSessionFile, controlPath)
      : SessionManager.create(controlPath);
    const createdSessionFile = continued.getSessionFile();
    if (!createdSessionFile) throw new Error("Pi did not create a persisted continuation session.");
    if (liveBranch !== undefined) {
      const header = continued.getHeader();
      if (!header) throw new Error("Pi did not create a continuation header.");
      const file = await open(createdSessionFile, "wx", 0o600);
      try {
        await file.writeFile([JSON.stringify({ ...header, parentSession: currentSessionFile }), ...liveBranch.map(entry => JSON.stringify(entry))].join("\n") + "\n");
        await file.sync();
      } finally { await file.close(); }
    }
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
