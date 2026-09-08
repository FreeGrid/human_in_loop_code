import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { modelSwitchEntryData, switchTaskPlanModel, type TaskPlanModelSwitchConfig } from "./model-switch.ts";
import { renderPlanOperationResult } from "./operation-result.ts";
import { reminderForStage } from "./prompts.ts";
import { TaskPlanService, type TaskPlanSessionState } from "./operations.ts";
import { captureHumanDecision } from "./phase-contracts.ts";
import { inspectPhaseRecords } from "./phase-record.ts";
import { currentRoundTasks } from "./tasks.ts";
import { phaseSwitchHelp } from "./phase-input.ts";

export function registerTaskPlanCommands(pi: ExtensionAPI, state: TaskPlanSessionState, modelConfig: Required<TaskPlanModelSwitchConfig>): void {
  pi.registerCommand("plan", { description: "Start a guided Harness Plan from a natural-language brief", handler: (args, ctx) => newPlan(pi, args, ctx, state, modelConfig) });
  pi.registerCommand("plan:new", { description: "Create a new one-file Harness Plan skeleton, then ask the Agent to draft What / Why", handler: (args, ctx) => newPlan(pi, args, ctx, state, modelConfig) });
  pi.registerCommand("plan:status", { description: "Show current Harness Plan status", handler: (args, ctx) => run(ctx, state, (s) => s.status(args.trim() || undefined)) });
  pi.registerCommand("plan:edit", { description: "Submit Markdown content for the current Harness Plan stage", handler: (args, ctx) => edit(args, ctx, state) });
  pi.registerCommand("plan:approve", { description: "Apply the current Human approval gate", handler: (args, ctx) => approve(pi, args, ctx, state, modelConfig) });
  pi.registerCommand("plan:review", { description: "Review the current Harness Plan stage", handler: (args, ctx) => review(args, ctx, state) });
  pi.registerCommand("plan:task", { description: "Bind or mark a current-round Task: <id> <start|done|open>", handler: (args, ctx) => task(args, ctx, state) });
  pi.registerCommand("plan:execute", { description: "Start/resume only the approved current phase: [plan-path]", handler: (args, ctx) => executePhase(pi, args, ctx, state) });
  pi.registerCommand("plan:finalize", { description: "Verify and finalize the entire current phase: [TNNN]", handler: (args, ctx) => finalizePhase(args, ctx, state) });
  pi.registerCommand("docsync", { description: "Human-only document check switch: on|off (does not skip Task acceptance)", handler: (args, ctx) => docsync(args, ctx, state) });
  pi.registerCommand("plan:abandon", { description: "Abandon the current Harness Plan, optionally recording a reason", handler: (args, ctx) => abandon(pi, args, ctx, state, modelConfig) });
}

async function executePhase(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext, state: TaskPlanSessionState) {
  const service = new TaskPlanService(ctx.cwd, state);
  const current = await service.get(args.trim() || undefined);
  if (!current.document_hash) return notify(ctx, current);
  const snap = current.snapshot as { metadata: { stage: string; round: number }; sections: { tasks: string } };
  if (snap.metadata.stage !== "executing") return ctx.ui.notify("Phase execution requires reviewed Tasks and separate Human execution approval.", "error");
  const open = currentRoundTasks(snap.sections.tasks, snap.metadata.round).filter((task) => !task.completed);
  let task_id = open.length === 1 ? open[0]!.id : undefined;
  if (!task_id && ctx.hasUI) task_id = await ctx.ui.select("Choose the phase (no automatic cross-phase execution)", open.map((task) => task.id));
  if (!task_id) return ctx.ui.notify("Ambiguous phase. Use plan_execute with explicit task_id.", "error");
  const existing = inspectPhaseRecords(snap.sections.tasks).records[task_id];
  let target_root: string | undefined, governance_root: string | undefined;
  ctx.ui.notify(phaseSwitchHelp(existing?.docsync.enabled ?? true), "info");
  if (!existing) {
    if (!ctx.hasUI) return ctx.ui.notify("First execution requires Human input and explicit roots. Say execute phase, then use plan_execute with target_root/governance_root.", "error");
    target_root = await ctx.ui.input("Target Git repository root (absolute path)");
    governance_root = await ctx.ui.input("Governance root containing this Plan (absolute path)");
    if (!target_root || !governance_root || !await ctx.ui.confirm("Authorize this phase execution?", `${task_id}\nTarget: ${target_root}\nGovernance: ${governance_root}\n${phaseSwitchHelp()}`)) return;
    state.humanDecision = captureHumanDecision({ action: "execute", source: "slash", input_id: randomUUID(), text: `/plan:execute ${current.path ?? ""}; Human confirmed ${task_id}, target=${target_root}, governance=${governance_root}` });
  }
  const result = await service.executePhase({ expected_document_hash: current.document_hash, planPath: current.path, task_id, target_root, governance_root });
  notify(ctx, result);
  if (result.status === "ok" || result.status === "applied") pi.sendMessage({ customType: "pi-plan-phase-execute", display: false, content: `Continue only phase ${task_id} at ${current.path}. Read the Plan as authoritative progress. Use bound work_item_id reports; completed means pending_finalize. When all work/evidence is ready call plan_finalize once for this phase. Stop at phase completion or a genuine blocker; never enter the next phase automatically.` }, { triggerTurn: true, deliverAs: "followUp" });
}

async function docsync(args: string, ctx: ExtensionCommandContext, state: TaskPlanSessionState) {
  const setting = args.trim();
  if (setting !== "on" && setting !== "off") return ctx.ui.notify("Usage: /docsync on|off", "error");
  const service = new TaskPlanService(ctx.cwd, state);
  const current = await service.get();
  if (!current.document_hash) return notify(ctx, current);
  const tasks = (current.snapshot as { sections: { tasks: string } }).sections.tasks;
  const active = Object.values(inspectPhaseRecords(tasks).records).filter((record) => !record.finalized);
  let task_id = active.length === 1 ? active[0]!.context.phase_id : undefined;
  if (!task_id && active.length && ctx.hasUI) task_id = await ctx.ui.select("Choose active phase", active.map((record) => record.context.phase_id));
  if (!task_id) return ctx.ui.notify("DocSync requires one explicitly selected active phase.", "error");
  // Commands may also be injected by extensions; a trusted UI confirmation is the authority.
  if (!ctx.hasUI || !await ctx.ui.confirm(`Set DocSync ${setting}?`, `${task_id}\n${phaseSwitchHelp(setting === "on")}`)) return ctx.ui.notify("No Human confirmation; DocSync unchanged. Natural-language Human input is also supported.", "info");
  state.humanDecision = captureHumanDecision({ action: setting === "on" ? "docsync_on" : "docsync_off", source: "slash", input_id: randomUUID(), text: `/docsync ${setting}; Human confirmed ${task_id}` });
  notify(ctx, await service.setPhaseDocSync({ expected_document_hash: current.document_hash, task_id, enabled: setting === "on" }));
}

async function finalizePhase(args: string, ctx: ExtensionCommandContext, state: TaskPlanSessionState) {
  const service = new TaskPlanService(ctx.cwd, state);
  const current = await service.get();
  if (!current.document_hash) return notify(ctx, current);
  const task_id = args.trim() || state.binding?.task_id || state.phaseTaskId;
  if (!task_id || !/^T\d{3}$/.test(task_id)) return ctx.ui.notify("Usage: /plan:finalize TNNN", "error");
  notify(ctx, await service.finalizePhase({ expected_document_hash: current.document_hash, task_id }));
}

async function newPlan(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext, state: TaskPlanSessionState, modelConfig: Required<TaskPlanModelSwitchConfig>) {
  const brief = await collectPlanBrief(args, ctx);
  if (!brief) {
    ctx.ui.notify("没有创建 Plan。你可以直接输入 `/plan 我想做什么...`，也可以只输入 `/plan` 打开引导输入。", "info");
    return;
  }
  ctx.ui.notify("收到。我会先切换到 Plan 专用模型，把需求概括成短文件名，再创建 Plan 并起草 What / Why。", "info");
  const switched = await switchTaskPlanModel(pi, ctx, state.modelSwitch ??= {}, modelConfig, "planning");
  if (!switched) return;
  pi.appendEntry("pi-plan-task-binding", { currentPlanPath: state.currentPlanPath, binding: state.binding ? { task_id: state.binding.task_id } : undefined, modelSwitch: modelSwitchEntryData(state.modelSwitch) });
  queueNewPlanFollowUp(pi, brief);
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

async function approve(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext, state: TaskPlanSessionState, modelConfig: Required<TaskPlanModelSwitchConfig>) {
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
  const nextStage = (result.snapshot as { metadata?: { stage?: string } } | undefined)?.metadata?.stage;
  if (result.status === "applied" && (nextStage === "plan" || nextStage === "tasks")) {
    ctx.ui.notify(nextStage === "plan"
      ? "收到“继续”。我会基于已确认的 What / Why 直接起草 Plan，完成后把 Plan 内容贴出来请你审批。"
      : "收到“继续”。我会基于已确认的 Plan 直接拆当前轮 Tasks，完成后把任务列表贴出来请你审批。", "info");
    const switched = await switchTaskPlanModel(pi, ctx, state.modelSwitch ??= {}, modelConfig, "planning");
    if (!switched) return;
    pi.appendEntry("pi-plan-task-binding", { currentPlanPath: state.currentPlanPath, binding: state.binding ? { task_id: state.binding.task_id } : undefined, modelSwitch: modelSwitchEntryData(state.modelSwitch) });
    queueDraftFollowUp(pi, nextStage, result.path);
    return;
  }
  const terminalStage = (result.snapshot as { metadata?: { stage?: string } } | undefined)?.metadata?.stage;
  if (result.status === "applied" && ["executing", "completed", "abandoned"].includes(terminalStage ?? "")) {
    await switchTaskPlanModel(pi, ctx, state.modelSwitch ??= {}, modelConfig, "normal");
    pi.appendEntry("pi-plan-task-binding", { currentPlanPath: state.currentPlanPath, binding: state.binding ? { task_id: state.binding.task_id } : undefined, modelSwitch: modelSwitchEntryData(state.modelSwitch) });
  }
  notify(ctx, result);
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

async function abandon(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext, state: TaskPlanSessionState, modelConfig: Required<TaskPlanModelSwitchConfig>) {
  const service = new TaskPlanService(ctx.cwd, state);
  const current = await service.get();
  if (!current.document_hash) return notify(ctx, current);
  const result = await service.abandon({ expected_document_hash: current.document_hash, reason: args.trim() || undefined });
  if (result.status === "applied") {
    await switchTaskPlanModel(pi, ctx, state.modelSwitch ??= {}, modelConfig, "normal");
    pi.appendEntry("pi-plan-task-binding", { currentPlanPath: state.currentPlanPath, binding: state.binding ? { task_id: state.binding.task_id } : undefined, modelSwitch: modelSwitchEntryData(state.modelSwitch) });
  }
  notify(ctx, result);
  if (result.status !== "applied" || args.trim() || !result.document_hash || !ctx.hasUI) return;
  const reason = await ctx.ui.input("可选：为什么放弃这个 Plan？", "不想填写可以直接按 Esc 或留空");
  if (!reason?.trim()) return;
  notify(ctx, await service.updateClosureReason({ expected_document_hash: result.document_hash, reason }));
}

async function run(ctx: ExtensionCommandContext, state: TaskPlanSessionState, fn: (service: TaskPlanService) => Promise<Parameters<typeof notify>[1]>) {
  return notify(ctx, await fn(new TaskPlanService(ctx.cwd, state)));
}

function queueNewPlanFollowUp(pi: ExtensionAPI, brief: string): void {
  const instruction = `Start a new Harness Plan for this original request:\n\n${brief}\n\nBefore calling plan_start, summarize the original request into one concise descriptive title for the plan filename. Requirements for the title: capture the actual subject, not conversational filler; prefer 2 to 8 English words or roughly 4 to 18 Chinese characters; do not include numbering, file extensions, quotes, markdown, punctuation wrappers, or explanations. Call plan_start with the full original request as goal and the concise title as title. Draft the What / Why exactly as a normal /plan follow-up would, but keep it concise and do not add a separate Why heading; if rationale matters, fold it into Goal or Desired Outcome. Include Open Questions instead of blocking when information is missing, then submit it. Stop after submission; do not advance to Plan. Final user-facing reply requirements, in Chinese: start by saying you are their Plan assistant and what you just helped organize; show the generated section content (the generated What / Why content) in the reply so the user can review without opening the file; then show the saved file path; then explain both edit paths: they can tell you natural-language changes such as “把 X 加进去/范围缩小一点”, or manually edit the Markdown file and say “我改好了，检查一下”; finally state the exact next phrase “继续” and explain that it will approve this What / Why and start drafting the Plan. Do not mention internal tool names.`;
  pi.sendMessage({ customType: "pi-plan-guided-draft", content: instruction, display: false }, { triggerTurn: true, deliverAs: "followUp" });
}

function queueDraftFollowUp(pi: ExtensionAPI, stage: string, path?: string): void {
  const replyContract = `Final user-facing reply requirements, in Chinese: start by saying you are their Plan assistant and what you just helped organize; show the generated section content in the reply so the user can review without opening the file; then show the saved file path; then explain both edit paths: they can tell you natural-language changes such as “把 X 加进去/范围缩小一点”, or manually edit the Markdown file and say “我改好了，检查一下”; finally state the exact next phrase and explicitly name what that phrase will do. Do not mention internal tool names.`;
  const instruction = stage === "what_why"
    ? `Continue the current Harness Plan${path ? ` at ${path}` : ""}. Use plan_get to read the snapshot. Draft a concise What / Why from Original Request: goal, desired outcome, scope, constraints, success, non-goals, and open questions. Do not add a separate Why heading; fold rationale into Goal or Desired Outcome only when needed. Use plan_submit_section to submit it. If information is missing, continue with explicit Open Questions instead of blocking. Stop after submission; do not advance to Plan. Next phrase: “继续”; explain that it will approve this What / Why and start drafting the Plan. ${replyContract}`
    : stage === "plan"
      ? `Continue the current Harness Plan${path ? ` at ${path}` : ""}. Use plan_get, draft the Plan from approved What / Why, and use plan_submit_section. The Plan must use T001/T002/T003 as stage headings: T001 is the current stage and most detailed, T002 is required but less detailed, and later stages are increasingly fuzzy/conditional. Do not add completion markers or executable Tasks/Acceptance/Depends On subsections yet. Stop after submission; do not create executable Tasks. Next phrase: “继续” or “开始拆任务”; explain that it will approve this Plan and expand the current T001 stage into concrete Tasks. ${replyContract}`
      : `Continue the current Harness Plan${path ? ` at ${path}` : ""}. Use plan_get, draft executable Tasks only for the approved Plan's current T001 stage, and use plan_submit_section. Use the same heading as “### T001 — Stage title [ ]”; do not expand T002 or later stages yet. Put smaller tasks under its “#### Tasks” subsection using trailing status markers like “- Smaller task [ ]”. Keep the executable stage concise with only Tasks, Acceptance, and Depends On subsections; do not add visible Round, Outcome, Why, Inputs, Work, or Outputs. If the current round is after R000, add only the hidden metadata line \`<!-- pi-plan:round:RNNN -->\` immediately below each new stage Task heading. Stop after submission; do not run Review. In the final reply, show the generated Tasks with their heading completion marker intact. Next phrase: “检查一下这些任务”; explain that it will review the current-stage Tasks for coverage, necessity, atomicity, dependencies, verifiability, and scope before execution approval. ${replyContract}`;
  pi.sendMessage({ customType: "pi-plan-guided-draft", content: instruction, display: false }, { triggerTurn: true, deliverAs: "followUp" });
}

function notify(ctx: ExtensionCommandContext, result: { status: string; snapshot?: unknown }) {
  const stage = (result.snapshot as { metadata?: { stage?: string } } | undefined)?.metadata?.stage;
  ctx.ui.notify(`${renderPlanOperationResult(result as never)}${stage ? `\n\n${reminderForStage(stage)}` : ""}`, result.status === "conflict" || result.status === "validation_error" ? "error" : "info");
}
