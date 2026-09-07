import { parseTasks, taskField } from "./tasks.ts";
import type { TaskBlock, ValidationIssue } from "./types.ts";
import { sha256 } from "./plan-file.ts";

export interface PlanNodeOutline { id: string; title: string; definition: string; }
export interface PlanNode { id: string; title: string; outline?: PlanNodeOutline; executable?: TaskBlock; }
export interface NodeMappingOptions { currentNodeId?: string; }
export type NodeDocumentFormat = "v1-projections" | "v2-canonical";

export interface CanonicalPlanNode {
  id: string;
  title: string;
  outcome: string;
  work: string;
  acceptance: string;
  dependsOn: string;
  progress: string;
  definition: string;
}

export function canonicalNodeOutlineHash(node: CanonicalPlanNode): string {
  return sha256(JSON.stringify([node.id, node.title, node.outcome, node.work, node.dependsOn]));
}

export function canonicalNodeContractHash(node: CanonicalPlanNode): string {
  return sha256(JSON.stringify([node.id, node.title, node.outcome, node.work, node.acceptance, node.dependsOn]));
}

export function detectNodeDocumentFormat(markdown: string): NodeDocumentFormat {
  return /^### T\d{3} — .+$/m.test(markdown) && /^#### (Outcome|Work|Acceptance|Depends On|Progress)\s*$/m.test(markdown)
    ? "v2-canonical" : "v1-projections";
}

/** Parse the compact V2 node grammar without interpreting execution state. */
export function parseCanonicalNodes(markdown: string): CanonicalPlanNode[] {
  const headers = [...markdown.matchAll(/^### (T\d{3}) — (.+?)\s*$/gm)];
  return headers.map((match, index) => {
    const start = match.index!;
    const end = index + 1 < headers.length ? headers[index + 1]!.index! : markdown.length;
    const definition = markdown.slice(start, end).trimEnd();
    return {
      id: match[1]!, title: match[2]!.trim(),
      outcome: nodeField(definition, "Outcome"), work: nodeField(definition, "Work"),
      acceptance: nodeField(definition, "Acceptance"), dependsOn: nodeField(definition, "Depends On"),
      progress: nodeField(definition, "Progress"), definition,
    };
  });
}

/** Read the V1 two-section representation as one logical node view. */
export function readPlanNodes(planMarkdown: string, tasksMarkdown: string): PlanNode[] {
  const outlines = parsePlanOutlineEntries(planMarkdown);
  const tasks = parseTasks(tasksMarkdown);
  const outlineById = new Map(outlines.map((outline) => [outline.id, outline]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const ids = new Set([...outlines.map((outline) => outline.id), ...tasks.map((task) => task.id)]);
  return [...ids].sort(compareNodeIds).map((id) => {
    const outline = outlineById.get(id); const executable = taskById.get(id);
    return { id, title: executable?.title ?? outline?.title ?? id, outline, executable };
  });
}

/** Detect drift between the two V1 projections before a V2 migration. */
export function validatePlanNodeMapping(planMarkdown: string, tasksMarkdown: string, options: NodeMappingOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const outlines = parsePlanOutlineEntries(planMarkdown); const tasks = parseTasks(tasksMarkdown);
  const outlineIds = new Set<string>(); const taskIds = new Set<string>();
  for (const outline of outlines) {
    if (outlineIds.has(outline.id)) issues.push(issue("duplicate_plan_node", `${outline.id} appears more than once in Plan`));
    outlineIds.add(outline.id);
  }
  for (const task of tasks) {
    if (taskIds.has(task.id)) issues.push(issue("duplicate_tasks_node", `${task.id} appears more than once in Tasks`));
    taskIds.add(task.id);
  }
  const outlineById = new Map(outlines.map((outline) => [outline.id, outline]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  for (const [id, outline] of outlineById) {
    const task = taskById.get(id);
    if (!task) {
      const severity = options.currentNodeId === id ? "error" : "warning";
      issues.push({ severity, code: "plan_node_missing_tasks", message: `${id} exists in Plan but has no Tasks projection` });
    } else if (normalizeTitle(outline.title) !== normalizeTitle(task.title)) {
      issues.push(issue("plan_node_title_drift", `${id} title differs between Plan and Tasks`));
    }
  }
  for (const task of tasks) if (!outlineById.has(task.id)) issues.push(issue("tasks_node_missing_plan", `${task.id} exists in Tasks but has no Plan outline`));
  return issues;
}

export function migrateV1Nodes(planMarkdown: string, tasksMarkdown: string): CanonicalPlanNode[] {
  const outlines = parsePlanOutlineEntries(planMarkdown);
  const tasks = parseTasks(tasksMarkdown);
  const issues = validatePlanNodeMapping(planMarkdown, tasksMarkdown).filter((item) => item.severity === "error");
  if (issues.length) throw new Error(issues.map((item) => item.message).join("; "));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  return outlines.map((outline) => {
    const task = taskById.get(outline.id);
    return {
      id: outline.id,
      title: outline.title,
      outcome: nodeField(outline.definition, "Outcome"),
      work: task ? taskField(task.definition, "Tasks") : nodeField(outline.definition, "Work Areas"),
      acceptance: task ? taskField(task.definition, "Acceptance") : "",
      dependsOn: task ? taskField(task.definition, "Depends On") : "",
      progress: task ? (task.completed ? "completed" : "open") : "outline",
      definition: outline.definition,
    };
  });
}

export function parsePlanOutlines(markdown: string): Map<string, PlanNodeOutline> {
  return new Map(parsePlanOutlineEntries(markdown).map((outline) => [outline.id, outline]));
}

export function parsePlanOutlineEntries(markdown: string): PlanNodeOutline[] {
  const headers = [...markdown.matchAll(/^### (T\d{3}) — (.+?)\s*$/gm)];
  return headers.map((match, index) => {
    const start = match.index!; const end = index + 1 < headers.length ? headers[index + 1]!.index! : markdown.length;
    return { id: match[1]!, title: match[2]!.trim(), definition: markdown.slice(start, end).trimEnd() };
  });
}

function nodeField(definition: string, field: string): string {
  const lines = definition.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === `#### ${field}`);
  if (start < 0) return "";
  const next = lines.findIndex((line, index) => index > start && /^#{1,4} /.test(line));
  return lines.slice(start + 1, next < 0 ? undefined : next).join("\n").trim();
}

function issue(code: string, message: string): ValidationIssue { return { severity: "error", code, message }; }
function normalizeTitle(title: string): string { return title.replace(/\s+/g, " ").trim().toLowerCase(); }
function compareNodeIds(a: string, b: string): number { return Number(a.slice(1)) - Number(b.slice(1)); }
