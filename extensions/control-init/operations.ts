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

function applyConflict(error: unknown): OperationResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = /rollback was incomplete/i.test(message)
    ? "workspace-rollback-incomplete"
    : /changed during apply|changed after preview|already exists/i.test(message)
      ? "concurrent-workspace-change"
      : "workspace-apply-failed";
  return {
    status: "conflict",
    conflicts: [{
      code,
      message,
      choices: code === "workspace-rollback-incomplete"
        ? ["run-doctor", "inspect-authoritative-files", "retry-after-repair"]
        : ["run-doctor", "inspect-current-state", "retry"],
    }],
  };
}

function predictFileAction(source: string | null, output: string): "created" | "updated" | "unchanged" {
  if (source === null) return "created";
  return source === output ? "unchanged" : "updated";
}

function controlEnteredPath(input: InitWorkspaceInput, index: ControlIndex): string {
  const customControl = input.customRepositories?.find((repository) => repository.id === index.control_repository);
  if (customControl?.path?.trim()) return customControl.path;
  if (input.controlPath?.trim()) return input.controlPath;
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
  const customControl = input.customRepositories?.find((repository) => repository.id === index.control_repository);
  if (customControl?.path?.trim() && input.controlPath?.trim()) {
    const explicitControl = await resolveCanonicalPath(input.controlPath, cwd);
    if (explicitControl.canonicalPath !== controlRoot) {
      throw Object.assign(new Error("controlPath and the custom control repository path resolve to different directories."), {
        conflictDetail: {
          code: "conflicting-control-paths",
          message: "controlPath and the custom control repository path resolve to different directories; supply one canonical control binding.",
          choices: ["use-custom-control-path", "use-control-path"],
        } satisfies ConflictDetail,
      });
    }
  }
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

  const normalizedIndex: ControlIndex = {
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
  };
  const normalizedIssues = validateControlIndex(normalizedIndex).filter((entry) => entry.severity === "error");
  if (normalizedIssues.length > 0) {
    throw Object.assign(new Error("Normalized workspace paths violate the control index contract."), {
      validationIssues: normalizedIssues,
    });
  }

  return {
    controlRoot,
    absolutePaths,
    index: normalizedIndex,
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
  expectedIndexSource?: string,
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
    const validationIssues = typeof error === "object" && error !== null && "validationIssues" in error
      ? (error as { validationIssues: ValidationIssue[] }).validationIssues
      : undefined;
    if (validationIssues) {
      return {
        status: "conflict",
        conflicts: validationIssues.map((entry) => ({ code: entry.code, message: entry.message, path: entry.path })),
      };
    }
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
  if (mode === "update" && expectedIndexSource !== undefined && onDiskIndex !== expectedIndexSource) {
    return {
      status: "conflict",
      conflicts: [{
        code: "index-changed-during-update",
        message: `${CONTROL_INDEX_FILENAME} changed after the update snapshot was read; inspect current state and retry.`,
        path: indexPath,
        choices: ["inspect-current-state", "retry-update"],
      }],
    };
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
  summary.agentsPreview = {
    before: currentBlock.status === "valid" || currentBlock.status === "drift" ? currentBlock.block : null,
    after: artifacts.managedBlock,
  };
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
  const report = await new ControlWorkspaceService(prepared.controlRoot).doctor(prepared.controlRoot);
  if (!report.ok) {
    const errors = report.issues
      .filter((entry) => entry.severity === "error")
      .map((entry) => `${entry.code}: ${entry.message}`)
      .join("; ");
    throw new Error(`Post-write doctor verification failed: ${errors}`);
  }
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
    const summary = summaryFor(prepared.index, statuses);
    if (result.warnings?.length) summary.warnings?.push(...result.warnings);
    return {
      status: "applied",
      summary: {
        ...summary,
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

function pathsFromExisting(index: ControlIndex, controlRoot: string): Pick<InitWorkspaceInput, "controlPath" | "codePath" | "latexRepositories" | "customRepositories" | "customRelationships" | "focusAreas"> {
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
      focusAreas: [...index.agents.focus_areas],
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
  const targetProfile = input.topologyProfile ?? index.topology_profile;
  const sameProfileFamily = (targetProfile === "custom") === (index.topology_profile === "custom");
  const previous: Partial<InitWorkspaceInput> = sameProfileFamily
    ? pathsFromExisting(index, controlRoot)
    : { controlPath: controlRoot };
  if (targetProfile === "control-code") previous.latexRepositories = [];
  return {
    ...previous,
    topologyProfile: targetProfile,
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
    ...(input.focusAreas !== undefined ? { focusAreas: input.focusAreas } : {}),
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
    if (options.dryRun) {
      return { status: "applied", summary: prepared.summary };
    }
    if (input.agentsExistingStrategy === "preview-only") {
      return {
        status: "conflict",
        conflicts: [{
          code: "preview-only-no-apply",
          message: "Preview-only was selected, so initialization was not applied.",
          choices: ["inspect-preview", "append-managed-block-and-apply"],
        }],
        summary: prepared.summary,
      };
    }
    try {
      return await applyPrepared(prepared, true);
    } catch (error) {
      return applyConflict(error);
    }
  }

  async status(controlPath?: string): Promise<OperationResult> {
    let root: string;
    try {
      root = await this.resolveControlRoot(controlPath);
    } catch (error) {
      return conflict(error, "invalid-control-path");
    }
    const indexPath = join(root, CONTROL_INDEX_FILENAME);
    let source: string | null;
    try {
      source = await readOptional(indexPath);
    } catch (error) {
      return conflict(error, "invalid-control-index-file");
    }
    if (source === null) {
      return { status: "needs_input", questions: [{ id: "initialize", prompt: `${CONTROL_INDEX_FILENAME} is missing. Initialize this control workspace first.`, kind: "confirmation" }] };
    }
    try {
      const index = parseControlIndexJson(source);
      const inspected = await this.inspectPersistedRepositories(index, root);
      if (inspected.issues.some((entry) => entry.severity === "error")) {
        return {
          status: "conflict",
          conflicts: inspected.issues
            .filter((entry) => entry.severity === "error")
            .map((entry) => ({ code: entry.code, message: entry.message, path: entry.path })),
          summary: summaryFor(index, inspected.statuses),
        };
      }
      const statuses = inspected.statuses;
      const summary = summaryFor(index, statuses);
      let agents: string | null;
      try {
        agents = await readOptional(join(root, AGENTS_FILENAME));
      } catch (error) {
        return conflict(error, "invalid-agents-file");
      }
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
      return { status: "conflict", ok: false, issues: [issue("error", "invalid-control-path", error instanceof Error ? error.message : String(error))], summary: {} };
    }
    const indexPath = join(root, CONTROL_INDEX_FILENAME);
    const agentsPath = join(root, AGENTS_FILENAME);
    let source: string | null;
    try {
      source = await readOptional(indexPath);
    } catch (error) {
      return {
        status: "conflict",
        ok: false,
        issues: [issue("error", "invalid-control-index-file", error instanceof Error ? error.message : String(error), indexPath)],
        summary: {},
      };
    }
    if (source === null) {
      return { status: "conflict", ok: false, issues: [issue("error", "index-missing", `${CONTROL_INDEX_FILENAME} is missing.`, indexPath)], summary: {} };
    }
    let index: ControlIndex;
    try {
      index = parseControlIndexJson(source);
    } catch (error) {
      return { status: "conflict", ok: false, issues: [issue("error", "invalid-control-index", error instanceof Error ? error.message : String(error), indexPath)], summary: {} };
    }
    const inspected = await this.inspectPersistedRepositories(index, root);
    const statuses = inspected.statuses;
    const issues = [...validateControlIndex(index), ...inspected.issues];
    const unsafeRepositoryIds = new Set(inspected.issues.map((entry) => entry.repositoryId).filter((id): id is string => Boolean(id)));
    const nesting = nestedPathConflict(statuses.map((status) => ({ id: status.id, path: status.absolutePath })));
    if (nesting) issues.push(issue("error", nesting.code, nesting.message, nesting.path));
    for (const status of statuses) {
      if (unsafeRepositoryIds.has(status.id)) continue;
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
    let agents: string | null = null;
    try {
      agents = await readOptional(agentsPath);
    } catch (error) {
      issues.push(issue("error", "invalid-agents-file", error instanceof Error ? error.message : String(error), agentsPath));
    }
    if (agents === null) {
      if (!issues.some((entry) => entry.code === "invalid-agents-file")) {
        issues.push(issue("error", "agents-missing", `${AGENTS_FILENAME} is missing.`, agentsPath));
      }
    } else {
      const block = inspectManagedBlock(agents, index.agents.managed_block_hash);
      if (block.status !== "valid") issues.push(issue("error", `agents-${block.status}`, block.status === "invalid" ? block.message : `Managed AGENTS block is ${block.status}.`, agentsPath));
      try {
        const canonical = renderAgentsArtifacts(index);
        if (canonical.index.agents.managed_block_hash !== index.agents.managed_block_hash) {
          issues.push(issue(
            "error",
            "agents-index-mismatch",
            "The managed AGENTS block hash does not match the canonical content rendered from the current index.",
            agentsPath,
          ));
        }
      } catch (error) {
        issues.push(issue("error", "agents-render-failed", error instanceof Error ? error.message : String(error), agentsPath));
      }
    }
    const ok = !issues.some((entry) => entry.severity === "error");
    return { status: ok ? "applied" : "conflict", ok, issues, summary: summaryFor(index, statuses) };
  }

  async update(input: UpdateWorkspaceInput, options: OperationOptions = {}): Promise<OperationResult> {
    let root: string;
    try {
      root = await this.resolveControlRoot(input.controlPath);
    } catch (error) {
      return conflict(error, "invalid-control-path");
    }
    const indexPath = join(root, CONTROL_INDEX_FILENAME);
    let source: string | null;
    try {
      source = await readOptional(indexPath);
    } catch (error) {
      return conflict(error, "invalid-control-index-file");
    }
    if (source === null) return { status: "conflict", conflicts: [{ code: "index-missing", message: `${CONTROL_INDEX_FILENAME} is missing; initialize first.` }] };
    let current: ControlIndex;
    try {
      current = parseControlIndexJson(source);
    } catch (error) {
      return conflict(error, "invalid-control-index");
    }
    const persisted = await this.inspectPersistedRepositories(current, root);
    const unsafeIds = new Set(persisted.issues.map((entry) => entry.repositoryId).filter((id): id is string => Boolean(id)));
    if (unsafeIds.size > 0) {
      const explicitlyRepaired = [...unsafeIds].every((id) => {
        const repository = current.repositories.find((entry) => entry.id === id);
        if (repository?.kind === "code") return input.codePath !== undefined;
        if (repository?.kind === "latex") return input.latexRepositories?.some((entry) => entry.id === id) === true;
        return input.customRepositories?.some((entry) => entry.id === id && entry.path !== undefined) === true;
      });
      if (!explicitlyRepaired) {
        return {
          status: "conflict",
          conflicts: persisted.issues.map((entry) => ({
            code: entry.code,
            message: `${entry.message} Supply an explicit safe replacement path for this repository before updating.`,
            path: entry.path,
          })),
          summary: summaryFor(current, persisted.statuses),
        };
      }
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
      input.focusAreas,
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
        summary: summaryFor(current, persisted.statuses),
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
        source,
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
    if (options.dryRun) return { status: "applied", summary: prepared.summary };
    if (input.agentsExistingStrategy === "preview-only") {
      return {
        status: "conflict",
        conflicts: [{
          code: "preview-only-no-apply",
          message: "Preview-only was selected, so the workspace update was not applied.",
          choices: ["inspect-preview", "apply-managed-update"],
        }],
        summary: prepared.summary,
      };
    }
    try {
      return await applyPrepared(prepared, false);
    } catch (error) {
      return applyConflict(error);
    }
  }

  private async inspectPersistedRepositories(
    index: ControlIndex,
    controlRoot: string,
  ): Promise<{ statuses: RepositoryStatus[]; issues: ValidationIssue[] }> {
    const statuses: RepositoryStatus[] = [];
    const issues: ValidationIssue[] = [];
    const workspaceParent = dirname(controlRoot);
    for (const repository of index.repositories) {
      let resolution;
      try {
        resolution = await resolveCanonicalPath(repository.path, controlRoot);
      } catch (error) {
        issues.push(issue(
          "error",
          "invalid-repository-path",
          error instanceof Error ? error.message : String(error),
          repository.path,
          repository.id,
        ));
        statuses.push({
          id: repository.id,
          kind: repository.kind,
          configuredPath: repository.path,
          absolutePath: absoluteBinding(controlRoot, repository.path),
          exists: false,
          gitRoot: null,
          branch: null,
          dirty: null,
          gitRemote: null,
          remoteMatches: null,
        });
        continue;
      }
      if (!isAbsolute(repository.path)
        && (!isWithin(workspaceParent, resolution.lexicalPath) || !isWithin(workspaceParent, resolution.canonicalPath))) {
        issues.push(issue(
          "error",
          "relative-path-boundary-escape",
          `${repository.id} uses a relative path that escapes the control workspace parent. Use an explicit absolute path for a special location.`,
          repository.path,
          repository.id,
        ));
        statuses.push({
          id: repository.id,
          kind: repository.kind,
          configuredPath: repository.path,
          absolutePath: resolution.canonicalPath,
          exists: resolution.exists,
          gitRoot: null,
          branch: null,
          dirty: null,
          gitRemote: null,
          remoteMatches: null,
        });
        continue;
      }
      statuses.push(await repositoryStatus(repository, controlRoot));
    }
    return { statuses, issues };
  }

  private async resolveControlRoot(controlPath?: string): Promise<string> {
    const resolution = await resolveCanonicalPath(controlPath?.trim() || this.cwd, this.cwd);
    if (!resolution.exists) throw new Error(`Control repository directory does not exist: ${resolution.canonicalPath}`);
    return resolution.canonicalPath;
  }
}
