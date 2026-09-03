import { readdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { SimilarPathCandidate } from "./types.js";
import { inspectGitRepository } from "./git-inspector.js";
import { resolveCanonicalPath } from "./path-binding.js";

const MAX_SUGGESTIONS = 3;
const COMMON_SUFFIXES = [
  "repository",
  "repo",
  "control",
  "code",
  "latex",
  "source",
  "src",
];

function compactName(value: string): string {
  let normalized = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  for (const suffix of COMMON_SUFFIXES) {
    if (normalized.length > suffix.length + 2 && normalized.endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length);
      break;
    }
  }
  return normalized;
}

function levenshtein(left: string, right: string): number {
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + (left[leftIndex] === right[rightIndex] ? 0 : 1),
      ));
    }
    previous = current;
  }
  return previous[right.length];
}

function nameScore(targetName: string, candidateName: string): number {
  const targetLower = targetName.toLocaleLowerCase();
  const candidateLower = candidateName.toLocaleLowerCase();
  if (targetName === candidateName) return 1;
  if (targetLower === candidateLower) return 0.99;

  const targetCompact = compactName(targetName);
  const candidateCompact = compactName(candidateName);
  if (targetCompact && targetCompact === candidateCompact) return 0.96;

  const rawDistance = levenshtein(targetLower, candidateLower);
  const rawScore = 1 - rawDistance / Math.max(targetLower.length, candidateLower.length, 1);
  const compactDistance = levenshtein(targetCompact, candidateCompact);
  const compactScore = 1 - compactDistance / Math.max(targetCompact.length, candidateCompact.length, 1);
  return Math.max(0, rawScore, compactScore * 0.95);
}

export function pathSimilarityScore(targetName: string, candidateName: string): number {
  return Number(nameScore(targetName, candidateName).toFixed(6));
}

/**
 * Searches exactly one explicitly selected parent directory. Results are
 * suggestions only: the function has no selection or mutation capability.
 */
export async function findSimilarPaths(missingPath: string, requestedLimit = MAX_SUGGESTIONS): Promise<SimilarPathCandidate[]> {
  const target = await resolveCanonicalPath(missingPath);
  if (target.exists) return [];

  const parent = target.nearestExistingParent;
  // Only suggest direct siblings when the requested target's immediate parent
  // exists. If multiple parent levels are missing, there is no specified
  // directory whose children may be searched.
  if (dirname(target.canonicalPath) !== parent) return [];

  const targetName = basename(target.canonicalPath);
  const entries = await readdir(parent, { withFileTypes: true });
  const ranked = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => ({
      path: resolve(parent, entry.name),
      score: pathSimilarityScore(targetName, entry.name),
    }))
    .filter((candidate) => candidate.score >= 0.35)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, Math.min(MAX_SUGGESTIONS, Math.max(0, requestedLimit)));

  return Promise.all(ranked.map(async (candidate) => {
    const inspection = await inspectGitRepository(candidate.path);
    return {
      path: candidate.path,
      score: candidate.score,
      gitRoot: inspection.gitRoot,
      gitRemote: inspection.remote,
    };
  }));
}

export const suggestSimilarPaths = findSimilarPaths;
