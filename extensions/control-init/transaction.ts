import { randomBytes } from "node:crypto";
import { chmod, link, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface TransactionWrite {
  path: string;
  content: string;
  createOnly?: boolean;
  /** Exact preflight bytes, or null when absence is required. */
  expectedContent?: string | null;
}

export interface TransactionResult {
  files: Array<{ path: string; action: "created" | "updated" | "unchanged" }>;
}

interface Snapshot {
  write: TransactionWrite;
  existed: boolean;
  content?: Buffer;
  mode?: number;
  tempPath: string;
  applied: boolean;
}

function notFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && left.equals(right);
}

async function snapshot(write: TransactionWrite): Promise<Snapshot> {
  const parent = dirname(write.path);
  const parentStats = await lstat(parent);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new Error(`Transaction parent must be a real directory: ${parent}`);
  }
  let content: Buffer | undefined;
  let mode: number | undefined;
  try {
    const stats = await lstat(write.path);
    if (stats.isSymbolicLink()) throw new Error(`Refusing to replace symlink: ${write.path}`);
    if (!stats.isFile()) throw new Error(`Transaction target is not a regular file: ${write.path}`);
    if (write.createOnly) throw new Error(`File already exists and will not be overwritten: ${write.path}`);
    content = await readFile(write.path);
    mode = stats.mode;
  } catch (error) {
    if (!notFound(error)) throw error;
  }

  if (write.expectedContent === null && content !== undefined) {
    throw new Error(`File appeared after preview and will not be overwritten: ${write.path}`);
  }
  if (typeof write.expectedContent === "string") {
    const expected = Buffer.from(write.expectedContent, "utf8");
    if (content === undefined || !sameBytes(content, expected)) {
      throw new Error(`File changed after preview and will not be overwritten: ${write.path}`);
    }
  }

  return {
    write,
    existed: content !== undefined,
    content,
    mode,
    tempPath: join(parent, `.${basename(write.path)}.control-init-${process.pid}-${randomBytes(8).toString("hex")}.tmp`),
    applied: false,
  };
}

async function install(snapshot: Snapshot): Promise<"created" | "updated" | "unchanged"> {
  const desired = Buffer.from(snapshot.write.content, "utf8");
  if (snapshot.content && sameBytes(snapshot.content, desired)) return "unchanged";

  await writeFile(snapshot.tempPath, desired, { flag: "wx", mode: snapshot.mode ?? 0o600 });
  if (snapshot.mode !== undefined) await chmod(snapshot.tempPath, snapshot.mode);

  if (snapshot.write.createOnly) {
    // link(2) gives exclusive-create semantics; rename would overwrite a racing writer.
    await link(snapshot.tempPath, snapshot.write.path);
    await unlink(snapshot.tempPath);
  } else {
    await rename(snapshot.tempPath, snapshot.write.path);
  }
  snapshot.applied = true;
  return snapshot.existed ? "updated" : "created";
}

async function rollback(snapshot: Snapshot): Promise<void> {
  if (!snapshot.applied) return;
  const desired = Buffer.from(snapshot.write.content, "utf8");
  let current: Buffer;
  try {
    current = await readFile(snapshot.write.path);
  } catch (error) {
    if (notFound(error) && !snapshot.existed) return;
    throw error;
  }
  if (!sameBytes(current, desired)) {
    throw new Error(`Rollback refused because another process changed ${snapshot.write.path}`);
  }

  if (!snapshot.existed) {
    await unlink(snapshot.write.path);
    return;
  }

  const rollbackTemp = `${snapshot.tempPath}.rollback`;
  await writeFile(rollbackTemp, snapshot.content!, { flag: "wx", mode: snapshot.mode ?? 0o600 });
  if (snapshot.mode !== undefined) await chmod(rollbackTemp, snapshot.mode);
  await rename(rollbackTemp, snapshot.write.path);
}

async function cleanTemp(snapshot: Snapshot): Promise<void> {
  await unlink(snapshot.tempPath).catch((error: unknown) => {
    if (!notFound(error)) throw error;
  });
}

/**
 * Atomically installs each file and restores earlier files if a later install
 * fails. Callers still own rollback of repository bootstrap operations.
 */
export async function writeWorkspaceTransaction(
  writes: TransactionWrite[],
  verify?: () => Promise<void>,
): Promise<TransactionResult> {
  if (writes.length === 0) return { files: [] };
  const unique = new Set(writes.map((write) => write.path));
  if (unique.size !== writes.length) throw new Error("A transaction cannot write the same path twice");

  const snapshots: Snapshot[] = [];
  try {
    // Complete every read-only preflight before staging or installing content.
    for (const write of writes) snapshots.push(await snapshot(write));
    const files: TransactionResult["files"] = [];
    for (const item of snapshots) {
      files.push({ path: item.write.path, action: await install(item) });
    }
    await verify?.();
    return { files };
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const item of [...snapshots].reverse()) {
      try {
        await rollback(item);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Workspace transaction failed and rollback was incomplete");
    }
    throw error;
  } finally {
    await Promise.all(snapshots.map((item) => cleanTemp(item).catch(() => undefined)));
  }
}
