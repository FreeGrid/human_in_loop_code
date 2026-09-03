import { readFileSync } from "node:fs";
import { buildManagedBlock, hashManagedBlock } from "./managed-block.js";
import type { ControlIndex, RepositoryBinding } from "./types.js";

export const DEFAULT_FOCUS_AREAS = [
  "repository-boundary",
  "artifact-ownership",
  "dirty-worktree-preservation",
  "test-acceptance-authority",
  "human-gates",
  "commit-pr-traceability",
  "privacy-boundaries",
  "destructive-operations",
  "delegation-review",
  "long-term-recovery",
  "context-evidence",
  "release-checkpoint",
] as const;

const FOCUS_MODULES = new Map<string, string>(
  DEFAULT_FOCUS_AREAS.map((name) => [name, `focus-modules/${name}.md`]),
);

function loadAgentResource(relativePath: string): string {
  const url = new URL(`./resources/agents/${relativePath}`, import.meta.url);
  try {
    return readFileSync(url, "utf8").replace(/\r\n?/g, "\n").trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load control-init AGENTS resource ${relativePath}: ${message}`);
  }
}

function oneLine(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\s*\n\s*/g, " ").trim();
}

function markdownCell(value: string): string {
  return oneLine(value).replaceAll("|", "\\|").replaceAll("`", "\\`");
}

function replaceTokens(template: string, tokens: Record<string, string>): string {
  let rendered = template;
  for (const [name, value] of Object.entries(tokens)) {
    rendered = rendered.replaceAll(`{{${name}}}`, value);
  }
  const unresolved = rendered.match(/{{[A-Z0-9_]+}}/g);
  if (unresolved) throw new Error(`Unresolved AGENTS template token(s): ${[...new Set(unresolved)].join(", ")}`);
  return rendered;
}

function renderRepositoryTable(repositories: RepositoryBinding[]): string {
  const header = "| ID | Kind | Path | Visibility | Owns |\n| --- | --- | --- | --- | --- |";
  const rows = repositories.map((repository) =>
    `| ${markdownCell(repository.id)} | ${repository.kind} | ${markdownCell(repository.path)} | ${repository.visibility} | ${repository.owns.map(markdownCell).join(", ")} |`
  );
  return [header, ...rows].join("\n");
}

function renderRelationships(index: ControlIndex): string {
  if (index.relationships.length === 0) return "- No cross-repository relationship is declared.";
  return index.relationships.map((relationship) => {
    const description = relationship.description ? ` — ${oneLine(relationship.description)}` : "";
    return `- \`${relationship.from}\` **${relationship.type}** \`${relationship.to}\`${description}`;
  }).join("\n");
}

function renderRequirements(requirements: string[]): string {
  if (requirements.length === 0) return "- None. The profile defaults apply.";
  return requirements.map((requirement) => {
    const lines = requirement.replace(/\r\n?/g, "\n").split("\n");
    return `- ${lines[0]}${lines.slice(1).map((line) => `\n  ${line}`).join("")}`;
  }).join("\n");
}

function renderRole(repository: RepositoryBinding, customProfile: boolean): string {
  const template = loadAgentResource(customProfile ? "roles/custom.md" : `roles/${repository.kind}.md`);
  return replaceTokens(template, {
    REPOSITORY_ID: repository.id,
    REPOSITORY_KIND: repository.kind[0].toUpperCase() + repository.kind.slice(1),
    REPOSITORY_PATH: repository.path,
    REPOSITORY_ROLE: oneLine(repository.role),
    REPOSITORY_OWNS: repository.owns.join(", "),
  });
}

export function listAvailableFocusModules(): string[] {
  return [...FOCUS_MODULES.keys()];
}

/** Render only the generated Markdown body. The stored hash is deliberately not rendered. */
export function renderAgentsManagedContent(index: ControlIndex): string {
  const baseline = replaceTokens(loadAgentResource("baseline.md"), {
    WORKSPACE_NAME: index.name,
    WORKSPACE_ID: index.workspace_id,
    REPOSITORY_TABLE: renderRepositoryTable(index.repositories),
    RELATIONSHIP_LIST: renderRelationships(index),
    USER_REQUIREMENTS: renderRequirements(index.policies.user_requirements),
  });

  const roles = index.repositories
    .map((repository) => renderRole(repository, index.topology_profile === "custom"))
    .join("\n\n");
  const focusNames = index.agents.focus_areas.length > 0
    ? index.agents.focus_areas
    : [...DEFAULT_FOCUS_AREAS];
  const seen = new Set<string>();
  const focus = focusNames.map((name) => {
    if (seen.has(name)) throw new Error(`Duplicate AGENTS focus module: ${name}`);
    seen.add(name);
    const resource = FOCUS_MODULES.get(name);
    if (!resource) throw new Error(`Unknown AGENTS focus module: ${name}`);
    return loadAgentResource(resource);
  }).join("\n\n");

  const latexCount = index.repositories.filter((repository) => repository.kind === "latex").length;
  const paperNote = latexCount > 0
    ? `### Paper isolation\n\nThis workspace binds ${latexCount} independent paper ${latexCount === 1 ? "repository" : "repositories"}. Each represents one paper and may refer to the code repository; code must not depend on a paper repository, and paper repositories must remain independent from one another.`
    : "";

  return [baseline, "## Repository role rules", roles, paperNote, "## Operating rules", focus]
    .filter((section) => section.length > 0)
    .join("\n\n")
    .trim();
}

export function renderAgentsManagedBlock(index: ControlIndex): string {
  return buildManagedBlock(renderAgentsManagedContent(index));
}

export const renderManagedAgentsBlock = renderAgentsManagedBlock;

/** Produce the block and an immutable index copy containing its exact byte hash. */
export function renderAgentsArtifacts(index: ControlIndex): {
  content: string;
  managedBlock: string;
  managedBlockHash: string;
  index: ControlIndex;
} {
  const content = renderAgentsManagedContent(index);
  const managedBlock = buildManagedBlock(content);
  const managedBlockHash = hashManagedBlock(managedBlock);
  return {
    content,
    managedBlock,
    managedBlockHash,
    index: {
      ...index,
      agents: { ...index.agents, managed_block_hash: managedBlockHash },
    },
  };
}
