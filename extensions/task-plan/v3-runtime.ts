import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { assertAuthorizationReceipt, canonicalHash, canonicalJson, type AuthorizationReceipt } from "./authority.ts";
import { parseFinalizeReceipt, parseReviewEvidence, parseVerificationReceipt, type FinalizeReceipt, type ReviewEvidence, type SealedEvidence, type VerificationReceipt } from "./evidence.ts";
import { assertReadableContract, exactV3, hashV3, textV3, v3Fail, type ReadableContract } from "./v3-contract.ts";
import { parseReadablePlan, renderReadablePlan } from "./v3-format.ts";

export interface V3RawEntry { path: string; kind: "file" | "directory" | "symlink"; mode: number; hash: string }
export interface V3Baseline { root: string; entries: V3RawEntry[]; hash: string }
export interface V3ExecutionRevision {
  revision_id: string;
  execute_id: string;
  implementer_session_id: string;
  contract: ReadableContract;
  stage: "prepared" | "approved" | "authorized" | "finalized" | "invalidated";
  approval: AuthorizationReceipt | null;
  authorization: AuthorizationReceipt | null;
  finalize_authorization: AuthorizationReceipt | null;
  baseline: V3Baseline | null;
  verification: SealedEvidence<VerificationReceipt>[];
  review: SealedEvidence<ReviewEvidence> | null;
  finalized: SealedEvidence<FinalizeReceipt> | null;
}
export interface V3Projection {
  revision_id: string;
  source_text: string;
  source_hash: string;
  candidate_text: string;
  candidate_hash: string;
  status: "pending" | "projected" | "conflict";
}
export interface V3RuntimeState {
  version: 1;
  plan_path: string;
  plan_id: string;
  target_root: string;
  governance_root: string;
  revisions: V3ExecutionRevision[];
  active_revision: string | null;
  invalidated_revisions: string[];
  projection: V3Projection | null;
  recovery: AuthorizationReceipt[];
}
export interface V3RuntimeConfiguration {
  root: string;
  plan_path: string;
  target_root: string;
  governance_root: string;
  /** Persist outside child-readable content. Missing/wrong keys cannot recreate state. */
  authentication_key: Uint8Array;
  protected_key_paths?: string[];
  checkpoint?: (stage: "runtime_state_linked" | "runtime_committed" | "projection_written") => Promise<void>;
}
interface Envelope { version: 1; generation: number; previous_hash: string | null; state: V3RuntimeState; seal: string }
export interface V3RuntimeSnapshot { generation: number; hash: string | null; state: V3RuntimeState | null }
export const v3BytesHash = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
/** Preserve the exact meaning of historical projections while validating new completion. */
export function v3ProjectionKind(projection: V3Projection, contract: ReadableContract): "completed" | "retained" | "legacy_pruned" {
  const source = parseReadablePlan(projection.source_text), candidate = parseReadablePlan(projection.candidate_text);
  const task = source.tasks.find(item => item.id === contract.node_id);
  if (!task || task.completed || source.plan_id !== contract.plan_id) v3Fail("invalid_projection_source");
  const firstOpen = source.tasks.find(item => !item.completed);
  const legacySource = !source.tasks.some(item => !item.completed && item !== firstOpen && item.subtasks.length);
  const styled = (text: string): string => projection.source_text.includes("\r\n") && !/(?<!\r)\n/.test(projection.source_text) ? text.replace(/\n/g, "\r\n") : text;
  if (styled(renderReadablePlan(candidate)) !== projection.candidate_text) v3Fail("invalid_projection_candidate");
  task.completed = true;
  const retained = styled(renderReadablePlan(source));
  for (const child of task.subtasks) child.completed = true;
  if (styled(renderReadablePlan(source)) === projection.candidate_text) return "completed";
  // Earlier retained projections checked only the parent; replay their recorded checks.
  if (retained === projection.candidate_text) return "retained";
  // The old parser and renderer discarded children of every completed root.
  for (const completed of source.tasks.filter(item => item.completed)) completed.subtasks = [];
  if (!legacySource || styled(renderReadablePlan(source)) !== projection.candidate_text) v3Fail("invalid_projection_candidate");
  return "legacy_pruned";
}
const uuid = (value: unknown): void => { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) v3Fail("invalid_execution_identity"); };
const inside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
function sealed(value: unknown, parser: (receipt: unknown) => unknown): void { exactV3(value, ["receipt", "seal"]); hashV3(value.seal); parser(value.receipt); }
export function assertV3Baseline(value: unknown): asserts value is V3Baseline {
  exactV3(value, ["root", "entries", "hash"]); textV3(value.root); hashV3(value.hash);
  if (!isAbsolute(value.root) || !Array.isArray(value.entries) || value.entries.length > 100000) v3Fail("invalid_baseline");
  const seen = new Set<string>(); let previous = "";
  for (const entry of value.entries) {
    exactV3(entry, ["path", "kind", "mode", "hash"]); textV3(entry.path, 4096); hashV3(entry.hash);
    if (isAbsolute(entry.path) || entry.path.split("/").some(part => !part || part === "." || part === "..") || !["file", "directory", "symlink"].includes(String(entry.kind)) || !Number.isSafeInteger(entry.mode) || Number(entry.mode) < 0 || Number(entry.mode) > 0o7777 || seen.has(entry.path) || entry.path < previous) v3Fail("invalid_baseline_entry");
    seen.add(entry.path); previous = entry.path;
  }
  if (canonicalHash({ root: value.root, entries: value.entries }) !== value.hash) v3Fail("baseline_hash_mismatch");
}
export function assertV3RuntimeState(value: unknown): asserts value is V3RuntimeState {
  exactV3(value, ["version", "plan_path", "plan_id", "target_root", "governance_root", "revisions", "active_revision", "invalidated_revisions", "projection", "recovery"]);
  if (value.version !== 1 || typeof value.plan_id !== "string" || !/^P\d{3,}$/.test(value.plan_id)) v3Fail("invalid_runtime_identity");
  for (const field of ["plan_path", "target_root", "governance_root"] as const) { textV3(value[field]); if (!isAbsolute(value[field])) v3Fail("absolute_runtime_paths_required"); }
  if (!Array.isArray(value.revisions) || value.revisions.length > 4096 || !Array.isArray(value.recovery) || value.recovery.length > 4096) v3Fail("invalid_runtime_collections");
  const ids = new Set<string>(), executions = new Set<string>();
  for (const revision of value.revisions) {
    exactV3(revision, ["revision_id", "execute_id", "implementer_session_id", "contract", "stage", "approval", "authorization", "finalize_authorization", "baseline", "verification", "review", "finalized"]);
    uuid(revision.revision_id); uuid(revision.execute_id); textV3(revision.implementer_session_id, 256); assertReadableContract(revision.contract);
    if (revision.contract.plan_id !== value.plan_id || ids.has(String(revision.revision_id)) || executions.has(String(revision.execute_id)) || !["prepared", "approved", "authorized", "finalized", "invalidated"].includes(String(revision.stage))) v3Fail("invalid_revision");
    ids.add(String(revision.revision_id)); executions.add(String(revision.execute_id));
    for (const field of ["approval", "authorization", "finalize_authorization"] as const) if (revision[field] !== null) {
      assertAuthorizationReceipt(revision[field]); const receipt = revision[field];
      const action = field === "approval" ? "approve_contract" : field === "authorization" ? "authorize_execution" : "finalize";
      if (receipt.context.payload_hash !== canonicalHash({ action, revision_id: revision.revision_id, execute_id: revision.execute_id })) v3Fail("runtime_authority_revision_binding");
      if (receipt.action !== (field === "approval" ? "approve_contract" : field === "authorization" ? "authorize_execution" : "finalize") || receipt.context.plan_id !== value.plan_id || receipt.context.node_id !== revision.contract.node_id || receipt.context.contract_hash !== revision.contract.contract_hash || receipt.context.target_root !== value.target_root || receipt.context.governance_root !== value.governance_root) v3Fail("runtime_authority_binding");
    }
    if (revision.baseline !== null) { assertV3Baseline(revision.baseline); if (revision.baseline.root !== value.target_root) v3Fail("runtime_baseline_binding"); }
    if (!Array.isArray(revision.verification) || revision.verification.length > 256) v3Fail("invalid_verification_list");
    revision.verification.forEach(item => sealed(item, parseVerificationReceipt));
    if (revision.review !== null) sealed(revision.review, parseReviewEvidence);
    if (revision.finalized !== null) { sealed(revision.finalized, parseFinalizeReceipt);
      if ((revision.finalized as unknown as SealedEvidence<FinalizeReceipt>).receipt.authorization_ref !== (revision.finalize_authorization as AuthorizationReceipt | null)?.receipt_hash) v3Fail("finalize_authority_binding");
    }
    if (revision.stage === "prepared" && (revision.approval || revision.authorization || revision.finalize_authorization || revision.baseline || revision.verification.length || revision.review || revision.finalized) || revision.stage === "approved" && (!revision.approval || revision.authorization || revision.finalize_authorization || revision.baseline || revision.verification.length || revision.review || revision.finalized) || ["authorized", "finalized"].includes(String(revision.stage)) && (!revision.approval || !revision.authorization || !revision.baseline) || revision.stage === "finalized" && (!revision.finalize_authorization || !revision.finalized || !revision.review || !revision.verification.length) || revision.stage === "authorized" && (revision.finalized || revision.finalize_authorization)) v3Fail("invalid_revision_transition_state");
  }
  if (!Array.isArray(value.invalidated_revisions) || value.invalidated_revisions.some(id => typeof id !== "string" || !ids.has(id)) || new Set(value.invalidated_revisions).size !== value.invalidated_revisions.length) v3Fail("invalid_revocation_list");
  if (value.active_revision !== null && (typeof value.active_revision !== "string" || !ids.has(value.active_revision))) v3Fail("invalid_active_revision");
  if (value.projection !== null) {
    exactV3(value.projection, ["revision_id", "source_text", "source_hash", "candidate_text", "candidate_hash", "status"]);
    const p = value.projection; textV3(p.source_text, 1048576); textV3(p.candidate_text, 1048576); hashV3(p.source_hash); hashV3(p.candidate_hash);
    const revision = value.revisions.find(item => item.revision_id === p.revision_id);
    if (!revision || revision.stage !== "finalized" || !["pending", "projected", "conflict"].includes(String(p.status)) || v3BytesHash(p.source_text) !== p.source_hash || v3BytesHash(p.candidate_text) !== p.candidate_hash) v3Fail("invalid_projection");
    v3ProjectionKind(p as unknown as V3Projection, revision.contract as ReadableContract);
  }
  for (const receipt of value.recovery) { assertAuthorizationReceipt(receipt); if (receipt.action !== "recover" || receipt.context.plan_id !== value.plan_id) v3Fail("invalid_recovery_receipt"); }
}
async function directory(path: string, privateMode = false): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path || privateMode && (info.mode & 0o077) !== 0) v3Fail("unsafe_runtime_directory");
}
async function regularRead(path: string, allowedLinks = 1n): Promise<string> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.nlink !== allowedLinks || before.size > 16777216n || (before.mode & 0o077n) !== 0n) v3Fail("unsafe_runtime_file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await handle.stat({ bigint: true }); if (!actual.isFile() || actual.nlink !== allowedLinks || actual.dev !== before.dev || actual.ino !== before.ino) v3Fail("runtime_changed");
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true }), current = await lstat(path, { bigint: true });
    if (BigInt(bytes.length) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || current.ino !== before.ino || current.dev !== before.dev || current.nlink !== allowedLinks) v3Fail("runtime_changed");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally { await handle.close(); }
}

/** Only the writer's exact private publication companion is a recoverable hardlink. */
async function internalPair(path: string, kind: "owner" | "state"): Promise<string | undefined> {
  const info = await lstat(path);
  if (info.nlink === 1) return undefined;
  if (!info.isFile() || info.nlink !== 2) v3Fail("unsafe_runtime_file");
  const pattern = new RegExp(`^[.]${kind}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}[.]tmp$`);
  const companions: string[] = [];
  for (const name of await readdir(dirname(path))) if (pattern.test(name)) {
    const candidate = join(dirname(path), name), sibling = await lstat(candidate);
    if (sibling.dev === info.dev && sibling.ino === info.ino && sibling.isFile() && sibling.nlink === 2) companions.push(candidate);
  }
  if (companions.length !== 1) v3Fail("unsafe_runtime_file");
  return companions[0];
}
async function removeInternalPair(path: string, pair: string): Promise<void> {
  const current = await lstat(path), sibling = await lstat(pair);
  if (current.nlink !== 2 || sibling.nlink !== 2 || current.dev !== sibling.dev || current.ino !== sibling.ino) v3Fail("runtime_changed");
  await unlink(pair);
}

async function syncDirectory(path: string): Promise<void> { const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { await file.sync(); } finally { await file.close(); } }
export class V3Runtime {
  readonly root: string; readonly plan_path: string; readonly target_root: string; readonly governance_root: string; readonly protected_key_paths: readonly string[];
  #key: Buffer; #checkpoint: V3RuntimeConfiguration["checkpoint"];
  private constructor(config: V3RuntimeConfiguration) {
    this.root = config.root; this.plan_path = config.plan_path; this.target_root = config.target_root; this.governance_root = config.governance_root;
    this.protected_key_paths = Object.freeze([...(config.protected_key_paths ?? [])]); this.#key = Buffer.from(config.authentication_key); this.#checkpoint = config.checkpoint;
  }
  static async create(config: V3RuntimeConfiguration): Promise<V3Runtime> {
    if (!(config.authentication_key instanceof Uint8Array) || config.authentication_key.byteLength < 32 || config.authentication_key.byteLength > 4096) v3Fail("runtime_key_required");
    for (const path of [config.root, config.plan_path, config.target_root, config.governance_root, ...(config.protected_key_paths ?? [])]) if (!isAbsolute(path) || resolve(path) !== path) v3Fail("canonical_runtime_paths_required");
    await directory(config.target_root); await directory(config.governance_root); await directory(dirname(config.plan_path));
    if (await realpath(config.plan_path) !== config.plan_path || !inside(config.governance_root, config.plan_path) || inside(config.target_root, config.root) || inside(config.root, config.target_root) || inside(config.root, config.plan_path)) v3Fail("runtime_location_boundary");
    await directory(dirname(config.root));
    try { await mkdir(config.root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await directory(config.root, true);
    return new V3Runtime(config);
  }
  private sign(value: unknown): string { return createHmac("sha256", this.#key).update("pi-plan-v3-runtime:1\n").update(canonicalJson(value)).digest("hex"); }
  async read(): Promise<V3RuntimeSnapshot> { return this.load(false); }
  /** Pure, authenticated inspection for a Human-bound interrupted-head recovery. */
  async inspectRecovery(): Promise<V3RuntimeSnapshot> { return this.load(true); }
  private async load(allowPendingHead: boolean): Promise<V3RuntimeSnapshot> {
    await directory(this.root, true);
    const names = (await readdir(this.root)).filter(name => name.endsWith(".json")).sort();
    if (names.length > 10000) v3Fail("runtime_history_budget");
    let head: Record<string, unknown> | null = null;
    try {
      const raw = await regularRead(join(this.root, "head")); const parsed: unknown = JSON.parse(raw);
      exactV3(parsed, ["version", "generation", "state_hash", "seal"]); hashV3(parsed.state_hash); hashV3(parsed.seal);
      const { seal, ...body } = parsed;
      if (parsed.version !== 1 || !Number.isSafeInteger(parsed.generation) || Number(parsed.generation) < 1 || canonicalJson(parsed) + "\n" !== raw || !timingSafeEqual(Buffer.from(seal, "hex"), Buffer.from(this.sign(body), "hex"))) v3Fail("runtime_head_authentication_failed");
      head = parsed;
    } catch (error) { if (!absent(error)) throw error; }
    if (names.length < Number(head?.generation ?? 0)) v3Fail("runtime_committed_head_missing_data");
    let previous: string | null = null, state: V3RuntimeState | null = null;
    for (const [index, name] of names.entries()) {
      if (name !== `${String(index + 1).padStart(10, "0")}.json`) v3Fail("runtime_sequence_corrupt");
      const path = join(this.root, name), pair = allowPendingHead ? await internalPair(path, "state") : undefined;
      const raw = await regularRead(path, pair ? 2n : 1n); let envelope: unknown;
      try { envelope = JSON.parse(raw); } catch { v3Fail("runtime_json_corrupt"); }
      exactV3(envelope, ["version", "generation", "previous_hash", "state", "seal"]); hashV3(envelope.seal);
      if (envelope.version !== 1 || envelope.generation !== index + 1 || envelope.previous_hash !== previous || canonicalJson(envelope) + "\n" !== raw) v3Fail("runtime_chain_corrupt");
      const { seal, ...body } = envelope;
      if (!timingSafeEqual(Buffer.from(seal, "hex"), Buffer.from(this.sign(body), "hex"))) v3Fail("runtime_authentication_failed");
      assertV3RuntimeState(envelope.state); state = envelope.state;
      if (state.plan_path !== this.plan_path || state.target_root !== this.target_root || state.governance_root !== this.governance_root) v3Fail("runtime_foreign_binding");
      previous = canonicalHash(envelope);
      if (head?.generation === index + 1 && head.state_hash !== previous) v3Fail("runtime_head_mismatch");
    }
    if (names.length > Number(head?.generation ?? 0) && !allowPendingHead) v3Fail("runtime_head_recovery_required");
    return { generation: names.length, hash: previous, state: structuredClone(state) };
  }
  async checkpoint(stage: "runtime_state_linked" | "runtime_committed" | "projection_written"): Promise<void> { await this.#checkpoint?.(stage); }
  /** Cooperative runtime mutex. Recovery may reclaim only a validated, dead process owner. */
  async transaction<T>(work: (tx: { read(): Promise<V3RuntimeSnapshot>; save(state: V3RuntimeState, expected: V3RuntimeSnapshot): Promise<V3RuntimeSnapshot> }) => Promise<T>, recoverDeadOwner = false): Promise<T> {
    await directory(this.root, true);
    const path = join(this.root, ".lock"), temporary = join(this.root, `.owner-${randomUUID()}.tmp`);
    const owner = { pid: process.pid, token: randomUUID() }; let identity: { dev: number; ino: number } | undefined;
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(canonicalJson(owner)); await handle.sync(); } finally { await handle.close(); }
    try {
      if (recoverDeadOwner) {
        try {
          const info = await lstat(path), pair = await internalPair(path, "owner"); const raw = await regularRead(path, pair ? 2n : 1n); const prior: unknown = JSON.parse(raw); exactV3(prior, ["pid", "token"]); uuid(prior.token);
          if (!Number.isSafeInteger(prior.pid) || Number(prior.pid) <= 0) v3Fail("invalid_lock_owner");
          let dead = false; try { process.kill(Number(prior.pid), 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
          if (!dead) v3Fail("runtime_owner_active");
          const current = await lstat(path); if (current.dev !== info.dev || current.ino !== info.ino) v3Fail("runtime_lock_changed"); if (pair) await removeInternalPair(path, pair); await unlink(path);
        } catch (error) { if (!absent(error)) throw error; }
      }
      try { await link(temporary, path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") v3Fail("runtime_locked"); throw error; }
      identity = await lstat(path); await unlink(temporary);
      const save = async (state: V3RuntimeState, expected: V3RuntimeSnapshot): Promise<V3RuntimeSnapshot> => {
        assertV3RuntimeState(state);
        const current = await this.load(recoverDeadOwner);
        if (current.generation !== expected.generation || current.hash !== expected.hash) v3Fail("runtime_cas_conflict");
        if (recoverDeadOwner) for (let generation = 1; generation <= current.generation; generation++) {
          const path = join(this.root, `${String(generation).padStart(10, "0")}.json`), pair = await internalPair(path, "state");
          if (pair) await removeInternalPair(path, pair);
        }
        if (state.plan_path !== this.plan_path || state.target_root !== this.target_root || state.governance_root !== this.governance_root) v3Fail("runtime_foreign_binding");
        // A new revision cannot erase earlier execution identities or revise finalized evidence.
        if (current.state?.invalidated_revisions.some(id => !state.invalidated_revisions.includes(id))) v3Fail("runtime_revocation_rewrite");
        if (current.state) for (const prior of current.state.revisions) {
          const retained = state.revisions.find(item => item.revision_id === prior.revision_id);
          if (!retained || retained.execute_id !== prior.execute_id || retained.implementer_session_id !== prior.implementer_session_id || canonicalJson(retained.contract) !== canonicalJson(prior.contract) || prior.stage === "invalidated" && retained.stage !== "invalidated" || prior.stage === "finalized" && canonicalJson(retained) !== canonicalJson(prior)) v3Fail("runtime_history_rewrite");
        }
        const body = { version: 1 as const, generation: current.generation + 1, previous_hash: current.hash, state: structuredClone(state) };
        const envelope: Envelope = { ...body, seal: this.sign(body) }, raw = canonicalJson(envelope) + "\n";
        if (Buffer.byteLength(raw) > 16777216) v3Fail("runtime_state_budget");
        const temp = join(this.root, `.state-${randomUUID()}.tmp`), destination = join(this.root, `${String(body.generation).padStart(10, "0")}.json`);
        const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
        try { await directory(this.root, true); await link(temp, destination); await syncDirectory(this.root); } finally { await unlink(temp).catch(() => undefined); }
        await this.checkpoint("runtime_state_linked");
        const headBody = { version: 1, generation: body.generation, state_hash: canonicalHash(envelope) };
        const head = { ...headBody, seal: this.sign(headBody) }, headTemp = join(this.root, `.head-${randomUUID()}.tmp`);
        const headFile = await open(headTemp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { await headFile.writeFile(canonicalJson(head) + "\n"); await headFile.sync(); } finally { await headFile.close(); }
        try { await directory(this.root, true); await rename(headTemp, join(this.root, "head")); await syncDirectory(this.root); } finally { await unlink(headTemp).catch(() => undefined); }
        await this.checkpoint("runtime_committed");
        return { generation: body.generation, hash: canonicalHash(envelope), state: structuredClone(state) };
      };
      return await work({ read: () => this.load(recoverDeadOwner), save });
    } finally {
      await unlink(temporary).catch(() => undefined);
      if (identity) { const current = await lstat(path).catch(() => undefined); if (current && current.dev === identity.dev && current.ino === identity.ino) await unlink(path); }
    }
  }
}
export const createV3Runtime = V3Runtime.create;
