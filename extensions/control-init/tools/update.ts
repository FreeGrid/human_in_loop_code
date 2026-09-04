import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { toolResponse } from "../operation-result.js";
import { ControlWorkspaceService } from "../operations.js";
import { ControlUpdateParameters } from "./schemas.js";
import { preferredControlPath, rememberAppliedControlPath, type ControlWorkspaceSessionState } from "../session-state.js";

export function registerControlWorkspaceUpdateTool(pi: ExtensionAPI, sessionState?: ControlWorkspaceSessionState): void {
  pi.registerTool({
    name: "control_workspace_update",
    label: "Update Control Workspace",
    description: "Apply a user-requested change to an initialized control workspace. First preserve the original changeRequest, then provide only affected structured fields. Omitted fields keep current state. The result is applied, needs_input, or conflict. Removing a binding never deletes its directory or Git data; drift and bootstrap require explicit acceptance.",
    promptSnippet: "Update repository bindings or governance while preserving unaffected state and human-owned AGENTS content.",
    promptGuidelines: [
      "Use control_workspace_status before a complex update and preserve fields the user did not change.",
      "Pass the user's original wording in changeRequest and translate it into the smallest structured update.",
      "Never treat removing a repository binding as permission to delete its files or Git metadata.",
    ],
    parameters: ControlUpdateParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Control workspace update was aborted");
      const result = await new ControlWorkspaceService(ctx.cwd).update({
        ...params,
        controlPath: preferredControlPath(params.controlPath, sessionState),
      });
      rememberAppliedControlPath(result, sessionState);
      return toolResponse(result);
    },
  });
}
