import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isAlias, isMap, isScalar, parseDocument } from "yaml";
import { parseReadablePlan, renderReadablePlan, type ReadablePlan } from "./v3-format.ts";

export interface ReadablePlanSnapshot { path: string; text: string; document_hash: string; plan: ReadablePlan }

function digest(bytes: string | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function decode(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("v3_invalid_utf8: document is not valid UTF-8"); }
}
function snapshot(path: string, bytes: Buffer): ReadablePlanSnapshot {
  const text = decode(bytes);
  return { path, text, document_hash: digest(bytes), plan: parseReadablePlan(text) };
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) { if (code(error) === "ENOENT") throw new Error("v3_missing_file"); throw error; }
}

async function source(path: string): Promise<{ bytes: Buffer; mode: number }> {
  let file: FileHandle;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (code(error) === "ENOENT") throw new Error("v3_missing_file");
    if (code(error) === "ELOOP") throw new Error("v3_path_changed");
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("v3_not_regular_file");
    return { bytes: await file.readFile(), mode: info.mode & 0o7777 };
  } finally { await file.close(); }
}

/** A pure read: no lock, runtime discovery, directory creation, or legacy adaptation. */
export async function readReadablePlan(path: string): Promise<ReadablePlanSnapshot> {
  const canonical = await canonicalPath(path);
  return snapshot(canonical, (await source(canonical)).bytes);
}

interface OwnedLock { path: string; file: FileHandle; dev: number; ino: number; token: string }
async function acquireLock(path: string): Promise<OwnedLock> {
  let file: FileHandle;
  try { file = await open(path, "wx", 0o600); }
  catch (error) { if (code(error) === "EEXIST") throw new Error("v3_plan_locked: another writer or an uninspected lock exists"); throw error; }
  const info = await file.stat();
  const token = `${process.pid}:${randomUUID()}\n`;
  const lock = { path, file, dev: info.dev, ino: info.ino, token };
  try { await file.writeFile(token, "utf8"); await file.sync(); }
  catch (error) { await file.close(); throw error; } // Unknown/incompletely initialized locks are not guessed away.
  return lock;
}

async function assertLock(lock: OwnedLock): Promise<void> {
  let info;
  try { info = await lstat(lock.path); }
  catch { throw new Error("v3_lock_changed"); }
  if (!info.isFile() || info.dev !== lock.dev || info.ino !== lock.ino || await readFile(lock.path, "utf8") !== lock.token) throw new Error("v3_lock_changed");
}

async function releaseLock(lock: OwnedLock): Promise<void> {
  await lock.file.close();
  await assertLock(lock);
  await rm(lock.path);
}

async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, "r");
  try { await file.sync(); }
  catch (error) { if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(code(error) ?? "")) throw error; }
  finally { await file.close(); }
}

async function prepareFile(path: string, text: string, mode: number): Promise<void> {
  const file = await open(path, "wx", mode);
  try {
    await file.writeFile(text, "utf8");
    await file.chmod(mode); // Creation umask and write-time mode changes must not alter an existing plan's permissions.
    await file.sync();
  } finally { await file.close(); }
}

/** Cooperative, realpath-aware CAS. Conflict failures leave the readable document unchanged. */
export async function writeReadablePlan(path: string, expectedHash: string, plan: ReadablePlan): Promise<ReadablePlanSnapshot> {
  const rendered = renderReadablePlan(plan); // Entire candidate is checked before any filesystem mutation.
  const candidate = parseReadablePlan(rendered);
  if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("v3_invalid_document_hash");
  const canonical = await canonicalPath(path);
  const lock = await acquireLock(join(dirname(canonical), `.${basename(canonical)}.pi-plan-v3.lock`));
  const temporary = join(dirname(canonical), `.${basename(canonical)}.v3-${randomUUID()}.tmp`);
  let published = false;
  try {
    const original = await source(canonical);
    if (digest(original.bytes) !== expectedHash) throw new Error("v3_stale_document_hash");
    const current = snapshot(canonical, original.bytes);
    if (current.plan.plan_id !== candidate.plan_id) throw new Error("v3_plan_id_mismatch");
    // Preserve a conventional CRLF document when a human edits it with a Windows editor.
    const text = current.text.includes("\r\n") && !/(?<!\r)\n/.test(current.text) ? rendered.replace(/\n/g, "\r\n") : rendered;
    if (text === current.text) return current;
    await prepareFile(temporary, text, original.mode);
    await assertLock(lock);
    if (await canonicalPath(path) !== canonical || await canonicalPath(canonical) !== canonical) throw new Error("v3_path_changed");
    if (digest((await source(canonical)).bytes) !== expectedHash) throw new Error("v3_stale_document_hash");
    await rename(temporary, canonical);
    published = true;
    await syncDirectory(dirname(canonical));
    return snapshot(canonical, Buffer.from(text, "utf8"));
  } catch (error) {
    if (published) throw new Error(`v3_write_uncertain: file replaced but durability could not be confirmed: ${String(error)}`);
    throw error;
  } finally {
    try { await rm(temporary, { force: true }); }
    finally { await releaseLock(lock); }
  }
}

async function nextSequence(directory: string): Promise<bigint> {
  let maximum = 0n;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // Reserve all numbered entries, including legacy formats and unreadable/corrupt documents.
    const filename = /^(\d+)(?:[-.]|$)/.exec(entry.name);
    if (filename) maximum = maximum > BigInt(filename[1]!) ? maximum : BigInt(filename[1]!);
    if (!/\.md$/i.test(entry.name) || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    let bytes: Buffer;
    try { bytes = (await source(await canonicalPath(join(directory, entry.name)))).bytes; }
    catch (error) {
      // Nonregular and disappeared entries cannot be plan documents. Their numbered
      // filenames remain reserved above; never block by reading a FIFO or device.
      if (error instanceof Error && ["v3_missing_file", "v3_not_regular_file", "v3_path_changed"].includes(error.message)) continue;
      throw error;
    }
    // Identity reservation is deliberately format-agnostic; it never rewrites or loads a legacy runtime.
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(bytes.toString("utf8"));
    if (!frontmatter) continue;
    for (const match of frontmatter[1]!.matchAll(/^\s*["']?plan_id["']?\s*:\s*["']?P(\d+)["']?(?:\s*(?:#.*)?)$/gm)) {
      const identity = BigInt(match[1]!);
      if (identity > maximum) maximum = identity;
    }
    // YAML spelling is not identity: quotes, escapes, flow mappings and folded scalars
    // must reserve the same number as their ordinary block-mapping representation.
    const metadata = parseDocument(frontmatter[1]!, { strict: true, uniqueKeys: true, schema: "failsafe" });
    if (isMap(metadata.contents)) {
      for (const pair of metadata.contents.items) {
        if (!isScalar(pair.key) || pair.key.value !== "plan_id") continue;
        const value = isAlias(pair.value) ? pair.value.resolve(metadata) : pair.value;
        if (!isScalar(value) || typeof value.value !== "string") continue;
        const match = /^P(\d+)$/.exec(value.value.trim());
        if (match && BigInt(match[1]!) > maximum) maximum = BigInt(match[1]!);
      }
    }
  }
  return maximum + 1n;
}

function slug(title: string): string {
  return Array.from(title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-")).slice(0, 72).join("").replace(/^-+|-+$/g, "") || "plan";
}

/** Create a flat numbered plan without overwriting a document or reusing a legacy identity. */
export async function createReadablePlan(root: string, plan: ReadablePlan): Promise<ReadablePlanSnapshot> {
  // A caller's provisional identity is replaced. Other unknown or invalid candidate fields still fail before mkdir.
  const validated = parseReadablePlan(renderReadablePlan({ ...plan, plan_id: "P001" }));
  const canonicalRoot = await canonicalPath(root);
  const requestedDirectory = join(canonicalRoot, "plans");
  await mkdir(requestedDirectory, { recursive: true });
  const directory = await realpath(requestedDirectory);
  const lock = await acquireLock(join(directory, ".pi-plan-v3-create.lock"));
  let temporary: string | undefined;
  let published = false;
  try {
    // link is exclusive even if a noncooperating creator wins the filename after our scan.
    for (let attempt = 0; attempt < 100; attempt++) {
      const sequence = (await nextSequence(directory)).toString().padStart(3, "0");
      const filename = `${sequence}-${slug(validated.title)}.md`;
      const path = join(directory, filename);
      const text = renderReadablePlan({ ...validated, plan_id: `P${sequence}` });
      temporary = join(directory, `.${filename}.v3-${randomUUID()}.tmp`);
      await prepareFile(temporary, text, 0o600);
      await assertLock(lock);
      if (await realpath(requestedDirectory) !== directory) throw new Error("v3_path_changed");
      try { await link(temporary, path); }
      catch (error) {
        if (code(error) !== "EEXIST") throw error;
        await rm(temporary, { force: true }); temporary = undefined;
        continue;
      }
      published = true;
      await rm(temporary); temporary = undefined;
      await syncDirectory(directory);
      return snapshot(path, Buffer.from(text, "utf8"));
    }
    throw new Error("v3_create_collision: filename remained busy after 100 attempts");
  } catch (error) {
    if (published) throw new Error(`v3_write_uncertain: file created but durability could not be confirmed: ${String(error)}`);
    throw error;
  } finally {
    try { if (temporary) await rm(temporary, { force: true }); }
    finally { await releaseLock(lock); }
  }
}
