import type { TaskBlock, TaskChecklistItem } from "./types.ts";
import { inspectExecutionNotes } from "./execution-notes.ts";

const TASK_HEADER = /^### (T\d{3}) — (.+?) \[( |x|X)\]$/gm;
const REQUIRED_FIELDS = ["Tasks", "Acceptance", "Depends On"];

export function parseTasks(markdown: string): TaskBlock[] {
  const headers = [...markdown.matchAll(TASK_HEADER)];
  return headers.map((match, index) => {
    const start = match.index!;
    const end = index + 1 < headers.length ? headers[index + 1]!.index! : markdown.length;
    const definition = markdown.slice(start, end).trimEnd();
    const roundMatch = definition.match(/^#### Round\s*\n\s*R(\d{3}) — T\+0\s*$/m);
    const hiddenRoundMatch = definition.match(/^<!-- pi-plan:round:R(\d{3}) -->$/m);
    const completed = match[3] === "x" || match[3] === "X";
    const execution = inspectExecutionNotes(definition);
    const workItems = parseChecklist(taskField(execution.definition, "Tasks"), match[1]!, "W");
    for (const item of workItems) if (execution.notes[item.id]) item.note = execution.notes[item.id];
    const acceptance = parseChecklist(taskField(execution.definition, "Acceptance"), match[1]!, "A");
    const acceptanceItems = acceptance.map((item) => item.text);
    const dependsText = taskField(definition, "Depends On").trim();
    const dependsOn = dependsText === "None." || dependsText === "None" ? [] : [...dependsText.matchAll(/\bT\d{3}\b/g)].map((m) => m[0]);
    return {
      id: match[1]!,
      title: match[2]!.trim(),
      round: hiddenRoundMatch ? Number(hiddenRoundMatch[1]) : roundMatch ? Number(roundMatch[1]) : 0,
      completed,
      completionLine: match[0]!,
      workItems,
      acceptance,
      acceptanceItems,
      dependsOn,
      definition,
    };
  });
}

/** Extract through the next heading, not the first end-of-line under /m. */
export function taskField(definition: string, field: string): string {
  const lines = definition.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === `#### ${field}`);
  if (start < 0) return "";
  const next = lines.findIndex((line, index) => index > start && /^#{1,4} /.test(line));
  return lines.slice(start + 1, next < 0 ? undefined : next).join("\n");
}

function parseChecklist(content: string, taskId: string, kind: "W" | "A"): TaskChecklistItem[] {
  const items: TaskChecklistItem[] = [];
  let current: TaskChecklistItem | undefined;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    const match = kind === "W" ? line.match(/^[ \t]*- (.+?) \[( |x|X)\]$/) : line.match(/^[ \t]*- \[( |x|X)\] (.+)$/);
    if (match) {
      const marker = match[kind === "W" ? 2 : 1];
      current = { id: `${taskId}.${kind}${String(items.length + 1).padStart(3, "0")}`, text: match[kind === "W" ? 1 : 2]!.trim(), completed: marker !== " " };
      items.push(current);
    } else if (/^\s*- /.test(line)) {
      current = undefined; // Invalid bullets are diagnosed by validation, never absorbed as evidence.
    } else if (current && line.trim()) {
      current.text += `\n${line.trim()}`;
    }
  }
  return items;
}

export function currentRoundTasks(markdown: string, round: number): TaskBlock[] {
  return parseTasks(markdown).filter((task) => task.round === round);
}

export function taskRequiredFields(): readonly string[] {
  return REQUIRED_FIELDS;
}

export function canonicalTaskDefinition(content: string): string {
  return inspectExecutionNotes(content).definition
    .replace(/^(### T\d{3} — .+?) \[(?: |x|X)\]$/gm, "$1 [#]")
    .replace(/^([ \t]*- )\[(?: |x|X)\]/gm, "$1[#]")
    .replace(/^([ \t]*- .+?) \[(?: |x|X)\]([ \t]*)$/gm, "$1 [#]$2");
}

export function taskDefinitionWithoutCheckboxState(task: TaskBlock): string {
  return canonicalTaskDefinition(task.definition);
}
