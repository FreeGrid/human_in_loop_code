import type { ArtifactMetadata, ArtifactStatus, PlanningStage } from "./types.js";

const REQUIRED_KEYS = ["harness", "work_id", "stage", "status"] as const;
const ALLOWED_STAGES = new Set<PlanningStage>(["spec", "plan", "tasks"]);
const ALLOWED_STATUSES = new Set<ArtifactStatus>(["draft", "approved"]);

export interface ParsedArtifact {
  metadata: ArtifactMetadata;
  body: string;
  frontmatter: string;
}

function frontmatterMatch(content: string): RegExpMatchArray {
  const match = content.match(/^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m);
  if (!match || match.index !== 0) {
    throw new Error("Artifact must begin with a closed '---' frontmatter block");
  }
  return match;
}

export function parseArtifact(content: string): ParsedArtifact {
  const match = frontmatterMatch(content);
  const header = match[1] ?? "";
  const values = new Map<string, string>();

  for (const rawLine of header.split(/\r?\n/)) {
    if (rawLine.trim() === "") continue;
    const line = rawLine.match(/^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/);
    if (!line) throw new Error(`Malformed frontmatter line: ${rawLine}`);
    const key = line[1] ?? "";
    const value = line[2] ?? "";
    if (!REQUIRED_KEYS.includes(key as (typeof REQUIRED_KEYS)[number])) {
      throw new Error(`Unknown frontmatter key: ${key}`);
    }
    if (values.has(key)) throw new Error(`Duplicate frontmatter key: ${key}`);
    if (value.trim() === "") throw new Error(`Empty frontmatter value: ${key}`);
    values.set(key, value.trim());
  }

  for (const key of REQUIRED_KEYS) {
    if (!values.has(key)) throw new Error(`Missing frontmatter key: ${key}`);
  }

  const harness = values.get("harness");
  const workId = values.get("work_id") ?? "";
  const stage = values.get("stage") as PlanningStage;
  const status = values.get("status") as ArtifactStatus;
  if (harness !== "task-plan/v1") throw new Error(`Unsupported harness: ${harness}`);
  if (!/^W-\d{8}-\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(workId)) {
    throw new Error(`Invalid work_id: ${workId}`);
  }
  if (!ALLOWED_STAGES.has(stage)) throw new Error(`Invalid stage: ${stage}`);
  if (!ALLOWED_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);

  return {
    metadata: { harness: "task-plan/v1", work_id: workId, stage, status },
    body: content.slice(match[0].length),
    frontmatter: match[0],
  };
}

export function renderArtifact(metadata: ArtifactMetadata, body: string): string {
  const normalizedBody = body.endsWith("\n") ? body : `${body}\n`;
  return [
    "---",
    `harness: ${metadata.harness}`,
    `work_id: ${metadata.work_id}`,
    `stage: ${metadata.stage}`,
    `status: ${metadata.status}`,
    "---",
    "",
    normalizedBody,
  ].join("\n");
}

export function updateArtifactStatus(content: string, status: ArtifactStatus): string {
  const parsed = parseArtifact(content);
  if (parsed.metadata.status === status) return content;

  const updatedFrontmatter = parsed.frontmatter.replace(
    /^(status:)[ \t]*(draft|approved)[ \t]*$/m,
    `$1 ${status}`,
  );
  if (updatedFrontmatter === parsed.frontmatter) {
    throw new Error("Unable to locate status field in frontmatter");
  }
  return `${updatedFrontmatter}${parsed.body}`;
}
