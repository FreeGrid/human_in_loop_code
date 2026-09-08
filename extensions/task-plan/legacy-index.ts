import { selectedNode } from "./node-approval.ts";
import { nodeContractHash } from "./receipt-state.ts";
import { parsePlanCandidate } from "./plan-integrity.ts";
import type { PlanCreationOptions } from "./plan-file.ts";
import { randomUUID } from "node:crypto";
import { issueHumanCapability, type AuthorityAction } from "./authority.ts";
import { documentAuthorityContext } from "./authority-context.ts";
import { readPlanDocument } from "./plan-file.ts";
import { parseTasks } from "./tasks.ts";
import { GitBaselineProvider } from "./docsync/baseline.ts";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerTaskPlanCommands } from "./commands.ts";
import { TaskPlanService, isCurrentHarnessPlanPath, type TaskPlanSessionState } from "./operations.ts";
import { modelSwitchEntryData, normalizeTaskPlanModelConfig, switchTaskPlanModel, taskPlanModelConfigFromEnv, type TaskPlanModelSwitchConfig } from "./model-switch.ts";
import { PLAN_PROMPTS } from "./prompts.ts";
import { registerTaskPlanTools } from "./tools.ts";
import { inspectPhaseRecords } from "./phase-record.ts";
import { explicitPhaseAction } from "./phase-input.ts";
import type { PhaseDependencies } from "./phase-contracts.ts";
import { renderPlanOperationResult } from "./operation-result.ts";

export * from "./docsync/index.ts";
export * from "./execution-notes.ts";
export * from "./phase-contracts.ts";
export * from "./phase-execution.ts";
export * from "./phase-record.ts";
export * from "./phase-input.ts";
export * from "./model-switch.ts";
export * from "./nodes.ts";
export * from "./v2-plan.ts";
export * from "./review-receipt.ts";
// Migration apply is deliberately absent from the public extension surface.
export * from "./authority.ts";
export * from "./authority-context.ts";
export * from "./evidence.ts";
export * from "./receipt-state.ts";
export * from "./operation-result.ts";
export * from "./operations.ts";
export * from "./plan-file.ts";
export * from "./prompts.ts";
export * from "./sections.ts";
export * from "./state.ts";
export * from "./tasks.ts";
export * from "./types.ts";
export * from "./validators.ts";

export interface TaskPlanExtensionConfig extends TaskPlanModelSwitchConfig { phase?: PhaseDependencies; creationOptions?:PlanCreationOptions }

export default function taskPlanExtension(pi: ExtensionAPI, config: TaskPlanExtensionConfig = {}): void {
  const envConfig = taskPlanModelConfigFromEnv();
  const modelConfig = normalizeTaskPlanModelConfig({
    ...envConfig,
    ...config,
    planning: { ...envConfig.planning, ...config.planning },
    normal: { ...envConfig.normal, ...config.normal },
    review: { ...envConfig.review, ...config.review },
  });
  const state: TaskPlanSessionState = { modelSwitch: {}, creationOptions:config.creationOptions, phaseDependencies: { baseline: new GitBaselineProvider({planIdentityResolver:async(context,text)=>({policy:"node-v1",identity:nodeContractHash(parsePlanCandidate(context.plan_path,text),context.phase_id,config.phase?.evidence)})}), ...config.phase } };
  registerTaskPlanTools(pi, state);
  registerTaskPlanCommands(pi, state, modelConfig);

  pi.on("session_start", async (_event, ctx) => {
    const entry = [...ctx.sessionManager.getEntries()].reverse().find((candidate: { type: string; customType?: string }) => candidate.type === "custom" && candidate.customType === "pi-plan-task-binding") as { data?: TaskPlanSessionState } | undefined;
    if (entry?.data?.currentPlanPath) state.currentPlanPath = entry.data.currentPlanPath;
    delete state.binding;
    delete state.humanDecision;
    delete state.humanCapability;
    if (entry?.data?.modelSwitch) state.modelSwitch = entry.data.modelSwitch;
    if (entry?.data?.binding?.task_id && state.currentPlanPath) {
      const service = new TaskPlanService(ctx.cwd, state);
      const current = await service.get(state.currentPlanPath);
      if (current.document_hash) await service.bindTask({ expected_document_hash: current.document_hash, task_id: entry.data.binding.task_id, planPath: state.currentPlanPath });
    }
  });

  pi.on("input", async (event, ctx) => {
    delete state.humanDecision;
    delete state.humanCapability;
    if (event.source !== "interactive" && event.source !== "rpc") return { action: "continue" };
    const value = event.text.trim().replace(/[。！.!]+$/u, "").trim();
    const phaseAction = explicitPhaseAction(event.text);
    const approval = /^(继续|开始拆任务|批准合同|approve contract|approve plan)$/iu.test(value);
    const closure = /^(放弃计划|abandon plan|完成计划|complete plan)$/iu.test(value);
    const nodeAction = value.match(/^(重开|reopen|完成阶段|finalize)\s+(T\d{3})$/iu);
    if (!phaseAction && !approval && !closure && !nodeAction) return { action: "continue" };
    const service = new TaskPlanService(ctx.cwd, state);
    const current = await service.get();
    if (!current.path || !current.document_hash) return { action: "continue" };
    const document = await readPlanDocument(current.path);
    if (document.document_hash !== current.document_hash) return { action: "continue" };
    const records = Object.values(inspectPhaseRecords(document.sections.tasks).records);
    const active = records.filter(r => !r.finalized);
    const stage = document.metadata.stage;
    let action: AuthorityAction | undefined;
    let node = "$plan";
    if (approval) {
      if (/^(批准合同|approve contract)$/iu.test(value)) action = stage === "awaiting_execution_approval" ? "approve_contract" : undefined;
      else if (/^(开始拆任务|approve plan)$/iu.test(value)) action = stage === "plan" ? "approve_plan" : undefined;
      else action = stage === "what_why" ? "approve_what_why" : stage === "plan" ? "approve_plan" : stage === "awaiting_execution_approval" ? "approve_contract" : undefined;
    }
    else if (closure) action = /^(放弃|abandon)/iu.test(value) ? "abandon" : "complete";
    else if (nodeAction) { action = /^(重开|reopen)$/iu.test(nodeAction[1]!) ? "reopen" : "finalize"; node = nodeAction[2]!; }
    else if (phaseAction === "execute") {
      if (stage === "awaiting_execution_approval") action = "authorize_execution";
      // A first execution needs concrete roots shown to the Human through /plan:execute.
      else if (stage === "executing" && active.length === 1) { action = "execute"; node = active[0]!.context.phase_id; }
    } else if (phaseAction && active.length === 1) { action = phaseAction; node = active[0]!.context.phase_id; }
    const namedNode = value.match(/\bT\d{3}\b/iu)?.[0]?.toUpperCase();
    if (phaseAction && namedNode) {
      const currentNodes = parseTasks(document.sections.tasks).filter(t => t.round === document.metadata.round && !t.completed);
      if (currentNodes.length !== 1 || currentNodes[0]!.id !== namedNode) action = undefined;
    }
    if (!action) {
      ctx.ui.notify("No unambiguous context-bound authorization issued. First execution requires /plan:execute and explicit roots.", "info");
      return { action: "continue" };
    }
    if(document.metadata.identity_policy === "node-v1" && ["approve_contract","authorize_execution"].includes(action))node=selectedNode(document);
    const context = await documentAuthorityContext(document, node,{},state.phaseDependencies?.evidence);
    state.humanCapability = issueHumanCapability(action, context, { source: event.source, input_id: randomUUID(), text: event.text });
    if (action === "docsync_on" || action === "docsync_off") {
      const result = await service.setPhaseDocSync({ expected_document_hash: document.document_hash, task_id: node, enabled: action === "docsync_on" });
      ctx.ui.notify(renderPlanOperationResult(result), result.status === "applied" ? "info" : "error");
      return { action: "handled" };
    }
    return { action: "continue" };
  });

  pi.on("agent_start", async () => { state.reportedThisTurn = false; });

  pi.on("before_agent_start", async (event, ctx) => {
    const systemPrompt = `${event.systemPrompt}\n\n${PLAN_PROMPTS.system}`;
    if (!state.binding) return { systemPrompt };
    const service = new TaskPlanService(ctx.cwd, state);
    const current = await service.get(state.binding.plan_path);
    if (!current.document_hash || (await service.bindTask({ expected_document_hash: current.document_hash, task_id: state.binding.task_id, planPath: state.binding.plan_path })).status !== "ok") {
      delete state.binding;
      return { systemPrompt, message: { customType: "pi-plan-binding-stale", display: true, content: "Plan binding is stale or blocked. Read the Plan and resolve the conflict before execution; do not infer completion." } };
    }
    const task = state.binding!.contract;
    return { systemPrompt, message: { customType: "pi-plan-bound-task", display: false, content: `Bound Harness Phase ${task.id} — ${task.title}\n\nTasks:\n${task.workItems.map((w) => `- ${w.id}: ${w.text}${w.note ? ` — ${w.note.status}: ${w.note.summary}` : ""}`).join("\n")}\n\nAcceptance:\n${task.acceptance.map((a) => `- ${a.id}: ${a.text}`).join("\n")}\n\nDepends On:\n${task.dependsOn.join(", ") || "None."}\n\nUse plan_execute to start/resume this phase before work. Report work_item_id with plan_report_task_result. completed only records pending_finalize; plan_finalize alone verifies and marks the entire phase. Do not infer completion from agent_end or final prose. Do not cross into the next phase.` } };
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
      pi.appendEntry("pi-plan-task-binding", { currentPlanPath: state.currentPlanPath, binding: state.binding ? { task_id: state.binding.task_id } : undefined, modelSwitch: modelSwitchEntryData(state.modelSwitch ?? {}) });
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
export * from "./evidence-key.ts";

export * from "./operation-journal.ts";
