import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";
import { inspectExecutionNotes, upsertExecutionNote, validateExecutionNote, type ExecutionNote } from "./execution-notes.ts";
import { readHumanDecision, type HumanDecisionToken, type PhaseDependencies, type PhaseRecord } from "./phase-contracts.ts";
import { inspectPhaseRecords, upsertPhaseRecord, validatePhaseRecord } from "./phase-record.ts";
import { acquirePhaseFinalizeLock, canonicalSectionHash, canonicalTasksDefinitionHash, readPlanDocument, replaceFrontmatter, phaseExecutionDefinitionHash, writeIfDocumentHash } from "./plan-file.ts";
import { replaceSection } from "./sections.ts";
import { parseTasks } from "./tasks.ts";
import type { PlanDocument, TaskBlock } from "./types.ts";
import type { PlanOperationResult } from "./operation-result.ts";
import { validateFrontmatter, validateTasks } from "./validators.ts";

const exec = promisify(execFile);
const fail = (message: string): never => { throw new Error(message); };
const normalize = (s: string) => s.trim().replace(/\s+/g, " ");
const SWITCH_HELP = "DocSync: /docsync off · /docsync on. Human may also explicitly say ‘turn off DocSync’ or ‘turn on DocSync’.";
type Report = { task_id: string; work_item_id?: string; result: "in_progress" | "blocked" | "completed"; summary: string; files?: string[]; change_types?: ExecutionNote["change_types"]; acceptance_results?: Array<{ item: string; satisfied: boolean }> };

/** Plan owns progress; providers own only baseline/runtime facts and the documentation decision. */
export class PhaseExecutionService {
  constructor(private readonly dependencies: PhaseDependencies = {}) {}

  async start(document: PlanDocument, params: { task_id?: string; target_root?: string; governance_root?: string; decision?: HumanDecisionToken }): Promise<PlanOperationResult> {
    return this.operation(document, async () => {
      const d = await this.current(document);
      const { task, records } = this.select(d, params.task_id);
      let record = records[task.id];
      if (record) {
        await this.verify(d, task, record);
        if (params.target_root && await realpath(params.target_root) !== record.context.target_root) fail("root_mismatch: target root differs from original execution");
        if (params.governance_root && await realpath(params.governance_root) !== record.context.governance_root) fail("root_mismatch: governance root differs from original execution");
        return { status: "ok", path: d.path, document_hash: d.document_hash, message: `Resumed ${task.id}, execute ${record.context.execute_id}; DocSync ${record.docsync.enabled ? "on" : "off"}. ${SWITCH_HELP}`, snapshot: record };
      }
      const authorization = readHumanDecision(params.decision, "execute") ?? fail("human_authorization_required: a real Human execute decision is required");
      if (!params.target_root || !params.governance_root) fail("roots_required: explicitly supply target Git root and governance root");
      if (![params.target_root, params.governance_root].every(p => typeof p === "string" && isAbsolute(p))) fail("invalid_roots: explicitly supply absolute roots");
      if (task.workItems.some(w => w.note)) fail("baseline_missing: existing progress cannot acquire a replacement baseline");
      const context = { execute_id: randomUUID(), phase_id: task.id, round: d.metadata.round, plan_path: await realpath(d.path), target_root: await realpath(params.target_root!), governance_root: await realpath(params.governance_root!) };
      await this.roots(context);
      const provider = this.dependencies.baseline ?? fail("capability_unavailable: BaselineProvider is not configured");
      const baseline = await provider.capture({ ...context });
      record = { version: 1, context, definition_hash: this.contract(d), baseline, authorization, docsync: { enabled: true }, acceptance: [] };
      if (!validatePhaseRecord(record)) fail("baseline_invalid: provider returned an invalid baseline reference");
      await this.verify(d, task, record);
      return this.save(d, upsertPhaseRecord(d.sections.tasks, task.id, record), `Started ${task.id}, execute ${context.execute_id}; DocSync on. ${SWITCH_HELP}`, record);
    });
  }

  async report(document: PlanDocument, params: Report): Promise<PlanOperationResult> {
    return this.operation(document, async () => {
      const d = await this.current(document);
      const { task, records } = this.select(d, params.task_id);
      const record = records[task.id] ?? fail("execution_missing: start the phase before reporting");
      const contentVersion = await this.verify(d, task, record);
      const itemId = params.work_item_id ?? (task.workItems.length === 1 ? task.workItems[0]!.id : fail("work_item_required: select a stable work_item_id"));
      if (!task.workItems.some(w => w.id === itemId)) fail("unknown_work_item");
      const note: ExecutionNote = { version: 1, status: params.result === "completed" ? "pending_finalize" : params.result, summary: params.summary, files: params.files ?? [], change_types: params.change_types ?? [] };
      if (!validateExecutionNote(note)) fail("invalid_execution_note");
      if (params.acceptance_results !== undefined && (!Array.isArray(params.acceptance_results) || params.acceptance_results.length > 128)) fail("invalid_acceptance_results");
      const seen = new Set<string>();
      for (const evidence of params.acceptance_results ?? []) {
        if (!evidence || typeof evidence.item !== "string" || typeof evidence.satisfied !== "boolean" || Object.keys(evidence).some(k => !["item", "satisfied"].includes(k))) fail("invalid_acceptance_results");
        const matches = task.acceptance.filter(a => a.id === evidence.item || normalize(a.text) === normalize(evidence.item));
        if (matches.length !== 1) fail("unknown_or_ambiguous_acceptance");
        const id = matches[0]!.id;
        if (seen.has(id)) fail("duplicate_acceptance");
        seen.add(id);
        record.acceptance = record.acceptance.filter(a => a.id !== id);
        record.acceptance.push({ id, satisfied: evidence.satisfied, summary: params.summary, content_version: contentVersion });
      }
      delete record.last_finalize;
      // The note helper sees only task definitions and notes, never phase-record JSON.
      const phases = inspectPhaseRecords(d.sections.tasks);
      let markdown = upsertExecutionNote(phases.definition, itemId, note);
      phases.records[task.id] = record;
      for (const [id, r] of Object.entries(phases.records)) markdown = upsertPhaseRecord(markdown, id, r);
      return this.save(d, markdown, `${itemId}: ${note.status}; completion markers unchanged`, record);
    });
  }

  async setDocSync(document: PlanDocument, task_id: string, enabled: boolean, decision?: HumanDecisionToken): Promise<PlanOperationResult> {
    return this.operation(document, async () => {
      if (typeof enabled !== "boolean") fail("invalid_docsync_switch");
      const authority = readHumanDecision(decision, enabled ? "docsync_on" : "docsync_off") ?? fail("human_authorization_required: only actual Human input may change DocSync");
      const d = await this.current(document);
      const { task, records } = this.select(d, task_id);
      const record = records[task.id] ?? fail("execution_missing");
      await this.verify(d, task, record);
      record.docsync = { enabled, decision: authority };
      delete record.last_finalize;
      return this.save(d, upsertPhaseRecord(d.sections.tasks, task.id, record), `DocSync ${enabled ? "on" : "off"}. ${SWITCH_HELP}`, record);
    });
  }

  async finalize(document: PlanDocument, task_id: string): Promise<PlanOperationResult> {
    return this.operation(document, async () => {
      const release = await acquirePhaseFinalizeLock(document.path, task_id);
      try { return await this.finalizeLocked(document, task_id); } finally { await release(); }
    });
  }

  private async finalizeLocked(document: PlanDocument, task_id: string): Promise<PlanOperationResult> {
    let attempt: { document: PlanDocument; record: PhaseRecord } | undefined;
    return this.operation(document, async () => {
      const d = await this.current(document);
      const { task, records } = this.select(d, task_id);
      const record = records[task.id] ?? fail("execution_missing");
      attempt = { document: d, record: structuredClone(record) };
      const version = await this.verify(d, task, record);
      if (task.workItems.some(w => w.note?.status !== "pending_finalize")) fail("work_pending: every work item must be pending_finalize");
      if (task.acceptance.some(a => !record.acceptance.find(e => e.id === a.id)?.satisfied)) fail("acceptance_incomplete: all Acceptance evidence must be satisfied");
      if (record.acceptance.some(evidence => evidence.content_version !== version)) fail("acceptance_stale: repository changed after Acceptance verification; reverify every criterion");
      let finalized: NonNullable<PhaseRecord["finalized"]>;
      if (!record.docsync.enabled) {
        finalized = { check: "skipped", summary: "Documentation check explicitly disabled by Human; Task Acceptance verified.", content_version: version, debt_refs: [], human_exceptions: [] };
      } else {
        const gate = this.dependencies.docsync ?? fail("capability_unavailable: DocSyncGate is not configured; no completion written");
        const notes: Record<string, ExecutionNote> = {};
        for (const w of task.workItems) notes[w.id] = w.note!;
        const result = await gate.check(structuredClone({ context: record.context, baseline: record.baseline, content_version: version, notes }));
        if (!result || result.status === "blocked") throw new Error(`docsync_blocked: ${result?.summary ?? "missing gate result"}`);
        if (Object.keys(result).sort().join(",") !== "debt_refs,human_exceptions,status,summary,verified_version") fail("invalid_docsync_result");
        finalized = { check: result.status, summary: result.summary, content_version: result.verified_version, debt_refs: result.debt_refs, human_exceptions: result.human_exceptions };
      }
      record.finalized = finalized;
      delete record.last_finalize;
      if (!validatePhaseRecord(record)) fail("invalid_docsync_result: malformed result or missing durable debt/exception references");
      // Gate may legitimately edit documentation. Verify its final content identity, not the pre-gate identity.
      const after = await this.verify(d, task, { ...record, finalized: undefined });
      if (after !== finalized.content_version) fail("content_changed: repository changed after documentation verification");
      await this.current(d); // Recheck Plan contract and document version after asynchronous gate work.
      let markdown = inspectPhaseRecords(d.sections.tasks).definition;
      const start = markdown.indexOf(task.completionLine);
      const tail = markdown.slice(start + task.completionLine.length);
      const next = tail.search(/^### T\d{3} — /m);
      const end = next < 0 ? markdown.length : start + task.completionLine.length + next;
      const block = markdown.slice(start, end).split("\n");
      let field = "";
      const completed = block.map((line, i) => {
        if (i === 0) return line.replace(/ \[ \]$/, " [x]");
        if (/^#### /.test(line)) field = line.trimEnd();
        if (field === "#### Tasks" && /^[ \t]*- .+ \[ \][ \t]*$/.test(line)) return line.replace(/ \[ \]([ \t]*)$/, " [x]$1");
        if (field === "#### Acceptance" && /^[ \t]*- \[ \] /.test(line)) return line.replace("- [ ] ", "- [x] ");
        return line;
      }).join("\n");
      markdown = markdown.slice(0, start) + completed + markdown.slice(end);
      records[task.id] = record;
      for (const [id, r] of Object.entries(records)) markdown = upsertPhaseRecord(markdown, id, r);
      const completedTask = parseTasks(markdown).find(item => item.id === task.id);
      if (!completedTask?.completed || completedTask.workItems.some(item => !item.completed) || completedTask.acceptance.some(item => !item.completed) || canonicalTasksDefinitionHash(markdown) !== d.metadata.reviewed_tasks_hash || !validateTasks(markdown, d.metadata.round).ok) fail("incomplete_batch: refusing a partial or definition-changing completion write");
      const allDone = parseTasks(markdown).filter(t => t.round === d.metadata.round).every(t => t.completed);
      let text = replaceSection(d.text, "tasks", markdown);
      text = replaceFrontmatter(text, { ...d.metadata, stage: allDone ? "awaiting_round_decision" : "executing", stage_status: allDone ? "awaiting_human" : "in_progress" });
      // No implicit next-phase start. One CAS contains every target checkbox and the receipt.
      const finalVersion = await this.dependencies.baseline!.verify(structuredClone(record.context), structuredClone(record.baseline));
      if (finalVersion !== finalized.content_version) fail("content_changed: repository changed before completion write");
      return this.write(d, text, `${task.id} finalized: ${finalized.check}${finalized.debt_refs.length ? `; debt: ${finalized.debt_refs.join(", ")}` : ""}${finalized.human_exceptions.length ? `; Human exceptions: ${finalized.human_exceptions.join(", ")}` : ""}. ${allDone ? "Awaiting Human round decision." : "Other phases remain open."}`, record);
    }, async message => {
      if (!attempt) return undefined;
      const { document: d, record } = attempt;
      // Only append failure evidence to the same inspected Plan version. Never persist
      // a gate-mutated receipt, replace its baseline, or overwrite a concurrent edit.
      record.last_finalize = { outcome: "blocked", summary: message.slice(0, 2000) || "Finalize failed" };
      const markdown = upsertPhaseRecord(d.sections.tasks, record.context.phase_id, record);
      const saved = await this.save(d, markdown, message, record);
      return saved.status === "applied" ? { ...saved, status: "validation_error", message } : { ...saved, message: `${message}; failure receipt not saved: ${saved.message}` };
    });
  }

  private async current(document: PlanDocument): Promise<PlanDocument> {
    const d = await readPlanDocument(document.path);
    if (d.document_hash !== document.document_hash) fail("stale_document_hash: reread the Plan");
    if (d.metadata.stage !== "executing") fail("invalid_stage: phase operations require executing");
    if (!validateFrontmatter(d).ok) fail("invalid_plan_metadata");
    const phases = inspectPhaseRecords(d.sections.tasks);
    if (phases.errors.length || !validateTasks(d.sections.tasks, d.metadata.round).ok) fail("invalid_tasks_or_phase_records");
    if (inspectExecutionNotes(phases.definition).errors.length) fail("invalid_execution_notes");
    if (!d.metadata.approved_what_why_hash || d.metadata.approved_what_why_hash !== canonicalSectionHash(d.sections.what_why) || !d.metadata.approved_plan_hash || d.metadata.approved_plan_hash !== canonicalSectionHash(d.sections.plan) || !d.metadata.reviewed_tasks_hash || d.metadata.reviewed_tasks_hash !== canonicalTasksDefinitionHash(d.sections.tasks)) fail("stale_approval_contract: approved/reviewed definitions are required");
    return d;
  }

  private select(d: PlanDocument, id?: string): { task: TaskBlock; records: Record<string, PhaseRecord> } {
    const tasks = parseTasks(d.sections.tasks);
    const records = inspectPhaseRecords(d.sections.tasks).records;
    const available = tasks.filter(t => t.round === d.metadata.round && !t.completed);
    const task = id ? available.find(t => t.id === id) : available.length === 1 ? available[0] : undefined;
    if (!task) fail("phase_selection_required: select one open current-round task_id");
    if (Object.values(records).some(record => !record.finalized && record.context.phase_id !== task!.id)) fail("another_phase_active: finish the original phase before starting another");
    for (const t of tasks.filter(t => t.round === d.metadata.round)) {
      if (t.completed && !records[t.id]?.finalized) fail("completion_receipt_missing: handwritten completion is not trusted");
      if (!t.completed && (t.workItems.some(w => w.completed) || t.acceptance.some(a => a.completed) || records[t.id]?.finalized)) fail("completion_marker_conflict: only finalize may mark phase items complete");
    }
    if (task!.dependsOn.some(id => !tasks.find(t => t.id === id)?.completed)) fail("dependencies_incomplete");
    return { task: task!, records };
  }

  private contract(d: PlanDocument): string {
    return phaseExecutionDefinitionHash(d);
  }

  private async roots(c: PhaseRecord["context"]): Promise<void> {
    if (![c.target_root, c.governance_root, c.plan_path].every(isAbsolute)) fail("invalid_roots: canonical absolute paths required");
    for (const path of [c.target_root, c.governance_root, c.plan_path]) if (await realpath(path) !== path) fail("root_mismatch: canonical path changed");
    if (!(await stat(c.governance_root)).isDirectory()) fail("invalid_governance_root");
    const rel = relative(c.governance_root, c.plan_path);
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) fail("plan_outside_governance_root");
    const gitRoot = (await exec("git", ["-C", c.target_root, "rev-parse", "--show-toplevel"])).stdout.trim();
    if (await realpath(gitRoot) !== c.target_root) fail("target_not_git_root");
  }

  private async verify(d: PlanDocument, task: TaskBlock, record: PhaseRecord): Promise<string> {
    if (!validatePhaseRecord(record)) fail("invalid_phase_record");
    if (record.finalized) fail("already_finalized");
    if (record.definition_hash !== this.contract(d) || record.context.phase_id !== task.id || record.context.round !== d.metadata.round || record.context.plan_path !== await realpath(d.path)) fail("stale_execution_contract: original phase binding changed");
    if (record.acceptance.some(a => !task.acceptance.some(item => item.id === a.id))) fail("unknown_acceptance_record");
    await this.roots(record.context);
    const provider = this.dependencies.baseline ?? fail("capability_unavailable: BaselineProvider is not configured");
    const version = await provider.verify(structuredClone(record.context), structuredClone(record.baseline));
    if (typeof version !== "string" || !version.trim() || version.length > 500) fail("baseline_unavailable: invalid content identity");
    return version;
  }

  private async save(d: PlanDocument, tasks: string, message: string, record: PhaseRecord): Promise<PlanOperationResult> {
    return this.write(d, replaceSection(d.text, "tasks", tasks), message, record);
  }
  private async write(d: PlanDocument, text: string, message: string, record: PhaseRecord): Promise<PlanOperationResult> {
    const result = await writeIfDocumentHash(d.path, d.document_hash, text);
    return result.ok ? { status: "applied", path: d.path, document_hash: result.document_hash, message, snapshot: record } : { status: "conflict", path: d.path, message: result.conflict };
  }
  private async operation(document: PlanDocument, action: () => Promise<PlanOperationResult>, onFailure?: (message: string) => Promise<PlanOperationResult | undefined>): Promise<PlanOperationResult> {
    try { return await action(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (onFailure) {
        try { const recorded = await onFailure(message); if (recorded) return recorded; }
        catch { /* Preserve the original failure; inability to save evidence never passes. */ }
      }
      return { status: "validation_error", path: document.path, message };
    }
  }
}
