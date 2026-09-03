import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
const MAX_GIT_OUTPUT = 1024 * 1024;

export interface GitInspection {
  path: string;
  exists: boolean;
  gitRoot: string | null;
  branch: string | null;
  dirty: boolean | null;
  remote: string | null;
  error: string | null;
}

interface GitResult {
  stdout: string;
  stderr: string;
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return (error as { code?: string | number }).code;
}

function commandError(error: unknown): { code?: string | number; stderr: string; message: string } {
  if (typeof error !== "object" || error === null) {
    return { stderr: "", message: String(error) };
  }
  const candidate = error as { code?: string | number; stderr?: string | Buffer; message?: string };
  return {
    code: candidate.code,
    stderr: String(candidate.stderr ?? ""),
    message: String(candidate.message ?? error),
  };
}

function sanitizeGitError(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted]@")
    .replace(/([?&](?:access_?token|auth|key|password|secret|token)=)[^&\s]+/gi, "$1[redacted]")
    .trim();
}

async function runGit(cwd: string, args: string[], allowFailure = false): Promise<GitResult | null> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      env: GIT_ENV,
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const detail = commandError(error);
    if (detail.code === "ENOENT") {
      throw new Error("Git executable was not found; install Git and retry");
    }
    if (allowFailure) return null;
    const safeDetail = sanitizeGitError(detail.stderr || detail.message);
    throw new Error(`Git inspection failed${safeDetail ? `: ${safeDetail}` : ""}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * Removes credentials and URL query/fragment data before a remote is returned
 * to a caller, preview, index candidate, or log.
 */
export function redactRemoteUrl(remote: string | null | undefined): string | null {
  const value = remote?.trim();
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = "redacted";
      parsed.password = "";
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value
      .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, "$1[redacted]@")
      .replace(/([?&](?:access_?token|auth|key|password|secret|token)=)[^&\s]+/gi, "$1[redacted]");
  }
}

/**
 * Produces a credential-free repository identity. Network transports and their
 * login usernames are intentionally ignored so SSH and HTTPS forms of the same
 * host/repository compare equal.
 */
export function normalizeRemoteIdentity(remote: string | null | undefined): string | null {
  const redacted = redactRemoteUrl(remote);
  if (!redacted) return null;
  const value = redacted.trim();

  if (value.includes("://")) {
    try {
      const parsed = new URL(value);
      if (parsed.hostname) return normalizeRemoteParts(parsed.hostname, parsed.pathname);
      if (parsed.protocol === "file:") return normalizeRepositoryPath(parsed.pathname);
    } catch {
      // Fall through to SCP-like and local-path handling.
    }
  }

  const scp = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):\/?(.+)$/);
  if (scp && !/^[A-Za-z]:[\\/]/.test(value)) {
    return normalizeRemoteParts(scp[1], scp[2]);
  }
  return normalizeRepositoryPath(value);
}

function normalizeRemoteParts(host: string, repositoryPath: string): string {
  return `${host.toLowerCase()}/${normalizeRepositoryPath(repositoryPath)}`;
}

function normalizeRepositoryPath(repositoryPath: string): string {
  return repositoryPath
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
}

export function remotesMatch(left: string | null | undefined, right: string | null | undefined): boolean | null {
  const normalizedLeft = normalizeRemoteIdentity(left);
  const normalizedRight = normalizeRemoteIdentity(right);
  if (!normalizedLeft || !normalizedRight) return null;
  return normalizedLeft === normalizedRight;
}

async function readRemote(root: string): Promise<string | null> {
  const origin = await runGit(root, ["remote", "get-url", "origin"], true);
  if (origin?.stdout.trim()) return redactRemoteUrl(origin.stdout);

  const remotes = await runGit(root, ["remote"], true);
  const first = remotes?.stdout
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean)
    .sort()[0];
  if (!first) return null;
  const fallback = await runGit(root, ["remote", "get-url", first], true);
  return redactRemoteUrl(fallback?.stdout);
}

/**
 * Inspects an existing directory without modifying its repository or index.
 * A gitRoot different from path means the directory is nested in another
 * worktree; callers can surface that as a binding conflict.
 */
export async function inspectGitRepository(inputPath: string): Promise<GitInspection> {
  const requestedPath = inputPath;
  if (!(await pathExists(requestedPath))) {
    return {
      path: requestedPath,
      exists: false,
      gitRoot: null,
      branch: null,
      dirty: null,
      remote: null,
      error: null,
    };
  }

  const stats = await lstat(requestedPath);
  if (stats.isSymbolicLink()) {
    return {
      path: requestedPath,
      exists: true,
      gitRoot: null,
      branch: null,
      dirty: null,
      remote: null,
      error: "Repository path is a symbolic link",
    };
  }
  if (!stats.isDirectory()) {
    return {
      path: requestedPath,
      exists: true,
      gitRoot: null,
      branch: null,
      dirty: null,
      remote: null,
      error: "Repository path is not a directory",
    };
  }

  const canonicalPath = await realpath(requestedPath);
  const rootResult = await runGit(canonicalPath, ["rev-parse", "--show-toplevel"], true);
  if (!rootResult?.stdout.trim()) {
    return {
      path: canonicalPath,
      exists: true,
      gitRoot: null,
      branch: null,
      dirty: null,
      remote: null,
      error: null,
    };
  }

  let gitRoot: string;
  try {
    gitRoot = await realpath(rootResult.stdout.trim());
  } catch {
    return {
      path: canonicalPath,
      exists: true,
      gitRoot: null,
      branch: null,
      dirty: null,
      remote: null,
      error: "Git reported a repository root that does not exist",
    };
  }

  const branchResult = await runGit(canonicalPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
  const statusResult = await runGit(canonicalPath, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  const remote = await readRemote(gitRoot);

  return {
    path: canonicalPath,
    exists: true,
    gitRoot,
    branch: branchResult?.stdout.trim() || null,
    dirty: Boolean(statusResult?.stdout),
    remote,
    error: null,
  };
}
