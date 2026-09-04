import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { join, resolve } from "node:path";
import { toolResponse } from "../operation-result.js";
import { ControlWorkspaceService } from "../operations.js";
import { resolveCanonicalPath, type CanonicalPathResolution } from "../path-binding.js";
import { rememberAppliedControlPath, type ControlWorkspaceSessionState } from "../session-state.js";
import type { OperationResult } from "../types.js";
import { workspaceNameError } from "../workspace-name.js";
import { ControlInitParameters, type ControlInitParams } from "./schemas.js";

async function applyNameFirstDefaults(
  params: ControlInitParams,
  cwd: string,
): Promise<ControlInitParams | OperationResult> {
  if (params.controlPath !== undefined || params.codePath !== undefined || !params.name?.trim()) return params;
  if (params.topologyProfile === "custom" || params.customRepositories !== undefined) return params;

  const name = params.name.trim();
  const nameError = workspaceNameError(name);
  if (nameError) {
    return {
      status: "needs_input",
      questions: [{ id: "name", prompt: `Invalid workspace name: ${name}. ${nameError}`, kind: "text" }],
      summary: { profile: params.topologyProfile ?? "control-code" },
    };
  }

  let control: CanonicalPathResolution;
  let code: CanonicalPathResolution;
  try {
    [control, code] = await Promise.all([
      resolveCanonicalPath(join(cwd, `${name}_control`), cwd),
      resolveCanonicalPath(join(cwd, `${name}_code`), cwd),
    ]);
  } catch (error) {
    return {
      status: "conflict",
      conflicts: [{
        code: "invalid-workspace-parent",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }

  const existing = [control, code].filter((entry) => entry.exists);
  if (existing.length > 0) {
    return {
      status: "conflict",
      conflicts: [{
        code: "workspace-name-collision",
        message: `The workspace name "${name}" cannot be created under ${cwd} because ${existing.length === 1 ? "this directory already exists" : "these directories already exist"}: ${existing.map((entry) => entry.canonicalPath).join(", ")}.`,
        choices: ["choose-another-workspace-name", "provide-explicit-existing-repository-paths"],
      }],
    };
  }

  return {
    ...params,
    topologyProfile: params.topologyProfile ?? "control-code",
    name,
    controlPath: control.canonicalPath,
    codePath: code.canonicalPath,
    bootstrap: {
      ...params.bootstrap,
      create: [...new Set([...(params.bootstrap?.create ?? []), control.canonicalPath, code.canonicalPath])],
    },
  };
}

export function registerControlWorkspaceInitTool(pi: ExtensionAPI, sessionState?: ControlWorkspaceSessionState): void {
  pi.registerTool({
    name: "control_workspace_init",
    label: "Initialize Control Workspace",
    description: "Initialize a durable control/code workspace from built-in governance templates. When the user asks to create local repositories by name and gives no paths, provide the name only: the tool creates <name>_control and <name>_code under Pi's current directory. Use exact paths when the user supplies or wants custom/existing locations. Missing facts return needs_input; unsafe or existing state returns conflict.",
    promptSnippet: "Initialize or bind a multi-repository control workspace with deterministic templates and safety checks.",
    promptGuidelines: [
      "Use control_workspace_init when the user explicitly asks to initialize a control workspace or establish code/control bindings.",
      "For a local name-only creation request, pass the base name and omit controlPath/codePath; the tool deterministically uses Pi's current directory and adds _control/_code.",
      "Never invent paths for custom or existing repositories. Retry only with the answers returned under needs_input or conflict.",
      "A control+code request selects control-code; one or more paper repositories selects control-code-latex.",
    ],
    parameters: ControlInitParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Control workspace initialization was aborted");
      const prepared = await applyNameFirstDefaults(params, ctx.cwd);
      if ("status" in prepared) return toolResponse(prepared);
      const result = await new ControlWorkspaceService(ctx.cwd).init(prepared);
      rememberAppliedControlPath(result, sessionState);
      const response = toolResponse(result);
      if (result.status === "applied") {
        const control = result.summary.repositories?.find((repository) => repository.kind === "control");
        if (control && resolve(control.absolutePath) !== resolve(ctx.cwd)) {
          response.content[0].text += "\nNext action: run /control:enter to continue Pi from the new control repository.";
        }
      }
      return response;
    },
  });
}
