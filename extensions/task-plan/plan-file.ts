import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { extractAllSections } from "./sections.ts";
import { HARNESS, type PlanDocument, type PlanMetadata } from "./types.ts";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export function canonicalSectionHash(content: string): string {
  return sha256(content.replace(/\r\n/g, "\n"));
}

export function canonicalTasksDefinitionHash(content: string): string {
  return sha256(content
    .replace(/\r\n/g, "\n")
    .replace(/^(### T\d{3} — .+?) \[(?: |x|X)\]$/gm, "$1 [#]")
    .replace(/- \[(?: |x|X)\]/g, "- [#]")
    .replace(/^(\s*- .+?) \[(?: |x|X)\]$/gm, "$1 [#]"));
}

export function parseFrontmatter(text: string): { metadata: PlanMetadata; body: string } {
  const match = text.match(FRONTMATTER);
  if (!match) throw new Error("Plan document is missing frontmatter");
  const raw = match[1]!;
  const metadata: Record<string, unknown> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    if (colon < 0) throw new Error(`Invalid frontmatter line: ${line}`);
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    metadata[key] = parseScalar(value);
  }
  return { metadata: metadata as PlanMetadata, body: text.slice(match[0].length) };
}

export function renderFrontmatter(metadata: PlanMetadata): string {
  const ordered = [
    "harness", "plan_id", "round", "stage", "stage_status",
    "approved_what_why_hash", "approved_plan_hash", "reviewed_tasks_hash", "closure_reason",
  ];
  const keys = [...ordered.filter((k) => metadata[k] !== undefined && metadata[k] !== ""), ...Object.keys(metadata).filter((k) => !ordered.includes(k)).sort()];
  return `---\n${keys.map((key) => `${key}: ${formatScalar(metadata[key])}`).join("\n")}\n---\n`;
}

export function replaceFrontmatter(text: string, metadata: PlanMetadata): string {
  const match = text.match(FRONTMATTER);
  if (!match) throw new Error("Plan document is missing frontmatter");
  return renderFrontmatter(metadata) + text.slice(match[0].length);
}

export async function readPlanDocument(path: string): Promise<PlanDocument> {
  const bytes = await readFile(path);
  const text = bytes.toString("utf8");
  const { metadata, body } = parseFrontmatter(text);
  return { path, text, document_hash: sha256(bytes), metadata, body, sections: extractAllSections(text) };
}

export async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

export async function writeIfDocumentHash(path: string, expectedHash: string, content: string): Promise<{ ok: true; document_hash: string } | { ok: false; conflict: string }> {
  const current = await readFile(path).catch(() => undefined);
  if (!current) return { ok: false, conflict: "missing_file" };
  if (sha256(current) !== expectedHash) return { ok: false, conflict: "stale_document_hash" };
  await atomicWriteFile(path, content);
  return { ok: true, document_hash: sha256(Buffer.from(content, "utf8")) };
}

export async function detectLegacyWorkspaceConflict(root: string): Promise<string[]> {
  const conflicts: string[] = [];
  const planning = join(root, "planning");
  if (await exists(join(planning, ".current"))) conflicts.push("planning/.current");
  const active = join(planning, "active");
  try {
    const entries = await readdir(active);
    if (entries.some((entry) => !entry.startsWith("."))) conflicts.push("planning/active/");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return conflicts;
}

export async function nextPlanSequence(root: string): Promise<number> {
  const plans = join(root, "plans");
  let max = 0;
  try {
    for (const entry of await readdir(plans)) {
      const match = entry.match(/^(\d{3})-.*\.md$/);
      if (match) max = Math.max(max, Number(match[1]));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return max + 1;
}

export async function findUnfinishedHarnessPlans(root: string): Promise<string[]> {
  const plans = join(root, "plans");
  const found: string[] = [];
  try {
    for (const entry of await readdir(plans)) {
      if (!/^\d{3}-.*\.md$/.test(entry)) continue;
      const path = join(plans, entry);
      try {
        const document = await readPlanDocument(path);
        if (document.metadata.harness === HARNESS && !["completed", "abandoned"].includes(String(document.metadata.stage))) found.push(path);
      } catch {
        // Non-harness markdown may have arbitrary content and is ignored for unfinished detection.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return found.sort();
}

export function planTitleFromGoal(input: string): string {
  let title = input.trim().replace(/\s+/g, " ");
  title = title.replace(/^(?:\/plan(?::new)?|plan|计划|规划)\s*[:：-]?\s*/iu, "");
  title = title.replace(/^(?:请|麻烦|帮我|帮忙|需要|我需要|我要|我想|想|我们要|先)?\s*(?:给我|给(?:这个|这件事|这个事情)?|把(?:这个|这件事|这个事情)?)?\s*(?:写(?:一个|个|一下)?|做(?:一个|个|一下)?|弄(?:一个|个|一下)?|搞(?:一个|个|一下)?|实现(?:一个|个|一下)?|构建(?:一个|个|一下)?|规划(?:一个|个|一下)?|拆(?:一个|个|一下)?|设计(?:一个|个|一下)?)\s*/u, "");
  title = title.replace(/[。！？.!?；;：:，,、\s]+$/u, "").trim();
  return title || input.trim() || "Plan";
}

export function slugify(input: string): string {
  return input.toLowerCase().normalize("NFKD").replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "plan";
}

export async function createPlanSkeleton(root: string, goal: string, titleOverride?: string): Promise<PlanDocument> {
  const legacy = await detectLegacyWorkspaceConflict(root);
  if (legacy.length) throw new Error(`Legacy planning workspace conflict: ${legacy.join(", ")}`);
  const unfinished = await findUnfinishedHarnessPlans(root);
  if (unfinished.length) throw new Error(`Unfinished Harness Plan already exists: ${unfinished.join(", ")}`);
  const sequence = await nextPlanSequence(root);
  const planId = `P${String(sequence).padStart(3, "0")}`;
  const title = titleOverride?.trim() || planTitleFromGoal(goal);
  const path = join(root, "plans", `${String(sequence).padStart(3, "0")}-${slugify(title)}.md`);
  await mkdir(dirname(path), { recursive: true });
  const fh = await open(path, "wx");
  try { await fh.writeFile(renderSkeleton(planId, goal, title), "utf8"); } finally { await fh.close(); }
  return readPlanDocument(path);
}

function renderSkeleton(planId: string, goal: string, title = planTitleFromGoal(goal)): string {
  return `${renderFrontmatter({ harness: HARNESS, plan_id: planId, round: 0, stage: "what_why", stage_status: "drafting" })}\n# ${planId} — ${title}\n\n## Original Request\n\n${goal}\n\n---\n\n## What / Why\n\n<!-- pi-plan:what-why:start -->\n\nPending.\n\n<!-- pi-plan:what-why:end -->\n\n---\n\n## Plan\n\n<!-- pi-plan:plan:start -->\n\nPending approval of What / Why.\n\n<!-- pi-plan:plan:end -->\n\n---\n\n## Tasks\n\n<!-- pi-plan:tasks:start -->\n\nPending approval of Plan.\n\n<!-- pi-plan:tasks:end -->\n\n## Review\n\n<!-- pi-plan:review:start -->\n\nNot run.\n\n<!-- pi-plan:review:end -->\n`;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function parseScalar(value: string): unknown {
  if (value === "") return undefined;
  if (/^-?\d+$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function formatScalar(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[:#\n]|^\s|\s$/.test(text) ? JSON.stringify(text) : text;
}
