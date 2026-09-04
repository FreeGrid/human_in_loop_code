import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const PLAN_PROMPTS = {
  system: readPrompt("system.md"),
  whatWhy: readPrompt("what-why.md"),
  plan: readPrompt("plan.md"),
  tasks: readPrompt("tasks.md"),
  review: readPrompt("review.md"),
};

export function reminderForStage(stage: string): string {
  switch (stage) {
    case "what_why": return "What / Why 已整理完成。请检查并直接修改 Markdown，或告诉我具体修改；确认后说“继续”或“开始规划”。";
    case "plan": return "Plan 已生成，尚未拆 Tasks。请检查 T+0/T+1/T+2；确认后说“继续”或“开始拆任务”。";
    case "tasks": return "T+0 已拆成当前 round 的 Tasks。请检查粒度和 Acceptance；方向正确后可以说“检查一下这些任务”。";
    case "awaiting_execution_approval": return "本轮 Tasks 已完成 Review，处于 awaiting_execution_approval。可修改并重新 Review，或说“确认本轮”进入 executing。";
    case "executing": return "当前 round 正在 executing。可以让 Pi Agent 开始某个 Task，或由 Human 明确标记 done/open。";
    case "awaiting_round_decision": return "当前 round 已完成。可以进入下一轮、重新打开 Task，或说明原因后完成 Plan。";
    case "completed": return "Plan 已 completed。";
    case "abandoned": return "Plan 已 abandoned。";
    default: return "请检查当前 Harness Plan 状态。";
  }
}

function readPrompt(name: string): string {
  return readFileSync(join(here, "prompts", name), "utf8");
}
