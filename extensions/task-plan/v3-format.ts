import { isMap, isScalar, parseDocument } from "yaml";

export interface ReadableSubtask { text: string; completed: boolean }
export interface ReadableTask { id: string; text: string; completed: boolean; subtasks: ReadableSubtask[] }
export interface ReadablePlan { format: "pi-plan/v3"; plan_id: string; title: string; brief: string; tasks: ReadableTask[] }

function invalid(reason: string): never { throw new Error(`v3_invalid_plan: ${reason}`); }

function withoutInlineCode(line: string): string {
  let visible = "";
  for (let index = 0; index < line.length;) {
    if (line[index] === "\\" && index + 1 < line.length) {
      visible += line.slice(index, index + 2); index += 2;
      continue;
    }
    if (line[index] !== "`") { visible += line[index++]!; continue; }
    let end = index;
    while (line[end] === "`") end++;
    const width = end - index;
    let closing = end;
    while (closing < line.length) {
      if (line[closing] !== "`") { closing++; continue; }
      let next = closing;
      while (line[next] === "`") next++;
      if (next - closing === width) break;
      closing = next;
    }
    if (closing === line.length) { visible += line.slice(index); break; } // An unmatched backtick is visible prose.
    visible += " "; index = closing + width;
  }
  return visible;
}

function cleanText(value: unknown, label: string, multiline = false): string {
  if (typeof value !== "string") invalid(`${label} must be text`);
  // Strings can contain unpaired UTF-16 surrogates even though files cannot contain them in UTF-8.
  if (Buffer.from(value, "utf8").toString("utf8") !== value) invalid(`${label} contains invalid Unicode`);
  const text = value.replace(/\r\n/g, "\n");
  if (/[\u0000-\u0009\u000b-\u001f\u007f\u200b\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(text)) invalid(`${label} contains hidden or control characters`);
  if (!multiline && text.includes("\n")) invalid(`${label} must occupy one line`);
  if (/<(?:[!/?]|[A-Za-z][A-Za-z0-9:-]*(?:\s|>|\/))/u.test(text.split("\n").map(withoutInlineCode).join("\n"))) invalid(`${label} contains HTML or hidden markup`);
  if (!text.trim()) invalid(`${label} must not be empty`);
  return multiline ? text.replace(/^\n+|\n+$/g, "") : text.trim();
}

function plainLine(line: string, label: string): void {
  // The brief is prose, not a second document, section tree, payload, or Markdown block.
  if (/^\s*(?:#{1,6}(?:\s|$)|[-+*]\s|\d+[.)]\s|>|`{3,}|~{3,}|\||\[[^\]]+\]:|(?:[-=_*]\s*){3,}$)/u.test(line)
      || /^(?: {2,}|\t)\S/u.test(line)
      || /^\s*(?:\{\s*"|\[\s*\{)/u.test(line)) invalid(`${label} must contain prose only`);
}

function exactObject(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must be a plain object`);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== "string" || !keys.includes(key))) invalid(`${label} has missing or unknown keys`);
}

/** Validate and copy the visible domain without discarding recorded work. */
function normalizePlan(value: unknown): ReadablePlan {
  exactObject(value, ["format", "plan_id", "title", "brief", "tasks"], "plan");
  if (value.format !== "pi-plan/v3") throw new Error("v3_unsupported_format: expected pi-plan/v3");
  if (typeof value.plan_id !== "string" || !/^P\d{3,}$/.test(value.plan_id)) invalid("plan_id must be P followed by at least three digits");
  const title = cleanText(value.title, "title");
  if (/^#|\s#+$/.test(title)) invalid("title contains another heading marker");
  const brief = cleanText(value.brief, "brief", true);
  brief.split("\n").forEach(line => { if (line.trim()) plainLine(line, "brief"); });
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) invalid("at least one task is required");
  const ids = new Set<string>();
  const tasks = value.tasks.map((task, index): ReadableTask => {
    exactObject(task, ["id", "text", "completed", "subtasks"], `task ${index + 1}`);
    if (typeof task.id !== "string" || !/^T\d{3,}$/.test(task.id) || /^T0+$/.test(task.id)) invalid("task IDs must use T001-style positive IDs");
    if (ids.has(task.id)) invalid(`duplicate task ID ${task.id}`);
    ids.add(task.id);
    const text = cleanText(task.text, `${task.id} text`);
    plainLine(text, `${task.id} text`);
    if (typeof task.completed !== "boolean") invalid(`${task.id} completed must be boolean`);
    if (!Array.isArray(task.subtasks)) invalid(`${task.id} subtasks must be an array`);
    const subtasks = task.subtasks.map((child, childIndex): ReadableSubtask => {
      exactObject(child, ["text", "completed"], `${task.id} child ${childIndex + 1}`);
      const text = cleanText(child.text, `${task.id} child text`);
      plainLine(text, `${task.id} child text`);
      if (typeof child.completed !== "boolean") invalid(`${task.id} child completed must be boolean`);
      return { text, completed: child.completed };
    });
    // A file may retain detail from completed or previously selected tasks.
    // Current-only authoring is enforced by mutations, not by deleting read data.
    return { id: task.id, text, completed: task.completed, subtasks };
  });
  return { format: "pi-plan/v3", plan_id: value.plan_id, title, brief, tasks };
}

function metadata(source: string): { format: "pi-plan/v3"; plan_id: string } {
  const doc = parseDocument(source, { strict: true, uniqueKeys: true, schema: "failsafe" });
  if (doc.errors.length || doc.warnings.length || !isMap(doc.contents) || doc.contents.items.length !== 2) invalid("frontmatter must contain exactly format and plan_id");
  const result: Record<string, string> = {};
  for (const pair of doc.contents.items) {
    if (!isScalar(pair.key) || !isScalar(pair.value) || pair.key.tag || pair.key.anchor || pair.value.tag || pair.value.anchor
        || typeof pair.key.value !== "string" || typeof pair.value.value !== "string"
        || !["format", "plan_id"].includes(pair.key.value)) invalid("invalid frontmatter key or value");
    result[pair.key.value] = pair.value.value;
  }
  if (result.format !== "pi-plan/v3") throw new Error("v3_unsupported_format: expected pi-plan/v3");
  if (!/^P\d{3,}$/.test(result.plan_id ?? "")) invalid("invalid plan_id");
  return { format: "pi-plan/v3", plan_id: result.plan_id! };
}

/** Parse the complete V3 file without consulting authority, receipts, or any runtime. */
export function parseReadablePlan(text: string): ReadablePlan {
  if (typeof text !== "string") invalid("document must be text");
  const normalized = cleanText(text, "document", true);
  // Do not silently accept a prefix before the frontmatter (including whitespace or BOM).
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) invalid("document must begin with frontmatter");
  const lines = normalized.split("\n");
  const end = lines.indexOf("---", 1);
  if (end < 0) invalid("frontmatter is not closed");
  const meta = metadata(lines.slice(1, end).join("\n"));
  let cursor = end + 1;
  while (lines[cursor] === "") cursor++;
  const titleMatch = /^# (\S.*)$/.exec(lines[cursor] ?? "");
  if (!titleMatch) invalid("one H1 title is required after frontmatter");
  cursor++;
  const brief: string[] = [];
  while (cursor < lines.length && !/^- \[[ xX]\] /.test(lines[cursor]!)) brief.push(lines[cursor++]!);
  const tasks: ReadableTask[] = [];
  for (; cursor < lines.length; cursor++) {
    const line = lines[cursor]!;
    if (!line.trim()) continue;
    const root = /^- \[([ xX])\] (T\d{3,}) (\S.*)$/.exec(line);
    if (root) {
      tasks.push({ id: root[2]!, text: root[3]!, completed: root[1]!.toLowerCase() === "x", subtasks: [] });
      continue;
    }
    const child = /^  - \[([ xX])\] (\S.*)$/.exec(line);
    if (child && tasks.length) {
      tasks[tasks.length - 1]!.subtasks.push({ text: child[2]!, completed: child[1]!.toLowerCase() === "x" });
      continue;
    }
    invalid(`unsupported task structure at line ${cursor + 1}`);
  }
  return normalizePlan({ ...meta, title: titleMatch[1], brief: brief.join("\n"), tasks });
}

/** Produce the single canonical visible representation with all recorded children. */
export function renderReadablePlan(plan: ReadablePlan): string {
  const value = normalizePlan(plan);
  const tasks = value.tasks.flatMap(task => [
    `- [${task.completed ? "x" : " "}] ${task.id} ${task.text}`,
    ...task.subtasks.map(child => `  - [${child.completed ? "x" : " "}] ${child.text}`),
  ]);
  return `---\nformat: pi-plan/v3\nplan_id: ${value.plan_id}\n---\n\n# ${value.title}\n\n${value.brief}\n\n${tasks.join("\n")}\n`;
}

/** File order, not the numeric ID, determines the current task. */
export function currentReadableTask(plan: ReadablePlan): ReadableTask | undefined {
  normalizePlan(plan);
  return plan.tasks.find(task => !task.completed);
}
