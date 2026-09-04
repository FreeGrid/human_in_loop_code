import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export type ControlCommandContext = Pick<ExtensionCommandContext, "cwd" | "hasUI" | "ui">;

export function commandFailure(ctx: ControlCommandContext, operation: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`${operation} failed: ${message}`, "error");
}
