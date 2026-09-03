import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { toolResponse } from "../operation-result.js";
import { ControlWorkspaceService } from "../operations.js";
import { ControlLocationParameters } from "./schemas.js";

export function registerControlWorkspaceStatusTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "control_workspace_status",
    label: "Control Workspace Status",
    description: "Read the current CONTROL_INDEX.json and report repository bindings, Git state, policies, warnings, and the next incomplete item. This tool is strictly read-only.",
    promptSnippet: "Read the current control workspace state without changing it.",
    promptGuidelines: ["Use control_workspace_status for a quick read-only summary of an initialized control workspace."],
    parameters: ControlLocationParameters,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Control workspace status was aborted");
      return toolResponse(await new ControlWorkspaceService(ctx.cwd).status(params.controlPath));
    },
  });
}
