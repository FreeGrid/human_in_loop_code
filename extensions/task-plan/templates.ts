import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RESOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "resources");

export function interpolateResource(template: string, variables: Record<string, string>): string {
  const referenced = new Set(Array.from(template.matchAll(/\{\{([A-Z0-9_]+)\}\}/g), (match) => match[1] ?? ""));
  for (const name of referenced) {
    if (!(name in variables)) throw new Error(`Missing template variable: ${name}`);
  }

  const rendered = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_token, name: string) => variables[name] ?? "");
  const unresolved = rendered.match(/\{\{[A-Z0-9_]+\}\}/);
  if (unresolved) throw new Error(`Unresolved template variable: ${unresolved[0]}`);
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

function loadTemplate(name: "spec" | "plan" | "tasks"): string {
  return readFileSync(join(RESOURCE_ROOT, "templates", `${name}.md`), "utf8");
}

export function renderSpecTemplate(workId: string, goal: string): string {
  return interpolateResource(loadTemplate("spec"), { WORK_ID: workId, GOAL: goal.trim() });
}

export function renderPlanTemplate(workId: string): string {
  return interpolateResource(loadTemplate("plan"), { WORK_ID: workId });
}

export function renderTasksTemplate(workId: string): string {
  return interpolateResource(loadTemplate("tasks"), { WORK_ID: workId });
}
