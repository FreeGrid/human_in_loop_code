import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

const cleanTargets = [
  "dist",
  "coverage",
  ".harness-tmp",
  path.join("artifacts", "tmp"),
  path.join("artifacts", "dev-command-results"),
] as const;

const pruneIfEmptyTargets = ["artifacts"] as const;

type CleanResult = {
  readonly command: "clean";
  readonly repoRoot: string;
  readonly removed: readonly string[];
  readonly skipped: readonly string[];
};

function assertInsideRepo(relativeTarget: string): string {
  if (path.isAbsolute(relativeTarget)) {
    throw new Error(`Clean target must be relative: ${relativeTarget}`);
  }

  const absoluteTarget = path.resolve(repoRoot, relativeTarget);
  const relativeFromRepo = path.relative(repoRoot, absoluteTarget);
  if (relativeFromRepo === "" || relativeFromRepo.startsWith("..") || path.isAbsolute(relativeFromRepo)) {
    throw new Error(`Refusing to clean outside repository: ${relativeTarget}`);
  }

  return absoluteTarget;
}

export function cleanRepository(): CleanResult {
  const removed: string[] = [];
  const skipped: string[] = [];

  for (const relativeTarget of cleanTargets) {
    const absoluteTarget = assertInsideRepo(relativeTarget);
    if (!fs.existsSync(absoluteTarget)) {
      skipped.push(relativeTarget);
      continue;
    }

    fs.rmSync(absoluteTarget, { force: true, recursive: true });
    removed.push(relativeTarget);
  }

  for (const relativeTarget of pruneIfEmptyTargets) {
    const absoluteTarget = assertInsideRepo(relativeTarget);
    if (!fs.existsSync(absoluteTarget)) {
      skipped.push(relativeTarget);
      continue;
    }

    const entries = fs.readdirSync(absoluteTarget);
    if (entries.length > 0) {
      skipped.push(relativeTarget);
      continue;
    }

    fs.rmdirSync(absoluteTarget);
    removed.push(relativeTarget);
  }

  return {
    command: "clean",
    repoRoot,
    removed,
    skipped,
  };
}

if (import.meta.main) {
  const result = cleanRepository();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
