import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { toolResponse } from "../operation-result.js";
import { ControlWorkspaceService } from "../operations.js";
import { ControlInitParameters } from "./schemas.js";

export function registerControlWorkspaceInitTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "control_workspace_init",
    label: "Initialize Control Workspace",
    description: "Initialize a durable control/code workspace from built-in governance templates. Supply only facts the user stated. For a normal control+code request, provide the exact controlPath and codePath and do not ask for template-defined roles, ownership, visibility, or Git policy. Missing facts return needs_input; unsafe or existing state returns conflict. Exact bootstrap authorization is required before creating a directory or initializing an existing non-Git directory.",
    promptSnippet: "Initialize or bind a multi-repository control workspace with deterministic templates and safety checks.",
    promptGuidelines: [
      "Use control_workspace_init when the user explicitly asks to initialize a control workspace or establish code/control bindings.",
      "Never invent repository paths. Retry only with the answers returned under needs_input or conflict.",
      "A control+code request selects control-code; one or more paper repositories selects control-code-latex.",
    ],
    parameters: ControlInitParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Control workspace initialization was aborted");
      return toolResponse(await new ControlWorkspaceService(ctx.cwd).init(params));
    },
  });
}
