import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { handleControlDoctor } from "./commands/doctor.js";
import { handleControlInit } from "./commands/init.js";
import { handleControlStatus } from "./commands/status.js";
import { handleControlUpdate } from "./commands/update.js";
import { registerControlWorkspaceDoctorTool } from "./tools/doctor.js";
import { registerControlWorkspaceInitTool } from "./tools/init.js";
import { registerControlWorkspaceStatusTool } from "./tools/status.js";
import { registerControlWorkspaceUpdateTool } from "./tools/update.js";
import type { ControlWorkspaceSessionState } from "./session-state.js";

/** Registration only: importing/loading the extension performs no filesystem I/O. */
export default function controlInitExtension(pi: ExtensionAPI): void {
  const sessionState: ControlWorkspaceSessionState = {};
  registerControlWorkspaceInitTool(pi, sessionState);
  registerControlWorkspaceStatusTool(pi, sessionState);
  registerControlWorkspaceDoctorTool(pi, sessionState);
  registerControlWorkspaceUpdateTool(pi, sessionState);

  pi.registerCommand("control:init", {
    description: "Interactively initialize a template-first control workspace",
    handler: (args, ctx) => handleControlInit(args, ctx, sessionState),
  });
  pi.registerCommand("control:status", {
    description: "Read the current control workspace state",
    handler: (args, ctx) => handleControlStatus(args, ctx, sessionState),
  });
  pi.registerCommand("control:doctor", {
    description: "Run deterministic read-only control workspace checks",
    handler: (args, ctx) => handleControlDoctor(args, ctx, sessionState),
  });
  pi.registerCommand("control:update", {
    description: "Interactively update repository bindings or governance",
    handler: (args, ctx) => handleControlUpdate(args, ctx, sessionState),
  });
}
