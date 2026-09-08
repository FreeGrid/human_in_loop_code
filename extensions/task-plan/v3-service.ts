import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { currentReadableTask, parseReadablePlan, renderReadablePlan, type ReadablePlan, type ReadableSubtask, type ReadableTask } from "./v3-format.ts";
import { createReadablePlan, readReadablePlan, writeReadablePlan } from "./v3-file.ts";

export type ReadableSnapshot = Awaited<ReturnType<typeof readReadablePlan>>;
export interface ReadableSessionState {
  currentPlanPath?: string;
  /** Optimistic editing cache only. Losing it never disables ordinary use. */
  lastRead?: { path: string; hash: string };
}
export interface ReadableRevision {
  path?: string;
  title?: string;
  brief?: string;
  tasks?: ReadableTask[];
  /** Authoring judgment, not an authorization claim. Omit for conservative reopening. */
  affected_task_ids?: string[];
}

const meaning = (text: string) => text.trim().replace(/\s+/gu, " ");
const childMeaning = (task: ReadableTask) => JSON.stringify(task.subtasks.map(item => meaning(item.text)).sort());
const clone = <T>(value: T): T => structuredClone(value);
function assertCurrentRefinement(plan: ReadablePlan, previous: ReadableTask[] = [], supplied: ReadableTask[] = plan.tasks): void {
  const current = plan.tasks.find(task => !task.completed);
  for (const task of plan.tasks) {
    const proposed = supplied.find(item => item.id === task.id);
    const old = previous.find(item => item.id === task.id);
    if (task !== current && proposed?.subtasks.length && JSON.stringify(proposed.subtasks.map(item => item.text)) !== JSON.stringify((old?.subtasks ?? []).map(item => item.text))) {
      throw new Error("v3_refine_current_task_only: only the first open task may receive new subtasks");
    }
  }
}

/** Ordinary planning has no dependency on execution, policy, receipts or a runtime store. */
export class ReadablePlanService {
  constructor(private readonly root: string, private readonly state: ReadableSessionState = {}) {}

  async start(brief: string, title?: string, tasks?: ReadableTask[]): Promise<ReadableSnapshot> {
    const normalized = brief.trim();
    if (!normalized) throw new Error("v3_brief_required");
    const heading = title?.trim() || normalized.split(/\r?\n/u)[0]!.slice(0, 80);
    const plan: ReadablePlan = { format: "pi-plan/v3", plan_id: "P001", title: heading, brief: normalized,
      tasks: tasks ?? [{ id: "T001", text: "完成当前需求", completed: false, subtasks: [] }] };
    renderReadablePlan(plan);
    assertCurrentRefinement(plan);
    return this.remember(await createReadablePlan(this.root, plan));
  }

  async get(path?: string): Promise<ReadableSnapshot> {
    return this.remember(await readReadablePlan(await this.resolvePath(path)));
  }

  /** Partial views must not acknowledge requirements that their reader never saw. */
  async peek(path?: string): Promise<ReadableSnapshot> {
    return readReadablePlan(await this.resolvePath(path));
  }

  async previewEdit(path?: string): Promise<ReadableSnapshot> {
    const snapshot = await this.forEdit(path);
    // The following edit derives its candidate from this exact source, including
    // the first edit in a fresh session with no prior full-view cache.
    this.state.lastRead = { path: snapshot.path, hash: snapshot.document_hash };
    return snapshot;
  }

  async list(): Promise<Array<{ path: string; title: string; completed: boolean }>> {
    const directory = join(this.root, "plans");
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const found: Array<{ path: string; title: string; completed: boolean }> = [];
    for (const name of names.sort()) {
      if (!/^\d{3,}-.+\.md$/u.test(name)) continue;
      const path = await realpath(join(directory, name));
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let text: string;
      try {
        if (!(await file.stat()).isFile()) continue;
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.readFile());
      } finally { await file.close(); }
      try {
        const plan = parseReadablePlan(text);
        found.push({ path, title: plan.title, completed: !currentReadableTask(plan) });
      } catch (error) {
        const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
        if (header.includes("pi-plan/v3")) throw error;
      }
    }
    return found;
  }

  async revise(revision: ReadableRevision): Promise<ReadableSnapshot> {
    const before = await this.forEdit(revision.path), next = clone(before.plan);
    if (revision.title !== undefined) next.title = revision.title.trim();
    if (revision.brief !== undefined) next.brief = revision.brief.trim();
    if (revision.tasks !== undefined) next.tasks = clone(revision.tasks);
    // Reject newly supplied future detail rather than silently discarding proposed work.
    renderReadablePlan(next);
    // Completed candidates may reopen below; validate their final selection after
    // applying definition changes. An added completed node never bypasses that check.
    assertCurrentRefinement(next, before.plan.tasks, (revision.tasks ?? []).filter(task => !task.completed));
    if (revision.affected_task_ids !== undefined && (new Set(revision.affected_task_ids).size !== revision.affected_task_ids.length || revision.affected_task_ids.some(id => !next.tasks.some(task => task.id === id)))) throw new Error("v3_unknown_affected_task");
    const briefChanged = meaning(next.brief) !== meaning(before.plan.brief);
    for (const task of next.tasks) {
      const previous = before.plan.tasks.find(item => item.id === task.id);
      const changed = previous && meaning(previous.text) !== meaning(task.text);
      const childrenChanged = previous && childMeaning(previous) !== childMeaning(task);
      const affected = briefChanged && (revision.affected_task_ids === undefined || revision.affected_task_ids.includes(task.id));
      if (changed || affected) {
        task.completed = false;
        for (const item of task.subtasks) item.completed = false;
      } else if (childrenChanged) {
        task.completed = false;
        for (const item of task.subtasks) if (!previous.subtasks.some(old => meaning(old.text) === meaning(item.text))) item.completed = false;
      }
    }
    // Reopening an earlier task changes selection without removing recorded work.
    assertCurrentRefinement(next, before.plan.tasks, revision.tasks ?? []);
    return this.save(before, next);
  }

  async refine(subtasks: ReadableSubtask[], taskId?: string, path?: string): Promise<ReadableSnapshot> {
    const before = await this.forEdit(path), next = clone(before.plan), current = currentReadableTask(next);
    if (!current || taskId !== undefined && current.id !== taskId) throw new Error("v3_refine_current_task_only");
    current.subtasks = clone(subtasks);
    return this.save(before, next);
  }

  async setStatus(taskId: string, completed: boolean, subtaskIndex?: number, path?: string): Promise<ReadableSnapshot> {
    if (typeof completed !== "boolean") throw new Error("v3_invalid_completion");
    const before = await this.forEdit(path), next = clone(before.plan), task = next.tasks.find(item => item.id === taskId);
    if (!task) throw new Error("v3_unknown_task");
    if (subtaskIndex === undefined) task.completed = completed;
    else {
      if (!Number.isSafeInteger(subtaskIndex) || subtaskIndex < 0 || !task.subtasks[subtaskIndex]) throw new Error("v3_unknown_subtask");
      task.subtasks[subtaskIndex]!.completed = completed;
    }
    return this.save(before, next);
  }

  async select(taskId: string, path?: string): Promise<ReadableSnapshot> {
    const before = await this.forEdit(path), next = clone(before.plan);
    const index = next.tasks.findIndex(task => task.id === taskId), current = currentReadableTask(next);
    if (index < 0 || next.tasks[index]!.completed) throw new Error("v3_select_open_task");
    if (current?.id !== taskId) {
      const target = next.tasks.splice(index, 1)[0]!;
      const at = next.tasks.findIndex(task => !task.completed);
      next.tasks.splice(at < 0 ? next.tasks.length : at, 0, target);
    }
    return this.save(before, next);
  }

  private async resolvePath(path?: string): Promise<string> {
    const selected = path ?? this.state.currentPlanPath;
    if (selected) return isAbsolute(selected) ? selected : resolve(this.root, selected);
    const plans = await this.list(), open = plans.filter(plan => !plan.completed);
    const candidates = open.length ? open : plans;
    if (candidates.length !== 1) throw new Error(candidates.length ? "v3_select_plan_path" : "v3_no_plan");
    return candidates[0]!.path;
  }

  private async forEdit(path?: string): Promise<ReadableSnapshot> {
    const snapshot = await readReadablePlan(await this.resolvePath(path));
    const previous = this.state.lastRead;
    if (previous?.path === snapshot.path && previous.hash !== snapshot.document_hash) throw new Error("v3_stale_document: read the changed Plan before editing");
    return snapshot;
  }

  private async save(before: ReadableSnapshot, next: ReadablePlan): Promise<ReadableSnapshot> {
    const text = renderReadablePlan(next);
    if (text === before.text) return this.remember(before);
    return this.remember(await writeReadablePlan(before.path, before.document_hash, next));
  }

  private remember(snapshot: ReadableSnapshot): ReadableSnapshot {
    this.state.currentPlanPath = snapshot.path;
    this.state.lastRead = { path: snapshot.path, hash: snapshot.document_hash };
    return snapshot;
  }
}

/** Human/model-facing edits describe changes once, without serializing private state. */
export function readableChanges(before: ReadablePlan, after: ReadablePlan): string[] {
  const lines: string[] = [];
  if (before.title !== after.title) lines.push(`标题：${after.title}`);
  if (before.brief !== after.brief) {
    const sentences = (brief: string) => brief.split(/(?<=[。！？；;])\s*|\n+/u).map(text => text.trim()).filter(Boolean);
    const old = sentences(before.brief), current = sentences(after.brief);
    for (const sentence of current) if (!old.includes(sentence)) lines.push(`需求：${sentence}`);
    if (!current.some(sentence => !old.includes(sentence))) for (const sentence of old) if (!current.includes(sentence)) lines.push(`移除需求：${sentence}`);
  }
  for (const task of after.tasks) {
    const old = before.tasks.find(item => item.id === task.id);
    if (!old) { lines.push(`新增 ${task.id} ${task.text}`); continue; }
    if (old.completed !== task.completed) lines.push(`${task.completed ? "[x]" : "[ ]"} ${task.id} ${task.text}`);
    else if (old.text !== task.text) lines.push(`${task.id} ${task.text}`);
    if (JSON.stringify(old.subtasks) !== JSON.stringify(task.subtasks)) {
      if (task.subtasks.length) lines.push(`${task.id} 小工作：\n${task.subtasks.map(item => `- [${item.completed ? "x" : " "}] ${item.text}`).join("\n")}`);
      else lines.push(`${task.id} 已移除小工作。`);
    }
  }
  for (const task of before.tasks) if (!after.tasks.some(item => item.id === task.id)) lines.push(`移除 ${task.id} ${task.text}`);
  if (before.tasks.map(task => task.id).join() !== after.tasks.map(task => task.id).join()) lines.push(`任务顺序：${after.tasks.map(task => task.id).join(" → ")}`);
  return lines;
}
