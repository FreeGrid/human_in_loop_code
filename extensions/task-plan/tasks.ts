import type { TaskBlock } from "./types.ts";

const TASK_HEADER = /^### (T\d{3}) — (.+?) \[( |x|X)\]$/gm;
const REQUIRED_FIELDS = ["Round", "Outcome", "Why", "Inputs", "Work", "Outputs", "Acceptance", "Depends On"];

export function parseTasks(markdown: string): TaskBlock[] {
  const headers = [...markdown.matchAll(TASK_HEADER)];
  return headers.map((match, index) => {
    const start = match.index!;
    const end = index + 1 < headers.length ? headers[index + 1]!.index! : markdown.length;
    const definition = markdown.slice(start, end).trimEnd();
    const roundMatch = definition.match(/^#### Round\s*\n\s*R(\d{3}) — T\+0\s*$/m);
    const completed = match[3] === "x" || match[3] === "X";
    const acceptanceMatch = definition.match(/^#### Acceptance\s*\n([\s\S]*?)(?=^#### |$)/m);
    const acceptanceItems = [...(acceptanceMatch?.[1] ?? "").matchAll(/^- \[(?: |x|X)\]\s+(.+)$/gm)].map((m) => m[1]!.trim());
    const dependsMatch = definition.match(/^#### Depends On\s*\n([\s\S]*?)(?=^#### |$)/m);
    const dependsText = (dependsMatch?.[1] ?? "").trim();
    const dependsOn = dependsText === "None." || dependsText === "None" ? [] : [...dependsText.matchAll(/\bT\d{3}\b/g)].map((m) => m[0]);
    return {
      id: match[1]!,
      title: match[2]!.trim(),
      round: roundMatch ? Number(roundMatch[1]) : -1,
      completed,
      completionLine: match[0]!,
      acceptanceItems,
      dependsOn,
      definition,
    };
  });
}

export function currentRoundTasks(markdown: string, round: number): TaskBlock[] {
  return parseTasks(markdown).filter((task) => task.round === round);
}

export function taskRequiredFields(): readonly string[] {
  return REQUIRED_FIELDS;
}

export function taskDefinitionWithoutCheckboxState(task: TaskBlock): string {
  return task.definition.replace(/^(### T\d{3} — .+?) \[(?: |x|X)\]$/m, "$1 [#]").replace(/- \[(?: |x|X)\]/g, "- [#]");
}
