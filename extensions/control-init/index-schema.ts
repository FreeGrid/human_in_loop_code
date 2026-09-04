import { assertValidControlIndex } from "./index-validator.js";
import type { ControlIndex, ValidationIssue } from "./types.js";

type JsonObject = Record<string, unknown>;

const TOP_LEVEL_KEYS = ["schema", "workspace_id", "name", "topology_profile", "control_repository", "repositories", "relationships", "policies", "agents"];
const REPOSITORY_KEYS = ["id", "kind", "path", "role", "visibility", "git_remote", "owns"];
const RELATIONSHIP_KEYS = ["from", "to", "type", "description"];
const POLICY_KEYS = ["runtime_dependency_direction", "dirty_worktree", "task_activation", "agent_git_workflow", "merge_and_release", "commit_granularity", "pr_granularity", "user_requirements"];
const AGENT_KEYS = ["template_version", "focus_areas", "managed_block_hash"];

const TOPOLOGY_PROFILES = ["control-code", "control-code-latex", "custom"] as const;
const REPOSITORY_KINDS = ["control", "code", "latex", "custom"] as const;
const VISIBILITIES = ["private", "private-now-may-open-source", "public", "unspecified"] as const;
const RELATIONSHIP_TYPES = ["manages", "tests", "paper-about", "runtime-depends-on", "custom"] as const;

export class ControlIndexSchemaError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(issues.map((entry) => `${entry.path ?? "$"}: ${entry.message}`).join("\n"));
    this.name = "ControlIndexSchemaError";
    this.issues = issues;
  }
}

function schemaIssue(issues: ValidationIssue[], path: string, code: string, message: string): void {
  issues.push({ severity: "error", code, message, path });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, path: string, issues: ValidationIssue[]): JsonObject {
  if (!isObject(value)) {
    schemaIssue(issues, path, "expected-object", "Expected a JSON object.");
    return {};
  }
  return value;
}

function rejectUnknownKeys(object: JsonObject, allowed: readonly string[], path: string, issues: ValidationIssue[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allowedSet.has(key)) schemaIssue(issues, `${path}.${key}`, "unknown-field", `Unknown V1 field ${key}.`);
  }
  for (const key of allowed) {
    if (!(key in object) && key !== "description") schemaIssue(issues, `${path}.${key}`, "missing-field", `Missing required field ${key}.`);
  }
}

function readString(object: JsonObject, key: string, path: string, issues: ValidationIssue[]): string {
  const value = object[key];
  if (typeof value !== "string") {
    schemaIssue(issues, `${path}.${key}`, "expected-string", "Expected a string.");
    return "";
  }
  return value;
}

function readLiteral<T extends readonly string[]>(
  object: JsonObject,
  key: string,
  literals: T,
  path: string,
  issues: ValidationIssue[],
): T[number] {
  const value = readString(object, key, path, issues);
  if (!(literals as readonly string[]).includes(value)) {
    schemaIssue(issues, `${path}.${key}`, "invalid-enum", `Expected one of: ${literals.join(", ")}.`);
  }
  return value as T[number];
}

function readStringArray(object: JsonObject, key: string, path: string, issues: ValidationIssue[]): string[] {
  const value = object[key];
  if (!Array.isArray(value)) {
    schemaIssue(issues, `${path}.${key}`, "expected-array", "Expected an array of strings.");
    return [];
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      schemaIssue(issues, `${path}.${key}[${index}]`, "expected-string", "Expected a string.");
      return "";
    }
    return item;
  });
}

function parseRepository(value: unknown, index: number, issues: ValidationIssue[]): ControlIndex["repositories"][number] {
  const itemPath = `$.repositories[${index}]`;
  const object = requireObject(value, itemPath, issues);
  rejectUnknownKeys(object, REPOSITORY_KEYS, itemPath, issues);
  const remote = object.git_remote;
  if (remote !== null && typeof remote !== "string") {
    schemaIssue(issues, `${itemPath}.git_remote`, "expected-nullable-string", "Expected a string or null.");
  }
  return {
    id: readString(object, "id", itemPath, issues),
    kind: readLiteral(object, "kind", REPOSITORY_KINDS, itemPath, issues),
    path: readString(object, "path", itemPath, issues),
    role: readString(object, "role", itemPath, issues),
    visibility: readLiteral(object, "visibility", VISIBILITIES, itemPath, issues),
    git_remote: typeof remote === "string" ? remote : null,
    owns: readStringArray(object, "owns", itemPath, issues),
  };
}

function parseRelationship(value: unknown, index: number, issues: ValidationIssue[]): ControlIndex["relationships"][number] {
  const itemPath = `$.relationships[${index}]`;
  const object = requireObject(value, itemPath, issues);
  rejectUnknownKeys(object, RELATIONSHIP_KEYS, itemPath, issues);
  const description = object.description;
  if (description !== undefined && typeof description !== "string") {
    schemaIssue(issues, `${itemPath}.description`, "expected-string", "Expected a string.");
  }
  return {
    from: readString(object, "from", itemPath, issues),
    to: readString(object, "to", itemPath, issues),
    type: readLiteral(object, "type", RELATIONSHIP_TYPES, itemPath, issues),
    ...(typeof description === "string" ? { description } : {}),
  };
}

function parseArray<T>(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  parse: (item: unknown, index: number, issues: ValidationIssue[]) => T,
): T[] {
  if (!Array.isArray(value)) {
    schemaIssue(issues, path, "expected-array", "Expected an array.");
    return [];
  }
  return value.map((item, index) => parse(item, index, issues));
}

/** Strictly decode an already parsed JSON value and run deterministic V1 validation. */
export function parseControlIndex(value: unknown): ControlIndex {
  const issues: ValidationIssue[] = [];
  const object = requireObject(value, "$", issues);
  rejectUnknownKeys(object, TOP_LEVEL_KEYS, "$", issues);

  const policies = requireObject(object.policies, "$.policies", issues);
  rejectUnknownKeys(policies, POLICY_KEYS, "$.policies", issues);
  const agents = requireObject(object.agents, "$.agents", issues);
  rejectUnknownKeys(agents, AGENT_KEYS, "$.agents", issues);

  const index: ControlIndex = {
    schema: readString(object, "schema", "$", issues) as ControlIndex["schema"],
    workspace_id: readString(object, "workspace_id", "$", issues),
    name: readString(object, "name", "$", issues),
    topology_profile: readLiteral(object, "topology_profile", TOPOLOGY_PROFILES, "$", issues),
    control_repository: readString(object, "control_repository", "$", issues),
    repositories: parseArray(object.repositories, "$.repositories", issues, parseRepository),
    relationships: parseArray(object.relationships, "$.relationships", issues, parseRelationship),
    policies: {
      runtime_dependency_direction: readStringArray(policies, "runtime_dependency_direction", "$.policies", issues),
      dirty_worktree: readString(policies, "dirty_worktree", "$.policies", issues) as ControlIndex["policies"]["dirty_worktree"],
      task_activation: readString(policies, "task_activation", "$.policies", issues) as ControlIndex["policies"]["task_activation"],
      agent_git_workflow: readString(policies, "agent_git_workflow", "$.policies", issues) as ControlIndex["policies"]["agent_git_workflow"],
      merge_and_release: readString(policies, "merge_and_release", "$.policies", issues) as ControlIndex["policies"]["merge_and_release"],
      commit_granularity: readString(policies, "commit_granularity", "$.policies", issues) as ControlIndex["policies"]["commit_granularity"],
      pr_granularity: readString(policies, "pr_granularity", "$.policies", issues) as ControlIndex["policies"]["pr_granularity"],
      user_requirements: readStringArray(policies, "user_requirements", "$.policies", issues),
    },
    agents: {
      template_version: readString(agents, "template_version", "$.agents", issues) as ControlIndex["agents"]["template_version"],
      focus_areas: readStringArray(agents, "focus_areas", "$.agents", issues),
      managed_block_hash: readString(agents, "managed_block_hash", "$.agents", issues),
    },
  };

  const fixedPolicyValues: Array<[keyof ControlIndex["policies"], string]> = [
    ["dirty_worktree", "preserve-unrelated"],
    ["task_activation", "explicit-human-assignment"],
    ["agent_git_workflow", "branch-commit-push-pr-after-validation"],
    ["merge_and_release", "explicit-human-decision"],
    ["commit_granularity", "small-complete-change"],
    ["pr_granularity", "coherent-verified-feature"],
  ];
  for (const [key, expected] of fixedPolicyValues) {
    if (policies[key] !== expected) {
      schemaIssue(issues, `$.policies.${key}`, "invalid-policy-value", `V1 requires ${JSON.stringify(expected)}.`);
    }
  }

  if (issues.length > 0) throw new ControlIndexSchemaError(issues);
  return assertValidControlIndex(index);
}

export function parseControlIndexJson(source: string): ControlIndex {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ControlIndexSchemaError([{ severity: "error", code: "invalid-json", message, path: "$" }]);
  }
  return parseControlIndex(value);
}

export const parseControlIndexText = parseControlIndexJson;

export function serializeControlIndex(index: ControlIndex): string {
  assertValidControlIndex(index);
  return `${JSON.stringify(index, null, 2)}\n`;
}

export const renderControlIndex = serializeControlIndex;
