import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { toolResponse } from "../operation-result.js";
import { ControlWorkspaceService } from "../operations.js";
import { ControlLocationParameters } from "./schemas.js";
import { preferredControlPath, type ControlWorkspaceSessionState } from "../session-state.js";

export function registerControlWorkspaceDoctorTool(pi: ExtensionAPI, sessionState?: ControlWorkspaceSessionState): void {
  pi.registerTool({
    name: "control_workspace_doctor",
    label: "Doctor Control Workspace",
    description: "Run deterministic, read-only checks for index schema, canonical paths, Git roots, remote identities, repository boundaries, and AGENTS managed-block drift.",
    promptSnippet: "Diagnose control workspace binding and governance drift without making repairs.",
    promptGuidelines: ["Use control_workspace_doctor before proposing a repair; never imply that it changes files."],
    parameters: ControlLocationParameters,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Control workspace doctor was aborted");
      return toolResponse(await new ControlWorkspaceService(ctx.cwd).doctor(preferredControlPath(params.controlPath, sessionState)));
    },
  });
}
