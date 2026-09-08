#!/usr/bin/env node
import { inspectDocumentationImpact } from "./delivery-impact.ts";

// Optional host-neutral entry: JSON on stdin, bounded response on stdout. No persistent state.
try {
  if (process.argv.length > 2) throw new Error("Pipe one delivery-check JSON request to stdin; no command arguments are accepted");
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 65536) throw new Error("Request exceeds 64 KiB");
    chunks.push(chunk);
  }
  const result = await inspectDocumentationImpact(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  process.stdout.write(JSON.stringify({ advisory: true, ...result }) + "\n");
} catch (error) {
  process.stderr.write(`Documentation check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
