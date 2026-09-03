import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { handlePlanApprove } from "./commands/approve.js";
import { handlePlanConverge } from "./commands/converge.js";
import { handlePlanNew } from "./commands/new.js";
import { handlePlanRevise } from "./commands/revise.js";
import type { CommandServices } from "./commands/shared.js";
import { handlePlanStatus } from "./commands/status.js";
import { handlePlanValidate } from "./commands/validate.js";
import { GenerationGuard } from "./generation-guard.js";
import { WorkspaceService } from "./workspace.js";

export default function taskPlanExtension(pi: ExtensionAPI): void {
  let guard: GenerationGuard | null = null;
  let guardRoot: string | null = null;

  const servicesFor = (ctx: ExtensionContext): CommandServices => {
    const workspace = new WorkspaceService(ctx.cwd);
    if (!guard || guardRoot !== workspace.paths.root) {
      if (guard?.active) throw new Error(`Planning generation is already active in ${guardRoot}`);
      guard = new GenerationGuard(workspace.paths.root);
      guardRoot = workspace.paths.root;
    }
    return { pi, workspace, guard };
  };

  pi.on("tool_call", async (event, ctx) => {
    if (!guard?.active) return undefined;
    return guard.check(event.toolName, event.input, ctx.cwd);
  });

  pi.on("agent_end", () => {
    guard?.clear();
  });

  pi.on("session_shutdown", () => {
    guard?.clear();
  });

  pi.registerCommand("plan:new", {
    description: "Start a human-gated planning workflow",
    handler: async (args, ctx) => handlePlanNew(args, ctx, servicesFor(ctx)),
  });
  pi.registerCommand("plan:status", {
    description: "Show the active planning work and next action",
    handler: async (args, ctx) => handlePlanStatus(args, ctx, servicesFor(ctx)),
  });
  pi.registerCommand("plan:revise", {
    description: "Ask Pi to revise the current draft artifact",
    handler: async (args, ctx) => handlePlanRevise(args, ctx, servicesFor(ctx)),
  });
  pi.registerCommand("plan:validate", {
    description: "Deterministically validate the current artifact",
    handler: async (args, ctx) => handlePlanValidate(args, ctx, servicesFor(ctx)),
  });
  pi.registerCommand("plan:approve", {
    description: "Approve the current artifact through an interactive Human Gate",
    handler: async (args, ctx) => handlePlanApprove(args, ctx, servicesFor(ctx)),
  });
  pi.registerCommand("plan:converge", {
    description: "Minimally converge the draft task list",
    handler: async (args, ctx) => handlePlanConverge(args, ctx, servicesFor(ctx)),
  });
}
