import { parseArtifact } from "./frontmatter.js";
import {
  parseDependencies,
  parseTasks,
  scanHeadings,
  sectionContent,
  stripFencedCode,
  type MarkdownHeading,
} from "./task-parser.js";
import type { PlanningStage, ValidationIssue, ValidationResult } from "./types.js";

export interface ValidationOptions {
  forApproval?: boolean;
}

const SPEC_HEADINGS = [
  "# What",
  "## Goal",
  "## Desired Outcome",
  "## Scope",
  "### In",
  "### Out",
  "## Constraints",
  "# Why",
  "## Motivation",
  "## Problem",
  "## Success",
  "## Non-Goals",
  "## Open Questions",
];

const PLAN_HEADINGS = [
  "# Approach",
  "## Strategy",
  "## Planning Horizon",
  "### Current",
  "#### Outcome",
  "#### Work Areas",
  "#### Ordering",
  "### Next",
  "#### Expected Outcome",
  "#### Entry Condition",
  "#### Candidate Work",
  "### Later",
  "#### Goal",
  "#### Conditional Direction",
  "#### Replan Triggers",
  "## Key Decisions",
  "## Risks / Unknowns",
  "## Replan Conditions",
];

const TASK_SECTIONS = ["Outcome", "Why", "Inputs", "Work", "Outputs", "Acceptance", "Depends On"];
const VAGUE_ACCEPTANCE = new Set(["done", "completed", "works", "quality is good", "完成", "正常", "符合要求"]);

function marker(heading: MarkdownHeading): string {
  return `${"#".repeat(heading.level)} ${heading.title}`;
}

function result(issues: ValidationIssue[]): ValidationResult {
  return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}

function commonValidation(
  content: string,
  expectedStage: PlanningStage,
  expectedWorkId: string,
  path: string,
  options: ValidationOptions,
): { body?: string; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  let parsed;
  try {
    parsed = parseArtifact(content);
  } catch (error) {
    issues.push({
      severity: "error",
      code: "invalid_frontmatter",
      message: error instanceof Error ? error.message : String(error),
      path,
    });
    return { issues };
  }

  if (parsed.metadata.work_id !== expectedWorkId) {
    issues.push({ severity: "error", code: "work_id_mismatch", message: `work_id must be ${expectedWorkId}`, path });
  }
  if (parsed.metadata.stage !== expectedStage) {
    issues.push({ severity: "error", code: "stage_mismatch", message: `stage must be ${expectedStage}`, path });
  }
  if (!parsed.body.trim()) {
    issues.push({ severity: "error", code: "empty_body", message: "Markdown body is empty", path });
  }

  const visibleBody = stripFencedCode(parsed.body);
  const placeholderSeverity = options.forApproval ? "error" : "warning";
  if (/\b(?:TODO|TBD)\b/i.test(visibleBody) || /填这里/.test(visibleBody) || /^\s*\.\.\.\s*$/m.test(visibleBody)) {
    issues.push({
      severity: placeholderSeverity,
      code: "placeholder",
      message: options.forApproval ? "Placeholder content must be resolved before approval" : "Draft contains placeholder content",
      path,
    });
  }
  return { body: parsed.body, issues };
}

function validateRequiredHeadings(body: string, required: string[], path: string, issues: ValidationIssue[]): void {
  const headings = scanHeadings(body);
  const counts = new Map<string, number>();
  for (const heading of headings) counts.set(marker(heading), (counts.get(marker(heading)) ?? 0) + 1);
  for (const requiredHeading of required) {
    const count = counts.get(requiredHeading) ?? 0;
    if (count === 0) {
      issues.push({ severity: "error", code: "missing_heading", message: `Missing heading: ${requiredHeading}`, path });
    } else if (count > 1) {
      issues.push({ severity: "error", code: "duplicate_heading", message: `Duplicate heading: ${requiredHeading}`, path });
    }
  }
}

function requireSectionContent(body: string, headingMarker: string, path: string, issues: ValidationIssue[]): void {
  const headings = scanHeadings(body);
  const heading = headings.find((candidate) => marker(candidate) === headingMarker);
  if (heading && !sectionContent(body, heading, headings)) {
    issues.push({ severity: "error", code: "empty_section", message: `Section is empty: ${headingMarker}`, path });
  }
}

export function validateSpec(
  content: string,
  expectedWorkId: string,
  path = "spec.md",
  options: ValidationOptions = {},
): ValidationResult {
  const common = commonValidation(content, "spec", expectedWorkId, path, options);
  if (!common.body) return result(common.issues);
  const issues = common.issues;
  validateRequiredHeadings(common.body, SPEC_HEADINGS, path, issues);
  for (const section of ["### In", "### Out", "## Success", "## Non-Goals"]) {
    requireSectionContent(common.body, section, path, issues);
  }

  const visibleBody = stripFencedCode(common.body);
  if (/^##\s+Tasks\s*$/m.test(visibleBody)) {
    issues.push({ severity: "error", code: "tasks_in_spec", message: "spec.md must not contain a Tasks section", path });
  }
  if (/\bT\d{3}\b/.test(visibleBody)) {
    issues.push({ severity: "error", code: "task_id_in_spec", message: "spec.md must not contain task IDs", path });
  }
  if (/^###\s+Depends On\s*$/m.test(visibleBody)) {
    issues.push({ severity: "error", code: "dependency_in_spec", message: "spec.md must not contain dependencies", path });
  }
  return result(issues);
}

export function validatePlan(
  content: string,
  expectedWorkId: string,
  path = "plan.md",
  options: ValidationOptions = {},
): ValidationResult {
  const common = commonValidation(content, "plan", expectedWorkId, path, options);
  if (!common.body) return result(common.issues);
  const issues = common.issues;
  validateRequiredHeadings(common.body, PLAN_HEADINGS, path, issues);
  for (const section of ["#### Outcome", "#### Work Areas", "#### Entry Condition", "#### Replan Triggers"]) {
    requireSectionContent(common.body, section, path, issues);
  }

  const visibleBody = stripFencedCode(common.body);
  if (/\bT\d{3}\b/.test(visibleBody)) {
    issues.push({ severity: "error", code: "task_id_in_plan", message: "plan.md must not contain task IDs", path });
  }
  if (/^###\s+Acceptance\s*$/m.test(visibleBody)) {
    issues.push({ severity: "error", code: "acceptance_in_plan", message: "plan.md must not contain task acceptance sections", path });
  }
  if (/^\s*-\s*\[[ xX]\]\s+/m.test(visibleBody)) {
    issues.push({
      severity: "warning",
      code: "executable_tasks_in_plan",
      message: "Checkbox list may be an executable task list; keep plan.md at approach level",
      path,
    });
  }
  return result(issues);
}

export function validateTasks(
  content: string,
  expectedWorkId: string,
  path = "tasks.md",
  options: ValidationOptions = {},
): ValidationResult {
  const common = commonValidation(content, "tasks", expectedWorkId, path, options);
  if (!common.body) return result(common.issues);
  const issues = common.issues;
  const body = common.body;
  const headings = scanHeadings(body);
  const tasks = parseTasks(body);

  if (!headings.some((heading) => marker(heading) === "# Tasks")) {
    issues.push({ severity: "error", code: "missing_heading", message: "Missing heading: # Tasks", path });
  }
  if (tasks.length === 0) {
    issues.push({ severity: "error", code: "missing_tasks", message: "At least one task is required", path });
  }

  for (const heading of headings.filter((candidate) => candidate.level === 2 && /^T/i.test(candidate.title))) {
    if (!/^T\d{3}\s+[—-]\s+\S/.test(heading.title)) {
      issues.push({ severity: "error", code: "invalid_task_heading", message: `Invalid task heading on line ${heading.line}`, path });
    }
  }

  const ids = new Set<string>();
  const titles = new Set<string>();
  const taskOrder = new Map<string, number>();
  tasks.forEach((task, index) => taskOrder.set(task.id, index));
  const dependencyGraph = new Map<string, string[]>();

  for (const task of tasks) {
    if (ids.has(task.id)) {
      issues.push({ severity: "error", code: "duplicate_task_id", message: `Duplicate task ID: ${task.id}`, path, taskId: task.id });
    }
    ids.add(task.id);
    const expectedId = `T${String(ids.size).padStart(3, "0")}`;
    if (task.id !== expectedId) {
      issues.push({ severity: "error", code: "task_id_sequence", message: `Expected ${expectedId} at this position`, path, taskId: task.id });
    }
    const normalizedTitle = task.title.toLocaleLowerCase();
    if (titles.has(normalizedTitle)) {
      issues.push({ severity: "error", code: "duplicate_task_title", message: `Duplicate task title: ${task.title}`, path, taskId: task.id });
    }
    titles.add(normalizedTitle);

    for (const sectionName of TASK_SECTIONS) {
      const entries = task.sections.get(sectionName) ?? [];
      if (entries.length === 0) {
        issues.push({ severity: "error", code: "missing_task_section", message: `Missing section: ${sectionName}`, path, taskId: task.id });
      } else if (entries.length > 1) {
        issues.push({ severity: "error", code: "duplicate_task_section", message: `Duplicate section: ${sectionName}`, path, taskId: task.id });
      } else if (!entries[0]?.content.trim()) {
        issues.push({ severity: "error", code: "empty_task_section", message: `Empty section: ${sectionName}`, path, taskId: task.id });
      }
    }

    const acceptance = task.sections.get("Acceptance")?.[0]?.content ?? "";
    const checks = Array.from(acceptance.matchAll(/^\s*-\s*\[ \]\s+(.+?)\s*$/gm), (match) => match[1] ?? "");
    if (checks.length === 0) {
      issues.push({ severity: "error", code: "missing_acceptance_checkbox", message: "Acceptance needs at least one unchecked checkbox", path, taskId: task.id });
    } else {
      const allVague = checks.every((check) => VAGUE_ACCEPTANCE.has(check.toLocaleLowerCase().replace(/[.!。！]+$/g, "").trim()));
      if (allVague) {
        issues.push({ severity: "error", code: "vague_acceptance", message: "Acceptance criteria are not concretely verifiable", path, taskId: task.id });
      }
    }

    const dependencyContent = task.sections.get("Depends On")?.[0]?.content ?? "";
    const dependencyResult = parseDependencies(dependencyContent);
    if (!dependencyResult.valid) {
      issues.push({ severity: "error", code: "invalid_dependencies", message: "Depends On must be 'None.' or a task-ID bullet list", path, taskId: task.id });
    }
    dependencyGraph.set(task.id, dependencyResult.dependencies);
  }

  for (const [taskId, dependencies] of dependencyGraph) {
    for (const dependency of dependencies) {
      if (!ids.has(dependency)) {
        issues.push({ severity: "error", code: "unknown_dependency", message: `Unknown dependency: ${dependency}`, path, taskId });
      } else if (dependency === taskId) {
        issues.push({ severity: "error", code: "self_dependency", message: "Task cannot depend on itself", path, taskId });
      } else if ((taskOrder.get(dependency) ?? Number.MAX_SAFE_INTEGER) >= (taskOrder.get(taskId) ?? -1)) {
        issues.push({ severity: "error", code: "dependency_order", message: `Dependency must appear before task: ${dependency}`, path, taskId });
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleMembers = new Set<string>();
  const visit = (taskId: string): boolean => {
    if (visiting.has(taskId)) {
      cycleMembers.add(taskId);
      return true;
    }
    if (visited.has(taskId)) return false;
    visiting.add(taskId);
    let cyclic = false;
    for (const dependency of dependencyGraph.get(taskId) ?? []) {
      if (ids.has(dependency) && visit(dependency)) {
        cyclic = true;
        cycleMembers.add(taskId);
      }
    }
    visiting.delete(taskId);
    visited.add(taskId);
    return cyclic;
  };
  for (const taskId of ids) visit(taskId);
  if (cycleMembers.size > 0) {
    issues.push({
      severity: "error",
      code: "dependency_cycle",
      message: `Dependency cycle detected: ${Array.from(cycleMembers).sort().join(", ")}`,
      path,
    });
  }
  return result(issues);
}

export function validateForStage(
  content: string,
  stage: PlanningStage,
  expectedWorkId: string,
  path: string,
  options: ValidationOptions = {},
): ValidationResult {
  if (stage === "spec") return validateSpec(content, expectedWorkId, path, options);
  if (stage === "plan") return validatePlan(content, expectedWorkId, path, options);
  return validateTasks(content, expectedWorkId, path, options);
}

export function formatValidation(validation: ValidationResult): string {
  if (validation.issues.length === 0) return "Validation passed: 0 errors, 0 warnings.";
  const errors = validation.issues.filter((issue) => issue.severity === "error").length;
  const warnings = validation.issues.length - errors;
  const details = validation.issues.map((issue) => {
    const task = issue.taskId ? ` [${issue.taskId}]` : "";
    return `- ${issue.severity.toUpperCase()} ${issue.code}${task}: ${issue.message}`;
  });
  return [`Validation: ${errors} error(s), ${warnings} warning(s).`, ...details].join("\n");
}
