import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { renderAgentsArtifacts } from "./agents-template.js";
import { inspectGitRepository, remotesMatch } from "./git-inspector.js";
import { parseControlIndexJson, serializeControlIndex } from "./index-schema.js";
import { validateControlIndex } from "./index-validator.js";
import { applyManagedBlock, inspectManagedBlock } from "./managed-block.js";
import { resolveCanonicalPath } from "./path-binding.js";
import { findSimilarPaths } from "./path-similarity.js";
import {
  executeRepositoryBootstrap,
  planRepositoryBootstrap,
  rollbackRepositoryBootstrap,
  type RepositoryBootstrapPlan,
  type RepositoryBootstrapRecord,
} from "./repository-bootstrap.js";
import { resolveTemplate } from "./template-resolver.js";
import { writeWorkspaceTransaction } from "./transaction.js";
import type {
  ConflictDetail,
  ControlIndex,
  DoctorReport,
  InitWorkspaceInput,
  OperationResult,
  OperationSummary,
  RepositoryBinding,
  RepositoryStatus,
  UpdateWorkspaceInput,
  ValidationIssue,
} from "./types.js";

export const CONTROL_INDEX_FILENAME = "CONTROL_INDEX.json";
export const AGENTS_FILENAME = "AGENTS.md";

export interface OperationOptions {
  /** Build and validate the exact candidate without performing bootstrap or writes. */
  dryRun?: boolean;
}

interface PreparedWorkspace {
  index: ControlIndex;
  controlRoot: string;
  indexPath: string;
  agentsPath: string;
  indexSource: string | null;
  agentsOriginal: string | null;
  agentsSource: string;
  agentsOutput: string;
  bootstrapPlans: RepositoryBootstrapPlan[];
  summary: OperationSummary;
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return (error as { code?: string | number }).code;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new Error(`Refusing to read symlinked workspace file: ${path}`);
    if (!stats.isFile()) throw new Error(`Workspace path is not a regular file: ${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function portablePath(controlRoot: string, target: string): string {
  const value = relative(controlRoot, target);
  return (value || ".").split(sep).join("/");
}

function isWithin(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function absoluteBinding(controlRoot: string, configuredPath: string): string {
  return isAbsolute(configuredPath) ? resolve(configuredPath) : resolve(controlRoot, configuredPath);
}

function configuredInputPaths(input: InitWorkspaceInput, index: ControlIndex): Map<string, string> {
  const result = new Map<string, string>();
  if (index.topology_profile === "custom") {
    for (const repository of input.customRepositories ?? []) {
      const entered = repository.path || (repository.kind === "control" ? input.controlPath : undefined);
      if (entered) result.set(repository.id, entered);
    }
    return result;
  }
  result.set(index.control_repository, input.controlPath!);
  const code = index.repositories.find((repository) => repository.kind === "code");
  if (code) result.set(code.id, input.codePath!);
  for (const paper of input.latexRepositories ?? []) {
    if (paper.path) result.set(paper.id, paper.path);
  }
  return result;
}

function nestedPathConflict(paths: Array<{ id: string; path: string }>): ConflictDetail | null {
  for (let leftIndex = 0; leftIndex < paths.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex += 1) {
      const left = paths[leftIndex];
      const right = paths[rightIndex];
      const leftPrefix = left.path.endsWith(sep) ? left.path : `${left.path}${sep}`;
      const rightPrefix = right.path.endsWith(sep) ? right.path : `${right.path}${sep}`;
      if (left.path === right.path) {
        return { code: "duplicate-repository-path", message: `${left.id} and ${right.id} resolve to the same directory.`, path: left.path };
      }
      if (left.path.startsWith(rightPrefix) || right.path.startsWith(leftPrefix)) {
        return {
          code: "nested-repository-path",
          message: `${left.id} and ${right.id} would create nested Git worktrees; choose separate repository directories.`,
          path: left.path.startsWith(rightPrefix) ? left.path : right.path,
        };
      }
    }
  }
  return null;
}

async function repositoryStatus(repository: RepositoryBinding, controlRoot: string): Promise<RepositoryStatus> {
  const requested = absoluteBinding(controlRoot, repository.path);
  let absolutePath = requested;
  try {
    absolutePath = (await resolveCanonicalPath(requested)).canonicalPath;
  } catch {
    // The Git inspection below returns the concrete file/type error without
    // widening the requested path or following a final-component symlink.
  }
  const inspection = await inspectGitRepository(requested);
  return {
    id: repository.id,
    kind: repository.kind,
    configuredPath: repository.path,
    absolutePath,
    exists: inspection.exists,
    gitRoot: inspection.gitRoot,
    branch: inspection.branch,
    dirty: inspection.dirty,
    gitRemote: inspection.remote,
    remoteMatches: remotesMatch(repository.git_remote, inspection.remote),
  };
}

async function repositoryStatuses(index: ControlIndex, controlRoot: string): Promise<RepositoryStatus[]> {
  return Promise.all(index.repositories.map((repository) => repositoryStatus(repository, controlRoot)));
}

function warningsFromStatuses(statuses: RepositoryStatus[]): string[] {
  const warnings: string[] = [];
  for (const status of statuses) {
    if (status.dirty) warnings.push(`${status.id} has a dirty worktree; unrelated changes must be preserved.`);
    if (status.gitRemote === null) warnings.push(`${status.id} has no Git remote configured.`);
    if (status.remoteMatches === false) warnings.push(`${status.id} Git remote differs from the recorded identity.`);
  }
  return warnings;
}

function incompleteFromStatuses(statuses: RepositoryStatus[]): string[] {
  return statuses.flatMap((status) => {
    const incomplete: string[] = [];
    if (!status.exists) incomplete.push(`${status.id} directory does not exist.`);
    else if (!status.gitRoot) incomplete.push(`${status.id} is not a Git repository.`);
    else if (status.gitRoot !== status.absolutePath) incomplete.push(`${status.id} is nested in Git root ${status.gitRoot}.`);
    if (status.gitRemote === null) incomplete.push(`${status.id} has no remote identity yet.`);
    return incomplete;
  });
}

function agentsHighlights(index: ControlIndex): string[] {
  const highlights = [
    "Control owns plans, tests, fixtures, tools, evidence and release records; code owns delivered runtime artifacts.",
    "Only explicit human task assignment activates implementation; plan approval alone does not.",
    "Assigned work uses feature branches, focused commits, push, and a verified PR; merge and release remain human decisions.",
  ];
  if (index.repositories.some((repository) => repository.kind === "latex")) {
    highlights.push("Each paper has an independent private LaTeX repository; code never depends on paper repositories.");
  }
  return highlights;
}

function summaryFor(index: ControlIndex, statuses: RepositoryStatus[]): OperationSummary {
  return {
    profile: index.topology_profile,
    workspaceId: index.workspace_id,
    repositories: statuses,
    agentsHighlights: agentsHighlights(index),
    warnings: warningsFromStatuses(statuses),
    incomplete: incompleteFromStatuses(statuses),
    index,
  };
}

function issue(severity: "error" | "warning", code: string, message: string, path?: string, repositoryId?: string): ValidationIssue {
  return { severity, code, message, ...(path ? { path } : {}), ...(repositoryId ? { repositoryId } : {}) };
}

function conflict(error: unknown, code = "workspace-preflight-failed"): OperationResult {
  return {
    status: "conflict",
    conflicts: [{ code, message: error instanceof Error ? error.message : String(error) }],
  };
}

function predictFileAction(source: string | null, output: string): "created" | "updated" | "unchanged" {
  if (source === null) return "created";
  return source === output ? "unchanged" : "updated";
}

function controlEnteredPath(input: InitWorkspaceInput, index: ControlIndex): string {
  if (input.controlPath?.trim()) return input.controlPath;
  const customControl = input.customRepositories?.find((repository) => repository.id === index.control_repository);
  if (customControl?.path?.trim()) return customControl.path;
  throw new Error("The control repository path is missing");
}

async function normalizeIndexPaths(
  input: InitWorkspaceInput,
  index: ControlIndex,
  cwd: string,
): Promise<{ index: ControlIndex; controlRoot: string; absolutePaths: Map<string, string> }> {
  const inputs = configuredInputPaths(input, index);
  const controlResolution = await resolveCanonicalPath(controlEnteredPath(input, index), cwd);
  const controlRoot = controlResolution.canonicalPath;
  const absolutePaths = new Map<string, string>();

  for (const repository of index.repositories) {
    const entered = inputs.get(repository.id);
    if (!entered) throw new Error(`No explicit directory was supplied for repository ${repository.id}`);
    const resolution = await resolveCanonicalPath(entered, cwd);
    if (!isAbsolute(entered) && !isWithin(dirname(controlRoot), resolution.canonicalPath)) {
      throw new Error(`Relative repository path escapes the control workspace parent: ${entered}. Use an explicit absolute path for a special location.`);
    }
    absolutePaths.set(repository.id, resolution.canonicalPath);
  }
  const nesting = nestedPathConflict([...absolutePaths].map(([id, path]) => ({ id, path })));
  if (nesting) throw Object.assign(new Error(nesting.message), { conflictDetail: nesting });

  return {
    controlRoot,
    absolutePaths,
    index: {
      ...index,
      repositories: index.repositories.map((repository) => ({
        ...repository,
        path: (() => {
          const target = absolutePaths.get(repository.id)!;
          const entered = inputs.get(repository.id)!;
          return isAbsolute(entered) && !isWithin(dirname(controlRoot), target)
            ? target
            : portablePath(controlRoot, target);
        })(),
      })),
    },
  };
}

async function bootstrapConflicts(
  absolutePaths: Map<string, string>,
  input: InitWorkspaceInput,
): Promise<{ plans: RepositoryBootstrapPlan[]; conflicts: ConflictDetail[] }> {
  const plans: RepositoryBootstrapPlan[] = [];
  const conflicts: ConflictDetail[] = [];
  for (const [repositoryId, path] of absolutePaths) {
    const planned = await planRepositoryBootstrap(path, input.bootstrap);
    if (planned.status === "ready") {
      plans.push(planned);
      continue;
    }
    const detail: ConflictDetail = {
      code: planned.code,
      message: `${repositoryId}: ${planned.message}`,
      path: planned.path,
      choices: planned.requiredAuthorization
        ? [planned.requiredAuthorization === "create" ? "confirm-create-and-git-init" : "confirm-in-place-git-init", "choose-another-path"]
        : ["choose-another-path"],
    };
    if (planned.plannedAction === "create-and-init") detail.candidates = await findSimilarPaths(path);
    conflicts.push(detail);
  }
  return { plans, conflicts };
}

async function applyRepositoryRemotes(index: ControlIndex, controlRoot: string): Promise<ControlIndex> {
  const statuses = await repositoryStatuses(index, controlRoot);
  return {
    ...index,
    repositories: index.repositories.map((repository) => {
      const status = statuses.find((entry) => entry.id === repository.id)!;
      return { ...repository, git_remote: status.gitRemote };
    }),
  };
}

async function remoteDriftConflicts(
  before: ControlIndex | undefined,
  after: ControlIndex,
  controlRoot: string,
  acceptedIds: string[],
): Promise<ConflictDetail[]> {
  if (!before) return [];
  const accepted = new Set(acceptedIds);
  const statuses = await repositoryStatuses(after, controlRoot);
  const conflicts: ConflictDetail[] = [];
  for (const repository of after.repositories) {
    const previous = before.repositories.find((entry) => entry.id === repository.id);
    if (!previous || accepted.has(repository.id)) continue;
    const samePath = absoluteBinding(controlRoot, previous.path) === absoluteBinding(controlRoot, repository.path);
    if (!samePath) continue;
    const current = statuses.find((entry) => entry.id === repository.id)!;
    const sameRemote = previous.git_remote === null && current.gitRemote === null
      ? true
      : remotesMatch(previous.git_remote, current.gitRemote) === true;
    if (!sameRemote) {
      conflicts.push({
        code: "remote-identity-drift",
        message: `${repository.id} remote changed from the recorded identity to ${current.gitRemote ?? "no remote"}.`,
        path: current.absolutePath,
        choices: ["accept-current-remote", "repair-remote", "rebind-path"],
      });
    }
  }
  return conflicts;
}

async function prepareWorkspace(
  input: InitWorkspaceInput,
  cwd: string,
  mode: "init" | "update",
  existingIndex?: ControlIndex,
  acceptManagedBlockDrift = false,
  acceptedRemoteIds: string[] = [],
): Promise<PreparedWorkspace | OperationResult> {
  const resolved = resolveTemplate(input, { cwd });
  if (resolved.status === "needs_input") return { status: "needs_input", questions: resolved.questions, summary: { profile: resolved.profile } };
  if (resolved.status === "conflict") return { status: "conflict", conflicts: resolved.conflicts, summary: { profile: resolved.profile } };

  let normalized;
  try {
    normalized = await normalizeIndexPaths(input, resolved.index, cwd);
  } catch (error) {
    const detail = typeof error === "object" && error !== null && "conflictDetail" in error
      ? (error as { conflictDetail: ConflictDetail }).conflictDetail
      : undefined;
    return detail ? { status: "conflict", conflicts: [detail] } : conflict(error);
  }

  const indexPath = join(normalized.controlRoot, CONTROL_INDEX_FILENAME);
  const agentsPath = join(normalized.controlRoot, AGENTS_FILENAME);
  const onDiskIndex = await readOptional(indexPath);
  if (mode === "init" && onDiskIndex !== null) {
    return {
      status: "conflict",
      conflicts: [{
        code: "index-already-exists",
        message: `${CONTROL_INDEX_FILENAME} already exists; initialization will not overwrite it. Use control_workspace_update.`,
        path: indexPath,
        choices: ["inspect-status", "use-update"],
      }],
    };
  }
  if (mode === "update" && onDiskIndex === null) {
    return { status: "conflict", conflicts: [{ code: "index-missing", message: `${CONTROL_INDEX_FILENAME} does not exist; initialize the workspace first.`, path: indexPath }] };
  }

  const bootstrap = await bootstrapConflicts(normalized.absolutePaths, input);
  if (bootstrap.conflicts.length > 0) {
    const statuses = await repositoryStatuses(normalized.index, normalized.controlRoot);
    return { status: "conflict", conflicts: bootstrap.conflicts, summary: summaryFor(normalized.index, statuses) };
  }

  const remoteConflicts = await remoteDriftConflicts(existingIndex, normalized.index, normalized.controlRoot, acceptedRemoteIds);
  if (remoteConflicts.length > 0) {
    return { status: "conflict", conflicts: remoteConflicts, summary: summaryFor(normalized.index, await repositoryStatuses(normalized.index, normalized.controlRoot)) };
  }
  let index = await applyRepositoryRemotes(normalized.index, normalized.controlRoot);
  const agentsOriginal = await readOptional(agentsPath);
  const agentsSource = agentsOriginal ?? "";
  const currentBlock = inspectManagedBlock(agentsSource, existingIndex?.agents.managed_block_hash);
  if (mode === "init" && currentBlock.status === "valid") {
    return {
      status: "conflict",
      conflicts: [{
        code: "orphan-managed-agents-block",
        message: "AGENTS.md already contains a control-init managed block but no index is present; initialization will not overwrite it.",
        path: agentsPath,
        choices: ["merge-by-hand", "restore-matching-index"],
      }],
    };
  }
  if (currentBlock.status === "invalid") {
    return { status: "conflict", conflicts: [{ code: "agents-managed-block-invalid", message: currentBlock.message, path: agentsPath, choices: ["merge-by-hand"] }] };
  }
  if (currentBlock.status === "drift" && !acceptManagedBlockDrift) {
    return {
      status: "conflict",
      conflicts: [{
        code: "agents-managed-block-drift",
        message: `The managed AGENTS block changed since the index recorded ${currentBlock.expectedHash}.`,
        path: agentsPath,
        choices: ["preserve", "regenerate-after-explicit-acceptance", "merge-by-hand"],
      }],
    };
  }
  if (currentBlock.status === "missing" && agentsSource.length > 0 && !input.agentsExistingStrategy) {
    return {
      status: "conflict",
      conflicts: [{
        code: "unmanaged-agents-file",
        message: "AGENTS.md exists without a control-init managed block; choose whether to preserve it and append the block.",
        path: agentsPath,
        choices: ["append-managed-block", "preview-only"],
      }],
    };
  }

  const artifacts = renderAgentsArtifacts(index);
  index = artifacts.index;
  const agentsOutput = applyManagedBlock(agentsSource, artifacts.managedBlock, {
    expectedHash: existingIndex?.agents.managed_block_hash,
    acceptDrift: acceptManagedBlockDrift,
  });
  const statuses = await repositoryStatuses(index, normalized.controlRoot);
  const summary = summaryFor(index, statuses);
  summary.changes = bootstrap.plans.flatMap((plan) => {
    if (plan.action === "create-and-init") return [`Create ${plan.targetPath}, then run local git init (no remote, commit, or push).`];
    if (plan.action === "initialize-existing") return [`Preserve all existing files in ${plan.targetPath}, then run local git init (no remote, commit, or push).`];
    return [];
  });
  summary.files = [
    { path: agentsPath, action: predictFileAction(agentsOriginal, agentsOutput) },
    { path: indexPath, action: mode === "init" ? "created" : predictFileAction(onDiskIndex, serializeControlIndex(index)) },
  ];
  if (input.agentsExistingStrategy === "preview-only") {
    summary.changes = ["Preview only: no repository or file mutation was authorized."];
  }
  return {
    index,
    controlRoot: normalized.controlRoot,
    indexPath,
    agentsPath,
    indexSource: onDiskIndex,
    agentsOriginal,
    agentsSource,
    agentsOutput,
    bootstrapPlans: bootstrap.plans,
    summary,
  };
}

async function verifyInstalledWorkspace(prepared: PreparedWorkspace): Promise<void> {
  const parsed = parseControlIndexJson(await readFile(prepared.indexPath, "utf8"));
  const agents = await readFile(prepared.agentsPath, "utf8");
  const managed = inspectManagedBlock(agents, parsed.agents.managed_block_hash);
  if (managed.status !== "valid") throw new Error(`Post-write AGENTS verification failed: ${managed.status}`);
  const statuses = await repositoryStatuses(parsed, prepared.controlRoot);
  const invalid = statuses.find((status) => status.gitRoot !== status.absolutePath);
  if (invalid) throw new Error(`Post-write Git root verification failed for ${invalid.id}: ${invalid.absolutePath}`);
}

async function rollbackBootstraps(records: RepositoryBootstrapRecord[]): Promise<string[]> {
  const warnings: string[] = [];
  for (const record of [...records].reverse()) {
    const result = await rollbackRepositoryBootstrap(record);
    warnings.push(...result.warnings);
  }
  return warnings;
}

async function applyPrepared(prepared: PreparedWorkspace, createIndex: boolean): Promise<OperationResult> {
  const records: RepositoryBootstrapRecord[] = [];
  try {
    for (const plan of prepared.bootstrapPlans) records.push(await executeRepositoryBootstrap(plan));
    prepared.index = await applyRepositoryRemotes(prepared.index, prepared.controlRoot);
    const artifacts = renderAgentsArtifacts(prepared.index);
    prepared.index = artifacts.index;
    prepared.agentsOutput = applyManagedBlock(prepared.agentsSource, artifacts.managedBlock, {
      expectedHash: createIndex ? undefined : undefined,
      acceptDrift: true,
    });
    const result = await writeWorkspaceTransaction([
      { path: prepared.agentsPath, content: prepared.agentsOutput, expectedContent: prepared.agentsOriginal },
      {
        path: prepared.indexPath,
        content: serializeControlIndex(prepared.index),
        createOnly: createIndex,
        expectedContent: prepared.indexSource,
      },
    ], () => verifyInstalledWorkspace(prepared));
    const statuses = await repositoryStatuses(prepared.index, prepared.controlRoot);
    return {
      status: "applied",
      summary: {
        ...summaryFor(prepared.index, statuses),
        files: result.files,
        changes: prepared.summary.changes,
      },
    };
  } catch (error) {
    const rollbackWarnings = await rollbackBootstraps(records);
    if (rollbackWarnings.length > 0) {
      throw new AggregateError([error, ...rollbackWarnings.map((warning) => new Error(warning))], "Workspace apply failed and repository rollback was incomplete");
    }
    throw error;
  }
}

function pathsFromExisting(index: ControlIndex, controlRoot: string): Pick<InitWorkspaceInput, "controlPath" | "codePath" | "latexRepositories" | "customRepositories" | "customRelationships"> {
  if (index.topology_profile === "custom") {
    return {
      controlPath: controlRoot,
      customRepositories: index.repositories.map((repository) => ({
        id: repository.id,
        kind: repository.kind,
        path: absoluteBinding(controlRoot, repository.path),
        role: repository.role,
        visibility: repository.visibility,
        owns: [...repository.owns],
        gitRemote: repository.git_remote,
      })),
      customRelationships: index.relationships.map((relationship) => ({ ...relationship })),
    };
  }
  const code = index.repositories.find((repository) => repository.kind === "code")!;
  return {
    controlPath: controlRoot,
    codePath: absoluteBinding(controlRoot, code.path),
    latexRepositories: index.repositories
      .filter((repository) => repository.kind === "latex")
      .map((repository) => ({ id: repository.id, path: absoluteBinding(controlRoot, repository.path) })),
  };
}

function mergeUpdateInput(input: UpdateWorkspaceInput, index: ControlIndex, controlRoot: string): InitWorkspaceInput {
  const previous = pathsFromExisting(index, controlRoot);
  return {
    ...previous,
    topologyProfile: input.topologyProfile ?? index.topology_profile,
    workspaceId: input.workspaceId ?? index.workspace_id,
    name: input.name ?? index.name,
    userRequirements: input.userRequirements ?? index.policies.user_requirements,
    agentsExistingStrategy: input.agentsExistingStrategy ?? "append-managed-block",
    bootstrap: input.bootstrap,
    ...(input.controlPath !== undefined ? { controlPath: input.controlPath } : {}),
    ...(input.codePath !== undefined ? { codePath: input.codePath } : {}),
    ...(input.latexRepositories !== undefined ? { latexRepositories: input.latexRepositories } : {}),
    ...(input.customRepositories !== undefined ? { customRepositories: input.customRepositories } : {}),
    ...(input.customRelationships !== undefined ? { customRelationships: input.customRelationships } : {}),
  };
}

function describeChanges(before: ControlIndex, after: ControlIndex, request?: string): string[] {
  const changes: string[] = [];
  if (request?.trim()) changes.push(`Requested: ${request.trim()}`);
  if (before.topology_profile !== after.topology_profile) changes.push(`Profile: ${before.topology_profile} -> ${after.topology_profile}`);
  const beforeRepos = new Map(before.repositories.map((repository) => [repository.id, repository]));
  const afterRepos = new Map(after.repositories.map((repository) => [repository.id, repository]));
  for (const id of beforeRepos.keys()) if (!afterRepos.has(id)) changes.push(`Unbound repository ${id}; no directory or Git data was deleted.`);
  for (const [id, repository] of afterRepos) {
    const old = beforeRepos.get(id);
    if (!old) changes.push(`Added repository ${id} at ${repository.path}.`);
    else if (old.path !== repository.path) changes.push(`Rebound ${id}: ${old.path} -> ${repository.path}.`);
  }
  if (JSON.stringify(before.policies.user_requirements) !== JSON.stringify(after.policies.user_requirements)) {
    changes.push("Updated user-specific requirements.");
  }
  return changes.length > 0 ? changes : ["No effective workspace change."];
}

export class ControlWorkspaceService {
  constructor(readonly cwd: string) {}

  async init(input: InitWorkspaceInput, options: OperationOptions = {}): Promise<OperationResult> {
    let prepared: PreparedWorkspace | OperationResult;
    try {
      prepared = await prepareWorkspace(input, this.cwd, "init");
    } catch (error) {
      return conflict(error);
    }
    if (!("index" in prepared)) return prepared;
    if (options.dryRun || input.agentsExistingStrategy === "preview-only") {
      return { status: "applied", summary: prepared.summary };
    }
    return applyPrepared(prepared, true);
  }

  async status(controlPath?: string): Promise<OperationResult> {
    let root: string;
    try {
      root = await this.resolveControlRoot(controlPath);
    } catch (error) {
      return conflict(error, "invalid-control-path");
    }
    const indexPath = join(root, CONTROL_INDEX_FILENAME);
    const source = await readOptional(indexPath);
    if (source === null) {
      return { status: "needs_input", questions: [{ id: "initialize", prompt: `${CONTROL_INDEX_FILENAME} is missing. Initialize this control workspace first.`, kind: "confirmation" }] };
    }
    try {
      const index = parseControlIndexJson(source);
      const statuses = await repositoryStatuses(index, root);
      const summary = summaryFor(index, statuses);
      const agents = await readOptional(join(root, AGENTS_FILENAME));
      if (agents === null) summary.incomplete?.push(`${AGENTS_FILENAME} is missing.`);
      else {
        const block = inspectManagedBlock(agents, index.agents.managed_block_hash);
        if (block.status !== "valid") summary.warnings?.push(`Managed AGENTS block is ${block.status}; run control_workspace_doctor before updating.`);
      }
      return { status: "applied", summary };
    } catch (error) {
      return conflict(error, "invalid-control-index");
    }
  }

  async doctor(controlPath?: string): Promise<DoctorReport> {
    let root: string;
    try {
      root = await this.resolveControlRoot(controlPath);
    } catch (error) {
      return { ok: false, issues: [issue("error", "invalid-control-path", error instanceof Error ? error.message : String(error))], summary: {} };
    }
    const indexPath = join(root, CONTROL_INDEX_FILENAME);
    const agentsPath = join(root, AGENTS_FILENAME);
    const source = await readOptional(indexPath);
    if (source === null) {
      return { ok: false, issues: [issue("error", "index-missing", `${CONTROL_INDEX_FILENAME} is missing.`, indexPath)], summary: {} };
    }
    let index: ControlIndex;
    try {
      index = parseControlIndexJson(source);
    } catch (error) {
      return { ok: false, issues: [issue("error", "invalid-control-index", error instanceof Error ? error.message : String(error), indexPath)], summary: {} };
    }
    const statuses = await repositoryStatuses(index, root);
    const issues = [...validateControlIndex(index)];
    const nesting = nestedPathConflict(statuses.map((status) => ({ id: status.id, path: status.absolutePath })));
    if (nesting) issues.push(issue("error", nesting.code, nesting.message, nesting.path));
    for (const status of statuses) {
      if (!status.exists) issues.push(issue("error", "repository-missing", `${status.id} path does not exist.`, status.absolutePath, status.id));
      else if (!status.gitRoot) issues.push(issue("error", "not-git-repository", `${status.id} is not a Git repository.`, status.absolutePath, status.id));
      else if (status.gitRoot !== status.absolutePath) issues.push(issue("error", "nested-git-binding", `${status.id} resolves inside ${status.gitRoot}.`, status.absolutePath, status.id));
      const recorded = index.repositories.find((repository) => repository.id === status.id)!.git_remote;
      if (status.remoteMatches === false || (recorded !== null && status.gitRemote === null)) {
        issues.push(issue("error", "remote-identity-drift", `${status.id} remote does not match the recorded identity.`, status.absolutePath, status.id));
      }
      if (status.dirty) issues.push(issue("warning", "dirty-worktree", `${status.id} has unrelated worktree changes that must be preserved.`, status.absolutePath, status.id));
      if (status.gitRemote === null) issues.push(issue("warning", "missing-remote", `${status.id} does not have a remote.`, status.absolutePath, status.id));
    }
    const agents = await readOptional(agentsPath);
    if (agents === null) issues.push(issue("error", "agents-missing", `${AGENTS_FILENAME} is missing.`, agentsPath));
    else {
      const block = inspectManagedBlock(agents, index.agents.managed_block_hash);
      if (block.status !== "valid") issues.push(issue("error", `agents-${block.status}`, block.status === "invalid" ? block.message : `Managed AGENTS block is ${block.status}.`, agentsPath));
    }
    return { ok: !issues.some((entry) => entry.severity === "error"), issues, summary: summaryFor(index, statuses) };
  }

  async update(input: UpdateWorkspaceInput, options: OperationOptions = {}): Promise<OperationResult> {
    let root: string;
    try {
      root = await this.resolveControlRoot(input.controlPath);
    } catch (error) {
      return conflict(error, "invalid-control-path");
    }
    const source = await readOptional(join(root, CONTROL_INDEX_FILENAME));
    if (source === null) return { status: "conflict", conflicts: [{ code: "index-missing", message: `${CONTROL_INDEX_FILENAME} is missing; initialize first.` }] };
    let current: ControlIndex;
    try {
      current = parseControlIndexJson(source);
    } catch (error) {
      return conflict(error, "invalid-control-index");
    }

    const hasStructuredChange = [
      input.topologyProfile,
      input.workspaceId,
      input.name,
      input.userRequirements,
      input.codePath,
      input.latexRepositories,
      input.customRepositories,
      input.customRelationships,
      input.acceptManagedBlockDrift,
      input.acceptRemoteIdentityChanges,
    ].some((value) => value !== undefined);
    if (!hasStructuredChange) {
      return {
        status: "needs_input",
        questions: [{
          id: input.changeRequest?.trim() ? "structured_change" : "change_request",
          prompt: input.changeRequest?.trim()
            ? "Translate the change request into only the affected structured fields, preserving every other current binding and policy, then retry."
            : "Describe what changed in the control workspace.",
          kind: "repositories",
        }],
        summary: summaryFor(current, await repositoryStatuses(current, root)),
      };
    }

    const merged = mergeUpdateInput(input, current, root);
    let prepared: PreparedWorkspace | OperationResult;
    try {
      prepared = await prepareWorkspace(
        merged,
        this.cwd,
        "update",
        current,
        input.acceptManagedBlockDrift === true,
        input.acceptRemoteIdentityChanges ?? [],
      );
    } catch (error) {
      return conflict(error);
    }
    if (!("index" in prepared)) return prepared;
    prepared.summary.changes = [
      ...describeChanges(current, prepared.index, input.changeRequest),
      ...(prepared.summary.changes ?? []),
    ];
    if (input.agentsExistingStrategy === "preview-only") {
      prepared.summary.changes.push("Preview only: no repository or file mutation was authorized.");
    }
    if (options.dryRun || input.agentsExistingStrategy === "preview-only") return { status: "applied", summary: prepared.summary };
    return applyPrepared(prepared, false);
  }

  private async resolveControlRoot(controlPath?: string): Promise<string> {
    const resolution = await resolveCanonicalPath(controlPath?.trim() || this.cwd, this.cwd);
    if (!resolution.exists) throw new Error(`Control repository directory does not exist: ${resolution.canonicalPath}`);
    return resolution.canonicalPath;
  }
}
