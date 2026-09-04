import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { renderPlanOperationResult } from "./operation-result.ts";
import { reminderForStage } from "./prompts.ts";
import { TaskPlanService, type TaskPlanSessionState } from "./operations.ts";

export function registerTaskPlanCommands(pi: ExtensionAPI, state: TaskPlanSessionState): void {
  pi.registerCommand("plan:new", { description: "Create a new one-file Harness Plan skeleton", handler: (args, ctx) => run(ctx, state, (s) => s.start(args)) });
  pi.registerCommand("plan:status", { description: "Show current Harness Plan status", handler: (args, ctx) => run(ctx, state, (s) => s.status(args.trim() || undefined)) });
  pi.registerCommand("plan:edit", { description: "Submit Markdown content for the current Harness Plan stage", handler: (args, ctx) => edit(args, ctx, state) });
  pi.registerCommand("plan:approve", { description: "Apply the current Human approval gate", handler: (args, ctx) => approve(args, ctx, state) });
  pi.registerCommand("plan:review", { description: "Review the current Harness Plan stage", handler: (args, ctx) => review(args, ctx, state) });
  pi.registerCommand("plan:task", { description: "Bind or mark a current-round Task: <id> <start|done|open>", handler: (args, ctx) => task(args, ctx, state) });
  pi.registerCommand("plan:abandon", { description: "Abandon the current Harness Plan with a reason", handler: (args, ctx) => abandon(args, ctx, state) });
}

async function edit(args: string, ctx: ExtensionCommandContext, state: TaskPlanSessionState) {
  const service = new TaskPlanService(ctx.cwd, state);
  const current = await service.get();
  if (!current.document_hash) return notify(ctx, current);
  return notify(ctx, await service.submitSection({ expected_document_hash: current.document_hash, content: args }));
}

async function approve(args: string, ctx: ExtensionCommandContext, state: TaskPlanSessionState) {
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
  return notify(ctx, await service.advance({ expected_document_hash: current.document_hash, action, reason }));
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
  return notify(ctx, await service.abandon({ expected_document_hash: current.document_hash, reason: args }));
}

async function run(ctx: ExtensionCommandContext, state: TaskPlanSessionState, fn: (service: TaskPlanService) => Promise<Parameters<typeof notify>[1]>) {
  return notify(ctx, await fn(new TaskPlanService(ctx.cwd, state)));
}

function notify(ctx: ExtensionCommandContext, result: { status: string; snapshot?: unknown }) {
  const stage = (result.snapshot as { metadata?: { stage?: string } } | undefined)?.metadata?.stage;
  ctx.ui.notify(`${renderPlanOperationResult(result as never)}${stage ? `\n\n${reminderForStage(stage)}` : ""}`, result.status === "conflict" || result.status === "validation_error" ? "error" : "info");
}
