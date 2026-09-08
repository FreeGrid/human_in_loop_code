import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PhaseDependencies } from "./phase-contracts.ts";
import type { PlanCreationOptions } from "./plan-file.ts";
import type { V3GovernedFactory } from "./v3-governed-host.ts";
import { normalizeTaskPlanModelConfig, taskPlanModelConfigFromEnv, type TaskPlanModelSwitchConfig } from "./model-switch.ts";
import { registerReadablePlanExtension } from "./v3-extension.ts";

export * from "./model-switch.ts";
export * from "./v3-format.ts";
export * from "./v3-file.ts";
export * from "./v3-service.ts";

export interface TaskPlanExtensionConfig extends TaskPlanModelSwitchConfig {
  legacy?: boolean;
  governed?: V3GovernedFactory;
  phase?: PhaseDependencies;
  creationOptions?: PlanCreationOptions | { format: "v3" };
}

/** The ordinary entry loads no legacy lifecycle or execution runtime. */
export default function taskPlanExtension(pi: ExtensionAPI, config: TaskPlanExtensionConfig = {}): void | Promise<void> {
  if (config.creationOptions?.format !== "v3" && (config.legacy || config.phase || config.creationOptions)) {
    const creationOptions = config.creationOptions;
    return import("./legacy-index.ts").then(legacy => legacy.default(pi, { ...config, creationOptions }));
  }
  const envConfig = taskPlanModelConfigFromEnv();
  const modelConfig = normalizeTaskPlanModelConfig({
    ...envConfig, ...config,
    planning: { ...envConfig.planning, ...config.planning },
    normal: { ...envConfig.normal, ...config.normal },
    review: { ...envConfig.review, ...config.review },
  });
  registerReadablePlanExtension(pi, { modelConfig, governed: config.governed });
}
