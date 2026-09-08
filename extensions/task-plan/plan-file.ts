import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { extractAllSections } from "./sections.ts";
import { canonicalTaskDefinition, parseTasks } from "./tasks.ts";
import { HARNESS, type PlanDocument, type PlanMetadata } from "./types.ts";

import { FRONTMATTER, assertNoReservedPlanMarkup, decodePlanUtf8, parseFrontmatter, renderFrontmatter } from "./plan-text.ts";
import { parsePlanCandidate } from "./plan-integrity.ts";
import { PLAN_RUNTIME_ROOT, assertOperationWritable, beginPlanOperation, commitPlanOperation, journalCheckpoint, markOwnedPlanLockQuiescent, prepareOperationCandidate, recordOperationFailure, registerOwnedPlanLock, releaseOwnedPlanLock, syncDirectory, type LockIdentity, type OperationContext, type OperationIntent } from "./operation-journal.ts";
export { parseFrontmatter, renderFrontmatter } from "./plan-text.ts";

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export function canonicalSectionHash(content: string): string {
  return sha256(content.replace(/\r\n/g, "\n"));
}

export function canonicalTasksDefinitionHash(content: string): string {
  return sha256(canonicalTaskDefinition(content));
}

export function phaseExecutionDefinitionHash(document: PlanDocument): string {
  return sha256(JSON.stringify([document.metadata.plan_id, document.metadata.round, canonicalSectionHash(document.sections.what_why), canonicalSectionHash(document.sections.plan), canonicalTasksDefinitionHash(document.sections.tasks)]));
}

/** V2 contract identity is scoped to one executable node and its direct definition. */
export function executionDefinitionHash(document: PlanDocument, nodeId: string): string {
  return (document.metadata as Record<string, unknown>).format === "pi-plan/v2"
    ? nodeExecutionDefinitionHash(document, nodeId)
    : phaseExecutionDefinitionHash(document);
}

export function nodeExecutionDefinitionHash(document: PlanDocument, nodeId: string): string {
  const task = parseTasks(document.sections.tasks).find((candidate) => candidate.id === nodeId);
  const outline = [...document.sections.plan.matchAll(new RegExp(`^### ${escapeRegExp(nodeId)} — .+$[\\s\\S]*?(?=^### T\\d{3} — |$)`, "gm"))][0]?.[0] ?? "";
  if (!task && !outline) throw new Error(`Unknown execution node ${nodeId}`);
  return sha256(JSON.stringify([document.metadata.plan_id, document.metadata.round, nodeId, canonicalSectionHash(outline), task ? canonicalTasksDefinitionHash(task.definition) : ""]));
}

export function replaceFrontmatter(text: string, metadata: PlanMetadata): string {
  const match = text.match(FRONTMATTER);
  if (!match) throw new Error("Plan document is missing frontmatter");
  return renderFrontmatter(metadata) + text.slice(match[0].length);
}

export async function readPlanDocument(path: string): Promise<PlanDocument> {
  const bytes = await readFile(path);
  const text = decodePlanUtf8(bytes);
  return { ...parsePlanCandidate(path, text), document_hash: sha256(bytes) };
}

export async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  } finally { await rm(tmp, { force: true }); }
}

export interface PlanWriteOptions { operation?: OperationContext; completion?: "success" | "blocked_projection"; kind?: OperationIntent["kind"] }
export type PlanWriteResult = { ok: true; document_hash: string; operation_id: string } | { ok: false; conflict: string; operation_id?: string; observed_document_hash?: string };
export async function writeIfDocumentHash(path: string, expectedHash: string, content: string, options: PlanWriteOptions = {}): Promise<PlanWriteResult> {
  const requested = parsePlanCandidate(path, content); // No persistence before whole-candidate validity.
  if (requested.metadata.operation_runtime !== undefined && requested.metadata.operation_runtime !== PLAN_RUNTIME_ROOT) throw new Error("operation_runtime_mismatch");
  content = replaceFrontmatter(content, { ...requested.metadata, operation_runtime: PLAN_RUNTIME_ROOT });
  const candidate = parsePlanCandidate(path, content);
  let canonical: string;
  try { canonical = await realpath(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, conflict: "missing_file" }; throw error; }
  const lockPath = join(dirname(canonical), `.${basename(canonical)}.pi-plan.lock`);
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return { ok: false, conflict: "plan_write_locked" }; throw error; }
  let owned: LockIdentity | undefined;
  const tmp = join(dirname(canonical), `.${basename(canonical)}.${process.pid}.${randomUUID()}.tmp`);
  let operation = options.operation, renamed = false, preserveLock = false, checkpoint = "lock_setup";
  try {
    const lockInfo = await lock.stat(); owned = registerOwnedPlanLock(lockPath, lockInfo);
    checkpoint = "source_check";
    if (operation && (operation.plan_path !== canonical || operation.expected_document_hash !== expectedHash)) throw new Error("operation_document_mismatch");
    await assertOperationWritable(canonical, operation?.operation_id);
    const current = await readFile(canonical);
    if (sha256(current) !== expectedHash) return { ok: false, conflict: "stale_document_hash" };
    const original = parsePlanCandidate(canonical, decodePlanUtf8(current));
    operation ??= await beginPlanOperation(original, { kind: options.kind ?? "mutation" });
    await prepareOperationCandidate(operation, content, options.completion);
    checkpoint = "prepared"; await journalCheckpoint(checkpoint, operation);
    const mode = (await stat(canonical)).mode & 0o777;
    const file = await open(tmp, "wx", mode);
    try { await file.writeFile(content, "utf8"); await file.sync(); } finally { await file.close(); }
    checkpoint = "before_rename"; await journalCheckpoint(checkpoint, operation);
    if (sha256(await readFile(canonical)) !== expectedHash) {
      await recordOperationFailure(operation, { code: "stale_document_hash", checkpoint, side_effects_possible: false });
      return { ok: false, conflict: "stale_document_hash", operation_id: operation.operation_id };
    }
    await rename(tmp, canonical); renamed = true;
    checkpoint = "after_rename"; await journalCheckpoint(checkpoint, operation);
    await syncDirectory(dirname(canonical));
    checkpoint = "before_commit"; await journalCheckpoint(checkpoint, operation);
    await commitPlanOperation(operation, candidate.document_hash);
    return { ok: true, document_hash: candidate.document_hash, operation_id: operation.operation_id };
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    preserveLock = renamed;
    if (operation) {
      try { await recordOperationFailure(operation, { code, checkpoint, side_effects_possible: renamed, write_uncertain: renamed }); }
      catch { preserveLock = true; }
    }
    if (preserveLock) return { ok: false, conflict: "operation_recovery_required", operation_id: operation?.operation_id, ...(renamed ? { observed_document_hash: candidate.document_hash } : {}) };
    throw error;
  } finally {
    let cleanupFailure: unknown;
    try { if (operation) await journalCheckpoint("before_cleanup", operation); } catch (error) { cleanupFailure = error; }
    try { await rm(tmp, { force: true }); } catch (error) { cleanupFailure ??= error; }
    try { await lock.close(); } catch (error) { cleanupFailure ??= error; }
    if (cleanupFailure && renamed) preserveLock = true;
    if (owned) {
      if (!preserveLock) {
        try { if (operation) await journalCheckpoint("before_lock_release", operation); await releaseOwnedPlanLock(owned); }
        catch (error) { cleanupFailure ??= error; preserveLock = renamed; }
      }
      if (preserveLock) markOwnedPlanLockQuiescent(owned);
    }
    if (cleanupFailure) {
      if (operation) {
        try { await recordOperationFailure(operation, { code: String(cleanupFailure), checkpoint: "cleanup", side_effects_possible: renamed, write_uncertain: renamed }); }
        catch { /* Durable prepare/commit and retained ownership require explicit inspection. */ }
      }
      if (renamed) return { ok: false, conflict: "operation_recovery_required", operation_id: operation?.operation_id, observed_document_hash: candidate.document_hash };
      throw new Error(`plan_write_cleanup_failed: ${String(cleanupFailure)}`);
    }
  }
}

/** Serialize an entire finalize attempt, including its potentially mutating documentation gate. */
export async function acquirePhaseFinalizeLock(path: string, taskId: string): Promise<() => Promise<void>> {
  if (!/^T\d{3}$/.test(taskId)) throw new Error("invalid_phase_id");
  const canonical = await realpath(path);
  const lockPath = join(dirname(canonical), `.${basename(canonical)}.${taskId}.finalize.lock`);
  let handle;
  try { handle = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("phase_finalize_locked: another finalize attempt is active or needs explicit crash recovery");
    throw error;
  }
  let owned: LockIdentity;
  try { const info = await handle.stat(); owned = registerOwnedPlanLock(lockPath, info); }
  catch (error) { await handle.close(); throw new Error(`phase_finalize_lock_initialization_failed: preserved unknown lock: ${String(error)}`); }
  return async () => { try { await handle.close(); } finally { await releaseOwnedPlanLock(owned); } };
}

export async function detectLegacyWorkspaceConflict(root: string): Promise<string[]> {
  const conflicts: string[] = [];
  const planning = join(root, "planning");
  if (await exists(join(planning, ".current"))) conflicts.push("planning/.current");
  const active = join(planning, "active");
  try {
    const entries = await readdir(active);
    if (entries.some((entry) => !entry.startsWith("."))) conflicts.push("planning/active/");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return conflicts;
}

export async function nextPlanSequence(root: string): Promise<number> {
  const plans = join(root, "plans");
  let max = 0;
  try {
    for (const entry of await readdir(plans)) {
      const match = entry.match(/^(\d{3})-.*\.md$/);
      if (match) max = Math.max(max, Number(match[1]));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return max + 1;
}

export async function findUnfinishedHarnessPlans(root: string): Promise<string[]> {
  const plans = join(root, "plans");
  const found: string[] = [];
  try {
    for (const entry of await readdir(plans)) {
      if (!/^\d{3}-.*\.md$/.test(entry)) continue;
      const path = join(plans, entry);
      const bytes = await readFile(path);
      // Classification is independent of parsing, including malformed UTF-8/frontmatter.
      const signature = bytes.toString("latin1");
      const harnessCandidate = /<!--\s*pi-plan:/i.test(signature) || /(?:harness|format)["']?\s*:\s*["']?pi-plan\//i.test(signature);
      if (!harnessCandidate) continue;
      let document: PlanDocument;
      try { document = parsePlanCandidate(path, decodePlanUtf8(bytes)); }
      catch (error) { throw new Error(`corrupt_harness_plan: ${path}: ${(error as Error).message}`); }
      if (!["completed", "abandoned"].includes(document.metadata.stage)) found.push(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return found.sort();
}

export function planTitleFromGoal(input: string): string {
  let title = input.trim().replace(/\s+/g, " ");
  title = title.replace(/^(?:\/plan(?::new)?|plan|计划|规划)\s*[:：-]?\s*/iu, "");
  title = title.replace(/^(?:请|麻烦|帮我|帮忙|需要|我需要|我要|我想|想|我们要|先)?\s*(?:给我|给(?:这个|这件事|这个事情)?|把(?:这个|这件事|这个事情)?)?\s*(?:写(?:一个|个|一下)?|做(?:一个|个|一下)?|弄(?:一个|个|一下)?|搞(?:一个|个|一下)?|实现(?:一个|个|一下)?|构建(?:一个|个|一下)?|规划(?:一个|个|一下)?|拆(?:一个|个|一下)?|设计(?:一个|个|一下)?)\s*/u, "");
  title = title.replace(/[。！？.!?；;：:，,、\s]+$/u, "").trim();
  return title || input.trim() || "Plan";
}

export function slugify(input: string): string {
  return input.toLowerCase().normalize("NFKD").replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "plan";
}

export async function createPlanSkeleton(root: string, goal: string, titleOverride?: string): Promise<PlanDocument> {
  const legacy = await detectLegacyWorkspaceConflict(root);
  if (legacy.length) throw new Error(`Legacy planning workspace conflict: ${legacy.join(", ")}`);
  const unfinished = await findUnfinishedHarnessPlans(root);
  if (unfinished.length) throw new Error(`Unfinished Harness Plan already exists: ${unfinished.join(", ")}`);
  const sequence = await nextPlanSequence(root);
  const planId = `P${String(sequence).padStart(3, "0")}`;
  const title = titleOverride?.trim() || planTitleFromGoal(goal);
  const path = join(root, "plans", `${String(sequence).padStart(3, "0")}-${slugify(title)}.md`);
  assertNoReservedPlanMarkup(goal, "Original Request");
  assertNoReservedPlanMarkup(title, "title");
  if (/[\r\n\u2028\u2029]/u.test(title)) throw new Error("invalid_plan_title");
  const text = renderSkeleton(planId, goal, title), candidate = parsePlanCandidate(path, text);
  await mkdir(dirname(path), { recursive: true });
  const operation = await beginPlanOperation(candidate, { kind: "create" });
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let installed = false;
  try {
    await prepareOperationCandidate(operation, text);
    const fh = await open(temp, "wx", 0o600); try { await fh.writeFile(text, "utf8"); await fh.sync(); } finally { await fh.close(); }
    await journalCheckpoint("before_create", operation);
    await link(temp, path); installed = true; // Exclusive install: never overwrite a competing creator.
    await journalCheckpoint("after_create", operation);
    await syncDirectory(dirname(path)); await commitPlanOperation(operation, candidate.document_hash);
    return { ...candidate, path };
  } catch (error) {
    try { await recordOperationFailure(operation, { code: (error as Error).message, checkpoint: installed ? "after_create" : "before_create", side_effects_possible: installed, write_uncertain: installed }); } catch { /* Preserve prepare for explicit recovery. */ }
    if (installed) throw new Error(`operation_recovery_required: ${operation.operation_id}`);
    throw error;
  } finally {
    try { await rm(temp, { force: true }); }
    catch (error) {
      if (installed) {
        try { await recordOperationFailure(operation, { code: String(error), checkpoint: "create_cleanup", side_effects_possible: true, write_uncertain: true }); } catch { /* Explicit inspection uses the durable prepare/commit. */ }
        throw new Error(`operation_recovery_required: ${operation.operation_id}`);
      }
      throw error;
    }
  }
}

function renderSkeleton(planId: string, goal: string, title = planTitleFromGoal(goal)): string {
  return `${renderFrontmatter({ harness: HARNESS, plan_id: planId, round: 0, stage: "what_why", stage_status: "drafting", operation_runtime: PLAN_RUNTIME_ROOT })}\n# ${planId} — ${title}\n\n## Original Request\n\n${goal}\n\n---\n\n<!-- pi-plan:what-why:start -->\n\nPending.\n\n<!-- pi-plan:what-why:end -->\n\n---\n\n## Plan\n\n<!-- pi-plan:plan:start -->\n\nPending approval of What / Why.\n\n<!-- pi-plan:plan:end -->\n\n<!-- pi-plan:tasks:start -->\n\nPending approval of Plan.\n\n<!-- pi-plan:tasks:end -->\n\n<!-- pi-plan:review:start -->\n\nNot run.\n\n<!-- pi-plan:review:end -->\n`;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&"); }
