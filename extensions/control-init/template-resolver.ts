import { readFileSync } from "node:fs";
import * as path from "node:path";
import { validateControlIndex, hasValidationErrors } from "./index-validator.js";
import type {
  ConflictDetail,
  ControlIndex,
  CustomRepositoryInput,
  InitWorkspaceInput,
  InputQuestion,
  RepositoryBinding,
  RepositoryRelationship,
  TopologyProfile,
  ValidationIssue,
} from "./types.js";
import { AGENTS_TEMPLATE_VERSION, CONTROL_INDEX_SCHEMA } from "./types.js";

export const EMPTY_MANAGED_BLOCK_HASH = `sha256:${"0".repeat(64)}`;

interface ProfileRepositoryTemplate {
  kind: "control" | "code" | "latex";
  role: string;
  visibility: RepositoryBinding["visibility"];
  owns: string[];
}

export interface BuiltInProfile {
  id: "control-code" | "control-code-latex";
  repositories: {
    control: ProfileRepositoryTemplate;
    code: ProfileRepositoryTemplate;
    latex?: ProfileRepositoryTemplate;
  };
  relationships: RepositoryRelationship[];
  latex_relationship?: Omit<RepositoryRelationship, "from">;
  focus_areas: string[];
}

export type TemplateResolution =
  | { status: "resolved"; profile: TopologyProfile; index: ControlIndex }
  | { status: "needs_input"; profile: TopologyProfile; questions: InputQuestion[] }
  | { status: "conflict"; profile?: TopologyProfile; conflicts: ConflictDetail[] };

export interface TemplateResolverOptions {
  /** Base for user-entered relative paths. Defaults to the caller's current directory. */
  cwd?: string;
  /** Placeholder or final hash. A canonical zero digest is used while rendering AGENTS. */
  managedBlockHash?: string;
}

const PROFILE_FILES: Record<BuiltInProfile["id"], string> = {
  "control-code": "control-code.json",
  "control-code-latex": "control-code-latex.json",
};

const VISIBILITIES = new Set<RepositoryBinding["visibility"]>([
  "private",
  "private-now-may-open-source",
  "public",
  "unspecified",
]);

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseProfileRepository(value: unknown, label: string): ProfileRepositoryTemplate {
  const object = asObject(value, label);
  const keys = Object.keys(object);
  if (keys.some((key) => !["kind", "role", "visibility", "owns"].includes(key))) {
    throw new Error(`${label} has an unknown field.`);
  }
  if (!(["control", "code", "latex"] as unknown[]).includes(object.kind)) throw new Error(`${label}.kind is invalid.`);
  if (typeof object.role !== "string" || !object.role) throw new Error(`${label}.role is invalid.`);
  if (typeof object.visibility !== "string" || !VISIBILITIES.has(object.visibility as RepositoryBinding["visibility"])) {
    throw new Error(`${label}.visibility is invalid.`);
  }
  if (!Array.isArray(object.owns) || object.owns.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${label}.owns must contain non-empty strings.`);
  }
  return {
    kind: object.kind as ProfileRepositoryTemplate["kind"],
    role: object.role,
    visibility: object.visibility as RepositoryBinding["visibility"],
    owns: [...object.owns] as string[],
  };
}

function parseProfileRelationship(value: unknown, label: string): RepositoryRelationship {
  const object = asObject(value, label);
  if (typeof object.from !== "string" || typeof object.to !== "string") throw new Error(`${label} endpoints are invalid.`);
  if (!(object.type === "manages" || object.type === "tests")) throw new Error(`${label}.type is invalid.`);
  return { from: object.from, to: object.to, type: object.type };
}

function parseBuiltInProfile(value: unknown, expectedId: BuiltInProfile["id"]): BuiltInProfile {
  const object = asObject(value, `profile ${expectedId}`);
  if (object.id !== expectedId) throw new Error(`Profile resource id does not match ${expectedId}.`);
  const repositories = asObject(object.repositories, `${expectedId}.repositories`);
  const control = parseProfileRepository(repositories.control, `${expectedId}.repositories.control`);
  const code = parseProfileRepository(repositories.code, `${expectedId}.repositories.code`);
  if (control.kind !== "control" || code.kind !== "code") throw new Error(`${expectedId} contains mismatched built-in repository kinds.`);
  const latex = repositories.latex === undefined
    ? undefined
    : parseProfileRepository(repositories.latex, `${expectedId}.repositories.latex`);
  if ((expectedId === "control-code-latex") !== (latex?.kind === "latex")) {
    throw new Error(`${expectedId} has an invalid latex repository template.`);
  }
  if (!Array.isArray(object.relationships)) throw new Error(`${expectedId}.relationships must be an array.`);
  const relationships = object.relationships.map((relationship, index) =>
    parseProfileRelationship(relationship, `${expectedId}.relationships[${index}]`)
  );
  if (!Array.isArray(object.focus_areas) || object.focus_areas.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${expectedId}.focus_areas must contain non-empty strings.`);
  }

  let latexRelationship: BuiltInProfile["latex_relationship"];
  if (object.latex_relationship !== undefined) {
    const relation = asObject(object.latex_relationship, `${expectedId}.latex_relationship`);
    if (relation.to !== "code" || relation.type !== "paper-about") {
      throw new Error(`${expectedId}.latex_relationship must be paper-about -> code.`);
    }
    latexRelationship = { to: "code", type: "paper-about" };
  }
  if (expectedId === "control-code-latex" && !latexRelationship) {
    throw new Error(`${expectedId} is missing latex_relationship.`);
  }
  return {
    id: expectedId,
    repositories: { control, code, ...(latex ? { latex } : {}) },
    relationships,
    ...(latexRelationship ? { latex_relationship: latexRelationship } : {}),
    focus_areas: [...object.focus_areas] as string[],
  };
}

/** Load and validate the shipped profile at call time; extension import itself performs no I/O. */
export function getBuiltInProfile(profile: BuiltInProfile["id"]): BuiltInProfile {
  const resourceUrl = new URL(`./resources/topology-profiles/${PROFILE_FILES[profile]}`, import.meta.url);
  let source: string;
  try {
    source = readFileSync(resourceUrl, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load control-init topology profile ${profile}: ${message}`);
  }
  try {
    return parseBuiltInProfile(JSON.parse(source) as unknown, profile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid control-init topology profile ${profile}: ${message}`);
  }
}

function portablePath(controlRoot: string, enteredPath: string, cwd: string): string {
  const absolute = path.resolve(cwd, enteredPath);
  const relative = path.relative(controlRoot, absolute);
  return (relative || ".").split(path.sep).join("/");
}

function portableWorkspaceId(value: string): string {
  const result = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "");
  return result || "control-workspace";
}

function defaultWorkspaceName(workspaceId: string): string {
  return workspaceId
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function defaultPolicies(userRequirements: string[]): ControlIndex["policies"] {
  return {
    runtime_dependency_direction: ["control->code"],
    dirty_worktree: "preserve-unrelated",
    task_activation: "explicit-human-assignment",
    agent_git_workflow: "branch-commit-push-pr-after-validation",
    merge_and_release: "explicit-human-decision",
    commit_granularity: "small-complete-change",
    pr_granularity: "coherent-verified-feature",
    user_requirements: [...userRequirements],
  };
}

function repositoryFromTemplate(
  id: string,
  configuredPath: string,
  template: ProfileRepositoryTemplate,
): RepositoryBinding {
  return {
    id,
    kind: template.kind,
    path: configuredPath,
    role: template.role,
    visibility: template.visibility,
    git_remote: null,
    owns: [...template.owns],
  };
}

function conflictFromIssues(issues: ValidationIssue[]): ConflictDetail[] {
  return issues.filter((entry) => entry.severity === "error").map((entry) => ({
    code: entry.code,
    message: entry.message,
    ...(entry.path ? { path: entry.path } : {}),
  }));
}

function invalidRequirements(input: InitWorkspaceInput): ConflictDetail[] {
  if (!input.userRequirements) return [];
  return input.userRequirements.flatMap((value, index) =>
    typeof value !== "string"
      ? [{ code: "invalid-user-requirement", message: `userRequirements[${index}] must be a string.` }]
      : []
  );
}

function selectProfile(input: InitWorkspaceInput): TemplateResolution | TopologyProfile {
  const hasCustom = (input.customRepositories?.length ?? 0) > 0 || (input.customRelationships?.length ?? 0) > 0;
  const hasLatex = (input.latexRepositories?.length ?? 0) > 0;
  const explicit = input.topologyProfile;

  if (input.focusAreas !== undefined && (explicit ? explicit !== "custom" : !hasCustom)) {
    return {
      status: "conflict",
      profile: explicit,
      conflicts: [{
        code: "builtin-focus-customization",
        message: "Built-in profiles use the complete V1 focus set; select custom to choose focus modules explicitly.",
        choices: ["use-built-in-focus-set", "use-custom-profile"],
      }],
    };
  }

  if (explicit && explicit !== "custom" && hasCustom) {
    return {
      status: "conflict",
      profile: explicit,
      conflicts: [{
        code: "profile-custom-input-conflict",
        message: `Custom repositories or relationships cannot be applied to built-in profile ${explicit}; select custom explicitly.`,
        choices: ["use-built-in-profile", "use-custom-profile"],
      }],
    };
  }
  if (explicit === "control-code" && hasLatex) {
    return {
      status: "conflict",
      profile: explicit,
      conflicts: [{
        code: "profile-latex-conflict",
        message: "The control-code profile cannot contain latex repositories; select control-code-latex.",
        choices: ["control-code", "control-code-latex"],
      }],
    };
  }
  if (explicit === "custom" && hasLatex && !input.customRepositories?.length) {
    return {
      status: "conflict",
      profile: explicit,
      conflicts: [{ code: "custom-built-in-input-conflict", message: "Custom topology requires customRepositories; latexRepositories belongs to the built-in paper profile." }],
    };
  }
  return explicit ?? (hasCustom ? "custom" : hasLatex ? "control-code-latex" : "control-code");
}

function missingBuiltInQuestions(input: InitWorkspaceInput, profile: TopologyProfile): InputQuestion[] {
  const questions: InputQuestion[] = [];
  if (!input.controlPath?.trim()) questions.push({ id: "control_path", prompt: "Which exact directory is the control repository?", kind: "path", repositoryId: "control" });
  if (!input.codePath?.trim()) questions.push({ id: "code_path", prompt: "Which exact directory is the code repository?", kind: "path", repositoryId: "code" });
  if (profile === "control-code-latex") {
    if (!input.latexRepositories?.length) {
      questions.push({ id: "latex_repositories", prompt: "List each paper repository with a unique ID and exact directory.", kind: "repositories" });
    } else {
      input.latexRepositories.forEach((repository, index) => {
        if (!repository.id?.trim()) questions.push({ id: `latex_${index}_id`, prompt: `What is the unique ID for paper repository ${index + 1}?`, kind: "text" });
        if (!repository.path?.trim()) questions.push({ id: `latex_${repository.id || index}_path`, prompt: `Which exact directory is the ${repository.id || `paper ${index + 1}`} repository?`, kind: "path", repositoryId: repository.id || undefined });
      });
    }
  }
  return questions;
}

function buildBuiltInIndex(
  input: InitWorkspaceInput,
  profileId: "control-code" | "control-code-latex",
  cwd: string,
  managedBlockHash: string,
): ControlIndex {
  const profile = getBuiltInProfile(profileId);
  const controlRoot = path.resolve(cwd, input.controlPath!);
  const repositories = [
    repositoryFromTemplate("control", ".", profile.repositories.control),
    repositoryFromTemplate("code", portablePath(controlRoot, input.codePath!, cwd), profile.repositories.code),
  ];
  const relationships = profile.relationships.map((relationship) => ({ ...relationship }));

  if (profileId === "control-code-latex") {
    const latexTemplate = profile.repositories.latex!;
    for (const paper of input.latexRepositories ?? []) {
      repositories.push(repositoryFromTemplate(paper.id, portablePath(controlRoot, paper.path!, cwd), latexTemplate));
      relationships.push({ from: paper.id, ...profile.latex_relationship! });
    }
  }

  const workspaceId = portableWorkspaceId(input.workspaceId ?? path.basename(controlRoot));
  return {
    schema: CONTROL_INDEX_SCHEMA,
    workspace_id: workspaceId,
    name: input.name?.trim() || defaultWorkspaceName(workspaceId),
    topology_profile: profileId,
    control_repository: "control",
    repositories,
    relationships,
    policies: defaultPolicies(input.userRequirements ?? []),
    agents: {
      template_version: AGENTS_TEMPLATE_VERSION,
      focus_areas: [...profile.focus_areas],
      managed_block_hash: managedBlockHash,
    },
  };
}

function customShapeConflicts(repositories: CustomRepositoryInput[]): ConflictDetail[] {
  const controls = repositories.filter((repository) => repository.kind === "control");
  if (controls.length !== 1) {
    return [{ code: "custom-control-count", message: `Custom topology requires exactly one control repository; found ${controls.length}.` }];
  }
  return [];
}

function buildCustomIndex(
  input: InitWorkspaceInput,
  cwd: string,
  managedBlockHash: string,
): ControlIndex {
  const custom = input.customRepositories!;
  const controlInput = custom.find((repository) => repository.kind === "control")!;
  const controlEnteredPath = controlInput.path || input.controlPath!;
  const controlRoot = path.resolve(cwd, controlEnteredPath);
  const repositories: RepositoryBinding[] = custom.map((repository) => ({
    id: repository.id,
    kind: repository.kind,
    path: portablePath(controlRoot, repository.path || (repository.kind === "control" ? controlEnteredPath : ""), cwd),
    role: repository.role,
    visibility: repository.visibility,
    git_remote: repository.gitRemote ?? null,
    owns: [...repository.owns],
  }));
  const workspaceId = portableWorkspaceId(input.workspaceId ?? path.basename(controlRoot));
  return {
    schema: CONTROL_INDEX_SCHEMA,
    workspace_id: workspaceId,
    name: input.name?.trim() || defaultWorkspaceName(workspaceId),
    topology_profile: "custom",
    control_repository: controlInput.id,
    repositories,
    relationships: (input.customRelationships ?? []).map((relationship) => ({ ...relationship })),
    policies: defaultPolicies(input.userRequirements ?? []),
    agents: {
      template_version: AGENTS_TEMPLATE_VERSION,
      focus_areas: input.focusAreas === undefined
        ? getBuiltInProfile("control-code").focus_areas
        : [...input.focusAreas],
      managed_block_hash: managedBlockHash,
    },
  };
}

export function resolveTemplate(
  input: InitWorkspaceInput,
  options: TemplateResolverOptions = {},
): TemplateResolution {
  const selected = selectProfile(input);
  if (typeof selected !== "string") return selected;
  const profile = selected;
  const requirementConflicts = invalidRequirements(input);
  if (requirementConflicts.length > 0) return { status: "conflict", profile, conflicts: requirementConflicts };

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const managedBlockHash = options.managedBlockHash ?? EMPTY_MANAGED_BLOCK_HASH;

  if (profile !== "custom") {
    const questions = missingBuiltInQuestions(input, profile);
    if (questions.length > 0) return { status: "needs_input", profile, questions };
    const index = buildBuiltInIndex(input, profile, cwd, managedBlockHash);
    const issues = validateControlIndex(index);
    return hasValidationErrors(issues)
      ? { status: "conflict", profile, conflicts: conflictFromIssues(issues) }
      : { status: "resolved", profile, index };
  }

  if (!input.customRepositories?.length) {
    return {
      status: "needs_input",
      profile,
      questions: [{ id: "custom_repositories", prompt: "Define each custom repository, including exactly one control repository, its path, role, visibility and ownership.", kind: "repositories" }],
    };
  }
  const shapeConflicts = customShapeConflicts(input.customRepositories);
  if (shapeConflicts.length > 0) return { status: "conflict", profile, conflicts: shapeConflicts };
  const customControl = input.customRepositories.find((repository) => repository.kind === "control")!;
  const questions: InputQuestion[] = [];
  for (const repository of input.customRepositories) {
    if (!repository.path?.trim() && !(repository.kind === "control" && input.controlPath?.trim())) {
      questions.push({ id: `custom_${repository.id}_path`, prompt: `Which exact directory is repository ${repository.id}?`, kind: "path", repositoryId: repository.id });
    }
  }
  if (!customControl.path?.trim() && !input.controlPath?.trim()) {
    // The loop already emitted this question; keep a stable control-specific id for callers.
    const existing = questions.findIndex((question) => question.repositoryId === customControl.id);
    if (existing >= 0) questions[existing] = { id: "control_path", prompt: "Which exact directory is the control repository?", kind: "path", repositoryId: customControl.id };
  }
  if (questions.length > 0) return { status: "needs_input", profile, questions };

  const index = buildCustomIndex(input, cwd, managedBlockHash);
  const issues = validateControlIndex(index);
  return hasValidationErrors(issues)
    ? { status: "conflict", profile, conflicts: conflictFromIssues(issues) }
    : { status: "resolved", profile, index };
}

export const resolveWorkspaceTemplate = resolveTemplate;
