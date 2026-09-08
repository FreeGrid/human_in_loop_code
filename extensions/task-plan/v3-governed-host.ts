import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { issueHumanCapability, type AuthorityContext } from "./authority.ts";
import { assertReadableContract, readableContractMatches, v3Fail, type ReadableContract } from "./v3-contract.ts";
import { currentReadableTask } from "./v3-format.ts";
import { readReadablePlan, type ReadablePlanSnapshot } from "./v3-file.ts";
import type { SandboxedProcessRequest, SandboxedProcessResult } from "./execution-sandbox.ts";
import type { V3Governed, V3GovernedAction, V3GovernedStatus } from "./v3-governed.ts";

/** Trusted host composition only. Never accept a factory or context from a model tool. */
export type V3GovernedFactory = (path: string, ctx: ExtensionContext) => V3Governed | Promise<V3Governed>;
const actions = ["prepare", "status", "approve", "authorize", "verify", "review", "finalize", "recover"] as const;
type CommandAction = typeof actions[number];
const humanActions: Partial<Record<CommandAction, V3GovernedAction>> = {
  approve: "approve_contract", authorize: "authorize_execution", finalize: "finalize", recover: "recover",
};
const labels: Partial<Record<CommandAction, string>> = {
  approve: "Approve this optional governed contract?",
  authorize: "Authorize this optional governed execution?",
  finalize: "Finalize this optional governed task?",
  recover: "Recover this interrupted governed operation?",
};
function list(values: readonly string[]): string { return values.length ? values.map(value => `  - ${value}`).join("\n") : "  (none)"; }
function sourceBinding(source: ReadablePlanSnapshot, context: AuthorityContext): void {
  if (source.document_hash !== context.document_hash || source.plan.plan_id !== context.plan_id) v3Fail("confirmation_source_changed");
}
function contractDisplay(source: ReadablePlanSnapshot, context: AuthorityContext, contract: ReadableContract | null): string {
  if (!contract) v3Fail("confirmation_contract_missing");
  assertReadableContract(contract); sourceBinding(source, context);
  const current = currentReadableTask(source.plan);
  if (contract.contract_hash !== context.contract_hash || contract.plan_id !== context.plan_id || contract.node_id !== context.node_id || current?.id !== context.node_id || !readableContractMatches(source.plan, contract)) v3Fail("confirmation_contract_changed");
  const criteria = contract.policy.criteria.map(criterion => {
    const location = criterion.source.kind === "brief" ? "brief" : criterion.source.kind === "task" ? contract.node_id : `${contract.node_id}, subtask ${criterion.source.index! + 1}`;
    return `  - ${criterion.source.quote}\n    Source: ${location}\n    Verification: ${criterion.command_or_method}\n    Inputs: ${criterion.inputs.length ? criterion.inputs.join(", ") : "(none)"}`;
  }).join("\n");
  return [
    `Plan: ${source.path}`, `Brief:\n${source.plan.brief}`, `Current task: ${current.id} — ${current.text}`,
    ...(contract.definition.subtasks.length ? [`Current subtasks:\n${list(contract.definition.subtasks)}`] : []),
    `Target root: ${context.target_root}`, `Governance root: ${context.governance_root}`,
    `Read scope:\n${list(contract.policy.read_scope)}`, `Write scope:\n${list(contract.policy.write_scope)}`,
    `Forbidden scope:\n${list(contract.policy.forbidden_scope)}`, `Allowed executables:\n${list(contract.policy.allowed_executables)}`,
    `Criteria and methods:\n${criteria}`, `Governed dependencies:\n${list(contract.policy.dependencies)}`,
    "Contract approval and execution authorization are separate decisions. Final completion also requires current verification and independent review.",
  ].join("\n\n");
}
function recoveryDisplay(source: ReadablePlanSnapshot, context: AuthorityContext): string {
  sourceBinding(source, context);
  const target = source.plan.tasks.find(task => task.id === context.node_id);
  return [
    `Plan: ${source.path}`, `Brief:\n${source.plan.brief}`,
    `Recovery target: ${context.node_id}${target ? ` — ${target.text}` : " (no longer present in the current readable plan)"}`,
    `Target root: ${context.target_root}`, `Governance root: ${context.governance_root}`,
    "Recover the inspected interrupted governed state and release only a proven dead writer's lock. If an accepted completion is pending, replay its exact saved checkbox update only when the readable file still matches the saved source.",
    "Later manual edits and revoked task definitions are preserved. This decision does not authorize new execution.",
  ].join("\n\n");
}
function summary(action: CommandAction, status: V3GovernedStatus): string {
  const node = status.contract?.node_id;
  if (status.stage === "invalidated") return `Governed ${node}: definition changed; prepare a new revision before continuing.`;
  if (action === "verify") return `Verification passed for ${node}.`;
  if (action === "review") return `Independent review passed for ${node}.`;
  if (action === "recover") return `Governed state recovered${node ? ` for ${node}` : ""}${status.projection === "projected" ? "; completion is recorded" : ""}.`;
  if (!node) return "Optional governed execution is not prepared.";
  const completion = status.verified_completed_ids.includes(node) ? "; verified completion is current" : status.ordinary_completed_ids.includes(node) ? "; ordinary checkbox is complete" : "; task remains open";
  return `Governed ${node}: ${status.stage}${completion}.`;
}

/** Only explicit Human commands select actors. A model run cannot configure or discover a runtime. */
export class V3GovernedHost {
  readonly #factory: V3GovernedFactory;
  readonly #actors = new Map<string, V3Governed>();
  #generation = 0;
  constructor(factory: V3GovernedFactory) { this.#factory = factory; }
  clear(): void { this.#generation++; this.#actors.clear(); }
  private live(generation: number): void { if (generation !== this.#generation) v3Fail("governed_selection_cleared"); }
  private binding(actor: V3Governed, source: ReadablePlanSnapshot): void {
    if (actor.planPath !== source.path) v3Fail("governed_factory_plan_mismatch");
  }
  async command(action: string, path: string, ctx: ExtensionContext): Promise<string> {
    if (!actions.includes(action as CommandAction)) v3Fail("unknown_governed_command");
    const selectedAction = action as CommandAction, authorityAction = humanActions[selectedAction];
    if (authorityAction && (ctx.hasUI !== true || typeof ctx.ui?.confirm !== "function")) return "Human confirmation UI is unavailable; no authority granted.";
    const generation = this.#generation, selected = await readReadablePlan(path);
    this.live(generation);
    let actor = this.#actors.get(selected.path);
    if (!actor) {
      actor = await this.#factory(selected.path, ctx);
      this.live(generation); this.binding(actor, selected);
      const current = await readReadablePlan(path); this.live(generation);
      if (current.path !== selected.path) v3Fail("governed_selection_path_changed");
      this.binding(actor, current); this.#actors.set(selected.path, actor);
    }
    this.binding(actor, selected);
    let result: V3GovernedStatus;
    if (authorityAction) {
      // Capture first. Reissuing after the UI would authorize text the Human never saw.
      const context = await actor.context(authorityAction);
      const status = selectedAction === "recover" ? null : await actor.status();
      const displaySource = await readReadablePlan(path); this.live(generation); this.binding(actor, displaySource);
      const body = selectedAction === "recover" ? recoveryDisplay(displaySource, context) : contractDisplay(displaySource, context, status!.contract);
      const accepted = await ctx.ui.confirm(labels[selectedAction]!, body);
      this.live(generation);
      if (accepted !== true) return "Cancelled; no authority granted.";
      const current = await readReadablePlan(path); this.live(generation); this.binding(actor, current);
      const capability = issueHumanCapability(authorityAction, context, { source: "slash", input_id: randomUUID(), text: `Human confirmed optional governed ${selectedAction} for ${context.node_id} at ${selected.path}` });
      // The kernel checks the original context against the post-UI source and state.
      result = selectedAction === "approve" ? await actor.approve(capability)
        : selectedAction === "authorize" ? await actor.authorize(capability)
        : selectedAction === "finalize" ? await actor.finalize(capability)
        : await actor.recoverProjection(capability);
    } else {
      result = selectedAction === "prepare" ? await actor.prepare()
        : selectedAction === "verify" ? await actor.verify()
        : selectedAction === "review" ? await actor.review()
        : await actor.status();
    }
    return summary(selectedAction, result);
  }
  async run(path: string, request: SandboxedProcessRequest, abortSignal?: AbortSignal): Promise<SandboxedProcessResult> {
    abortSignal?.throwIfAborted();
    const generation = this.#generation, source = await readReadablePlan(path); this.live(generation);
    const actor = this.#actors.get(source.path) ?? v3Fail("governed_actor_not_selected_use_command");
    this.binding(actor, source);
    return actor.run(request, abortSignal);
  }
}
