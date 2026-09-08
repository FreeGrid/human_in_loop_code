export interface ExecutionNote {
  version: 1;
  status: "in_progress" | "blocked" | "pending_finalize";
  summary: string;
  files: string[];
  change_types: Array<"api" | "cli" | "config" | "extension" | "code" | "docs" | "test" | "other">;
}

const PREFIX = "<!-- pi-plan:execution:";
const WORK = /^[ \t]*- .+ \[(?: |x|X)\][ \t]*$/;
const TYPES = new Set(["api", "cli", "config", "extension", "code", "docs", "test", "other"]);

/** Notes are bounded data, never task definitions, readiness state or acceptance evidence. */
export function validateExecutionNote(value: unknown): value is ExecutionNote {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const note = value as Record<string, unknown>;
  if (Object.keys(note).sort().join(",") !== "change_types,files,status,summary,version") return false;
  if (note.version !== 1 || typeof note.status !== "string" || !["in_progress", "blocked", "pending_finalize"].includes(note.status)) return false;
  if (typeof note.summary !== "string" || !note.summary.trim() || note.summary.length > 2000) return false;
  if (!Array.isArray(note.files) || note.files.length > 32 || !note.files.every((path) => typeof path === "string" && path.length > 0 && path.length <= 300 && !/[\x00-\x1f]/.test(path))) return false;
  if (!Array.isArray(note.change_types) || note.change_types.length > TYPES.size || !note.change_types.every((type) => typeof type === "string" && TYPES.has(type))) return false;
  return serializeNote(note).length <= 16000;
}

function serializeNote(note: unknown): string {
  return JSON.stringify(note).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * Exclude only exact, valid three-line records immediately after their work-item line.
 * Malformed/misplaced regions remain in definition content AND produce validation errors.
 * Removing a valid record restores all original whitespace, including trailing newlines.
 */
export function inspectExecutionNotes(markdown: string): { definition: string; notes: Record<string, ExecutionNote>; errors: string[] } {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  const notes: Record<string, ExecutionNote> = {};
  const errors: string[] = [];
  let phase = "";
  let inWork = false;
  let ordinal = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Only ASCII space/tab are structural whitespace. Reject Unicode/control line
    // boundaries instead of letting trim(), regex /m and item placement disagree.
    if (/^[ \t]*[^\S \t]|[^\S \t][ \t]*$/u.test(line) || /[\r\u2028\u2029]/u.test(line)) {
      errors.push(`Unsupported structural whitespace at line ${i + 1}`);
    }
    const header = line.match(/^### (T\d{3}) — .+ \[(?: |x|X)\]$/);
    if (header) { phase = header[1]!; inWork = false; ordinal = 0; }
    else if (/^#{1,4} /.test(line)) inWork = Boolean(phase) && line.trimEnd() === "#### Tasks";
    if (inWork && WORK.test(line)) ordinal++;
    if (line.includes(PREFIX)) {
      const id = `${phase}.W${String(ordinal).padStart(3, "0")}`;
      let parsed: unknown;
      try { parsed = JSON.parse(lines[i + 1] ?? ""); } catch { /* Invalid data stays in the hash. */ }
      const valid = inWork && WORK.test(lines[i - 1] ?? "") && !notes[id]
        && line === `${PREFIX}${id}:start -->`
        && lines[i + 2] === `${PREFIX}${id}:end -->`
        && (lines[i + 1]?.length ?? 0) <= 16000 && validateExecutionNote(parsed)
        && lines[i + 1] === serializeNote(parsed);
      if (valid) { notes[id] = parsed as ExecutionNote; i += 2; continue; }
      errors.push(`Invalid or misplaced execution note at line ${i + 1}`);
    }
    kept.push(line);
  }
  return { definition: kept.join("\n"), notes, errors };
}

/** Latest per-item note only; history belongs in Git, not an unbounded parallel log. */
export function upsertExecutionNote(markdown: string, itemId: string, note: ExecutionNote): string {
  if (!validateExecutionNote(note)) throw new Error("Invalid execution note");
  const inspected = inspectExecutionNotes(markdown);
  if (inspected.errors.length) throw new Error(inspected.errors.join("; "));
  const notes = { ...inspected.notes, [itemId]: note };
  const lines = inspected.definition.split("\n");
  const output: string[] = [];
  let phase = "";
  let inWork = false;
  let ordinal = 0;
  let found = false;
  for (const line of lines) {
    const header = line.match(/^### (T\d{3}) — .+ \[(?: |x|X)\]$/);
    if (header) { phase = header[1]!; inWork = false; ordinal = 0; }
    else if (/^#{1,4} /.test(line)) inWork = Boolean(phase) && line.trimEnd() === "#### Tasks";
    output.push(line);
    if (inWork && WORK.test(line)) {
      const id = `${phase}.W${String(++ordinal).padStart(3, "0")}`;
      if (id === itemId) found = true;
      if (notes[id]) {
        // Escape markup delimiters so data cannot create Markdown headings or Harness regions.
        const data = serializeNote(notes[id]);
        output.push(`${PREFIX}${id}:start -->`, data, `${PREFIX}${id}:end -->`);
      }
    }
  }
  if (!found) throw new Error(`Unknown work item: ${itemId}`);
  return output.join("\n");
}
