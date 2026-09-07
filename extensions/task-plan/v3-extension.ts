import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { V3GovernedFactory, V3GovernedHost } from "./v3-governed-host.ts";
import { resolve } from "node:path";
import { readPlanSource, readLegacyPlanView, legacyViewText, previewReadableMigration } from "./v3-compat.ts";
import { currentReadableTask, renderReadablePlan, type ReadableTask, type ReadableSubtask } from "./v3-format.ts";
import { ReadablePlanService, readableChanges, type ReadableSessionState, type ReadableSnapshot } from "./v3-service.ts";
import { modelSwitchEntryData, switchTaskPlanModel, type TaskPlanModelSwitchConfig, type TaskPlanModelSwitchState } from "./model-switch.ts";
import { newReadablePlanPrompt, READABLE_PLAN_SYSTEM, reviseReadablePlanPrompt } from "./v3-prompts.ts";

export interface ReadableHostState extends ReadableSessionState { modelSwitch: TaskPlanModelSwitchState }
export interface ReadableExtensionOptions { modelConfig: Required<TaskPlanModelSwitchConfig>; governed?: V3GovernedFactory }
const pathField = Type.Optional(Type.String({ description: "Plan path; defaults to the selected readable Plan." }));
const child = Type.Object({ text: Type.String(), completed: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
const task = Type.Object({ id: Type.String({ pattern: "^T[0-9]{3,}$" }), text: Type.String(), completed: Type.Optional(Type.Boolean()), subtasks: Type.Optional(Type.Array(child)) }, { additionalProperties: false });
const tasks = Type.Optional(Type.Array(task, { minItems: 1 }));
type ChildInput = { text: string; completed?: boolean };
const sameText = (left: string, right: string) => left.trim().replace(/\s+/gu, " ") === right.trim().replace(/\s+/gu, " ");
function normalizeSubtasks(items: ChildInput[], previous: ReadableSubtask[] = []): ReadableSubtask[] {
  const remaining = [...previous];
  return items.map(item => {
    const index = remaining.findIndex(old => sameText(old.text, item.text));
    const old = index < 0 ? undefined : remaining.splice(index, 1)[0];
    return { text: item.text, completed: item.completed ?? old?.completed ?? false };
  });
}
function normalizeTasks(items: Array<{ id: string; text: string; completed?: boolean; subtasks?: ChildInput[] }>, previous: ReadableTask[] = []): ReadableTask[] {
  return items.map(item => {
    const old = previous.find(task => task.id === item.id);
    return { id: item.id, text: item.text, completed: item.completed ?? old?.completed ?? false,
      subtasks: item.subtasks === undefined ? structuredClone(old?.subtasks ?? []) : normalizeSubtasks(item.subtasks, old?.subtasks) };
  });
}

/** Separate registration means ordinary tools never invoke legacy state transitions. */
export function registerReadablePlanExtension(pi: ExtensionAPI, options: ReadableExtensionOptions): ReadableHostState {
  const state: ReadableHostState = { modelSwitch: {} };
  let governedHost: V3GovernedHost | undefined;
  let governedGeneration = 0;
  const governedFactory = options.governed;
  const optionalHost = async (generation: number) => {
    if (!governedFactory) throw new Error("未配置受控执行；普通 Plan 和工作工具可以继续使用。");
    if (!governedHost) { const { V3GovernedHost } = await import("./v3-governed-host.ts"); if (generation !== governedGeneration) throw new Error("governed_session_changed"); governedHost ??= new V3GovernedHost(governedFactory); }
    if (generation !== governedGeneration) throw new Error("governed_session_changed");
    return governedHost;
  };
  const service = (cwd: string) => new ReadablePlanService(cwd, state);
  const switchModel = async (ctx: ExtensionContext, mode: "planning" | "normal") => {
    try { await switchTaskPlanModel(pi, ctx, state.modelSwitch, options.modelConfig, mode); }
    catch {
      // A preference provider can fail independently of the available host model.
      try { ctx.ui.notify("模型偏好暂不可用，继续使用当前模型。", "info"); } catch { /* optional UI */ }
    }
  };
  const selectedSource = async (cwd: string, path?: string) => {
    const selected = path ?? state.currentPlanPath;
    return selected ? readPlanSource(resolve(cwd, selected)) : undefined;
  };
  const legacy = async (cwd: string, path?: string, select = false) => {
    const source = await selectedSource(cwd, path);
    if (!source || source.format === "v3") return undefined;
    const view = await readLegacyPlanView(source.path);
    if (select) { state.currentPlanPath = view.path; delete state.lastRead; }
    return view;
  };
  const editable = async (cwd: string, path?: string) => {
    const source = await selectedSource(cwd, path);
    if (source && source.format !== "v3") throw new Error("legacy_readonly: 旧文件请在原流程编辑，或明确整理当前需求后预览 V3；普通工作工具仍可使用。");
  };
  const remember = () => pi.appendEntry("pi-plan-readable", { currentPlanPath: state.currentPlanPath, modelSwitch: modelSwitchEntryData(state.modelSwitch) });
  const response = (content: string) => ({ content: [{ type: "text" as const, text: content }], details: { readable: true } });
  const failure = (error: unknown) => response(`未更新：${error instanceof Error ? error.message : String(error)}`);
  const view = (snapshot: ReadableSnapshot) => response(`${renderReadablePlan(snapshot.plan)}\n文件：${snapshot.path}`);
  const changed = (before: ReadableSnapshot, after: ReadableSnapshot) => {
    remember();
    const lines = readableChanges(before.plan, after.plan);
    const current = currentReadableTask(after.plan);
    return response(`${lines.length ? `已更新：\n${lines.map(line => `- ${line}`).join("\n")}` : "内容没有变化。"}\n${current ? `当前任务：${current.id} ${current.text}` : "所有任务已勾选完成。"}`);
  };

  pi.registerTool({ name: "plan_start", label: "创建 Plan", description: "Save current deduplicated requirements and a rolling checklist. One task is valid; only the current task may be expanded. This does not start implementation.",
    parameters: Type.Object({ title: Type.String(), brief: Type.String(), tasks }, { additionalProperties: false }), executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("plan_start aborted");
      try { const snapshot = await service(ctx.cwd).start(params.brief, params.title, params.tasks && normalizeTasks(params.tasks)); remember(); return view(snapshot); } catch (error) { return failure(error); }
    } });
  pi.registerTool({ name: "plan_get", label: "读取 Plan", description: "Read the selected Plan without changing files. Markdown completion is accepted without runtime state.", parameters: Type.Object({ path: pathField }, { additionalProperties: false }), executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) { try { const old = await legacy(ctx.cwd, params.path, true); if (old) { remember(); return response(legacyViewText(old)); } const snapshot = await service(ctx.cwd).get(params.path); remember(); return view(snapshot); } catch (error) { return failure(error); } } });
  pi.registerTool({ name: "plan_update", label: "修改 Plan", description: "Revise current requirements or task definitions in place. Affected completed tasks reopen by default. Returns only changes. Do not add result summaries.",
    parameters: Type.Object({ path: pathField, title: Type.Optional(Type.String()), brief: Type.Optional(Type.String()), tasks, task_id: Type.Optional(Type.String()), text: Type.Optional(Type.String()), affected_task_ids: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }), executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("plan_update aborted");
      try {
        await editable(ctx.cwd, params.path); const svc = service(ctx.cwd), before = await svc.previewEdit(params.path);
        let nextTasks = params.tasks && normalizeTasks(params.tasks, before.plan.tasks);
        if (params.task_id !== undefined || params.text !== undefined) {
          if (!params.task_id || params.text === undefined || nextTasks) throw new Error("Provide task_id and text together, or tasks.");
          nextTasks = structuredClone(before.plan.tasks);
          const target = nextTasks.find(item => item.id === params.task_id);
          if (!target) throw new Error("Unknown task");
          target.text = params.text;
        }
        return changed(before, await svc.revise({ path: params.path, title: params.title, brief: params.brief, tasks: nextTasks, affected_task_ids: params.affected_task_ids }));
      } catch (error) { return failure(error); }
    } });
  pi.registerTool({ name: "plan_refine", label: "展开当前任务", description: "Replace only the current task's small work in place. Future tasks remain one sentence.",
    parameters: Type.Object({ path: pathField, task_id: Type.Optional(Type.String()), subtasks: Type.Array(Type.String()) }, { additionalProperties: false }), executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) { if (signal?.aborted) throw new Error("plan_refine aborted"); try { await editable(ctx.cwd, params.path); const svc = service(ctx.cwd), before = await svc.previewEdit(params.path); return changed(before, await svc.refine(normalizeSubtasks(params.subtasks.map(text => ({ text })), currentReadableTask(before.plan)?.subtasks), params.task_id, params.path)); } catch (error) { return failure(error); } } });
  pi.registerTool({ name: "plan_set_task_status", label: "勾选任务", description: "Set ordinary completion or reopen a task. Human/manual completion is valid without certification. Completing a root collapses its small work; no result text is appended.",
    parameters: Type.Object({ path: pathField, task_id: Type.String(), completed: Type.Boolean(), subtask: Type.Optional(Type.Integer({ minimum: 1, description: "Optional one-based small-work position." })) }, { additionalProperties: false }), executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) { if (signal?.aborted) throw new Error("plan_set_task_status aborted"); try { await editable(ctx.cwd, params.path); const svc = service(ctx.cwd), before = await svc.previewEdit(params.path); return changed(before, await svc.setStatus(params.task_id, params.completed, params.subtask === undefined ? undefined : params.subtask - 1, params.path)); } catch (error) { return failure(error); } } });
  pi.registerTool({ name: "plan_select", label: "选择当前任务", description: "Move an open task to the current position, retaining IDs and collapsing future detail.", parameters: Type.Object({ path: pathField, task_id: Type.String() }, { additionalProperties: false }), executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) { if (signal?.aborted) throw new Error("plan_select aborted"); try { await editable(ctx.cwd, params.path); const svc = service(ctx.cwd), before = await svc.previewEdit(params.path); return changed(before, await svc.select(params.task_id, params.path)); } catch (error) { return failure(error); } } });
  pi.registerTool({ name: "plan_status", label: "当前进度", description: "Show the short checklist and next task without execution records.", parameters: Type.Object({ path: pathField }, { additionalProperties: false }), executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) { try { const old = await legacy(ctx.cwd, params.path); if (old) return response(legacyViewText(old)); const snapshot = await service(ctx.cwd).peek(params.path); return response(checklist(snapshot)); } catch (error) { return failure(error); } } });
  pi.registerTool({ name: "plan_continue", label: "继续普通工作", description: "Select ordinary work on the current task. Requires no hidden runtime and grants no additional host permissions. Use normal work tools for an implementation request.", parameters: Type.Object({ path: pathField }, { additionalProperties: false }), executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) { try { const old = await legacy(ctx.cwd, params.path); if (old) return response(legacyViewText(old)); const snapshot = await service(ctx.cwd).peek(params.path); state.currentPlanPath = snapshot.path; await switchModel(ctx, "normal"); remember(); const current = currentReadableTask(snapshot.plan); return response(current ? `当前任务：${current.id} ${current.text}\n按用户已经授权的范围使用普通工作工具。任务完成后更新 checklist。` : "所有任务已勾选完成。"); } catch (error) { return failure(error); } } });

  pi.registerTool({ name: "plan_migration_preview", label: "预览旧 Plan 整理", description: "Only after an explicit migration-preview request: show a supplied current V3 proposal. Does not infer requirements from old layers, write a file or transfer execution evidence. There is no migration apply.",
    parameters: Type.Object({ path: Type.String(), plan_id: Type.String({ pattern: "^P[0-9]{3,}$" }), title: Type.String(), brief: Type.String(), tasks: Type.Array(task, { minItems: 1 }) }, { additionalProperties: false }), executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) { try { const result = await previewReadableMigration(resolve(ctx.cwd, params.path), { format: "pi-plan/v3", plan_id: params.plan_id, title: params.title, brief: params.brief, tasks: normalizeTasks(params.tasks) }); return response(`仅预览，原文件未修改：\n\n${result.preview}`); } catch (error) { return failure(error); } } });

  if (governedFactory) pi.registerTool({ name: "plan_governed_run", label: "运行已授权的受控进程", description: "Run through a previously explicitly selected, Human-authorized governed actor. Does not select a runtime, grant authority, accept completion or affect availability of ordinary work.",
    parameters: Type.Object({ executable: Type.String(), args: Type.Array(Type.String()), cwd: Type.String(), env: Type.Optional(Type.Record(Type.String(), Type.String())), timeout_ms: Type.Optional(Type.Integer({ minimum: 1 })), max_buffer_bytes: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }), executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("plan_governed_run aborted");
      const generation = governedGeneration;
      try { await editable(ctx.cwd); const selected = await service(ctx.cwd).peek(); const host = await optionalHost(generation); if (generation !== governedGeneration) throw new Error("governed_session_changed"); const result = await host.run(selected.path, params, signal); return { content: [{ type: "text" as const, text: `受控进程退出：${result.exit_code ?? result.signal ?? "unknown"}${signal?.aborted ? "（已取消）" : result.timed_out ? "（超时）" : ""}${result.output_limit_exceeded ? "（输出超限）" : ""}\n${result.stdout}${result.stderr}` }], details: { mode: "optional_governed", exit_code: result.exit_code } }; }
      catch (error) { return response(`受控操作未完成：${(error as Error).message}\n普通 Plan 和工作工具仍可使用。`); }
    } });
  pi.registerCommand("plan:governed", { description: "可选受控流程：prepare|approve|authorize|verify|review|finalize|recover|status", async handler(args, ctx) {
    if (!governedFactory) return ctx.ui.notify("未配置受控执行；普通 Plan 和工作工具可以继续使用。", "info");
    if (!args.trim()) return ctx.ui.notify("用 /plan:governed prepare|approve|authorize|verify|review|finalize|recover|status；普通工作无需进入此流程。", "info");
    const generation = governedGeneration;
    try { await editable(ctx.cwd); const selected = await service(ctx.cwd).peek(); const host = await optionalHost(generation); if (generation !== governedGeneration) throw new Error("governed_session_changed"); ctx.ui.notify(await host.command(args.trim(), selected.path, ctx), "info"); }
    catch (error) { ctx.ui.notify(`受控操作未完成：${(error as Error).message}\n普通 Plan 和工作工具仍可使用。`, "info"); }
  } });

  const queue = (content: string) => pi.sendMessage({ customType: "pi-plan-readable-request", display: true, content }, { triggerTurn: true, deliverAs: "followUp" });
  async function newPlan(args: string, ctx: ExtensionCommandContext) {
    const request = args.trim() || (ctx.hasUI ? (await ctx.ui.input("想做什么？", "直接描述需求即可"))?.trim() : undefined);
    if (!request) return;
    // Model preferences must not make basic planning unavailable.
    await switchModel(ctx, "planning");
    remember(); queue(newReadablePlanPrompt(request));
  }
  pi.registerCommand("plan", { description: "整理需求并建立简洁 Plan", handler: newPlan });
  pi.registerCommand("plan:new", { description: "建立新的简洁 Plan", handler: newPlan });
  pi.registerCommand("plan:edit", { description: "原位更新需求或任务", async handler(args, ctx) { if (!args.trim()) return ctx.ui.notify("用 /plan:edit 描述修改。", "info"); await switchModel(ctx, "planning"); queue(reviseReadablePlanPrompt(args)); } });
  pi.registerCommand("plan:open", { description: "打开已有 Plan 文件", async handler(args, ctx) { try { const old = await legacy(ctx.cwd, args.trim() || undefined, true); if (old) { remember(); return ctx.ui.notify(legacyViewText(old), "info"); } const snapshot = await service(ctx.cwd).get(args.trim() || undefined); remember(); ctx.ui.notify(renderReadablePlan(snapshot.plan), "info"); } catch (error) { ctx.ui.notify(String((error as Error).message), "error"); } } });
  pi.registerCommand("plan:status", { description: "查看短 checklist", async handler(args, ctx) { try { const old = await legacy(ctx.cwd, args.trim() || undefined); ctx.ui.notify(old ? legacyViewText(old) : checklist(await service(ctx.cwd).peek(args.trim() || undefined)), "info"); } catch (error) { ctx.ui.notify(String((error as Error).message), "error"); } } });
  pi.registerCommand("plan:task", { description: "勾选或重新打开任务：T001 done|open", async handler(args, ctx) { const match = args.trim().match(/^(T\d{3,})\s+(done|open|完成|重开)$/iu); if (!match) return ctx.ui.notify("用 /plan:task T001 done 或 /plan:task T001 open。", "info"); try { await editable(ctx.cwd); const snapshot = await service(ctx.cwd).setStatus(match[1]!.toUpperCase(), /^(done|完成)$/iu.test(match[2]!)); remember(); ctx.ui.notify(checklist(snapshot), "info"); } catch (error) { ctx.ui.notify(String((error as Error).message), "error"); } } });
  pi.registerCommand("plan:next", { description: "继续当前任务的普通工作", async handler(args, ctx) { try { const old = await legacy(ctx.cwd, args.trim() || undefined); if (old) return ctx.ui.notify(legacyViewText(old), "info"); const snapshot = await service(ctx.cwd).peek(args.trim() || undefined); state.currentPlanPath = snapshot.path; const current = currentReadableTask(snapshot.plan); if (!current) return ctx.ui.notify("所有任务已勾选完成。", "info"); await switchModel(ctx, "normal"); remember(); queue(`继续当前 Plan 的普通工作：${current.id} ${current.text}。需要时先原位细分当前任务；使用普通工作工具，完成后更新 checklist。`); } catch (error) { ctx.ui.notify(String((error as Error).message), "error"); } } });

  pi.on("session_start", async (_event, ctx) => {
    governedGeneration++; governedHost?.clear();
    const entry = [...ctx.sessionManager.getEntries()].reverse().find((item: { type: string; customType?: string }) => item.type === "custom" && item.customType === "pi-plan-readable") as { data?: { currentPlanPath?: string; modelSwitch?: TaskPlanModelSwitchState } } | undefined;
    state.currentPlanPath = entry?.data?.currentPlanPath;
    state.modelSwitch = entry?.data?.modelSwitch ?? {};
    delete state.lastRead;
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const systemPrompt = `${event.systemPrompt}\n\n${READABLE_PLAN_SYSTEM}`;
    if (!state.currentPlanPath) return { systemPrompt };
    try { const old = await legacy(ctx.cwd); if (old) return { systemPrompt, message: { customType: "pi-plan-legacy-view", display: false, content: legacyViewText(old) + "\n此视图没有选择旧文档中互相冲突的需求；当前需求需明确整理，不能自动迁移或改写原文件。" } }; const snapshot = await service(ctx.cwd).get(); return { systemPrompt, message: { customType: "pi-plan-readable-context", display: false, content: renderReadablePlan(snapshot.plan) } }; }
    catch { return { systemPrompt }; } // Missing optional selection is not a host-wide blocker.
  });
  return state;
}

function checklist(snapshot: ReadableSnapshot): string {
  return snapshot.plan.tasks.map(task => `- [${task.completed ? "x" : " "}] ${task.id} ${task.text}`).join("\n");
}
