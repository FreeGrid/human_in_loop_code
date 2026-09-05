import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

export type TaskPlanThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface TaskPlanModelPreset {
  provider: string;
  model: string;
  thinkingLevel?: TaskPlanThinkingLevel;
}

export interface TaskPlanModelSwitchConfig {
  enabled?: boolean;
  planning?: TaskPlanModelPreset;
  normal?: TaskPlanModelPreset;
  restoreMode?: "configured" | "previous";
}

export interface TaskPlanModelSwitchState {
  activeMode?: "planning" | "normal";
  modelBeforePlan?: { provider: string; id: string; thinkingLevel?: TaskPlanThinkingLevel };
}

export const DEFAULT_TASK_PLAN_MODEL_CONFIG: Required<TaskPlanModelSwitchConfig> = {
  enabled: true,
  planning: { provider: "openai-codex", model: "gpt-6-astra", thinkingLevel: "xhigh" },
  normal: { provider: "openai-codex", model: "gpt-6-astra", thinkingLevel: "medium" },
  restoreMode: "configured",
};

type ModelSwitchContext = Pick<ExtensionCommandContext | ExtensionContext, "model" | "modelRegistry" | "ui">;

export function taskPlanModelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Required<TaskPlanModelSwitchConfig> {
  return normalizeTaskPlanModelConfig({
    enabled: env.PI_TASK_PLAN_MODEL_SWITCH === "0" || env.PI_TASK_PLAN_MODEL_SWITCH === "false" ? false : undefined,
    planning: {
      provider: env.PI_TASK_PLAN_MODEL_PROVIDER ?? DEFAULT_TASK_PLAN_MODEL_CONFIG.planning.provider,
      model: env.PI_TASK_PLAN_MODEL_ID ?? DEFAULT_TASK_PLAN_MODEL_CONFIG.planning.model,
      thinkingLevel: parseThinking(env.PI_TASK_PLAN_THINKING) ?? DEFAULT_TASK_PLAN_MODEL_CONFIG.planning.thinkingLevel,
    },
    normal: {
      provider: env.PI_TASK_PLAN_NORMAL_MODEL_PROVIDER ?? env.PI_TASK_PLAN_MODEL_PROVIDER ?? DEFAULT_TASK_PLAN_MODEL_CONFIG.normal.provider,
      model: env.PI_TASK_PLAN_NORMAL_MODEL_ID ?? env.PI_TASK_PLAN_MODEL_ID ?? DEFAULT_TASK_PLAN_MODEL_CONFIG.normal.model,
      thinkingLevel: parseThinking(env.PI_TASK_PLAN_NORMAL_THINKING) ?? DEFAULT_TASK_PLAN_MODEL_CONFIG.normal.thinkingLevel,
    },
    restoreMode: env.PI_TASK_PLAN_RESTORE_MODE === "previous" ? "previous" : DEFAULT_TASK_PLAN_MODEL_CONFIG.restoreMode,
  });
}

export function normalizeTaskPlanModelConfig(config: TaskPlanModelSwitchConfig = {}): Required<TaskPlanModelSwitchConfig> {
  return {
    enabled: config.enabled ?? DEFAULT_TASK_PLAN_MODEL_CONFIG.enabled,
    planning: { ...DEFAULT_TASK_PLAN_MODEL_CONFIG.planning, ...config.planning },
    normal: { ...DEFAULT_TASK_PLAN_MODEL_CONFIG.normal, ...config.normal },
    restoreMode: config.restoreMode ?? DEFAULT_TASK_PLAN_MODEL_CONFIG.restoreMode,
  };
}

export async function switchTaskPlanModel(pi: ExtensionAPI, ctx: ModelSwitchContext, state: TaskPlanModelSwitchState, config: Required<TaskPlanModelSwitchConfig>, mode: "planning" | "normal"): Promise<boolean> {
  if (!config.enabled) return true;
  if (mode === "planning") {
    if (!state.modelBeforePlan && ctx.model) state.modelBeforePlan = { provider: ctx.model.provider, id: ctx.model.id, thinkingLevel: pi.getThinkingLevel() as TaskPlanThinkingLevel };
    const ok = await applyPreset(pi, ctx, config.planning, "planning");
    if (ok) state.activeMode = "planning";
    return ok;
  }
  const target = config.restoreMode === "previous" && state.modelBeforePlan
    ? { provider: state.modelBeforePlan.provider, model: state.modelBeforePlan.id, thinkingLevel: state.modelBeforePlan.thinkingLevel }
    : config.normal;
  const ok = await applyPreset(pi, ctx, target, "normal");
  if (ok) {
    state.activeMode = "normal";
    state.modelBeforePlan = undefined;
  }
  return ok;
}

export function modelSwitchEntryData(state: TaskPlanModelSwitchState): TaskPlanModelSwitchState {
  return { activeMode: state.activeMode, modelBeforePlan: state.modelBeforePlan };
}

async function applyPreset(pi: ExtensionAPI, ctx: ModelSwitchContext, preset: TaskPlanModelPreset, label: string): Promise<boolean> {
  const model = ctx.modelRegistry.find(preset.provider, preset.model);
  if (!model) {
    ctx.ui.notify(`Task Plan ${label} model not found: ${preset.provider}/${preset.model}`, "warning");
    return false;
  }
  const switched = await pi.setModel(model);
  if (!switched) {
    ctx.ui.notify(`Task Plan ${label} model has no configured authentication: ${preset.provider}/${preset.model}`, "warning");
    return false;
  }
  if (preset.thinkingLevel) pi.setThinkingLevel(preset.thinkingLevel);
  return true;
}

function parseThinking(value: string | undefined): TaskPlanThinkingLevel | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized === "extrahigh" || normalized === "xhigh") return "xhigh";
  if (normalized === "medium" || normalized === "media") return "medium";
  if (["off", "minimal", "low", "high"].includes(normalized)) return normalized as TaskPlanThinkingLevel;
  return undefined;
}
