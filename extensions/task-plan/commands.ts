import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { renderPlanOperationResult } from "./operation-result.ts";
import { reminderForStage } from "./prompts.ts";
import { TaskPlanService, type TaskPlanSessionState } from "./operations.ts";

export function registerTaskPlanCommands(pi: ExtensionAPI, state: TaskPlanSessionState): void {
  pi.registerCommand("plan", { description: "Start a guided Harness Plan from a natural-language brief", handler: (args, ctx) => newPlan(pi, args, ctx, state) });
  pi.registerCommand("plan:new", { description: "Create a new one-file Harness Plan skeleton, then ask the Agent to draft What / Why", handler: (args, ctx) => newPlan(pi, args, ctx, state) });
  pi.registerCommand("plan:status", { description: "Show current Harness Plan status", handler: (args, ctx) => run(ctx, state, (s) => s.status(args.trim() || undefined)) });
  pi.registerCommand("plan:edit", { description: "Submit Markdown content for the current Harness Plan stage", handler: (args, ctx) => edit(args, ctx, state) });
  pi.registerCommand("plan:approve", { description: "Apply the current Human approval gate", handler: (args, ctx) => approve(pi, args, ctx, state) });
  pi.registerCommand("plan:review", { description: "Review the current Harness Plan stage", handler: (args, ctx) => review(args, ctx, state) });
  pi.registerCommand("plan:task", { description: "Bind or mark a current-round Task: <id> <start|done|open>", handler: (args, ctx) => task(args, ctx, state) });
  pi.registerCommand("plan:abandon", { description: "Abandon the current Harness Plan, optionally recording a reason", handler: (args, ctx) => abandon(args, ctx, state) });
}

async function newPlan(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext, state: TaskPlanSessionState) {
  const brief = await collectPlanBrief(args, ctx);
  if (!brief) {
    ctx.ui.notify("没有创建 Plan。你可以直接输入 `/plan 我想做什么...`，也可以只输入 `/plan` 打开引导输入。", "info");
    return;
  }
  const result = await new TaskPlanService(ctx.cwd, state).start(brief);
  notify(ctx, result);
  if (result.status === "created") queueDraftFollowUp(pi, "what_why", result.path);
}

async function collectPlanBrief(args: string, ctx: ExtensionCommandContext): Promise<string | undefined> {
  const trimmed = args.trim();
  if (trimmed) return trimmed;
  if (!ctx.hasUI) return undefined;
  const prompt = [
    "请描述你想规划的事情。可以随便写，不需要结构化：",
    "",
    "- 想做什么 / 目标是什么？",
    "- 为什么要做？",
    "- 已知约束、边界或不想做什么？",
    "- 你已经想到的实现建议、风险、成功标准？",
    "",
    "我会先整理 What / Why，不会直接开始执行。",
  ].join("\n");
  const value = await ctx.ui.editor("创建 Harness Plan", prompt);
  const cleaned = value?.trim();
  if (!cleaned || cleaned === prompt.trim()) return undefined;
  return cleaned;
}

async function edit(args: string, ctx: ExtensionCommandContext, state: TaskPlanSessionState) {
  const service = new TaskPlanService(ctx.cwd, state);
  const current = await service.get();
  if (!current.document_hash) return notify(ctx, current);
  return notify(ctx, await service.submitSection({ expected_document_hash: current.document_hash, content: args }));
}

async function approve(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext, state: TaskPlanSessionState) {
  const service = new TaskPlanService(ctx.cwd, state);
  const current = await service.get();
  if (!current.document_hash) return notify(ctx, current);
  const stage = (current.snapshot as { metadata?: { stage?: string } })?.metadata?.stage;
  let action: "execute" | "next_round" | "complete" | undefined;
  let reason: string | undefined;
  if (stage === "awaiting_execution_approval") action = "execute";
  else if (stage === "awaiting_round_decision") {
    const trimmed = args.trim();
    if (trimmed === "next" || trimmed === "next_round") action = "next_round";
    else { action = "complete"; reason = trimmed; }
  }
  const result = await service.advance({ expected_document_hash: current.document_hash, action, reason });
  notify(ctx, result);
  const nextStage = (result.snapshot as { metadata?: { stage?: string } } | undefined)?.metadata?.stage;
  if (result.status === "applied" && (nextStage === "plan" || nextStage === "tasks")) queueDraftFollowUp(pi, nextStage, result.path);
}

async function review(args: string, ctx: ExtensionCommandContext, state: TaskPlanSessionState) {
  const service = new TaskPlanService(ctx.cwd, state);
  const current = await service.get();
  if (!current.document_hash) return notify(ctx, current);
  return notify(ctx, await service.review({ expected_document_hash: current.document_hash, summary: args.trim() || undefined }));
}

async function task(args: string, ctx: ExtensionCommandContext, state: TaskPlanSessionState) {
  const [task_id, action] = args.trim().split(/\s+/, 2);
  if (!/^T\d{3}$/.test(task_id ?? "") || !["start", "done", "open"].includes(action ?? "")) {
    ctx.ui.notify("Usage: /plan:task <TNNN> <start|done|open>", "error");
    return;
  }
  const service = new TaskPlanService(ctx.cwd, state);
  const current = await service.get();
  if (!current.document_hash) return notify(ctx, current);
  const result = action === "start"
    ? await service.bindTask({ expected_document_hash: current.document_hash, task_id: task_id! })
    : await service.setTaskStatus({ expected_document_hash: current.document_hash, task_id: task_id!, status: action === "done" ? "completed" : "open" });
  return notify(ctx, result);
}

async function abandon(args: string, ctx: ExtensionCommandContext, state: TaskPlanSessionState) {
  const service = new TaskPlanService(ctx.cwd, state);
  const current = await service.get();
  if (!current.document_hash) return notify(ctx, current);
  const result = await service.abandon({ expected_document_hash: current.document_hash, reason: args.trim() || undefined });
  notify(ctx, result);
  if (result.status !== "applied" || args.trim() || !result.document_hash || !ctx.hasUI) return;
  const reason = await ctx.ui.input("可选：为什么放弃这个 Plan？", "不想填写可以直接按 Esc 或留空");
  if (!reason?.trim()) return;
  notify(ctx, await service.updateClosureReason({ expected_document_hash: result.document_hash, reason }));
}

async function run(ctx: ExtensionCommandContext, state: TaskPlanSessionState, fn: (service: TaskPlanService) => Promise<Parameters<typeof notify>[1]>) {
  return notify(ctx, await fn(new TaskPlanService(ctx.cwd, state)));
}

function queueDraftFollowUp(pi: ExtensionAPI, stage: string, path?: string): void {
  const instruction = stage === "what_why"
    ? `请继续当前 Harness Plan${path ? `（${path}）` : ""}：先调用 plan_get 读取 snapshot，然后像贴心的规划助理一样，根据 Original Request 中的目标、why、约束、边界和实现建议起草 What / Why，调用 plan_submit_section 提交。信息不足时不要卡住，把不确定点放入 Open Questions，并在回复里引导用户补充。提交成功后停止，不要推进到 Plan，并用简短中文提示我可以继续修改或说“继续”。`
    : stage === "plan"
      ? `请继续当前 Harness Plan${path ? `（${path}）` : ""}：先调用 plan_get，基于已批准 What / Why 起草 Plan，调用 plan_submit_section 提交。提交成功后停止，不要拆 Tasks，并提示我检查后可说“继续”。`
      : `请继续当前 Harness Plan${path ? `（${path}）` : ""}：先调用 plan_get，基于已批准 Plan 的 T+0 起草当前 round Tasks，调用 plan_submit_section 提交。提交成功后停止，不要 Review，并提示我可以说“检查一下这些任务”。`;
  pi.sendUserMessage(instruction, { deliverAs: "followUp" });
}

function notify(ctx: ExtensionCommandContext, result: { status: string; snapshot?: unknown }) {
  const stage = (result.snapshot as { metadata?: { stage?: string } } | undefined)?.metadata?.stage;
  ctx.ui.notify(`${renderPlanOperationResult(result as never)}${stage ? `\n\n${reminderForStage(stage)}` : ""}`, result.status === "conflict" || result.status === "validation_error" ? "error" : "info");
}
