import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { interpolateResource } from "./templates.js";
import type { ActiveWork, PlanningStage } from "./types.js";

const PROMPT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "resources", "prompts");

type PromptName = "specify" | "plan" | "tasks" | "converge";

function renderPrompt(name: PromptName, variables: Record<string, string>): string {
  return interpolateResource(readFileSync(join(PROMPT_ROOT, `${name}.md`), "utf8"), variables);
}

export function buildSpecifyPrompt(work: ActiveWork): string {
  return renderPrompt("specify", { TARGET_PATH: work.specPath });
}

export function buildPlanPrompt(work: ActiveWork): string {
  return renderPrompt("plan", { SPEC_PATH: work.specPath, TARGET_PATH: work.planPath });
}

export function buildTasksPrompt(work: ActiveWork): string {
  return renderPrompt("tasks", {
    SPEC_PATH: work.specPath,
    PLAN_PATH: work.planPath,
    TARGET_PATH: work.tasksPath,
  });
}

export function buildConvergePrompt(work: ActiveWork): string {
  return renderPrompt("converge", {
    SPEC_PATH: work.specPath,
    PLAN_PATH: work.planPath,
    TASKS_PATH: work.tasksPath,
  });
}

export function buildRevisionPrompt(work: ActiveWork, stage: PlanningStage, instruction: string): string {
  let contract: string;
  if (stage === "spec") contract = buildSpecifyPrompt(work);
  else if (stage === "plan") contract = buildPlanPrompt(work);
  else contract = buildTasksPrompt(work);

  return `${contract.trimEnd()}\n\nThis is a revision of the existing ${stage} artifact, not a new stage.\n` +
    "Keep its current status unchanged. Make only changes required by this human instruction:\n\n" +
    `${instruction.trim()}\n`;
}
