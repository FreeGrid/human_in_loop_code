import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export interface CanonicalPathResolution {
  requestedPath: string;
  lexicalPath: string;
  canonicalPath: string;
  exists: boolean;
  nearestExistingParent: string;
  missingSegments: string[];
}

export interface PathBindingResolution extends CanonicalPathResolution {
  controlRoot: string;
  portablePath: string;
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return (error as { code?: string | number }).code;
}

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function validateInput(inputPath: string): void {
  if (!inputPath.trim()) throw new Error("Repository path must not be empty");
  if (inputPath.includes("\0")) throw new Error("Repository path must not contain NUL bytes");
}

function portable(relativePath: string): string {
  if (!relativePath) return ".";
  return relativePath.split(sep).join("/");
}

function isWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

/**
 * Resolves a path through its nearest existing parent. Missing suffixes are
 * joined to the parent's realpath, so later mutations never follow an
 * unchecked symlink. A final-component symlink is rejected because it makes
 * the configured repository name an alias rather than a stable binding.
 */
export async function resolveCanonicalPath(inputPath: string, basePath = process.cwd()): Promise<CanonicalPathResolution> {
  validateInput(inputPath);
  const lexicalPath = normalize(isAbsolute(inputPath) ? resolve(inputPath) : resolve(basePath, inputPath));

  const exact = await statIfPresent(lexicalPath);
  if (exact) {
    if (exact.isSymbolicLink()) {
      throw new Error(`Repository path must not be a symbolic link: ${lexicalPath}`);
    }
    if (!exact.isDirectory()) {
      throw new Error(`Repository path is not a directory: ${lexicalPath}`);
    }
    const canonicalPath = await realpath(lexicalPath);
    return {
      requestedPath: inputPath,
      lexicalPath,
      canonicalPath,
      exists: true,
      nearestExistingParent: canonicalPath,
      missingSegments: [],
    };
  }

  const missingSegments: string[] = [];
  let cursor = lexicalPath;
  for (;;) {
    const stats = await statIfPresent(cursor);
    if (stats) {
      if (!stats.isDirectory() && !stats.isSymbolicLink()) {
        throw new Error(`Nearest existing path is not a directory: ${cursor}`);
      }
      const nearestExistingParent = await realpath(cursor);
      const parentStats = await lstat(nearestExistingParent);
      if (!parentStats.isDirectory()) {
        throw new Error(`Nearest existing path does not resolve to a directory: ${cursor}`);
      }
      const canonicalPath = missingSegments.reduce((parent, segment) => join(parent, segment), nearestExistingParent);
      return {
        requestedPath: inputPath,
        lexicalPath,
        canonicalPath,
        exists: false,
        nearestExistingParent,
        missingSegments,
      };
    }

    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`No existing parent found for repository path: ${lexicalPath}`);
    missingSegments.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
}

/**
 * Produces an index binding relative to the canonical control repository.
 * Siblings such as ../code are deliberately supported; containment inside the
 * control repository is neither required nor desirable.
 */
export async function resolvePathBinding(controlPath: string, repositoryPath: string): Promise<PathBindingResolution> {
  const control = await resolveCanonicalPath(controlPath);
  if (!control.exists) throw new Error(`Control repository does not exist: ${control.canonicalPath}`);

  const target = await resolveCanonicalPath(repositoryPath, control.canonicalPath);
  const workspaceParent = dirname(control.canonicalPath);
  if (!isAbsolute(repositoryPath)) {
    if (!isWithin(workspaceParent, target.lexicalPath) || !isWithin(workspaceParent, target.canonicalPath)) {
      throw new Error(
        `Relative repository path escapes the control workspace parent: ${repositoryPath}. Use an explicit absolute path for a special location`,
      );
    }
  }

  const portablePath = isWithin(workspaceParent, target.canonicalPath)
    ? portable(relative(control.canonicalPath, target.canonicalPath))
    : portable(target.canonicalPath);
  return {
    ...target,
    controlRoot: control.canonicalPath,
    portablePath,
  };
}

export async function toPortablePath(controlPath: string, repositoryPath: string): Promise<string> {
  return (await resolvePathBinding(controlPath, repositoryPath)).portablePath;
}

export interface PathBindingInput {
  id: string;
  path: string;
}

/**
 * Canonicalizes every binding before checking uniqueness, preventing aliases
 * (including case/path spelling differences) from assigning one repository to
 * multiple roles.
 */
export async function assertDistinctBindings(
  controlPath: string,
  bindings: PathBindingInput[],
): Promise<PathBindingResolution[]> {
  const resolutions = await Promise.all(bindings.map((binding) => resolvePathBinding(controlPath, binding.path)));
  const owners = new Map<string, string>();
  for (let index = 0; index < resolutions.length; index += 1) {
    const key = resolutions[index].canonicalPath;
    const previous = owners.get(key);
    if (previous) {
      throw new Error(`Repository path is bound more than once: ${previous} and ${bindings[index].id} resolve to ${key}`);
    }
    owners.set(key, bindings[index].id);
  }
  return resolutions;
}
