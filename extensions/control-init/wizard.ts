import { isAbsolute, resolve } from "node:path";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { renderOperationResult, renderSummary } from "./operation-result.js";
import { ControlWorkspaceService } from "./operations.js";
import { resolveCanonicalPath } from "./path-binding.js";
import { findSimilarPaths } from "./path-similarity.js";
import { planRepositoryBootstrap } from "./repository-bootstrap.js";
import type {
  BootstrapAuthorization,
  ControlIndex,
  InitWorkspaceInput,
  OperationResult,
  UpdateWorkspaceInput,
} from "./types.js";

export type WizardContext = Pick<ExtensionCommandContext, "cwd" | "hasUI" | "ui">;

interface PathSlot {
  id: string;
  get(): string | undefined;
  set(value: string): void;
}

const PROFILE_CONTROL_CODE = "Recommended — control + code";
const PROFILE_WITH_LATEX = "Optional — control + code + one LaTeX repository per paper";
const PROFILE_CUSTOM = "Advanced — custom topology";
const RETURN_TO_MODIFY = "Return to modify answers";
const CANCEL_WITHOUT_CHANGES = "Cancel without changes";

function cancelled(ctx: WizardContext): false {
  ctx.ui.notify("Control workspace operation cancelled. State was not changed.", "info");
  return false;
}

function requireUI(ctx: WizardContext, operation: string): boolean {
  if (ctx.hasUI) return true;
  ctx.ui.notify(`${operation} requires a Human UI. Use the structured control_workspace tool in print/JSON mode.`, "error");
  return false;
}

async function requestRevision(ctx: WizardContext): Promise<"revise" | "stop"> {
  const choice = await ctx.ui.select("The preview was not applied", [RETURN_TO_MODIFY, CANCEL_WITHOUT_CHANGES]);
  if (choice === RETURN_TO_MODIFY) return "revise";
  cancelled(ctx);
  return "stop";
}

function pathSlots(input: InitWorkspaceInput, partial: boolean): PathSlot[] {
  if (input.topologyProfile === "custom") {
    return (input.customRepositories ?? []).map((repository) => ({
      id: repository.id,
      get: () => repository.path ?? (repository.kind === "control" ? input.controlPath : undefined),
      set: (value) => {
        repository.path = value;
        if (repository.kind === "control") input.controlPath = value;
      },
    }));
  }
  const slots: PathSlot[] = [];
  if (!partial || input.controlPath !== undefined) {
    slots.push({ id: "control", get: () => input.controlPath, set: (value) => { input.controlPath = value; } });
  }
  if (!partial || input.codePath !== undefined) {
    slots.push({ id: "code", get: () => input.codePath, set: (value) => { input.codePath = value; } });
  }
  for (const paper of input.latexRepositories ?? []) {
    slots.push({ id: paper.id, get: () => paper.path, set: (value) => { paper.path = value; } });
  }
  return slots;
}

function addAuthorizedPath(authorization: BootstrapAuthorization, kind: "create" | "initialize", path: string): void {
  const values = authorization[kind] ?? [];
  if (!values.includes(path)) values.push(path);
  authorization[kind] = values;
}

async function collectBootstrapAuthorization(
  input: InitWorkspaceInput,
  ctx: WizardContext,
  partial = false,
): Promise<boolean> {
  const authorization: BootstrapAuthorization = {
    create: [...(input.bootstrap?.create ?? [])],
    initialize: [...(input.bootstrap?.initialize ?? [])],
  };

  for (const slot of pathSlots(input, partial)) {
    for (;;) {
      const entered = slot.get()?.trim();
      if (!entered) return cancelled(ctx);
      let canonical: string;
      try {
        canonical = (await resolveCanonicalPath(entered, ctx.cwd)).canonicalPath;
      } catch (error) {
        ctx.ui.notify(`${slot.id}: ${error instanceof Error ? error.message : String(error)}`, "error");
        const replacement = await ctx.ui.input(`Enter another directory for ${slot.id}`);
        if (replacement === undefined || !replacement.trim()) return cancelled(ctx);
        slot.set(replacement.trim());
        continue;
      }

      const planned = await planRepositoryBootstrap(canonical, authorization);
      if (planned.status === "ready") break;
      if (planned.code === "bootstrap-authorization-required" && planned.plannedAction === "create-and-init") {
        const candidates = await findSimilarPaths(canonical);
        const candidateOptions = candidates.map((candidate) => `Use existing candidate: ${candidate.path}`);
        const createOption = `None are correct — create ${canonical} and run local git init`;
        const reenterOption = "Enter a different directory";
        const choice = await ctx.ui.select(
          `${slot.id} does not exist. Similar direct-child directories are suggestions only.`,
          [...candidateOptions, createOption, reenterOption],
        );
        if (choice === undefined) return cancelled(ctx);
        const candidateIndex = candidateOptions.indexOf(choice);
        if (candidateIndex >= 0) {
          slot.set(candidates[candidateIndex].path);
          continue;
        }
        if (choice === reenterOption) {
          const replacement = await ctx.ui.input(`Enter another directory for ${slot.id}`);
          if (replacement === undefined || !replacement.trim()) return cancelled(ctx);
          slot.set(replacement.trim());
          continue;
        }
        addAuthorizedPath(authorization, "create", canonical);
        continue;
      }
      if (planned.code === "bootstrap-authorization-required" && planned.plannedAction === "initialize-existing") {
        const approved = await ctx.ui.confirm(
          `Initialize existing directory for ${slot.id}?`,
          `Preserve every existing file in ${canonical} and run local git init. This creates no remote, commit, or push.`,
        );
        if (!approved) return cancelled(ctx);
        addAuthorizedPath(authorization, "initialize", canonical);
        continue;
      }

      ctx.ui.notify(`${slot.id}: ${planned.message}\nPath: ${planned.path}`, "error");
      const replacement = await ctx.ui.input(`Choose a separate repository directory for ${slot.id}`);
      if (replacement === undefined || !replacement.trim()) return cancelled(ctx);
      slot.set(replacement.trim());
    }
  }
  input.bootstrap = authorization;
  return true;
}

function previewText(result: Extract<OperationResult, { status: "applied" }>): string {
  const index = result.summary.index;
  const indexPreview = index ? `\n\nCONTROL_INDEX.json preview:\n${JSON.stringify(index, null, 2)}` : "";
  const agents = result.summary.agentsPreview;
  const agentsPreview = !agents
    ? ""
    : agents.before === null
      ? `\n\nAGENTS.md managed block to append:\n${agents.after}`
      : agents.before === agents.after
        ? `\n\nAGENTS.md managed block (unchanged):\n${agents.after}`
        : `\n\nAGENTS.md managed block before:\n${agents.before}\n\nAGENTS.md managed block after:\n${agents.after}`;
  return `${renderOperationResult(result)}${indexPreview}${agentsPreview}`;
}

async function resolveInitConflict(
  result: Extract<OperationResult, { status: "conflict" }>,
  input: InitWorkspaceInput,
  ctx: WizardContext,
): Promise<"retry" | "revise" | "stop" | "preview-only"> {
  if (result.conflicts.length === 1 && result.conflicts[0].code === "unmanaged-agents-file") {
    const choice = await ctx.ui.select(
      "Existing AGENTS.md is human-owned",
      ["Preserve it byte-for-byte and append the managed block", "Preview only; write nothing"],
    );
    if (choice === "Preserve it byte-for-byte and append the managed block") {
      input.agentsExistingStrategy = "append-managed-block";
      return "retry";
    }
    if (choice === "Preview only; write nothing") {
      input.agentsExistingStrategy = "preview-only";
      return "preview-only";
    }
    cancelled(ctx);
    return "stop";
  }
  ctx.ui.notify(renderOperationResult(result), "error");
  return requestRevision(ctx);
}

async function chooseControlPath(ctx: WizardContext): Promise<string | undefined> {
  const choice = await ctx.ui.select(
    "Control repository directory",
    [`Use current directory: ${ctx.cwd}`, "Enter another directory"],
  );
  if (choice?.startsWith("Use current directory:")) return ctx.cwd;
  if (choice === "Enter another directory") {
    const entered = await ctx.ui.editor("Control repository directory", ctx.cwd);
    return entered?.trim() || undefined;
  }
  return undefined;
}

async function collectCustomInput(ctx: WizardContext): Promise<InitWorkspaceInput | undefined> {
  const prefill = JSON.stringify({
    repositories: [
      { id: "control", kind: "control", path: ctx.cwd, role: "private control plane", visibility: "private", owns: ["plans", "tests", "evidence"] },
      { id: "code", kind: "code", path: "", role: "delivered runtime", visibility: "private-now-may-open-source", owns: ["runtime"] },
    ],
    relationships: [
      { from: "control", to: "code", type: "manages" },
      { from: "control", to: "code", type: "tests" },
    ],
    focusAreas: [
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
    ],
  }, null, 2);
  let draft = prefill;
  for (;;) {
    const source = await ctx.ui.editor(
      "Custom topology JSON: define every repository path, role, visibility, ownership, and relationship",
      draft,
    );
    if (source === undefined) return undefined;
    try {
      const parsed = JSON.parse(source) as {
        repositories?: InitWorkspaceInput["customRepositories"];
        relationships?: InitWorkspaceInput["customRelationships"];
        focusAreas?: InitWorkspaceInput["focusAreas"];
      };
      return {
        topologyProfile: "custom",
        customRepositories: parsed.repositories,
        customRelationships: parsed.relationships,
        focusAreas: parsed.focusAreas,
        controlPath: parsed.repositories?.find((repository) => repository.kind === "control")?.path,
      };
    } catch (error) {
      ctx.ui.notify(`Custom topology JSON is invalid: ${error instanceof Error ? error.message : String(error)}`, "error");
      draft = source;
    }
  }
}

async function runInitWizardAttempt(ctx: WizardContext): Promise<"revise" | void> {
  const profileChoice = await ctx.ui.select("Choose a topology", [PROFILE_CONTROL_CODE, PROFILE_WITH_LATEX, PROFILE_CUSTOM]);
  if (profileChoice === undefined) {
    cancelled(ctx);
    return;
  }

  let input: InitWorkspaceInput;
  if (profileChoice === PROFILE_CUSTOM) {
    const custom = await collectCustomInput(ctx);
    if (!custom) {
      cancelled(ctx);
      return;
    }
    input = custom;
  } else {
    const controlPath = await chooseControlPath(ctx);
    if (!controlPath) {
      cancelled(ctx);
      return;
    }
    const codePath = await ctx.ui.input("Exact code repository directory (no automatic discovery)");
    if (codePath === undefined || !codePath.trim()) {
      cancelled(ctx);
      return;
    }
    input = {
      topologyProfile: profileChoice === PROFILE_WITH_LATEX ? "control-code-latex" : "control-code",
      controlPath,
      codePath: codePath.trim(),
    };
    if (profileChoice === PROFILE_WITH_LATEX) {
      const countSource = await ctx.ui.input("Number of independent paper repositories", "1");
      const count = Number(countSource);
      if (!Number.isSafeInteger(count) || count < 1) {
        ctx.ui.notify("Paper repository count must be a positive integer.", "error");
        return;
      }
      input.latexRepositories = [];
      for (let index = 0; index < count; index += 1) {
        const id = await ctx.ui.input(`Paper ${index + 1} short ID`);
        const path = await ctx.ui.input(`Exact directory for paper ${index + 1}`);
        if (!id?.trim() || !path?.trim()) {
          cancelled(ctx);
          return;
        }
        input.latexRepositories.push({ id: id.trim(), path: path.trim() });
      }
    }
  }

  const exceptions = await ctx.ui.editor(
    "Do the defaults fit? Enter all special directory, responsibility, privacy, or collaboration requirements; leave empty for none",
    "",
  );
  if (exceptions === undefined) {
    cancelled(ctx);
    return;
  }
  if (exceptions.trim()) input.userRequirements = [exceptions.trim()];
  if (!(await collectBootstrapAuthorization(input, ctx))) return;

  const service = new ControlWorkspaceService(ctx.cwd);
  let preview = await service.init(input, { dryRun: true });
  if (preview.status === "conflict") {
    const resolution = await resolveInitConflict(preview, input, ctx);
    if (resolution === "stop") return;
    if (resolution === "revise") return "revise";
    preview = await service.init(input, { dryRun: true });
    if (preview.status !== "applied") {
      ctx.ui.notify(renderOperationResult(preview), preview.status === "conflict" ? "error" : "warning");
      return (await requestRevision(ctx)) === "revise" ? "revise" : undefined;
    }
    if (resolution === "preview-only") {
      ctx.ui.notify(previewText(preview), "info");
      return;
    }
  }
  if (preview.status !== "applied") {
    ctx.ui.notify(renderOperationResult(preview), "warning");
    return (await requestRevision(ctx)) === "revise" ? "revise" : undefined;
  }

  ctx.ui.notify(previewText(preview), "info");
  const approved = await ctx.ui.confirm(
    "Apply this control workspace initialization?",
    "Create only the listed local repositories/Git metadata and write the shown CONTROL_INDEX.json plus managed AGENTS block? No remote, commit, push, merge, or release will run.",
  );
  if (!approved) {
    return (await requestRevision(ctx)) === "revise" ? "revise" : undefined;
  }
  const applied = await service.init(input, { expectedPreviewToken: preview.summary.previewToken });
  ctx.ui.notify(renderOperationResult(applied), applied.status === "applied" ? "info" : "error");
}

export async function runInitWizard(ctx: WizardContext): Promise<void> {
  if (!requireUI(ctx, "/control:init")) return;
  ctx.ui.notify(
    "Built-in profiles keep control private, code delivery-only and potentially public, tests/plans/evidence in control, dependencies one-way, focused commits pushed to a verified PR after explicit task assignment, and merge/release human-controlled. The paper profile adds one independent private LaTeX repository per paper.",
    "info",
  );
  while (await runInitWizardAttempt(ctx) === "revise") {
    ctx.ui.notify("Returning to initialization answers. Review the new preview before applying.", "info");
  }
}

function currentPath(index: ControlIndex, controlRoot: string, id: string): string {
  const repository = index.repositories.find((entry) => entry.id === id);
  if (!repository) throw new Error(`Unknown repository ${id}`);
  return isAbsolute(repository.path) ? repository.path : resolve(controlRoot, repository.path);
}

async function collectStructuredUpdate(
  request: string,
  index: ControlIndex,
  controlRoot: string,
  ctx: WizardContext,
): Promise<UpdateWorkspaceInput | undefined> {
  const categories = [
    "Move or rebind the code repository",
    "Add one paper repository",
    "Remove one paper repository binding",
    "Change the workspace name",
    "Replace user-specific requirements",
    "Advanced or combined structured update",
  ];
  const category = await ctx.ui.select("Which part of the workspace changed?", categories);
  if (!category) return undefined;
  const base: UpdateWorkspaceInput = { controlPath: controlRoot, changeRequest: request };

  if (category === categories[0]) {
    const path = await ctx.ui.input("New exact code repository directory");
    return path?.trim() ? { ...base, codePath: path.trim() } : undefined;
  }
  if (category === categories[1]) {
    const id = await ctx.ui.input("New paper repository short ID");
    const path = await ctx.ui.input("New paper repository exact directory");
    if (!id?.trim() || !path?.trim()) return undefined;
    const existing = index.repositories
      .filter((repository) => repository.kind === "latex")
      .map((repository) => ({ id: repository.id, path: currentPath(index, controlRoot, repository.id) }));
    return { ...base, topologyProfile: "control-code-latex", latexRepositories: [...existing, { id: id.trim(), path: path.trim() }] };
  }
  if (category === categories[2]) {
    const papers = index.repositories.filter((repository) => repository.kind === "latex");
    if (papers.length === 0) {
      ctx.ui.notify("No paper repository is currently bound.", "warning");
      return undefined;
    }
    const id = await ctx.ui.select("Repository binding to remove (disk data will remain)", papers.map((paper) => paper.id));
    if (!id) return undefined;
    const remaining = papers.filter((paper) => paper.id !== id).map((paper) => ({ id: paper.id, path: currentPath(index, controlRoot, paper.id) }));
    return {
      ...base,
      topologyProfile: remaining.length ? "control-code-latex" : "control-code",
      latexRepositories: remaining,
    };
  }
  if (category === categories[3]) {
    const name = await ctx.ui.input("New workspace display name", index.name);
    return name?.trim() ? { ...base, name: name.trim() } : undefined;
  }
  if (category === categories[4]) {
    const source = await ctx.ui.editor("One user-specific requirement per line", index.policies.user_requirements.join("\n"));
    return source === undefined ? undefined : { ...base, userRequirements: source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) };
  }

  let draft = JSON.stringify({ name: index.name }, null, 2);
  for (;;) {
    const source = await ctx.ui.editor("Structured update JSON (omit unaffected fields)", draft);
    if (source === undefined) return undefined;
    try {
      const parsed = JSON.parse(source) as UpdateWorkspaceInput;
      return { ...parsed, controlPath: controlRoot, changeRequest: request };
    } catch (error) {
      ctx.ui.notify(`Structured update JSON is invalid: ${error instanceof Error ? error.message : String(error)}`, "error");
      draft = source;
    }
  }
}

async function resolveUpdateConflicts(
  result: Extract<OperationResult, { status: "conflict" }>,
  input: UpdateWorkspaceInput,
  ctx: WizardContext,
): Promise<boolean> {
  const drift = result.conflicts.filter((entry) => entry.code === "agents-managed-block-drift");
  if (drift.length) {
    const approved = await ctx.ui.confirm("Managed AGENTS block drift detected", "Regenerate only the marker-bounded managed block and preserve all human-owned bytes outside it?");
    if (!approved) return false;
    input.acceptManagedBlockDrift = true;
  }
  const remotes = result.conflicts.filter((entry) => entry.code === "remote-identity-drift");
  if (remotes.length) {
    input.acceptRemoteIdentityChanges ??= [];
    for (const remote of remotes) {
      const id = remote.message.split(" remote changed", 1)[0];
      const approved = await ctx.ui.confirm(`Remote identity changed for ${id}`, `${remote.message}\nAccept this inspected identity in the updated index?`);
      if (!approved) return false;
      if (!input.acceptRemoteIdentityChanges.includes(id)) input.acceptRemoteIdentityChanges.push(id);
    }
  }
  return drift.length + remotes.length === result.conflicts.length;
}

async function runUpdateWizardAttempt(ctx: WizardContext, controlPath: string): Promise<"revise" | void> {
  const service = new ControlWorkspaceService(ctx.cwd);
  const current = await service.status(controlPath);
  if (current.status !== "applied" || !current.summary.index) {
    ctx.ui.notify(renderOperationResult(current), current.status === "conflict" ? "error" : "warning");
    return;
  }
  const resolvedControlRoot = current.summary.repositories?.find((repository) => repository.kind === "control")?.absolutePath
    ?? (isAbsolute(controlPath) ? controlPath : resolve(ctx.cwd, controlPath));
  ctx.ui.notify(`Current state:\n${renderSummary(current.summary)}`, "info");
  const request = await ctx.ui.editor("Describe what changed", "");
  if (request === undefined || !request.trim()) {
    cancelled(ctx);
    return;
  }
  const input = await collectStructuredUpdate(request.trim(), current.summary.index, resolvedControlRoot, ctx);
  if (!input) {
    cancelled(ctx);
    return;
  }
  if (!(await collectBootstrapAuthorization(input, ctx, true))) return;

  let preview = await service.update(input, { dryRun: true });
  if (preview.status === "conflict" && await resolveUpdateConflicts(preview, input, ctx)) {
    preview = await service.update(input, { dryRun: true });
  }
  if (preview.status !== "applied") {
    ctx.ui.notify(renderOperationResult(preview), preview.status === "conflict" ? "error" : "warning");
    return (await requestRevision(ctx)) === "revise" ? "revise" : undefined;
  }
  ctx.ui.notify(`Before:\n${renderSummary(current.summary)}\n\nCandidate after:\n${previewText(preview)}`, "info");
  const approved = await ctx.ui.confirm(
    "Apply this control workspace update?",
    "Apply only the shown binding/index/managed-block changes and approved local git init actions? Removed bindings leave all disk data intact.",
  );
  if (!approved) {
    return (await requestRevision(ctx)) === "revise" ? "revise" : undefined;
  }
  const applied = await service.update(input, { expectedPreviewToken: preview.summary.previewToken });
  ctx.ui.notify(renderOperationResult(applied), applied.status === "applied" ? "info" : "error");
}

export async function runUpdateWizard(ctx: WizardContext, controlPath = ctx.cwd): Promise<void> {
  if (!requireUI(ctx, "/control:update")) return;
  while (await runUpdateWizardAttempt(ctx, controlPath) === "revise") {
    ctx.ui.notify("Returning to update answers. Current state will be shown again before a new preview.", "info");
  }
}
