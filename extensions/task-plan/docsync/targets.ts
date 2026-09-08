import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, win32 } from "node:path";
import type { DocumentRead, DocumentTarget } from "./contracts.ts";

export function validateRelativePath(path: string): void {
  if (typeof path !== "string" || !path.length || path.length > 4096 || isAbsolute(path) || win32.isAbsolute(path) || /^[A-Za-z]:/.test(path) || /[\\\x00-\x1f\x7f:]/.test(path)) throw new Error("Unsafe relative path");
  if (path.split("/").some(p => !p || p === "." || p === ".." || /^\.git[ .]*$/i.test(p))) throw new Error("Unsafe path component");
}
export function validateSectionId(id: string): void {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) throw new Error("Invalid section ID");
}
export function targetPath(target: DocumentTarget): string { return typeof target === "string" ? target : target.path; }
export function targetKey(target: DocumentTarget): string {
  validateRelativePath(targetPath(target));
  if (typeof target !== "string") validateSectionId(target.section_id);
  return JSON.stringify(typeof target === "string" ? [target] : [target.path, target.section_id]);
}
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
/** Reject every symlink ancestor. Leaf links are permitted only for Git link facts, never document reads. */
export async function resolveContainedPath(root: string, path: string, options: { allowMissing?: boolean; allowLeafSymlink?: boolean } = {}): Promise<string> {
  validateRelativePath(path);
  const canonical = await realpath(root);
  if (!(await lstat(canonical)).isDirectory()) throw new Error("Root is not a directory");
  const parts = path.split("/");
  let current = canonical;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if (absent(error) && options.allowMissing) return join(canonical, ...parts);
      throw error;
    }
    if (stat.isSymbolicLink()) {
      if (i === parts.length - 1 && options.allowLeafSymlink) return current;
      throw new Error(`Symlink path rejected: ${path}`);
    }
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Non-directory ancestor: ${path}`);
    if (await realpath(current) !== current) throw new Error(`Path changed during resolution: ${path}`);
  }
  return current;
}
const hash = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const stamp = (s: import("node:fs").BigIntStats) => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(":");
/** Best-effort race detection, not an OS sandbox/transaction. Reads twice; identity and bytes must remain stable. */
export async function readContainedBytes(root: string, path: string): Promise<Buffer | null> {
  const canonical = await realpath(root);
  const resolved = await resolveContainedPath(canonical, path, { allowMissing: true });
  let before;
  try { before = await lstat(resolved, { bigint: true }); } catch (error) {
    if (!absent(error)) throw error;
    await resolveContainedPath(canonical, path, { allowMissing: true });
    try { await lstat(resolved); } catch (again) { if (absent(again)) return null; throw again; }
    throw new Error(`Document appeared during read: ${path}`);
  }
  if (!before.isFile() || before.size > 32n * 1024n * 1024n) throw new Error(`Not a regular or supported-size file: ${path}`);
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (stamp(before) !== stamp(await handle.stat({ bigint: true }))) throw new Error(`File replaced during open: ${path}`);
    // Bound allocation and reading even if a file grows after the pre-open stat.
    const first = Buffer.alloc(Number(before.size) + 1);
    let firstCount = 0;
    while (firstCount < first.length) {
      const result = await handle.read(first, firstCount, first.length - firstCount, firstCount);
      if (!result.bytesRead) break;
      firstCount += result.bytesRead;
    }
    if (firstCount !== Number(before.size)) throw new Error(`File size changed during read: ${path}`);
    const bytes = first.subarray(0, firstCount);
    // Positional reread avoids relying on mtime/size as content proof.
    const second = Buffer.alloc(bytes.length + 1);
    let count = 0;
    while (count < second.length) {
      const result = await handle.read(second, count, second.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count !== bytes.length || !bytes.equals(second.subarray(0, count))) throw new Error(`Content changed during read: ${path}`);
    if (stamp(before) !== stamp(await handle.stat({ bigint: true }))) throw new Error(`File changed during read: ${path}`);
    if (await resolveContainedPath(canonical, path) !== resolved || stamp(before) !== stamp(await lstat(resolved, { bigint: true }))) throw new Error(`Path changed during read: ${path}`);
    return bytes;
  } finally { await handle.close(); }
}
/** File identities hash raw bytes (binary supported). Section identities normalize CRLF to LF,
 * then hash exactly the bytes between the explicit markers, excluding the markers themselves.
 * This allows Git HEAD LF and worktree CRLF section proofs to agree; file_version is always raw. */
export function documentIdentity(bytes: Buffer | null, target: DocumentTarget): DocumentRead {
  targetKey(target);
  const file_version = bytes === null ? "missing" : hash(bytes);
  if (typeof target === "string") return { file_version, identity: bytes === null ? null : hash(bytes) };
  const fail = (error: string): DocumentRead => ({ file_version, identity: null, error });
  if (bytes === null) return fail("Section document is missing");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n"); } catch { return fail("Section document is not UTF-8"); }
  const markers = /<!--\s*docsync:section:([\s\S]*?)-->/g;
  const seen = new Set<string>();
  let active: { id: string; offset: number } | undefined;
  let region: string | undefined;
  for (const match of text.matchAll(markers)) {
    const exact = /^<!-- docsync:section:([A-Za-z0-9][A-Za-z0-9_.-]{0,127}):(start|end) -->$/.exec(match[0]);
    if (!exact) return fail("Malformed section marker");
    const [, id, direction] = exact;
    try { validateSectionId(id); } catch { return fail("Invalid section marker ID"); }
    if (direction === "start") {
      if (active || seen.has(id)) return fail("Duplicate or nested section markers");
      seen.add(id); active = { id, offset: match.index! + match[0].length };
    } else {
      if (!active || active.id !== id) return fail("Crossed or unmatched section markers");
      if (id === target.section_id) region = text.slice(active.offset, match.index);
      active = undefined;
    }
  }
  if (active || region === undefined) return fail("Missing section boundary");
  // An unterminated marker must not disappear from parsing.
  if (text.replace(markers, "").includes("docsync:section:")) return fail("Malformed section marker");
  return { file_version, identity: hash(Buffer.from(region, "utf8")) };
}
export async function readDocument(root: string, target: DocumentTarget): Promise<DocumentRead> {
  targetKey(target);
  return documentIdentity(await readContainedBytes(root, targetPath(target)), target);
}
