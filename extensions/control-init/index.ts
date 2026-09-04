import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { handleControlDoctor } from "./commands/doctor.js";
import { handleControlInit } from "./commands/init.js";
import { handleControlStatus } from "./commands/status.js";
import { handleControlUpdate } from "./commands/update.js";
import { registerControlWorkspaceDoctorTool } from "./tools/doctor.js";
import { registerControlWorkspaceInitTool } from "./tools/init.js";
import { registerControlWorkspaceStatusTool } from "./tools/status.js";
import { registerControlWorkspaceUpdateTool } from "./tools/update.js";

/** Registration only: importing/loading the extension performs no filesystem I/O. */
export default function controlInitExtension(pi: ExtensionAPI): void {
  registerControlWorkspaceInitTool(pi);
  registerControlWorkspaceStatusTool(pi);
  registerControlWorkspaceDoctorTool(pi);
  registerControlWorkspaceUpdateTool(pi);

  pi.registerCommand("control:init", {
    description: "Interactively initialize a template-first control workspace",
    handler: handleControlInit,
  });
  pi.registerCommand("control:status", {
    description: "Read the current control workspace state",
    handler: handleControlStatus,
  });
  pi.registerCommand("control:doctor", {
    description: "Run deterministic read-only control workspace checks",
    handler: handleControlDoctor,
  });
  pi.registerCommand("control:update", {
    description: "Interactively update repository bindings or governance",
    handler: handleControlUpdate,
  });
}
