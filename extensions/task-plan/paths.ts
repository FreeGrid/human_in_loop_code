import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  link,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface PlanningPaths {
  root: string;
  activeRoot: string;
  completedRoot: string;
  currentPointer: string;
}

export function getPlanningPaths(cwd: string): PlanningPaths {
  const root = resolve(cwd, "planning");
  return {
    root,
    activeRoot: join(root, "active"),
    completedRoot: join(root, "completed"),
    currentPointer: join(root, ".current"),
  };
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function nearestExistingAncestor(candidate: string): Promise<{ ancestor: string; suffix: string[] }> {
  let cursor = resolve(candidate);
  const suffix: string[] = [];

  while (true) {
    try {
      await access(cursor, constants.F_OK);
      return { ancestor: cursor, suffix };
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export async function canonicalPath(candidate: string): Promise<string> {
  const absolute = resolve(candidate);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const { ancestor, suffix } = await nearestExistingAncestor(absolute);
    return resolve(await realpath(ancestor), ...suffix);
  }
}

export async function assertPathWithin(root: string, candidate: string): Promise<string> {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  if (!isWithin(absoluteRoot, absoluteCandidate)) {
    throw new Error(`Target path escapes planning root: ${absoluteCandidate}`);
  }

  const canonicalRoot = await canonicalPath(absoluteRoot);
  const canonicalCandidate = await canonicalPath(absoluteCandidate);
  if (!isWithin(canonicalRoot, canonicalCandidate)) {
    throw new Error(`Target path resolves outside planning root: ${absoluteCandidate}`);
  }
  return absoluteCandidate;
}

export interface AtomicWriteOptions {
  overwrite?: boolean;
}

export async function atomicWriteText(
  root: string,
  target: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const safeTarget = await assertPathWithin(root, target);
  await mkdir(dirname(safeTarget), { recursive: true });
  const temporary = join(dirname(safeTarget), `.${basename(safeTarget)}.${process.pid}.${randomUUID()}.tmp`);
  await assertPathWithin(root, temporary);

  let temporaryExists = false;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    temporaryExists = true;
    if (options.overwrite === false) {
      await link(temporary, safeTarget);
      await unlink(temporary);
      temporaryExists = false;
    } else {
      await rename(temporary, safeTarget);
      temporaryExists = false;
    }
  } finally {
    if (temporaryExists) {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

export async function readTextInside(root: string, target: string): Promise<string> {
  const safeTarget = await assertPathWithin(root, target);
  return readFile(safeTarget, "utf8");
}

export function slugifyGoal(goal: string): string {
  const slug = goal
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "work";
}

function twoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

export function createWorkId(goal: string, now = new Date()): string {
  const date = `${now.getFullYear()}${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}`;
  const time = `${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}${twoDigits(now.getSeconds())}`;
  return `W-${date}-${time}-${slugifyGoal(goal)}`;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
