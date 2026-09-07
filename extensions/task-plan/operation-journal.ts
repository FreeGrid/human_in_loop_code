import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertAuthorizationReceipt, canonicalHash, canonicalJson, consumeHumanCapability, type AuthorityContext, type HumanCapability } from "./authority.ts";
import { assertSafeUnicode, decodePlanUtf8, parseFrontmatter } from "./plan-text.ts";
import { parsePlanCandidate } from "./plan-integrity.ts";
import type { PlanDocument } from "./types.ts";

// Trusted composition configuration, frozen before a model tool can execute.
function canonicalRuntime(path: string): string {
  let parent = resolve(path); const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(parent), ...tail); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; tail.unshift(basename(parent)); parent = dirname(parent); }
  }
}
export const PLAN_RUNTIME_ROOT = canonicalRuntime(process.env.PI_PLAN_RUNTIME_ROOT ?? join(homedir(), ".local", "state", "pi-plan", "operations"));
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export interface OperationIntent {
  kind: "mutation" | "reconcile" | "phase_start" | "phase_finalize" | "create";
  node_id?: string;
  execute_id?: string;
  baseline_id?: string;
  target_root?: string;
  governance_root?: string;
  authority_ref?: string;
  content_version?: string;
  contract_hash?: string;
}
export interface OperationContext {
  readonly operation_id: string;
  readonly plan_path: string;
  readonly plan_id: string;
  readonly expected_document_hash: string | null;
  readonly intent: Readonly<OperationIntent>;
}
export interface LockIdentity { path: string; dev: number; ino: number; pid: number; token: string }
interface JournalEvent {
  version: 1; sequence: number; previous_hash: string | null; event_hash: string;
  operation_id: string; plan_path: string; plan_id: string; expected_document_hash: string | null;
  type: "prepare" | "commit" | "failure" | "recovery"; timestamp: string; details: Record<string, unknown>;
}
/** Trusted filesystem fault seam, configured only by the Controller/test composition root. */
let checkpointHook: ((checkpoint: string, operation: OperationContext) => void | Promise<void>) | undefined;
export function configureJournalCheckpoints(hook?: (checkpoint: string, operation: OperationContext) => void | Promise<void>): void { checkpointHook = hook; }
export async function journalCheckpoint(checkpoint: string, operation: OperationContext): Promise<void> { await checkpointHook?.(checkpoint, operation); }
export function runtimeBindingIssue(document: Pick<PlanDocument, "metadata"> & Partial<Pick<PlanDocument, "text">>): string | undefined {
  if (document.metadata.operation_runtime !== undefined && document.metadata.operation_runtime !== PLAN_RUNTIME_ROOT) return "operation_runtime_mismatch";
  if (document.metadata.operation_runtime === undefined && /<!-- pi-plan:phase:/.test(document.text ?? "")) return "runtime_binding_required";
  return undefined;
}
const contexts = new WeakSet<OperationContext>();
const activeOperations = new Set<string>();
const locks = new Map<string, LockIdentity>();
const quiescentLocks = new Set<string>();
/** Only the settled writer may attest that its retained lock no longer guards active work. */
export function markOwnedPlanLockQuiescent(lock: LockIdentity): void { if (locks.get(lock.path)?.token === lock.token) quiescentLocks.add(lock.token); }
function ownerIsQuiescent(lock: LockIdentity): boolean { return lock.pid === process.pid && locks.get(lock.path)?.token === lock.token && quiescentLocks.has(lock.token); }
export function registerOwnedPlanLock(path: string, identity: Omit<LockIdentity, "path" | "pid" | "token">): LockIdentity {
  const lock = { path, dev: identity.dev, ino: identity.ino, pid: process.pid, token: randomUUID() }; locks.set(path, lock); return lock;
}
export function forgetOwnedPlanLock(lock: LockIdentity): void { quiescentLocks.delete(lock.token); if (locks.get(lock.path)?.token === lock.token) locks.delete(lock.path); }
export async function releaseOwnedPlanLock(lock: LockIdentity): Promise<void> {
  try { const current = await lstat(lock.path); if (current.isFile() && current.dev === lock.dev && current.ino === lock.ino) await rm(lock.path); }
  catch (error) { if (!missing(error)) throw error; }
  finally { forgetOwnedPlanLock(lock); }
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
async function regular(path: string): Promise<void> { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error("journal_unsafe_file"); }
async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("journal_unsafe_directory");
}
async function location(path: string, create = true): Promise<string> {
  if (create) await directory(PLAN_RUNTIME_ROOT);
  const root = await realpath(PLAN_RUNTIME_ROOT);
  const dir = join(root, hash(path));
  if (create) await directory(dir);
  else { const info = await lstat(dir); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("journal_unsafe_directory"); }
  return dir;
}
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); }
}
function validateEvent(value: unknown, sequence: number, previous: string | null, path: string): asserts value is JournalEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("corrupt_operation_journal");
  const e = value as JournalEvent;
  if (Object.keys(e).sort().join() !== "details,event_hash,expected_document_hash,operation_id,plan_id,plan_path,previous_hash,sequence,timestamp,type,version" || e.version !== 1 || e.sequence !== sequence || e.previous_hash !== previous || e.plan_path !== path || !UUID.test(e.operation_id) || !/^P\d{3}$/.test(e.plan_id) || !(e.expected_document_hash === null || HASH.test(e.expected_document_hash)) || !["prepare", "commit", "failure", "recovery"].includes(e.type) || !e.details || typeof e.details !== "object" || Array.isArray(e.details) || !Number.isFinite(Date.parse(e.timestamp))) throw new Error("corrupt_operation_journal");
  const { event_hash, ...unsigned } = e;
  if (!HASH.test(event_hash) || canonicalHash(unsigned) !== event_hash) throw new Error("corrupt_operation_journal_hash");
  assertSafeUnicode(e);
  const d = e.details;
  const exact = (required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(d, key)) && Object.keys(d).every(key => [...required, ...optional].includes(key));
  if (e.type === "prepare") {
    if (d.stage === "intent") {
      if (!exact(["stage", "intent", "locks", "owner_pid"]) || !d.intent || typeof d.intent !== "object" || Array.isArray(d.intent)) throw new Error("invalid_operation_intent");
      if (!Number.isSafeInteger(d.owner_pid) || Number(d.owner_pid) <= 0) throw new Error("invalid_operation_owner");
      const intent = d.intent as Record<string, unknown>;
      if (!Object.hasOwn(intent, "kind") || !["mutation", "reconcile", "phase_start", "phase_finalize", "create"].includes(String(intent.kind)) || Object.keys(intent).some(key => !["kind", "node_id", "execute_id", "baseline_id", "target_root", "governance_root", "authority_ref", "content_version", "contract_hash"].includes(key)) || Object.values(intent).some(value => typeof value !== "string" || value.length > 8192)) throw new Error("invalid_operation_intent");
    } else if (d.stage !== "candidate" || !exact(["stage", "candidate_hash", "candidate_file", "completion", "locks"]) || !HASH.test(String(d.candidate_hash)) || d.candidate_file !== `${e.operation_id}.candidate` || !["success", "blocked_projection"].includes(String(d.completion))) throw new Error("invalid_candidate_prepare");
    if (!Array.isArray(d.locks) || d.locks.length > 128) throw new Error("invalid_operation_locks");
    for (const lock of d.locks as LockIdentity[]) {
      if (!lock || typeof lock !== "object" || Object.keys(lock).sort().join() !== "dev,ino,path,pid,token" || !Number.isSafeInteger(lock.dev) || !Number.isSafeInteger(lock.ino) || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || !UUID.test(lock.token) || dirname(lock.path) !== dirname(path) || !(basename(lock.path) === `.${basename(path)}.pi-plan.lock` || /^T\d{3}\.finalize\.lock$/.test(basename(lock.path).slice(`.${basename(path)}.`.length)) && basename(lock.path).startsWith(`.${basename(path)}.`))) throw new Error("invalid_operation_lock_identity");
    }
  } else if (e.type === "commit") {
    if (!exact(["document_hash"]) || !HASH.test(String(d.document_hash))) throw new Error("invalid_operation_commit");
  } else if (e.type === "failure") {
    if (!exact(["code", "checkpoint", "side_effects_possible"], ["write_uncertain"]) || typeof d.code !== "string" || d.code.length > 65536 || typeof d.checkpoint !== "string" || d.checkpoint.length > 256 || typeof d.side_effects_possible !== "boolean" || d.write_uncertain !== undefined && typeof d.write_uncertain !== "boolean") throw new Error("invalid_operation_failure");
  } else {
    if (!exact(["action", "current_document_hash", "candidate_hash", "authorization"]) || !["abort", "confirm_commit", "already_committed"].includes(String(d.action)) || ![d.current_document_hash, d.candidate_hash].every(value => value === null || typeof value === "string" && HASH.test(value))) throw new Error("invalid_operation_recovery");
    assertAuthorizationReceipt(d.authorization);
    if (d.authorization.action !== "recover" || d.authorization.context.plan_id !== e.plan_id || !d.authorization.context.payload_hash) throw new Error("invalid_recovery_authorization");
  }
}
async function readEvents(path: string): Promise<JournalEvent[]> {
  let dir: string;
  try { dir = await location(path, false); } catch (error) { if (missing(error)) return []; throw error; }
  const entries = (await readdir(dir)).filter(name => name.endsWith(".json")).sort();
  const result: JournalEvent[] = [];
  const operations = new Map<string, JournalEvent[]>();
  for (const name of entries) {
    if (!/^\d{10}\.json$/.test(name) || Number(name.slice(0, 10)) !== result.length + 1) throw new Error("corrupt_operation_journal_sequence");
    const file = join(dir, name); await regular(file);
    const bytes = await readFile(file); if (bytes.length > 1024 * 1024) throw new Error("journal_event_too_large");
    const raw = decodePlanUtf8(bytes), event: unknown = JSON.parse(raw);
    validateEvent(event, result.length + 1, result.at(-1)?.event_hash ?? null, path);
    if (canonicalJson(event) + "\n" !== raw) throw new Error("noncanonical_operation_journal");
    const prior = operations.get(event.operation_id) ?? [];
    if (!prior.length && event.type !== "prepare" || prior.length && (prior[0]!.expected_document_hash !== event.expected_document_hash || prior[0]!.plan_id !== event.plan_id) || prior.some(e => e.type === "commit" || e.type === "recovery") && event.type !== "recovery" && !(event.type === "failure" && event.details.write_uncertain === true)) throw new Error("invalid_operation_sequence");
    if (event.type === "prepare" && !["intent", "candidate"].includes(String(event.details.stage))) throw new Error("invalid_operation_prepare");
    if (event.details.stage === "candidate" && (!HASH.test(String(event.details.candidate_hash)) || event.details.candidate_file !== `${event.operation_id}.candidate` || prior.some(e => e.details.stage === "candidate"))) throw new Error("invalid_candidate_prepare");
    if (event.type === "commit" && !prior.some(e => e.details.stage === "candidate" && e.details.candidate_hash === event.details.document_hash)) throw new Error("commit_without_prepare");
    prior.push(event); operations.set(event.operation_id, prior); result.push(event);
  }
  return result;
}
function assertContext(operation: OperationContext): void { if (!contexts.has(operation)) throw new Error("invalid_operation_context"); }
async function append(operation: OperationContext, type: JournalEvent["type"], details: Record<string, unknown>, expectedHead?: string | null): Promise<JournalEvent> {
  assertContext(operation);
  const dir = await location(operation.plan_path), lockPath = join(dir, ".append.lock");
  const ownerTemp = join(dir, `.append-owner-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined, owned: LockIdentity | undefined;
  let acquired = false, temp: string | undefined;
  try {
    // Publish only a complete, synced owner header. A crash cannot leave an empty public lock.
    handle = await open(ownerTemp, "wx", 0o600);
    const info = await handle.stat();
    owned = { path: lockPath, dev: info.dev, ino: info.ino, pid: process.pid, token: randomUUID() };
    await handle.writeFile(canonicalJson(owned)); await handle.sync();
    try { await link(ownerTemp, lockPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("operation_journal_locked"); throw error; }
    acquired = true;
    await rm(ownerTemp);
    const events = await readEvents(operation.plan_path), head = events.at(-1)?.event_hash ?? null;
    if (expectedHead !== undefined && head !== expectedHead) throw new Error("stale_operation_journal_head");
    const unsigned = { version: 1 as const, sequence: events.length + 1, previous_hash: head, operation_id: operation.operation_id, plan_path: operation.plan_path, plan_id: operation.plan_id, expected_document_hash: operation.expected_document_hash, type, timestamp: new Date().toISOString(), details };
    const event: JournalEvent = { ...unsigned, event_hash: canonicalHash(unsigned) };
    const prior = events.filter(e => e.operation_id === operation.operation_id);
    if (prior.some(e => e.type === "recovery") && type !== "recovery" || prior.some(e => e.type === "commit") && type !== "recovery" && !(type === "failure" && details.write_uncertain === true)) throw new Error("operation_already_resolved");
    validateEvent(event, unsigned.sequence, head, operation.plan_path);
    const raw = canonicalJson(event) + "\n"; if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("journal_event_too_large");
    temp = join(dir, `.event-${randomUUID()}.tmp`);
    const file = await open(temp, "wx", 0o600); try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
    await link(temp, join(dir, `${String(event.sequence).padStart(10, "0")}.json`));
    await journalCheckpoint(`journal_${type}_linked`, operation);
    await syncDirectory(dir);
    await journalCheckpoint(`journal_${type}_synced`, operation);
    return event;
  } finally {
    try { if (temp) await rm(temp, { force: true }); }
    finally {
      try { await rm(ownerTemp, { force: true }); }
      finally { try { await handle?.close(); } finally { if (acquired && owned) await releaseOwnedPlanLock(owned); } }
    }
  }
}
async function canonicalPlanPath(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) { if (!missing(error)) throw error; return join(await realpath(dirname(path)), basename(path)); }
}
export async function beginPlanOperation(document: Pick<PlanDocument, "path" | "metadata" | "document_hash">, intent: OperationIntent): Promise<OperationContext> {
  const path = await canonicalPlanPath(document.path);
  if (intent.target_root) {
    const root = await realpath(intent.target_root), runtime = resolve(PLAN_RUNTIME_ROOT), rel = relative(root, runtime);
    if (!rel || rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) throw new Error("operation_runtime_inside_target: configure PI_PLAN_RUNTIME_ROOT outside target content");
  }
  if (document.metadata.operation_runtime !== undefined && document.metadata.operation_runtime !== PLAN_RUNTIME_ROOT) throw new Error("operation_runtime_mismatch");
  if (document.metadata.operation_runtime === undefined && intent.kind !== "create") {
    const source = decodePlanUtf8(await readFile(path));
    if (["phase_start", "phase_finalize"].includes(intent.kind) || /<!-- pi-plan:phase:/.test(source)) throw new Error("runtime_binding_required");
  }
  const events = await readEvents(path);
  if (["phase_start", "phase_finalize"].includes(intent.kind) && events.some(e => e.type === "prepare" && e.details.stage === "intent" && (e.details.intent as OperationIntent)?.kind === intent.kind && !events.some(done => done.operation_id === e.operation_id && ["commit", "recovery"].includes(done.type)))) throw new Error(`operation_recovery_required: unresolved ${intent.kind} intent`);
  if (events.some(e => e.details.stage === "candidate" && !events.some(done => done.operation_id === e.operation_id && ["commit", "failure", "recovery"].includes(done.type)))) throw new Error("operation_recovery_required");
  const operation: OperationContext = Object.freeze({ operation_id: randomUUID(), plan_path: path, plan_id: document.metadata.plan_id, expected_document_hash: intent.kind === "create" ? null : document.document_hash, intent: Object.freeze({ ...intent }) });
  contexts.add(operation); activeOperations.add(operation.operation_id);
  await append(operation, "prepare", { stage: "intent", owner_pid: process.pid, intent: operation.intent, locks: [...locks.values()].filter(lock => dirname(lock.path) === dirname(path) && basename(lock.path).startsWith(`.${basename(path)}.`)) });
  try { await journalCheckpoint("intent", operation); }
  catch (error) {
    await recordOperationFailure(operation, { code: String(error), checkpoint: "intent", side_effects_possible: false });
    throw new Error(`operation_intent_failed: ${operation.operation_id}: ${String(error)}`);
  }
  return operation;
}
export async function prepareOperationCandidate(operation: OperationContext, content: string, completion: "success" | "blocked_projection" = "success"): Promise<void> {
  assertContext(operation);
  const dir = await location(operation.plan_path), candidate = join(dir, `${operation.operation_id}.candidate`);
  const file = await open(candidate, "wx", 0o600);
  try { await file.writeFile(content, "utf8"); await file.sync(); } finally { await file.close(); }
  await syncDirectory(dir);
  await journalCheckpoint("candidate_synced", operation);
  await append(operation, "prepare", { stage: "candidate", candidate_hash: hash(content), candidate_file: `${operation.operation_id}.candidate`, completion, locks: [...locks.values()].filter(lock => dirname(lock.path) === dirname(operation.plan_path) && basename(lock.path).startsWith(`.${basename(operation.plan_path)}.`)) });
}
export async function commitPlanOperation(operation: OperationContext, documentHash: string): Promise<void> { await append(operation, "commit", { document_hash: documentHash }); activeOperations.delete(operation.operation_id); }
export async function recordOperationFailure(operation: OperationContext, failure: { code: string; checkpoint: string; side_effects_possible: boolean; write_uncertain?: boolean }): Promise<void> {
  await append(operation, "failure", failure);
  activeOperations.delete(operation.operation_id);
}
export async function assertOperationWritable(path: string, ownId?: string): Promise<void> {
  path = await canonicalPlanPath(path);
  try { const metadata = parseFrontmatter(decodePlanUtf8(await readFile(path))).metadata; if (metadata.operation_runtime !== undefined && metadata.operation_runtime !== PLAN_RUNTIME_ROOT) throw new Error("operation_runtime_mismatch"); } catch (error) { if (!missing(error)) throw error; }
  const events = await readEvents(path);
  for (const event of events.filter(e => e.details.stage === "candidate" || e.type === "failure" && e.details.write_uncertain === true)) {
    if (event.operation_id === ownId) continue;
    const related = events.filter(e => e.operation_id === event.operation_id);
    if (!related.some(e => e.type === "commit" || e.type === "recovery" || e.type === "failure" && e.details.write_uncertain !== true)) throw new Error(`operation_recovery_required: ${event.operation_id}`);
    if (related.some(e => e.type === "failure" && e.details.write_uncertain === true) && !related.some(e => e.type === "recovery")) throw new Error(`operation_recovery_required: ${event.operation_id}`);
  }
}
/** Pure enumeration also recovers operation IDs when the host crashed before returning them. */
export async function listPlanOperationIds(path: string): Promise<string[]> {
  path = await canonicalPlanPath(path);
  const metadata = parseFrontmatter(decodePlanUtf8(await readFile(path))).metadata;
  if (metadata.operation_runtime !== undefined && metadata.operation_runtime !== PLAN_RUNTIME_ROOT) throw new Error("operation_runtime_mismatch");
  return [...new Set((await readEvents(path)).map(event => event.operation_id))];
}
export interface RecoveryInspection {
  operation_id: string; plan_path: string; plan_id: string; expected_document_hash: string | null;
  current_document_hash: string | null; candidate_hash: string | null; journal_head: string;
  outcome: "already_committed" | "confirm_commit" | "abort" | "conflict";
  authority_context: AuthorityContext;
}
export async function inspectOperationRecovery(path: string, operationId: string): Promise<RecoveryInspection> {
  path = await canonicalPlanPath(path);
  const events = await readEvents(path), own = events.filter(e => e.operation_id === operationId);
  if (!own.length) throw new Error("unknown_operation_id");
  const initial = own[0]!, prepare = own.find(e => e.details.stage === "candidate");
  let current: string | null = null;
  try { current = hash(await readFile(path)); } catch (error) { if (!missing(error)) throw error; }
  const candidate = prepare ? String(prepare.details.candidate_hash) : null;
  if (candidate) {
    const file = join(await location(path, false), `${operationId}.candidate`); await regular(file);
    const bytes = await readFile(file);
    if (hash(bytes) !== candidate) throw new Error("corrupt_operation_candidate");
    parsePlanCandidate(path, decodePlanUtf8(bytes));
  }
  const terminal = own.find(e => e.type === "commit" || e.type === "recovery");
  const outcome: RecoveryInspection["outcome"] = terminal ? current === (terminal.type === "commit" ? terminal.details.document_hash : terminal.details.current_document_hash) ? "already_committed" : "conflict" : candidate && current === candidate ? "confirm_commit" : current === initial.expected_document_hash ? "abort" : "conflict";
  const facts = { operation_id: operationId, plan_path: path, plan_id: initial.plan_id, expected_document_hash: initial.expected_document_hash, current_document_hash: current, candidate_hash: candidate, journal_head: events.at(-1)!.event_hash, outcome };
  const intent = initial.details.intent as OperationIntent;
  return { ...facts, authority_context: { plan_id: initial.plan_id, node_id: intent.node_id ?? "$plan", document_hash: current ?? hash("missing"), contract_hash: canonicalHash(facts), target_root: intent.target_root ?? dirname(path), governance_root: intent.governance_root ?? dirname(path), payload_hash: canonicalHash(facts) } };
}
function ownerIsDead(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
export async function recoverPlanOperation(inspection: RecoveryInspection, capability: HumanCapability): Promise<RecoveryInspection> {
  const current = await inspectOperationRecovery(inspection.plan_path, inspection.operation_id);
  if (canonicalJson(current) !== canonicalJson(inspection)) throw new Error("stale_recovery_inspection");
  if (current.outcome === "conflict") throw new Error("operation_recovery_conflict");
  const authorization = consumeHumanCapability(capability, "recover", current.authority_context);
  const events = await readEvents(current.plan_path), own = events.filter(e => e.operation_id === current.operation_id);
  const ownerPid = Number(own[0]!.details.owner_pid);
  if (activeOperations.has(current.operation_id) || !own.some(e => ["commit", "failure", "recovery"].includes(e.type)) && !ownerIsDead(ownerPid)) throw new Error("operation_owner_still_active");
  const identities = own.flatMap(e => Array.isArray(e.details.locks) ? e.details.locks as LockIdentity[] : []);
  const unique = [...new Map(identities.map(lock => [lock.path, lock])).values()];
  // A historical operation cannot adjudicate a newer lock created before its first intent.
  const planPrefix = `.${basename(current.plan_path)}.`;
  const presentLocks = (await readdir(dirname(current.plan_path))).filter(name => name === `${planPrefix}pi-plan.lock` || name.startsWith(planPrefix) && /^T\d{3}\.finalize\.lock$/.test(name.slice(planPrefix.length)));
  if (presentLocks.some(name => !unique.some(identity => identity.path === join(dirname(current.plan_path), name)))) throw new Error("unknown_lock_offline_recovery_required");
  let remainingLocks = false;
  for (const lock of unique) {
    try {
      const info = await lstat(lock.path);
      remainingLocks = true;
      if (!info.isFile() || info.dev !== lock.dev || info.ino !== lock.ino || !(ownerIsDead(lock.pid) || ownerIsQuiescent(lock))) throw new Error("recovery_lock_owner_not_proven_dead");
    } catch (error) { if (!missing(error)) throw error; }
  }
  // A crashed append owns an external lock. Explicit recovery can release it only with exact inode and proven dead process.
  const appendLockPath = join(await location(current.plan_path, false), ".append.lock");
  try {
    const info = await lstat(appendLockPath); await regular(appendLockPath);
    const owner = JSON.parse(decodePlanUtf8(await readFile(appendLockPath))) as LockIdentity;
    if (owner.path !== appendLockPath || owner.dev !== info.dev || owner.ino !== info.ino || !UUID.test(owner.token) || !ownerIsDead(owner.pid)) throw new Error("recovery_journal_owner_not_proven_dead");
    await releaseOwnedPlanLock(owner);
  } catch (error) { if (!missing(error)) throw error; }
  let observed: string | null = null;
  try { observed = hash(await readFile(current.plan_path)); } catch (error) { if (!missing(error)) throw error; }
  if (observed !== current.current_document_hash) throw new Error("stale_recovery_document");
  if (!remainingLocks && current.outcome === "already_committed" && own.some(e => e.type === "recovery")) return current;
  const initial = own[0]!;
  const operation: OperationContext = Object.freeze({ operation_id: initial.operation_id, plan_path: initial.plan_path, plan_id: initial.plan_id, expected_document_hash: initial.expected_document_hash, intent: Object.freeze(initial.details.intent as OperationIntent) }); contexts.add(operation);
  await append(operation, "recovery", { action: current.outcome, current_document_hash: current.current_document_hash, candidate_hash: current.candidate_hash, authorization }, current.journal_head);
  for (const lock of unique) await releaseOwnedPlanLock(lock);
  return inspectOperationRecovery(current.plan_path, current.operation_id);
}
