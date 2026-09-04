import type { OperationResult } from "./types.js";

export interface ControlWorkspaceSessionState {
  activeControlPath?: string;
}

export function preferredControlPath(
  explicitPath: string | undefined,
  state: ControlWorkspaceSessionState | undefined,
): string | undefined {
  return explicitPath?.trim() || state?.activeControlPath;
}

export function rememberAppliedControlPath(
  result: OperationResult,
  state: ControlWorkspaceSessionState | undefined,
): void {
  if (!state || result.status !== "applied") return;
  const control = result.summary.repositories?.find((repository) => repository.kind === "control");
  if (control) state.activeControlPath = control.absolutePath;
}
