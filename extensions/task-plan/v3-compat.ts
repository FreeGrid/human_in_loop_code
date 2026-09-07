import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isMap, isScalar, parseDocument } from "yaml";
import { parseReadablePlan, renderReadablePlan, type ReadablePlan } from "./v3-format.ts";

export type PlanFileFormat = "v1" | "v2" | "v3";

/** Classify the envelope before loading any format-specific legacy parser. */
export function detectPlanFileFormat(text: string): PlanFileFormat {
  if (typeof text !== "string") throw new Error("plan_format_unknown");
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!header) throw new Error("plan_format_unknown");
  const document = parseDocument(header[1]!, { strict: true, uniqueKeys: true, schema: "failsafe" });
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) throw new Error("plan_format_invalid");
  const fields: Record<string, string> = Object.create(null);
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.anchor || pair.key.tag) throw new Error("plan_format_invalid");
    if (!["format", "harness"].includes(pair.key.value)) continue;
    if (!isScalar(pair.value) || typeof pair.value.value !== "string" || pair.value.anchor || pair.value.tag) throw new Error("plan_format_invalid");
    fields[pair.key.value] = pair.value.value;
  }
  if (fields.format === "pi-plan/v3" && fields.harness === undefined) return "v3";
  if (fields.format === "pi-plan/v2" && fields.harness === "pi-plan/v2") return "v2";
  if (fields.harness === "pi-plan/v1" && fields.format === undefined) return "v1";
  throw new Error("plan_format_unknown_or_conflicting");
}

export interface LegacyPlanView {
  format: "v1" | "v2";
  path: string;
  title: string;
  tasks: Array<{ id: string; text: string; completed: boolean }>;
  readonly: true;
}

export interface PlanSource { path: string; text: string; format: PlanFileFormat }

/** Pure regular-file read and format detection, without any legacy parser. */
export async function readPlanSource(path: string): Promise<PlanSource> {
  const canonical = await realpath(path);
  // A FIFO must not block opening before fstat can reject it. A changed leaf
  // symlink must not redirect the read after realpath selected the target.
  const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let text: string;
  try {
    if (!(await file.stat()).isFile()) throw new Error("plan_not_regular_file");
    const bytes = await file.readFile();
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error("plan_invalid_utf8"); }
  } finally { await file.close(); }
  const format = detectPlanFileFormat(text);
  return { path: canonical, text, format };
}

/** No runtime discovery, reconciliation, migration, locks or writes. */
export async function readLegacyPlanView(path: string): Promise<LegacyPlanView> {
  const { path: canonical, text, format } = await readPlanSource(path);
  if (format === "v3") throw new Error("legacy_view_requires_legacy_format");
  const { parsePlanCandidate } = await import("./plan-integrity.ts");
  const document = parsePlanCandidate(canonical, text);
  // Use the legacy adapter's declared task labels and status. Do not expose
  // duplicated requirements, policies, approval data or execution records.
  const domain = document.domain!;
  return {
    format, path: canonical, title: domain.title, readonly: true,
    tasks: domain.nodes.map(node => ({ id: node.id, text: node.title, completed: node.progress === "completed" })),
  };
}

export interface ReadableMigrationPreview { source: LegacyPlanView; preview: string; applied: false }

/** Explicit current meaning is supplied by the caller; there is no migration apply. */
export async function previewReadableMigration(path: string, proposal: ReadablePlan): Promise<ReadableMigrationPreview> {
  const source = await readLegacyPlanView(path);
  const candidate = parseReadablePlan(renderReadablePlan(proposal));
  // Proposed checkboxes are ordinary status, never transferred execution evidence.
  return { source, preview: renderReadablePlan(candidate), applied: false };
}

export function legacyViewText(view: LegacyPlanView): string {
  return `${view.title}\n${view.tasks.map(task => `- [${task.completed ? "x" : " "}] ${task.id} ${task.text}`).join("\n")}\n旧格式 ${view.format}，原文件保持不变。可在原流程继续，或明确整理当前需求后预览 V3。`;
}
