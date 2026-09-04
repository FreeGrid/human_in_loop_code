import { createHash } from "node:crypto";

export const MANAGED_BLOCK_START = "<!-- control-init:managed:start version=1 -->";
export const MANAGED_BLOCK_END = "<!-- control-init:managed:end -->";

const ANY_START_MARKER = /<!--\s*control-init:managed:start\b[^>]*-->/g;
const ANY_END_MARKER = /<!--\s*control-init:managed:end\s*-->/g;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type ManagedBlockInspection =
  | { status: "missing" }
  | { status: "invalid"; message: string }
  | {
      status: "valid";
      block: string;
      hash: string;
      start: number;
      end: number;
      expectedHash?: string;
    }
  | {
      status: "drift";
      block: string;
      hash: string;
      start: number;
      end: number;
      expectedHash: string;
    };

export interface ManagedBlockUpdateOptions {
  /** Hash stored beside the currently installed block. */
  expectedHash?: string;
  /** Must be true before replacing a block whose bytes no longer match expectedHash. */
  acceptDrift?: boolean;
}

export class ManagedBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedBlockError";
  }
}

export class ManagedBlockDriftError extends ManagedBlockError {
  readonly actualHash: string;
  readonly expectedHash: string;

  constructor(expectedHash: string, actualHash: string) {
    super(
      `The managed AGENTS block has drifted (expected ${expectedHash}, found ${actualHash}); ` +
        "preserve it, explicitly accept regeneration, or merge it by hand.",
    );
    this.name = "ManagedBlockDriftError";
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

function markerMatches(source: string, pattern: RegExp): RegExpMatchArray[] {
  return [...source.matchAll(pattern)];
}

function assertCanonicalBlock(block: string): void {
  const inspection = inspectManagedBlock(block);
  if (
    inspection.status !== "valid" ||
    inspection.start !== 0 ||
    inspection.end !== block.length
  ) {
    const reason = inspection.status === "invalid" ? inspection.message : "not a standalone managed block";
    throw new ManagedBlockError(`Invalid generated managed block: ${reason}`);
  }
}

/** Build the canonical V1 block. Generated content is normalized to stable LF bytes. */
export function buildManagedBlock(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
  return `${MANAGED_BLOCK_START}\n${normalized}\n${MANAGED_BLOCK_END}`;
}

export const createManagedBlock = buildManagedBlock;

/** Hash the exact managed block bytes, including its two marker lines. */
export function hashManagedBlock(block: string): string {
  return `sha256:${createHash("sha256").update(block, "utf8").digest("hex")}`;
}

export function inspectManagedBlock(
  source: string,
  expectedHash?: string,
): ManagedBlockInspection {
  const starts = markerMatches(source, ANY_START_MARKER);
  const ends = markerMatches(source, ANY_END_MARKER);

  if (starts.length === 0 && ends.length === 0) return { status: "missing" };
  if (starts.length !== 1 || ends.length !== 1) {
    return {
      status: "invalid",
      message: `Expected exactly one managed start marker and one end marker; found ${starts.length} start and ${ends.length} end markers.`,
    };
  }

  const startMatch = starts[0];
  const endMatch = ends[0];
  if (startMatch[0] !== MANAGED_BLOCK_START) {
    return { status: "invalid", message: "The managed start marker has an unsupported version or format." };
  }
  if (endMatch[0] !== MANAGED_BLOCK_END) {
    return { status: "invalid", message: "The managed end marker has an unsupported format." };
  }

  const start = startMatch.index ?? -1;
  const endStart = endMatch.index ?? -1;
  if (start < 0 || endStart < 0 || endStart < start + startMatch[0].length) {
    return { status: "invalid", message: "The managed block markers are out of order or overlap." };
  }

  const end = endStart + endMatch[0].length;
  const block = source.slice(start, end);
  const hash = hashManagedBlock(block);
  if (expectedHash !== undefined) {
    if (!HASH_PATTERN.test(expectedHash)) {
      return { status: "invalid", message: `Invalid stored managed block hash: ${expectedHash}` };
    }
    if (hash !== expectedHash) {
      return { status: "drift", block, hash, start, end, expectedHash };
    }
  }
  return { status: "valid", block, hash, start, end, ...(expectedHash ? { expectedHash } : {}) };
}

/** Append a block without changing a single byte of existing human-owned content. */
export function insertManagedBlock(source: string, block: string): string {
  assertCanonicalBlock(block);
  const inspection = inspectManagedBlock(source);
  if (inspection.status !== "missing") {
    throw new ManagedBlockError(
      inspection.status === "invalid"
        ? inspection.message
        : "AGENTS.md already contains a managed block; use updateManagedBlock instead.",
    );
  }

  if (source.length === 0) return `${block}\n`;
  const separator = source.endsWith("\n\n") ? "" : source.endsWith("\n") ? "\n" : "\n\n";
  return `${source}${separator}${block}\n`;
}

/** Replace only the marker-bounded bytes; all bytes before and after remain untouched. */
export function updateManagedBlock(
  source: string,
  block: string,
  options: ManagedBlockUpdateOptions = {},
): string {
  assertCanonicalBlock(block);
  const inspection = inspectManagedBlock(source, options.expectedHash);
  if (inspection.status === "missing") {
    throw new ManagedBlockError("AGENTS.md does not contain a managed block; use insertManagedBlock instead.");
  }
  if (inspection.status === "invalid") throw new ManagedBlockError(inspection.message);
  if (inspection.status === "drift" && !options.acceptDrift) {
    throw new ManagedBlockDriftError(inspection.expectedHash, inspection.hash);
  }
  return `${source.slice(0, inspection.start)}${block}${source.slice(inspection.end)}`;
}

/** Insert when absent, otherwise perform a drift-aware marker-bounded update. */
export function applyManagedBlock(
  source: string,
  block: string,
  options: ManagedBlockUpdateOptions = {},
): string {
  const inspection = inspectManagedBlock(source, options.expectedHash);
  if (inspection.status === "missing") {
    if (options.expectedHash) {
      throw new ManagedBlockError(
        "AGENTS.md is missing the managed block recorded by CONTROL_INDEX.json; preserve the file and resolve the conflict explicitly.",
      );
    }
    return insertManagedBlock(source, block);
  }
  if (inspection.status === "invalid") throw new ManagedBlockError(inspection.message);
  return updateManagedBlock(source, block, options);
}

export const replaceManagedBlock = updateManagedBlock;
export const detectManagedBlock = inspectManagedBlock;
