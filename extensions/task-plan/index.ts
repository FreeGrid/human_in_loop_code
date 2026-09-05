import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerTaskPlanCommands } from "./commands.ts";
import { isCurrentHarnessPlanPath, type TaskPlanSessionState } from "./operations.ts";
import { modelSwitchEntryData, normalizeTaskPlanModelConfig, switchTaskPlanModel, taskPlanModelConfigFromEnv, type TaskPlanModelSwitchConfig } from "./model-switch.ts";
import { PLAN_PROMPTS } from "./prompts.ts";
import { registerTaskPlanTools } from "./tools.ts";

export * from "./model-switch.ts";
export * from "./operation-result.ts";
export * from "./operations.ts";
export * from "./plan-file.ts";
export * from "./prompts.ts";
export * from "./sections.ts";
export * from "./state.ts";
export * from "./tasks.ts";
export * from "./types.ts";
export * from "./validators.ts";

export default function taskPlanExtension(pi: ExtensionAPI, config: TaskPlanModelSwitchConfig = {}): void {
  const envConfig = taskPlanModelConfigFromEnv();
  const modelConfig = normalizeTaskPlanModelConfig({
    ...envConfig,
    ...config,
    planning: { ...envConfig.planning, ...config.planning },
    normal: { ...envConfig.normal, ...config.normal },
  });
  const state: TaskPlanSessionState = { modelSwitch: {} };
  registerTaskPlanTools(pi, state);
  registerTaskPlanCommands(pi, state, modelConfig);

  pi.on("session_start", async (_event, ctx) => {
    const entry = [...ctx.sessionManager.getEntries()].reverse().find((candidate: { type: string; customType?: string }) => candidate.type === "custom" && candidate.customType === "pi-plan-task-binding") as { data?: TaskPlanSessionState } | undefined;
    if (entry?.data?.currentPlanPath) state.currentPlanPath = entry.data.currentPlanPath;
    if (entry?.data?.binding) state.binding = entry.data.binding;
    if (entry?.data?.modelSwitch) state.modelSwitch = entry.data.modelSwitch;
  });

  pi.on("agent_start", async () => { state.reportedThisTurn = false; });

  pi.on("before_agent_start", async (event) => {
    const systemPrompt = `${event.systemPrompt}\n\n${PLAN_PROMPTS.system}`;
    if (!state.binding) return { systemPrompt };
    const task = state.binding.contract;
    return { systemPrompt, message: { customType: "pi-plan-bound-task", display: false, content: `Bound Harness Task ${task.id} — ${task.title}\n\nTasks:\n${field(task.definition, "Tasks")}\n\nAcceptance:\n${field(task.definition, "Acceptance")}\n\nDepends On:\n${field(task.definition, "Depends On")}\n\nBefore this execution turn ends, call plan_report_task_result with result in_progress, blocked, or completed. Do not infer completion from agent_end or final prose.` } };
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!state.binding || state.reportedThisTurn) return;
    ctx.ui.notify(`Bound Harness Task ${state.binding.task_id} did not receive plan_report_task_result; leaving it open.`, "warning");
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!event.details || typeof event.details !== "object") return;
    const details = event.details as { snapshot?: { path?: string; binding?: unknown; metadata?: { stage?: string } } };
    if (details.snapshot?.path) state.currentPlanPath = details.snapshot.path;
    if (details.snapshot && "binding" in details.snapshot) state.binding = details.snapshot.binding as TaskPlanSessionState["binding"];
    if (event.toolName?.startsWith("plan_")) {
      const stage = details.snapshot?.metadata?.stage;
      if (stage) await switchTaskPlanModel(pi, ctx, state.modelSwitch ??= {}, modelConfig, shouldUsePlanningModel(stage) ? "planning" : "normal");
      pi.appendEntry("pi-plan-task-binding", { currentPlanPath: state.currentPlanPath, binding: state.binding, modelSwitch: modelSwitchEntryData(state.modelSwitch ?? {}) });
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = typeof event.input.path === "string" ? event.input.path : undefined;
      if (path && await isCurrentHarnessPlanPath(ctx.cwd, path, state)) return { block: true, reason: "Current Harness Plan files can only be modified through plan_* tools." };
    }
    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      if (state.currentPlanPath && command.includes(state.currentPlanPath) && /\b(rm|mv|cp|mkdir|touch|sed\s+-i|perl\s+-pi|python|node|tee|>|>>|git\s+checkout)\b/.test(command)) {
        return { block: true, reason: "Shell command appears to modify the current Harness Plan; use plan_* tools instead." };
      }
    }
  });
}

function shouldUsePlanningModel(stage: string): boolean {
  return ["what_why", "plan", "tasks", "awaiting_execution_approval", "awaiting_round_decision"].includes(stage);
}

function field(markdown: string, name: string): string {
  const match = markdown.match(new RegExp(`^#### ${escapeRegExp(name)}\\s*\\n([\\s\\S]*?)(?=^#### |$)`, "m"));
  return match?.[1]?.trim() || "Not specified.";
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
