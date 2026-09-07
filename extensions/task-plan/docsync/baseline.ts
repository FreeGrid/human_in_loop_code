import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BaselineProvider, BaselineReference, PhaseContext } from "../phase-contracts.ts";
import { canonicalTaskDefinition } from "../tasks.ts";
import { inspectExecutionNotes } from "../execution-notes.ts";
import { inspectPhaseRecords } from "../phase-record.ts";
import { extractAllSections, markersFor } from "../sections.ts";
import type { ConfigurationState, ContentIdentity, DocumentRead, DocumentTarget, RepositoryFacts } from "./contracts.ts";
import { configurationTargets, readConfiguration } from "./configuration.ts";
import { documentIdentity, readDocument, resolveContainedPath, targetKey, targetPath } from "./targets.ts";
import { attributes, blobIdentity, canonicalDirectory, digest, git, missing, names, normalize, readRaw, safeName, same, snapshot, textGit, treeEntries, type Snapshot } from "./git.ts";

const MAX_BASELINE = 16 * 1024 * 1024;
interface Saved {
  schema: 1;
  context: PhaseContext;
  git_dir: string;
  head: string;
  tree: string;
  index: string;
  format: "sha1" | "sha256";
  rules: string;
  attributes: string;
  exceptions: Record<string, ContentIdentity>;
  initial_untracked: string[];
  documents: Record<string, { target: DocumentTarget; read: DocumentRead }>;
  configuration_version: string;
  plan_version: string;
}
interface Located { context: PhaseContext; gitDir: string; runtime: string }
interface Sample { facts: Omit<RepositoryFacts, "baseline" | "content_version">; version: string; stamp: string }
const hash = (value: unknown) => digest(JSON.stringify(value));
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const exact = (value: Record<string, unknown>, keys: string) => Object.keys(value).sort().join(",") === keys.split(",").sort().join(",");
const sha = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const oid = (value: unknown, format: string) => typeof value === "string" && new RegExp(`^[0-9a-f]{${format === "sha1" ? 40 : 64}}$`).test(value);
function validateIdentity(value: unknown, format: string): void {
  if (!object(value)) throw new Error("Corrupt baseline content identity");
  if (value.kind === "missing" && exact(value, "kind")) return;
  if (!exact(value, "kind,mode,oid,domain") || !["file", "symlink"].includes(String(value.kind)) || !["100644", "100755", "120000"].includes(String(value.mode)) || (value.kind === "symlink") !== (value.mode === "120000") || value.domain !== `git-${format}` || !oid(value.oid, format)) throw new Error("Corrupt baseline content identity");
}
function validateRead(value: unknown): void {
  if (!object(value) || !["file_version,identity", "error,file_version,identity"].includes(Object.keys(value).sort().join(",")) || typeof value.file_version !== "string" || value.file_version.length > 200 || !(value.identity === null || typeof value.identity === "string" && value.identity.length <= 200) || (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 4096))) throw new Error("Corrupt document identity");
}
function validateSaved(value: unknown): asserts value is Saved {
  if (!object(value) || !exact(value, "schema,context,git_dir,head,tree,index,format,rules,attributes,exceptions,initial_untracked,documents,configuration_version,plan_version") || value.schema !== 1 || !["sha1", "sha256"].includes(String(value.format))) throw new Error("Corrupt baseline schema");
  if (!object(value.context) || !exact(value.context, "execute_id,phase_id,round,plan_path,target_root,governance_root") || typeof value.git_dir !== "string" || !isAbsolute(value.git_dir)) throw new Error("Corrupt baseline binding");
  if (!oid(value.head, String(value.format)) || !oid(value.tree, String(value.format)) || ![value.index, value.rules, value.attributes, value.plan_version].every(sha) || typeof value.configuration_version !== "string" || value.configuration_version.length > 200) throw new Error("Corrupt baseline digests");
  if (!object(value.exceptions) || Object.keys(value.exceptions).length > 100000 || !Array.isArray(value.initial_untracked) || value.initial_untracked.length > 100000 || !object(value.documents) || Object.keys(value.documents).length > 2048) throw new Error("Corrupt baseline collections");
  for (const [path, identity] of Object.entries(value.exceptions)) { safeName(path); validateIdentity(identity, String(value.format)); }
  for (const path of value.initial_untracked) { if (typeof path !== "string" || !Object.hasOwn(value.exceptions, path)) throw new Error("Corrupt untracked exceptions"); safeName(path); }
  for (const [key, entry] of Object.entries(value.documents)) { if (!object(entry) || !exact(entry, "target,read")) throw new Error("Corrupt document baseline"); const target = entry.target as DocumentTarget; if (!(typeof target === "string" || object(target) && exact(target, "path,section_id") && typeof target.section_id === "string")) throw new Error("Corrupt document target"); safeName(targetPath(target)); if (key !== targetKey(target)) throw new Error("Corrupt document key"); validateRead(entry.read); }
}
async function locate(input: PhaseContext): Promise<Located> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.execute_id) || !/^T\d{3}$/.test(input.phase_id) || !Number.isSafeInteger(input.round) || input.round < 0) throw new Error("Invalid execution identity");
  const target_root = await canonicalDirectory(input.target_root), governance_root = await canonicalDirectory(input.governance_root);
  if (await textGit(target_root, ["rev-parse", "--show-toplevel"]) !== target_root) throw new Error("Target must be the canonical Git worktree root");
  let planRelative = relative(governance_root, resolve(input.plan_path));
  if (planRelative.startsWith("../")) planRelative = relative(resolve(input.governance_root), resolve(input.plan_path));
  const plan_path = await resolveContainedPath(governance_root, planRelative);
  const rawGitDir = await textGit(target_root, ["rev-parse", "--absolute-git-dir"]);
  const gitDir = await canonicalDirectory(rawGitDir);
  if (rawGitDir !== gitDir) throw new Error("Symlink Git directory is unsupported");
  const rawCommonDir = await textGit(target_root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonDir = await canonicalDirectory(rawCommonDir);
  if (rawCommonDir !== commonDir) throw new Error("Symlink common Git directory is unsupported");
  const within = (parent: string, path: string) => {
    const suffix = relative(parent, path);
    return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
  };
  // Only the standard .git namespace is excluded by path validation/discovery.
  // Reject other embedded metadata before reading policy/docs or claiming runtime,
  // including a shared object directory for a linked worktree.
  for (const metadata of [gitDir, commonDir]) {
    if (within(target_root, metadata) && !within(join(target_root, ".git"), metadata)) {
      throw new Error("Unsupported embedded Git metadata directory outside the standard .git namespace");
    }
  }
  // Also reject .git indirection through a symlink, while ordinary linked-worktree .git files work.
  if ((await lstat(join(target_root, ".git"))).isSymbolicLink()) throw new Error("Symlink .git is unsupported");
  const docs = await textGit(target_root, ["rev-parse", "--path-format=absolute", "--git-path", "docsync"]);
  if (docs !== join(gitDir, "docsync")) throw new Error("Unexpected per-worktree runtime path");
  return { context: { execute_id: input.execute_id, phase_id: input.phase_id, round: input.round, plan_path, target_root, governance_root }, gitDir, runtime: join(docs, input.execute_id) };
}
async function safeDirectory(parent: string, name: string, create: boolean): Promise<string> {
  const path = join(parent, name);
  if (create) { try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error("Unsafe runtime directory");
  return path;
}
/** Only this exact Plan's Tasks section uses the established strict execution metadata grammar. */
function planBytes(bytes: Buffer): Buffer {
  let text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("Non-UTF8 Plan");
  // Completion changes this validated lifecycle pair in addition to the checklist.
  // Normalize only these two exact pairs, never arbitrary frontmatter/approvals.
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(text);
  if (header) {
    const stages = [...header[1]!.matchAll(/^stage: ([^\r\n]*)\r?$/gm)];
    const statuses = [...header[1]!.matchAll(/^stage_status: ([^\r\n]*)\r?$/gm)];
    if (stages.length === 1 && statuses.length === 1 && ((stages[0]![1] === "executing" && statuses[0]![1] === "in_progress") || (stages[0]![1] === "awaiting_round_decision" && statuses[0]![1] === "awaiting_human"))) {
      const normalized = header[0].replace(/^(stage: )(executing|awaiting_round_decision)(\r?)$/m, "$1execution-lifecycle$3").replace(/^(stage_status: )(in_progress|awaiting_human)(\r?)$/m, "$1execution-lifecycle$3");
      text = normalized + text.slice(header[0].length);
    }
  }
  extractAllSections(text); // Validate unique, ordered delimiters before selecting the exact region.
  const { start, end } = markersFor("tasks");
  const from = text.indexOf(start) + start.length, to = text.indexOf(end);
  const tasks = text.slice(from, to);
  const records = inspectPhaseRecords(tasks), notes = inspectExecutionNotes(records.definition);
  if (records.errors.length || notes.errors.length) throw new Error("Invalid Plan execution metadata");
  return Buffer.from(text.slice(0, from) + canonicalTaskDefinition(tasks) + text.slice(to));
}

export class GitBaselineProvider implements BaselineProvider {
  constructor(private readonly options: { onContentRead?: (path: string) => void } = {}) {}

  async capture(input: PhaseContext): Promise<BaselineReference> {
    const location = await locate(input), { context, gitDir, runtime } = location;
    await safeDirectory(gitDir, "docsync", true);
    // The execution directory is a durable exclusive claim. Failure leaves a blocked, never-recaptured execution.
    await mkdir(runtime, { mode: 0o700 });
    await safeDirectory(dirname(runtime), context.execute_id, false);
    const initial = await snapshot(context.target_root, [], this.options.onContentRead);
    const configuration = await readConfiguration(context.governance_root);
    const targets = configuration.config ? configurationTargets(configuration.config) : [];
    const planPath = this.targetPlan(context);
    const paths: string[] = [];
    for (const path of [...new Set([...initial.dirty, ...initial.untracked, ...(planPath ? [planPath] : [])])].sort()) {
      if (!initial.entries[path] && await this.reservedFinalizeLock(context, path, initial)) continue;
      paths.push(path);
    }
    const attrs = await attributes(context.target_root, paths);
    const exceptions: Record<string, ContentIdentity> = Object.create(null);
    for (const path of paths) exceptions[path] = await this.current(context, path, initial, attrs[path]!, initial.entries[path]);
    const documents: Saved["documents"] = Object.create(null);
    for (const target of targets) documents[targetKey(target)] = { target, read: await this.document(context, target) };
    const saved: Saved = { schema: 1, context, git_dir: gitDir, head: initial.head, tree: initial.tree, index: initial.index, format: initial.format, rules: initial.rules, attributes: hash(await attributes(context.target_root, [...new Set([...Object.keys(initial.entries), ...paths])].sort())), exceptions, initial_untracked: initial.untracked.filter(path => Object.hasOwn(exceptions, path)), documents, configuration_version: configuration.version, plan_version: await this.planVersion(context) };
    validateSaved(saved);
    const id = `git-v1:${hash(saved)}`;
    const first = await this.sample(location, saved, id);
    const second = await this.sample(location, saved, id);
    if (!same(first, second) || !same(initial, await snapshot(context.target_root, [], this.options.onContentRead)) || configuration.version !== second.facts.configuration.version || saved.plan_version !== await this.planVersion(context)) throw new Error("Concurrent baseline capture; original execution claim retained");
    // Check every captured exception/document against the final sample, including unchanged dirty content.
    if (first.facts.changes.length || Object.values(first.facts.documents).some(d => d.before !== d.after)) throw new Error("Concurrent baseline content modification");
    const reference = { id, initial_version: first.version };
    const payload = JSON.stringify({ saved, reference });
    if (Buffer.byteLength(payload) > MAX_BASELINE) throw new Error("Baseline exceeds bounded schema size");
    await safeDirectory(dirname(runtime), context.execute_id, false);
    const temp = join(runtime, "baseline.pending");
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(payload); await handle.sync(); } finally { await handle.close(); }
    await safeDirectory(dirname(runtime), context.execute_id, false);
    // link is an atomic, no-replace publication; rename could overwrite a foreign destination.
    await link(temp, join(runtime, "baseline.json"));
    await unlink(temp);
    const directory = await open(runtime, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
    return reference;
  }

  async verify(context: PhaseContext, reference: BaselineReference): Promise<string> { return (await this.inspect(context, reference)).content_version; }

  async inspect(input: PhaseContext, reference: BaselineReference): Promise<RepositoryFacts> {
    const location = await locate(input);
    const saved = await this.load(location, reference);
    const first = await this.sample(location, saved, reference.id);
    const second = await this.sample(location, saved, reference.id);
    if (!same(first, second)) throw new Error("Concurrent repository modification; retry verification");
    // Recheck immutable runtime and metadata immediately before returning; no OS-wide transaction is claimed.
    if (!same(saved, await this.load(location, reference))) throw new Error("Concurrent baseline replacement");
    return { ...second.facts, baseline: reference, content_version: second.version };
  }

  private async load(location: Located, reference: BaselineReference): Promise<Saved> {
    if (!object(reference) || !exact(reference, "id,initial_version") || !/^git-v1:[0-9a-f]{64}$/.test(reference.id) || !sha(reference.initial_version)) throw new Error("Foreign or invalid baseline reference; recapture is forbidden");
    await safeDirectory(location.gitDir, "docsync", false);
    await safeDirectory(dirname(location.runtime), location.context.execute_id, false);
    const raw = await readRaw(location.runtime, "baseline.json");
    if (raw.kind !== "file" || !raw.bytes || raw.bytes.length > MAX_BASELINE) throw new Error("Missing or unsafe baseline");
    let envelope: unknown; try { envelope = JSON.parse(raw.bytes.toString()); } catch { throw new Error("Corrupt baseline JSON"); }
    if (!object(envelope) || !exact(envelope, "saved,reference") || JSON.stringify(envelope) !== raw.bytes.toString()) throw new Error("Corrupt or noncanonical baseline envelope");
    validateSaved(envelope.saved);
    if (!object(envelope.reference) || !exact(envelope.reference, "id,initial_version") || reference.id !== envelope.reference.id || reference.initial_version !== envelope.reference.initial_version || reference.id !== `git-v1:${hash(envelope.saved)}` || !same(envelope.saved.context, location.context) || envelope.saved.git_dir !== location.gitDir) throw new Error("Foreign or corrupt baseline binding");
    return envelope.saved;
  }

  private targetPlan(context: PhaseContext): string | undefined {
    const path = relative(context.target_root, context.plan_path);
    return !path.startsWith("../") && !isAbsolute(path) ? path : undefined;
  }
  /** D1's full-attempt mutex is execution infrastructure, not a source change. Only the
   * exact current Plan/phase sidecar, currently untracked and empty regular mode 0600,
   * qualifies. Prior meaningful baseline content and tracked paths never qualify. */
  private async reservedFinalizeLock(context: PhaseContext, path: string, state: Snapshot): Promise<boolean> {
    const plan = this.targetPlan(context);
    if (!plan || path !== relative(context.target_root, join(dirname(context.plan_path), `.${basename(context.plan_path)}.${context.phase_id}.finalize.lock`)) || !state.untracked.includes(path)) return false;
    const full = await resolveContainedPath(context.target_root, path, { allowMissing: true, allowLeafSymlink: true });
    let before;
    try { before = await lstat(full, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    if (!before.isFile() || (before.mode & 0o7777n) !== 0o600n || before.size !== 0n) return false;
    const raw = await readRaw(context.target_root, path, this.options.onContentRead), after = await lstat(full, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || after.size !== 0n || raw.kind !== "file" || raw.bytes?.length !== 0) throw new Error("Concurrent finalize lock modification");
    return true;
  }
  private async planVersion(context: PhaseContext): Promise<string> {
    const raw = await readRaw(context.governance_root, relative(context.governance_root, context.plan_path), this.options.onContentRead);
    if (raw.kind !== "file" || !raw.bytes) throw new Error("Missing or unsafe Plan");
    return digest(planBytes(raw.bytes));
  }
  private async document(context: PhaseContext, target: DocumentTarget): Promise<DocumentRead> {
    if (targetPath(target) !== this.targetPlan(context)) return readDocument(context.target_root, target);
    const raw = await readRaw(context.target_root, targetPath(target), this.options.onContentRead);
    if (raw.kind === "symlink") throw new Error("Symlink document target");
    return documentIdentity(raw.bytes ? planBytes(raw.bytes) : null, target);
  }
  private async current(context: PhaseContext, path: string, state: Snapshot, attrs: Record<string, string>, original?: ContentIdentity): Promise<ContentIdentity> {
    const raw = await readRaw(context.target_root, path, this.options.onContentRead);
    if (raw.kind === "missing") return missing;
    if (raw.kind === "symlink") return blobIdentity(raw.bytes!, raw.mode, state.format);
    let bytes = raw.bytes!;
    if (path === this.targetPlan(context)) bytes = planBytes(bytes);
    let originalBytes: Buffer | undefined;
    if (original?.kind === "file" && (attrs.text === "auto" || attrs.text === "unspecified" && state.autocrlf !== "false")) originalBytes = await git(context.target_root, ["cat-file", "blob", original.oid]);
    return blobIdentity(normalize(bytes, attrs, state.autocrlf, originalBytes), raw.mode, state.format);
  }
  private async sample(location: Located, saved: Saved, id: string): Promise<Sample> {
    const { context } = location, root = context.target_root;
    const state = await snapshot(root, Object.keys(saved.exceptions), this.options.onContentRead);
    if (state.rules !== saved.rules || state.format !== saved.format) throw new Error("Git normalization rules changed; restore original rules, never recapture this execution");
    const original = await treeEntries(root, saved.tree, saved.format);
    if (await textGit(root, ["rev-parse", "--verify", `${saved.head}^{tree}`]) !== saved.tree) throw new Error("Original HEAD/tree integrity failure");
    const originalPaths = [...new Set([...Object.keys(original), ...Object.keys(saved.exceptions)])].sort();
    if (hash(await attributes(root, originalPaths)) !== saved.attributes) throw new Error("Effective Git attributes changed; restore original rules");
    const committed = names(await git(root, ["diff-tree", "-r", "--no-commit-id", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", saved.tree, state.tree, "--"]));
    const paths = [...new Set([...committed, ...state.dirty, ...state.untracked, ...Object.keys(saved.exceptions)])].sort();
    const attrs = await attributes(root, paths);
    const changes: RepositoryFacts["changes"] = [];
    for (const path of paths) {
      if (!original[path] && !Object.hasOwn(saved.exceptions, path) && await this.reservedFinalizeLock(context, path, state)) continue;
      const before = Object.hasOwn(saved.exceptions, path) ? saved.exceptions[path]! : original[path] ?? missing;
      const after = await this.current(context, path, state, attrs[path]!, original[path]);
      if (!same(before, after)) changes.push({ path, before, after });
    }
    const configuration = await readConfiguration(context.governance_root);
    const documents: RepositoryFacts["documents"] = Object.create(null);
    const documentVersions: unknown[] = [];
    const targets = configuration.config ? configurationTargets(configuration.config) : [];
    for (const target of targets) {
      const key = targetKey(target), path = targetPath(target);
      let before = saved.documents[key]?.read;
      if (!before) {
        // Only clean original blobs have reconstructible raw start bytes; dirty/untracked sections never guess.
        if (Object.hasOwn(saved.exceptions, path)) before = { file_version: "unknown", identity: null, error: "Document target has no trustworthy initial identity (start exception)" };
        else if (!original[path]) before = { file_version: "unknown", identity: null, error: "Document target has no trustworthy initial identity (not captured at start)" };
        else if (original[path]!.kind !== "file") before = { file_version: "unknown", identity: null, error: "Original document is not a regular file" };
        else {
          const bytes = await git(root, ["cat-file", "blob", (original[path] as Exclude<ContentIdentity, { kind: "missing" }>).oid]);
          // Git-normalized blob bytes cannot prove the original raw document with checkout transforms.
          const a = (await attributes(root, [path]))[path]!;
          if (state.autocrlf !== "false" || !["unspecified", "unset"].includes(a.text!) || !["unspecified", "unset"].includes(a.eol!)) before = { file_version: "unknown", identity: null, error: "New document target has ambiguous original checkout normalization" };
          else before = documentIdentity(bytes, target);
        }
      }
      const after = await this.document(context, target);
      documents[key] = { target, before: before.identity, after: after.identity, ...((before.error || after.error) ? { error: [before.error, after.error].filter(Boolean).join("; ") } : {}) };
      documentVersions.push([key, after.file_version, after.identity, after.error ?? null]);
    }
    const planVersion = await this.planVersion(context);
    const final = await snapshot(root, Object.keys(saved.exceptions), this.options.onContentRead);
    if (!same(state, final) || configuration.version !== (await readConfiguration(context.governance_root)).version || planVersion !== await this.planVersion(context)) throw new Error("Concurrent repository/configuration modification");
    const facts = { context, configuration, changes, documents };
    return { facts, version: hash([id, changes, documentVersions, configuration.version, planVersion, saved.rules]), stamp: hash(final) };
  }
}
