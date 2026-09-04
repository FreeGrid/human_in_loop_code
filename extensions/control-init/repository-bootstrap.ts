import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { BootstrapAuthorization } from "./types.js";
import { inspectGitRepository } from "./git-inspector.js";
import { resolveCanonicalPath } from "./path-binding.js";

const execFileAsync = promisify(execFile);

export type RepositoryBootstrapAction = "none" | "create-and-init" | "initialize-existing";

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

export interface RepositoryBootstrapPlan {
  status: "ready";
  action: RepositoryBootstrapAction;
  targetPath: string;
  authorization: "not-required" | "create" | "initialize";
  nearestExistingParent: DirectoryIdentity;
  missingSegments: string[];
  existingTarget?: DirectoryIdentity;
}

export interface RepositoryBootstrapConflict {
  status: "conflict";
  code:
    | "bootstrap-authorization-required"
    | "path-inside-git-worktree"
    | "invalid-git-metadata";
  message: string;
  path: string;
  plannedAction?: Exclude<RepositoryBootstrapAction, "none">;
  requiredAuthorization?: "create" | "initialize";
}

export type RepositoryBootstrapPlanningResult = RepositoryBootstrapPlan | RepositoryBootstrapConflict;

interface TreeEntryFingerprint {
  path: string;
  type: "directory" | "file" | "symlink";
  mode: number;
  digest?: string;
  linkTarget?: string;
}

export interface TreeFingerprint {
  digest: string;
  entries: TreeEntryFingerprint[];
}

export interface RepositoryBootstrapRecord {
  action: RepositoryBootstrapAction;
  targetPath: string;
  createdDirectories: string[];
  gitDirectory: string | null;
  gitFingerprint: TreeFingerprint | null;
  targetFingerprint: TreeFingerprint | null;
}

export interface RepositoryBootstrapRollbackResult {
  rolledBack: boolean;
  preserved: boolean;
  warnings: string[];
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return (error as { code?: string | number }).code;
}

async function identity(path: string): Promise<DirectoryIdentity> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Expected a real directory: ${path}`);
  }
  return { path, dev: stats.dev, ino: stats.ino };
}

async function sameIdentity(expected: DirectoryIdentity): Promise<boolean> {
  try {
    const current = await identity(expected.path);
    return current.dev === expected.dev && current.ino === expected.ino;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function authorizedPathMatches(targetPath: string, paths: string[] | undefined): Promise<boolean> {
  for (const authorizedPath of paths ?? []) {
    if (!isAbsolute(authorizedPath)) continue;
    try {
      const canonical = await resolveCanonicalPath(authorizedPath);
      if (canonical.canonicalPath === targetPath) return true;
    } catch {
      // An invalid authorization never widens authority.
    }
  }
  return false;
}

async function ancestorGitRoot(path: string): Promise<string | null> {
  const inspection = await inspectGitRepository(path);
  return inspection.gitRoot;
}

/**
 * Creates a non-mutating plan. Missing paths and existing non-Git directories
 * become executable plans only when their exact canonical paths appear in the
 * matching authorization list.
 */
export async function planRepositoryBootstrap(
  targetPath: string,
  authorization: BootstrapAuthorization = {},
): Promise<RepositoryBootstrapPlanningResult> {
  const target = await resolveCanonicalPath(targetPath);

  if (target.exists) {
    const inspection = await inspectGitRepository(target.canonicalPath);
    if (inspection.gitRoot === target.canonicalPath) {
      return {
        status: "ready",
        action: "none",
        targetPath: target.canonicalPath,
        authorization: "not-required",
        nearestExistingParent: await identity(target.canonicalPath),
        missingSegments: [],
        existingTarget: await identity(target.canonicalPath),
      };
    }
    if (inspection.gitRoot) {
      return {
        status: "conflict",
        code: "path-inside-git-worktree",
        message: `Path is nested inside Git worktree ${inspection.gitRoot}; choose a repository root`,
        path: target.canonicalPath,
      };
    }

    const gitMetadata = join(target.canonicalPath, ".git");
    if ((await exists(gitMetadata)) || inspection.error) {
      return {
        status: "conflict",
        code: "invalid-git-metadata",
        message: "Directory contains Git metadata that could not be inspected; repair it before initialization",
        path: target.canonicalPath,
      };
    }

    if (!(await authorizedPathMatches(target.canonicalPath, authorization.initialize))) {
      return {
        status: "conflict",
        code: "bootstrap-authorization-required",
        message: "Initializing this existing directory requires exact-path authorization",
        path: target.canonicalPath,
        plannedAction: "initialize-existing",
        requiredAuthorization: "initialize",
      };
    }

    return {
      status: "ready",
      action: "initialize-existing",
      targetPath: target.canonicalPath,
      authorization: "initialize",
      nearestExistingParent: await identity(target.canonicalPath),
      missingSegments: [],
      existingTarget: await identity(target.canonicalPath),
    };
  }

  const parentGitRoot = await ancestorGitRoot(target.nearestExistingParent);
  if (parentGitRoot) {
    return {
      status: "conflict",
      code: "path-inside-git-worktree",
      message: `Path would be nested inside Git worktree ${parentGitRoot}; choose a separate repository location`,
      path: target.canonicalPath,
    };
  }

  if (!(await authorizedPathMatches(target.canonicalPath, authorization.create))) {
    return {
      status: "conflict",
      code: "bootstrap-authorization-required",
      message: "Creating this directory and running git init requires exact-path authorization",
      path: target.canonicalPath,
      plannedAction: "create-and-init",
      requiredAuthorization: "create",
    };
  }

  return {
    status: "ready",
    action: "create-and-init",
    targetPath: target.canonicalPath,
    authorization: "create",
    nearestExistingParent: await identity(target.nearestExistingParent),
    missingSegments: [...target.missingSegments],
  };
}

async function runGitInit(targetPath: string): Promise<void> {
  try {
    await execFileAsync("git", ["init", "--quiet", targetPath], {
      env: { ...process.env, LC_ALL: "C" },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new Error("Git executable was not found; install Git and retry");
    throw new Error(`git init failed for ${targetPath}`);
  }
}

async function treeFingerprint(root: string): Promise<TreeFingerprint> {
  const entries: TreeEntryFingerprint[] = [];

  async function visit(absolutePath: string): Promise<void> {
    const stats = await lstat(absolutePath);
    const relativePath = relative(root, absolutePath).split(sep).join("/");
    if (stats.isSymbolicLink()) {
      entries.push({ path: relativePath, type: "symlink", mode: stats.mode, linkTarget: await readlink(absolutePath) });
      return;
    }
    if (stats.isDirectory()) {
      entries.push({ path: relativePath, type: "directory", mode: stats.mode });
      const children = (await readdir(absolutePath)).sort();
      for (const child of children) await visit(join(absolutePath, child));
      return;
    }
    if (stats.isFile()) {
      entries.push({
        path: relativePath,
        type: "file",
        mode: stats.mode,
        digest: createHash("sha256").update(await readFile(absolutePath)).digest("hex"),
      });
      return;
    }
    throw new Error(`Unsupported filesystem entry in bootstrap rollback snapshot: ${absolutePath}`);
  }

  await visit(root);
  const digest = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return { digest, entries };
}

async function fingerprintMatches(path: string, expected: TreeFingerprint): Promise<boolean> {
  try {
    return (await treeFingerprint(path)).digest === expected.digest;
  } catch {
    return false;
  }
}

function entryAbsolutePath(root: string, entryPath: string): string {
  if (!entryPath) return root;
  const absolutePath = resolve(root, entryPath);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!absolutePath.startsWith(prefix)) throw new Error("Unsafe rollback snapshot path");
  return absolutePath;
}

async function entryMatches(root: string, entry: TreeEntryFingerprint): Promise<boolean> {
  const path = entryAbsolutePath(root, entry.path);
  try {
    const stats = await lstat(path);
    if (stats.mode !== entry.mode) return false;
    if (entry.type === "directory") return stats.isDirectory() && !stats.isSymbolicLink();
    if (entry.type === "symlink") {
      return stats.isSymbolicLink() && (await readlink(path)) === entry.linkTarget;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    return createHash("sha256").update(await readFile(path)).digest("hex") === entry.digest;
  } catch {
    return false;
  }
}

async function removeExactTree(root: string, snapshot: TreeFingerprint): Promise<void> {
  if (!(await fingerprintMatches(root, snapshot))) {
    throw new Error(`Rollback refused because repository contents changed: ${root}`);
  }
  const nonDirectories = snapshot.entries
    .filter((entry) => entry.type !== "directory")
    .sort((left, right) => right.path.length - left.path.length);
  for (const entry of nonDirectories) {
    const path = entryAbsolutePath(root, entry.path);
    if (!(await entryMatches(root, entry))) throw new Error(`Rollback entry changed: ${path}`);
    await unlink(path);
  }
  const directories = snapshot.entries
    .filter((entry) => entry.type === "directory")
    .sort((left, right) => {
      const leftDepth = left.path ? left.path.split("/").length : 0;
      const rightDepth = right.path ? right.path.split("/").length : 0;
      return rightDepth - leftDepth;
    });
  for (const entry of directories) await rmdir(entryAbsolutePath(root, entry.path));
}

async function quarantineAndRemove(path: string, snapshot: TreeFingerprint): Promise<void> {
  if (!(await fingerprintMatches(path, snapshot))) {
    throw new Error(`Rollback refused because repository contents changed: ${path}`);
  }
  const quarantine = join(dirname(path), `.${basename(path)}.control-init-rollback-${randomBytes(8).toString("hex")}`);
  if (await exists(quarantine)) throw new Error(`Rollback quarantine already exists: ${quarantine}`);
  await rename(path, quarantine);
  if (!(await fingerprintMatches(quarantine, snapshot))) {
    if (!(await exists(path))) await rename(quarantine, path);
    throw new Error(`Rollback refused because repository contents changed during rollback: ${path}`);
  }
  try {
    await removeExactTree(quarantine, snapshot);
  } catch (error) {
    if ((await exists(quarantine)) && !(await exists(path))) {
      await rename(quarantine, path);
    }
    throw error;
  }
}

function combineFailure(error: unknown, rollbackError: unknown): AggregateError {
  return new AggregateError([error, rollbackError], "Repository bootstrap failed and rollback was incomplete");
}

/**
 * Executes only a ready, authorized plan and re-checks every identity/absence
 * assumption before creating a directory or Git metadata.
 */
export async function executeRepositoryBootstrap(plan: RepositoryBootstrapPlan): Promise<RepositoryBootstrapRecord> {
  if (plan.status !== "ready") throw new Error("A conflicting bootstrap plan cannot be executed");
  if (plan.action === "none") {
    return {
      action: "none",
      targetPath: plan.targetPath,
      createdDirectories: [],
      gitDirectory: null,
      gitFingerprint: null,
      targetFingerprint: null,
    };
  }

  if (!(await sameIdentity(plan.nearestExistingParent))) {
    throw new Error(`Repository parent changed after preview: ${plan.nearestExistingParent.path}`);
  }

  const createdDirectories: string[] = [];
  let gitDirectoryCreated = false;
  let activeDirectory = plan.nearestExistingParent;
  let targetIdentity = plan.existingTarget;
  let cursor = plan.nearestExistingParent.path;
  try {
    if (plan.action === "create-and-init") {
      if (await exists(plan.targetPath)) {
        throw new Error(`Repository path appeared after preview and will not be used: ${plan.targetPath}`);
      }
      for (const segment of plan.missingSegments) {
        if (!(await sameIdentity(activeDirectory))) {
          throw new Error(`Repository parent changed while directories were being created: ${activeDirectory.path}`);
        }
        cursor = join(cursor, segment);
        await mkdir(cursor);
        createdDirectories.push(cursor);
        activeDirectory = await identity(cursor);
      }
      targetIdentity = activeDirectory;
    } else {
      if (!plan.existingTarget || !(await sameIdentity(plan.existingTarget))) {
        throw new Error(`Existing repository directory changed after preview: ${plan.targetPath}`);
      }
    }

    if (!targetIdentity || !(await sameIdentity(targetIdentity))) {
      throw new Error(`Repository directory changed before git init: ${plan.targetPath}`);
    }

    const gitDirectory = join(plan.targetPath, ".git");
    // Exclusive creation claims the metadata path before git init so a racing
    // process cannot cause us to adopt its repository.
    await mkdir(gitDirectory);
    gitDirectoryCreated = true;
    await runGitInit(plan.targetPath);

    const inspection = await inspectGitRepository(plan.targetPath);
    const canonicalRoot = inspection.gitRoot ? await realpath(inspection.gitRoot) : null;
    if (canonicalRoot !== plan.targetPath) {
      throw new Error(`git init did not create the expected repository root at ${plan.targetPath}`);
    }

    const gitFingerprint = await treeFingerprint(gitDirectory);
    const targetFingerprint = plan.action === "create-and-init" ? await treeFingerprint(plan.targetPath) : null;
    return {
      action: plan.action,
      targetPath: plan.targetPath,
      createdDirectories,
      gitDirectory,
      gitFingerprint,
      targetFingerprint,
    };
  } catch (error) {
    const gitDirectory = join(plan.targetPath, ".git");
    try {
      if (plan.action === "create-and-init" && (await exists(plan.targetPath))) {
        const targetEntries = await readdir(plan.targetPath);
        if (targetEntries.some((entry) => entry !== ".git")) {
          throw new Error(`Rollback refused because the newly created repository gained files: ${plan.targetPath}`);
        }
      }
      if (gitDirectoryCreated && (await exists(gitDirectory))) {
        const snapshot = await treeFingerprint(gitDirectory);
        await quarantineAndRemove(gitDirectory, snapshot);
      }
      for (const directory of [...createdDirectories].reverse()) await rmdir(directory);
    } catch (rollbackError) {
      throw combineFailure(error, rollbackError);
    }
    throw error;
  }
}

/**
 * Rolls back a later transaction failure. Existing directories keep all user
 * files; only unchanged plugin-created Git metadata is removed. Newly created
 * repositories are removed only when the complete post-init snapshot matches.
 */
export async function rollbackRepositoryBootstrap(
  record: RepositoryBootstrapRecord,
): Promise<RepositoryBootstrapRollbackResult> {
  if (record.action === "none") return { rolledBack: false, preserved: false, warnings: [] };

  try {
    if (record.action === "create-and-init") {
      if (!record.targetFingerprint || !(await fingerprintMatches(record.targetPath, record.targetFingerprint))) {
        return {
          rolledBack: false,
          preserved: true,
          warnings: [`Created repository was preserved because its contents changed: ${record.targetPath}`],
        };
      }
      await quarantineAndRemove(record.targetPath, record.targetFingerprint);
      for (const directory of [...record.createdDirectories].reverse()) {
        if (directory === record.targetPath) continue;
        try {
          await rmdir(directory);
        } catch (error) {
          if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTEMPTY") throw error;
        }
      }
      return { rolledBack: true, preserved: false, warnings: [] };
    }

    if (!record.gitDirectory || !record.gitFingerprint) {
      throw new Error("Bootstrap record is missing the created Git metadata snapshot");
    }
    if (!(await fingerprintMatches(record.gitDirectory, record.gitFingerprint))) {
      return {
        rolledBack: false,
        preserved: true,
        warnings: [`Git metadata was preserved because it changed: ${record.gitDirectory}`],
      };
    }
    await quarantineAndRemove(record.gitDirectory, record.gitFingerprint);
    return { rolledBack: true, preserved: false, warnings: [] };
  } catch (error) {
    return {
      rolledBack: false,
      preserved: true,
      warnings: [error instanceof Error ? error.message : String(error)],
    };
  }
}
