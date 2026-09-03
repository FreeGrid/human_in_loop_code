import { randomBytes } from "node:crypto";
import { chmod, link, lstat, open, readFile, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const TRANSACTION_LOCK_FILENAME = ".control-init.transaction.lock";

export interface TransactionWrite {
  path: string;
  content: string;
  createOnly?: boolean;
  /** Exact preflight bytes, or null when absence is required. */
  expectedContent?: string | null;
}

export interface TransactionResult {
  files: Array<{ path: string; action: "created" | "updated" | "unchanged" }>;
  warnings?: string[];
}

interface Snapshot {
  write: TransactionWrite;
  existed: boolean;
  content?: Buffer;
  mode?: number;
  tempPath: string;
  applied: boolean;
}

interface TransactionLock {
  path: string;
  handle: FileHandle;
}

function notFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function alreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
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

async function assertSnapshotCurrent(snapshot: Snapshot): Promise<void> {
  let current: Buffer | undefined;
  try {
    const stats = await lstat(snapshot.write.path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Transaction target changed type after preflight: ${snapshot.write.path}`);
    }
    current = await readFile(snapshot.write.path);
  } catch (error) {
    if (!notFound(error)) throw error;
  }
  if (snapshot.existed !== (current !== undefined)
    || (snapshot.content !== undefined && current !== undefined && !sameBytes(snapshot.content, current))) {
    throw new Error(`File changed while waiting for the workspace transaction lock: ${snapshot.write.path}`);
  }
}

async function acquireTransactionLocks(writes: TransactionWrite[]): Promise<TransactionLock[]> {
  const locks: TransactionLock[] = [];
  const parents = [...new Set(writes.map((write) => dirname(write.path)))].sort();
  try {
    for (const parent of parents) {
      const path = join(parent, TRANSACTION_LOCK_FILENAME);
      if (writes.some((write) => write.path === path)) {
        throw new Error(`Transaction target uses the reserved lock path: ${path}`);
      }
      let handle: FileHandle;
      try {
        handle = await open(path, "wx", 0o600);
      } catch (error) {
        if (alreadyExists(error)) {
          throw new Error(`Another control-init transaction is already in progress: ${parent}`);
        }
        throw error;
      }
      locks.push({ path, handle });
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`, "utf8");
    }
    return locks;
  } catch (error) {
    const releaseErrors = await releaseTransactionLocks(locks);
    if (releaseErrors.length > 0) {
      throw new AggregateError([error, ...releaseErrors], "Unable to acquire all workspace locks and cleanup was incomplete");
    }
    throw error;
  }
}

async function releaseTransactionLocks(locks: TransactionLock[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const lock of [...locks].reverse()) {
    try {
      await lock.handle.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await unlink(lock.path);
    } catch (error) {
      if (!notFound(error)) errors.push(error);
    }
  }
  return errors;
}

async function install(snapshot: Snapshot): Promise<"created" | "updated" | "unchanged"> {
  const desired = Buffer.from(snapshot.write.content, "utf8");
  if (snapshot.content && sameBytes(snapshot.content, desired)) return "unchanged";

  await writeFile(snapshot.tempPath, desired, { flag: "wx", mode: snapshot.mode ?? 0o600 });
  if (snapshot.mode !== undefined) await chmod(snapshot.tempPath, snapshot.mode);

  if (!snapshot.existed) {
    // link(2) gives exclusive-create semantics for every initially absent file;
    // rename would overwrite a writer that appeared after preflight.
    await link(snapshot.tempPath, snapshot.write.path);
    snapshot.applied = true;
    await unlink(snapshot.tempPath);
  } else {
    const current = await readFile(snapshot.write.path);
    if (!snapshot.content || !sameBytes(current, snapshot.content)) {
      throw new Error(`File changed during apply and will not be overwritten: ${snapshot.write.path}`);
    }
    await rename(snapshot.tempPath, snapshot.write.path);
    snapshot.applied = true;
  }
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
  let locks: TransactionLock[] = [];
  let result: TransactionResult | undefined;
  let transactionError: unknown;
  try {
    // Complete every read-only preflight before creating even a transient lock.
    for (const write of writes) snapshots.push(await snapshot(write));
    locks = await acquireTransactionLocks(writes);
    // A competing process may have committed between preflight and lock
    // acquisition. Re-check beneath the lock before staging any content.
    for (const item of snapshots) await assertSnapshotCurrent(item);
    const files: TransactionResult["files"] = [];
    for (const item of snapshots) {
      files.push({ path: item.write.path, action: await install(item) });
    }
    await verify?.();
    result = { files };
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
      transactionError = new AggregateError([error, ...rollbackErrors], "Workspace transaction failed and rollback was incomplete");
    } else {
      transactionError = error;
    }
  }
  await Promise.all(snapshots.map((item) => cleanTemp(item).catch(() => undefined)));
  const releaseErrors = await releaseTransactionLocks(locks);
  if (transactionError !== undefined) {
    if (releaseErrors.length > 0) {
      throw new AggregateError(
        [transactionError, ...releaseErrors],
        "Workspace transaction failed and lock cleanup was incomplete",
      );
    }
    throw transactionError;
  }
  if (!result) throw new Error("Workspace transaction completed without a result");
  if (releaseErrors.length > 0) {
    result.warnings = [
      `Workspace files were applied and verified, but ${TRANSACTION_LOCK_FILENAME} could not be removed. Confirm no control-init operation is running, remove the leftover lock manually, then run doctor.`,
    ];
  }
  return result;
}
