import * as path from "node:path";
import type {
  ControlIndex,
  RepositoryBinding,
  RepositoryRelationship,
  ValidationIssue,
} from "./types.js";
import { AGENTS_TEMPLATE_VERSION, CONTROL_INDEX_SCHEMA } from "./types.js";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_RUNTIME_DIRECTIONS = new Set(["control->code"]);
const KNOWN_FOCUS_AREAS = new Set([
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
]);

const BUILT_IN_CONTRACTS = {
  control: {
    role: "private planning, tests, documents, verification and release control",
    visibility: "private",
    owns: ["tests", "fixtures", "tools", "docs", "plans", "evidence", "release-records"],
  },
  code: {
    role: "delivered product runtime",
    visibility: "private-now-may-open-source",
    owns: ["runtime", "runtime-required-resources"],
  },
  latex: {
    role: "paper-specific writing and submission materials only",
    visibility: "private",
    owns: ["manuscript", "bibliography", "paper-figures", "submission-materials"],
  },
} as const;

function issue(
  issues: ValidationIssue[],
  severity: "error" | "warning",
  code: string,
  message: string,
  details: Pick<ValidationIssue, "path" | "repositoryId"> = {},
): void {
  issues.push({ severity, code, message, ...details });
}

function normalizedBindingPath(value: string): string {
  return path.normalize(value).replaceAll("\\", "/").replace(/\/$/, "") || ".";
}

function sameStringSet(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length && expected.every((item) => actual.includes(item));
}

function validateBuiltInContract(repository: RepositoryBinding, issues: ValidationIssue[]): void {
  if (repository.kind === "custom") {
    issue(
      issues,
      "error",
      "builtin-custom-kind",
      "Built-in topology profiles cannot contain a custom repository kind.",
      { repositoryId: repository.id },
    );
    return;
  }
  const expected = BUILT_IN_CONTRACTS[repository.kind];
  if (repository.role !== expected.role) {
    issue(
      issues,
      "error",
      "builtin-role-changed",
      `The ${repository.kind} role is fixed by the built-in profile. Select the custom profile to change it.`,
      { repositoryId: repository.id },
    );
  }
  if (repository.visibility !== expected.visibility) {
    issue(
      issues,
      "error",
      "builtin-visibility-changed",
      `The ${repository.kind} visibility is fixed by the built-in profile. Select the custom profile to change it.`,
      { repositoryId: repository.id },
    );
  }
  if (!sameStringSet(repository.owns, expected.owns)) {
    issue(
      issues,
      "error",
      "builtin-ownership-changed",
      `The ${repository.kind} ownership contract is fixed by the built-in profile. Select the custom profile to change it.`,
      { repositoryId: repository.id },
    );
  }
}

function hasRelationship(
  relationships: RepositoryRelationship[],
  from: string,
  to: string,
  type: RepositoryRelationship["type"],
): boolean {
  return relationships.some((relationship) =>
    relationship.from === from && relationship.to === to && relationship.type === type
  );
}

function remoteContainsCredentials(remote: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) return false;
  try {
    const parsed = new URL(remote);
    return parsed.password.length > 0 || /(?:token|key|secret|password|oauth)/i.test(parsed.username);
  } catch {
    return false;
  }
}

export function validateControlIndex(index: ControlIndex): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (index.schema !== CONTROL_INDEX_SCHEMA) {
    issue(issues, "error", "unsupported-schema", `Only ${CONTROL_INDEX_SCHEMA} is supported; found ${String(index.schema)}.`);
  }
  if (!index.workspace_id.trim() || !PORTABLE_ID_PATTERN.test(index.workspace_id)) {
    issue(issues, "error", "invalid-workspace-id", "workspace_id must be a non-empty portable identifier.", { path: "$.workspace_id" });
  }
  if (!index.name.trim()) {
    issue(issues, "error", "empty-workspace-name", "name must not be empty.", { path: "$.name" });
  }
  if (index.agents.template_version !== AGENTS_TEMPLATE_VERSION) {
    issue(issues, "error", "unsupported-agents-template", `Only ${AGENTS_TEMPLATE_VERSION} is supported.`);
  }
  if (!HASH_PATTERN.test(index.agents.managed_block_hash)) {
    issue(issues, "error", "invalid-managed-block-hash", "agents.managed_block_hash must be a lowercase sha256 digest.");
  }

  const ids = new Map<string, RepositoryBinding>();
  const paths = new Map<string, string>();
  for (const repository of index.repositories) {
    if (!repository.id.trim() || !PORTABLE_ID_PATTERN.test(repository.id)) {
      issue(issues, "error", "invalid-repository-id", `Invalid repository id: ${JSON.stringify(repository.id)}.`, { repositoryId: repository.id });
    }
    if (ids.has(repository.id)) {
      issue(issues, "error", "duplicate-repository-id", `Repository id ${repository.id} is bound more than once.`, { repositoryId: repository.id });
    } else {
      ids.set(repository.id, repository);
    }

    if (!repository.path.trim()) {
      issue(issues, "error", "empty-repository-path", "Repository path must not be empty.", { repositoryId: repository.id });
    } else {
      const normalized = normalizedBindingPath(repository.path);
      const previous = paths.get(normalized);
      if (previous) {
        issue(
          issues,
          "error",
          "duplicate-repository-path",
          `Repositories ${previous} and ${repository.id} resolve to the same configured path ${normalized}.`,
          { repositoryId: repository.id, path: repository.path },
        );
      } else {
        paths.set(normalized, repository.id);
      }
    }

    if (!repository.role.trim()) {
      issue(issues, "error", "empty-repository-role", "Repository role must not be empty.", { repositoryId: repository.id });
    }
    if (repository.owns.length === 0) {
      issue(issues, "error", "empty-repository-ownership", "Every repository must own at least one declared artifact class.", { repositoryId: repository.id });
    }
    const owned = new Set<string>();
    for (const artifact of repository.owns) {
      if (!artifact.trim()) {
        issue(issues, "error", "empty-owned-artifact", "Owned artifact names must not be empty.", { repositoryId: repository.id });
      } else if (owned.has(artifact)) {
        issue(issues, "error", "duplicate-owned-artifact", `Repository ${repository.id} lists ${artifact} more than once.`, { repositoryId: repository.id });
      }
      owned.add(artifact);
    }
    if (repository.git_remote && remoteContainsCredentials(repository.git_remote)) {
      issue(issues, "error", "remote-contains-credentials", `Repository ${repository.id} has a credential-bearing remote URL.`, { repositoryId: repository.id });
    } else if (repository.git_remote !== null && !repository.git_remote.trim()) {
      issue(issues, "error", "empty-git-remote", `Repository ${repository.id} must use null rather than an empty remote.`, { repositoryId: repository.id });
    }
  }

  const controls = index.repositories.filter((repository) => repository.kind === "control");
  const codes = index.repositories.filter((repository) => repository.kind === "code");
  const latex = index.repositories.filter((repository) => repository.kind === "latex");
  if (controls.length !== 1) {
    issue(issues, "error", "control-count", `A workspace must contain exactly one control repository; found ${controls.length}.`);
  }
  if (!ids.has(index.control_repository)) {
    issue(issues, "error", "unknown-control-repository", `control_repository references unknown id ${index.control_repository}.`);
  } else if (ids.get(index.control_repository)?.kind !== "control") {
    issue(issues, "error", "wrong-control-repository-kind", `control_repository ${index.control_repository} is not a control repository.`);
  }
  if (controls.length === 1 && normalizedBindingPath(controls[0].path) !== ".") {
    issue(issues, "error", "control-path-not-root", "The control repository binding must be '.'.", { repositoryId: controls[0].id, path: controls[0].path });
  }

  if (index.topology_profile !== "custom") {
    if (codes.length !== 1) {
      issue(issues, "error", "builtin-code-count", `A built-in topology must contain exactly one code repository; found ${codes.length}.`);
    }
    if (index.repositories.length !== controls.length + codes.length + latex.length) {
      issue(issues, "error", "builtin-repository-kind", "Built-in topologies may contain only control, code and latex repositories.");
    }
    if (index.topology_profile === "control-code" && latex.length !== 0) {
      issue(issues, "error", "unexpected-latex", "The control-code profile cannot contain a latex repository.");
    }
    if (index.topology_profile === "control-code-latex" && latex.length === 0) {
      issue(issues, "error", "missing-latex", "The control-code-latex profile requires at least one latex repository.");
    }
    index.repositories.forEach((repository) => validateBuiltInContract(repository, issues));
  }

  const relationshipKeys = new Set<string>();
  for (const relationship of index.relationships) {
    if (!ids.has(relationship.from) || !ids.has(relationship.to)) {
      issue(
        issues,
        "error",
        "unknown-relationship-repository",
        `Relationship ${relationship.from} -> ${relationship.to} references an unknown repository.`,
      );
      continue;
    }
    if (relationship.from === relationship.to) {
      issue(issues, "error", "self-relationship", `Repository ${relationship.from} cannot relate to itself.`);
    }
    const key = `${relationship.from}\u0000${relationship.to}\u0000${relationship.type}`;
    if (relationshipKeys.has(key)) {
      issue(issues, "error", "duplicate-relationship", `Duplicate ${relationship.type} relationship from ${relationship.from} to ${relationship.to}.`);
    }
    relationshipKeys.add(key);

    const from = ids.get(relationship.from)!;
    const to = ids.get(relationship.to)!;
    if (relationship.type === "runtime-depends-on" && !(from.kind === "control" && to.kind === "code")) {
      issue(
        issues,
        "error",
        "forbidden-runtime-dependency",
        `Runtime dependency ${relationship.from} -> ${relationship.to} crosses a protected repository boundary. Only control -> code is allowed.`,
      );
    }
    if (relationship.type === "paper-about" && !(from.kind === "latex" && to.kind === "code")) {
      issue(issues, "error", "invalid-paper-relationship", "paper-about must point from a latex repository to a code repository.");
    }
    if ((relationship.type === "manages" || relationship.type === "tests") && from.kind !== "control") {
      issue(issues, "error", "invalid-control-relationship", `${relationship.type} relationships must originate in the control repository.`);
    }
    if (relationship.type === "custom" && !relationship.description?.trim()) {
      issue(issues, "error", "missing-custom-relationship-description", "A custom relationship requires a non-empty description.");
    }
  }

  if (index.topology_profile !== "custom" && controls.length === 1 && codes.length === 1) {
    const controlId = controls[0].id;
    const codeId = codes[0].id;
    if (!hasRelationship(index.relationships, controlId, codeId, "manages")) {
      issue(issues, "error", "missing-manages-relationship", "The built-in topology requires control to manage code.");
    }
    if (!hasRelationship(index.relationships, controlId, codeId, "tests")) {
      issue(issues, "error", "missing-tests-relationship", "The built-in topology requires control to test code.");
    }
    for (const paper of latex) {
      if (!hasRelationship(index.relationships, paper.id, codeId, "paper-about")) {
        issue(issues, "error", "missing-paper-relationship", `Latex repository ${paper.id} must have a paper-about relationship to ${codeId}.`, { repositoryId: paper.id });
      }
    }
  }

  for (const direction of index.policies.runtime_dependency_direction) {
    if (!SAFE_RUNTIME_DIRECTIONS.has(direction)) {
      issue(issues, "error", "forbidden-runtime-direction", `Runtime dependency direction ${direction} is not allowed in V1.`);
    }
  }
  if (new Set(index.policies.runtime_dependency_direction).size !== index.policies.runtime_dependency_direction.length) {
    issue(issues, "error", "duplicate-runtime-direction", "runtime_dependency_direction contains a duplicate entry.");
  }

  if (index.topology_profile !== "custom" && !sameStringSet(index.policies.runtime_dependency_direction, ["control->code"])) {
    issue(issues, "error", "builtin-runtime-direction-changed", "Built-in profiles require runtime_dependency_direction to be exactly control->code.");
  }

  const fixedPolicies: Array<[string, string, unknown]> = [
    ["dirty_worktree", "preserve-unrelated", index.policies.dirty_worktree],
    ["task_activation", "explicit-human-assignment", index.policies.task_activation],
    ["agent_git_workflow", "branch-commit-push-pr-after-validation", index.policies.agent_git_workflow],
    ["merge_and_release", "explicit-human-decision", index.policies.merge_and_release],
    ["commit_granularity", "small-complete-change", index.policies.commit_granularity],
    ["pr_granularity", "coherent-verified-feature", index.policies.pr_granularity],
  ];
  for (const [name, expected, actual] of fixedPolicies) {
    if (actual !== expected) {
      issue(issues, "error", "invalid-policy-value", `V1 policy ${name} must be ${expected}.`, { path: `$.policies.${name}` });
    }
  }
  index.policies.user_requirements.forEach((requirement, requirementIndex) => {
    if (!requirement.trim()) {
      issue(issues, "error", "empty-user-requirement", "User-specific requirements must not contain empty entries.", { path: `$.policies.user_requirements[${requirementIndex}]` });
    }
  });

  const crossOwned = new Map<string, RepositoryBinding>();
  for (const repository of index.repositories) {
    for (const artifact of repository.owns) {
      const previous = crossOwned.get(artifact);
      // Repeated paper-scoped categories are intentional: each latex repository owns its own paper.
      if (previous && !(previous.kind === "latex" && repository.kind === "latex")) {
        issue(
          issues,
          "error",
          "multiple-artifact-owners",
          `Artifact class ${artifact} is owned by both ${previous.id} and ${repository.id}.`,
          { repositoryId: repository.id },
        );
      } else if (!previous) {
        crossOwned.set(artifact, repository);
      }
    }
  }

  const focusAreas = new Set<string>();
  if (index.agents.focus_areas.length === 0) {
    issue(issues, "error", "empty-focus-areas", "agents.focus_areas must enable at least one known focus module.");
  }
  for (const focus of index.agents.focus_areas) {
    if (!focus.trim()) {
      issue(issues, "error", "empty-focus-area", "agents.focus_areas cannot contain an empty name.");
    } else if (focusAreas.has(focus)) {
      issue(issues, "error", "duplicate-focus-area", `agents.focus_areas contains duplicate ${focus}.`);
    } else if (!KNOWN_FOCUS_AREAS.has(focus)) {
      issue(issues, "error", "unknown-focus-area", `Unknown AGENTS focus module ${focus}.`);
    }
    focusAreas.add(focus);
  }
  if (
    index.topology_profile !== "custom" &&
    (focusAreas.size !== KNOWN_FOCUS_AREAS.size || [...KNOWN_FOCUS_AREAS].some((focus) => !focusAreas.has(focus)))
  ) {
    issue(issues, "error", "builtin-focus-areas-changed", "Built-in profiles must enable the complete V1 AGENTS focus set.");
  }

  return issues;
}

export function hasValidationErrors(issues: ValidationIssue[]): boolean {
  return issues.some((entry) => entry.severity === "error");
}

export class ControlIndexValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(issues.map((entry) => `${entry.code}: ${entry.message}`).join("\n"));
    this.name = "ControlIndexValidationError";
    this.issues = issues;
  }
}

export function assertValidControlIndex(index: ControlIndex): ControlIndex {
  const issues = validateControlIndex(index);
  if (hasValidationErrors(issues)) throw new ControlIndexValidationError(issues);
  return index;
}
