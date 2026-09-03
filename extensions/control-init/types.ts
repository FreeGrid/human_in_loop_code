export const CONTROL_INDEX_SCHEMA = "human-in-loop/control-index/v1" as const;
export const AGENTS_TEMPLATE_VERSION = "control-agents/v1" as const;

export type TopologyProfile = "control-code" | "control-code-latex" | "custom";
export type RepositoryKind = "control" | "code" | "latex" | "custom";
export type BuiltInRepositoryKind = Exclude<RepositoryKind, "custom">;
export type RepositoryVisibility = "private" | "private-now-may-open-source" | "public" | "unspecified";

export interface RepositoryBinding {
  id: string;
  kind: RepositoryKind;
  path: string;
  role: string;
  visibility: RepositoryVisibility;
  git_remote: string | null;
  owns: string[];
}

export interface RepositoryRelationship {
  from: string;
  to: string;
  type: "manages" | "tests" | "paper-about" | "runtime-depends-on" | "custom";
  description?: string;
}

export interface ControlPolicies {
  runtime_dependency_direction: string[];
  dirty_worktree: "preserve-unrelated";
  task_activation: "explicit-human-assignment";
  agent_git_workflow: "branch-commit-push-pr-after-validation";
  merge_and_release: "explicit-human-decision";
  commit_granularity: "small-complete-change";
  pr_granularity: "coherent-verified-feature";
  user_requirements: string[];
}

export interface ControlIndex {
  schema: typeof CONTROL_INDEX_SCHEMA;
  workspace_id: string;
  name: string;
  topology_profile: TopologyProfile;
  control_repository: string;
  repositories: RepositoryBinding[];
  relationships: RepositoryRelationship[];
  policies: ControlPolicies;
  agents: {
    template_version: typeof AGENTS_TEMPLATE_VERSION;
    focus_areas: string[];
    managed_block_hash: string;
  };
}

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  path?: string;
  repositoryId?: string;
}

export interface LatexRepositoryInput {
  id: string;
  path?: string;
}

export interface CustomRepositoryInput {
  id: string;
  kind: RepositoryKind;
  path?: string;
  role: string;
  visibility: RepositoryVisibility;
  owns: string[];
  gitRemote?: string | null;
}

export type AgentsExistingStrategy = "append-managed-block" | "preview-only";

export interface BootstrapAuthorization {
  /** Exact absolute paths the human approved creating before this call. */
  create?: string[];
  /** Exact absolute paths the human approved initializing in place before this call. */
  initialize?: string[];
}

export interface InitWorkspaceInput {
  controlPath?: string;
  codePath?: string;
  latexRepositories?: LatexRepositoryInput[];
  topologyProfile?: TopologyProfile;
  workspaceId?: string;
  name?: string;
  userRequirements?: string[];
  /** Explicit focus-module selection; accepted only for custom topologies. */
  focusAreas?: string[];
  customRepositories?: CustomRepositoryInput[];
  customRelationships?: RepositoryRelationship[];
  agentsExistingStrategy?: AgentsExistingStrategy;
  bootstrap?: BootstrapAuthorization;
}

export interface UpdateWorkspaceInput extends InitWorkspaceInput {
  /** Original request retained for the durable update summary. */
  changeRequest?: string;
  /** Required before replacing a manually changed managed AGENTS block. */
  acceptManagedBlockDrift?: boolean;
  /** Repository IDs whose newly inspected remote identity the human accepted. */
  acceptRemoteIdentityChanges?: string[];
}

export interface InputQuestion {
  id: string;
  prompt: string;
  kind: "path" | "text" | "choice" | "confirmation" | "repositories";
  repositoryId?: string;
  choices?: string[];
}

export interface SimilarPathCandidate {
  path: string;
  score: number;
  gitRoot: string | null;
  gitRemote: string | null;
}

export interface ConflictDetail {
  code: string;
  message: string;
  path?: string;
  choices?: string[];
  candidates?: SimilarPathCandidate[];
}

export interface RepositoryStatus {
  id: string;
  kind: RepositoryKind;
  configuredPath: string;
  absolutePath: string;
  exists: boolean;
  gitRoot: string | null;
  branch: string | null;
  dirty: boolean | null;
  gitRemote: string | null;
  remoteMatches: boolean | null;
}

export interface OperationSummary {
  profile?: TopologyProfile;
  workspaceId?: string;
  repositories?: RepositoryStatus[];
  files?: Array<{ path: string; action: "created" | "updated" | "unchanged" }>;
  agentsHighlights?: string[];
  warnings?: string[];
  incomplete?: string[];
  changes?: string[];
  index?: ControlIndex;
  /** Exact marker-bounded content used by Human-UI previews. */
  agentsPreview?: {
    before: string | null;
    after: string;
  };
  /** Opaque compare token used by Human-UI preview/apply handoff. */
  previewToken?: string;
}

export type OperationResult =
  | { status: "applied"; summary: OperationSummary }
  | { status: "needs_input"; questions: InputQuestion[]; summary?: OperationSummary }
  | { status: "conflict"; conflicts: ConflictDetail[]; summary?: OperationSummary };

export interface DoctorReport {
  status: "applied" | "conflict";
  ok: boolean;
  issues: ValidationIssue[];
  summary: OperationSummary;
}

export interface CandidateWorkspace {
  index: ControlIndex;
  controlRoot: string;
  indexPath: string;
  agentsPath: string;
  managedBlock: string;
  repositories: RepositoryStatus[];
}
