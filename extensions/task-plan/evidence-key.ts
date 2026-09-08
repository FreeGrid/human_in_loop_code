import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createReceiptSigner, protectReceiptSignerPath, type ReceiptSigner } from "./evidence.ts";

/** Explicit Controller-only keystore. The host must deny Agent access to this directory. */
async function keyPath(path: string): Promise<string> {
  if (!isAbsolute(path) || path !== resolve(path)) throw new Error("receipt_key_requires_canonical_absolute_path");
  const parent = dirname(path);
  if (await realpath(parent) !== parent) throw new Error("receipt_key_symlink_parent");
  const info = await lstat(parent);
  if (!info.isDirectory() || (info.mode & 0o022) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("receipt_key_unsafe_directory");
  return path;
}
/** Load-only: losing a key must block recovery, never silently create a replacement authority. */
export async function loadReceiptSigner(path: string): Promise<ReceiptSigner> {
  const file = await keyPath(path);
  const handle = await open(file,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size !== 32 || (process.getuid && info.uid !== process.getuid())) throw new Error("receipt_key_unsafe_file");
    const bytes = await handle.readFile();
    const current = await lstat(file);
    if (current.ino !== info.ino || current.dev !== info.dev || bytes.length !== 32) throw new Error("receipt_key_changed");
    try { const signer=createReceiptSigner(bytes);protectReceiptSignerPath(signer,file);return signer; } finally { bytes.fill(0); }
  } finally { await handle.close(); }
}
/** Explicit provisioning only; exclusive creation prevents accidental signer rotation. */
export async function initializeReceiptSigner(path: string): Promise<ReceiptSigner> {
  const file = await keyPath(path);
  const bytes = randomBytes(32);
  const handle = await open(file,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { bytes.fill(0); await handle.close(); }
  return loadReceiptSigner(file);
}
