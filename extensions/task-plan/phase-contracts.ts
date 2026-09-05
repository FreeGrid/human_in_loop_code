import type { ExecutionNote } from "./execution-notes.ts";

export interface PhaseContext {
  execute_id: string;
  phase_id: string;
  round: number;
  plan_path: string;
  target_root: string;
  governance_root: string;
}

/** Reference only. The provider owns uncommitted runtime baseline data, never task state. */
export interface BaselineReference { id: string; initial_version: string }
export interface BaselineProvider {
  capture(context: PhaseContext): Promise<BaselineReference>;
  /** Throws on missing/foreign baseline; returns current content identity without resetting it. */
  verify(context: PhaseContext, baseline: BaselineReference): Promise<string>;
}

export interface DocSyncGateResult {
  status: "passed" | "with_debt" | "with_exceptions" | "blocked";
  summary: string;
  verified_version: string;
  debt_refs: string[];
  human_exceptions: string[];
}
export interface DocSyncGate {
  /** A passing result certifies required durable debt/exception records have already been saved. */
  check(input: { context: PhaseContext; baseline: BaselineReference; content_version: string; notes: Record<string, ExecutionNote> }): Promise<DocSyncGateResult>;
}

export interface MaintainerBudget { max_context_fetches: number; max_context_tokens: number; timeout_seconds: number }
export interface MaintainerStart {
  execute_id: string;
  content_version: string;
  budget: Readonly<MaintainerBudget>;
  authorized_documents: readonly string[];
}
export type MaintainerStep = { kind: "classify" | "context" | "correct" | "write"; payload: unknown };
export type MaintainerReply =
  | { kind: "result"; execute_id: string; content_version: string; payload: unknown }
  | { kind: "need_context"; execute_id: string; request: unknown }
  | { kind: "error"; message: string };
export interface MaintainerRunner {
  /** Exactly one isolated Session per handle; step never starts another Session. */
  start(input: MaintainerStart): Promise<string>;
  step(handle: string, input: MaintainerStep): Promise<MaintainerReply>;
  /** Revoke write authority before awaiting cooperative SDK cancellation. */
  cancel(handle: string): Promise<void>;
  close(handle: string): Promise<void>;
}

export interface PhaseDependencies {
  baseline?: BaselineProvider;
  docsync?: DocSyncGate;
  maintainer?: MaintainerRunner;
}

export interface HumanDecision {
  action: "execute" | "docsync_on" | "docsync_off";
  source: "interactive" | "rpc" | "slash";
  input_id: string;
  text: string;
}
/** Opaque, in-memory authority issued only by the trusted input adapter, not tool parameters. */
export interface HumanDecisionToken { readonly __humanDecision: unique symbol }
const decisions = new WeakMap<HumanDecisionToken, HumanDecision>();

/** Call only from actual Pi input/command handlers. Never expose this function as a model tool. */
export function captureHumanDecision(decision: HumanDecision): HumanDecisionToken {
  if (!decision.input_id.trim() || !decision.text.trim() || !["interactive", "rpc", "slash"].includes(decision.source)) throw new Error("Invalid Human input provenance");
  const token = Object.freeze({}) as HumanDecisionToken;
  decisions.set(token, { ...decision });
  return token;
}
export function readHumanDecision(token: HumanDecisionToken | undefined, action: HumanDecision["action"]): HumanDecision | undefined {
  const decision = token && decisions.get(token);
  return decision?.action === action ? { ...decision } : undefined;
}

export interface PhaseRecord {
  version: 1;
  context: PhaseContext;
  definition_hash: string;
  baseline: BaselineReference;
  authorization: HumanDecision;
  docsync: { enabled: boolean; decision?: HumanDecision };
  acceptance: Array<{ id: string; satisfied: boolean; summary: string }>;
  last_finalize?: { summary: string; outcome: "blocked" };
  finalized?: { check: "passed" | "with_debt" | "with_exceptions" | "skipped"; summary: string; content_version: string; debt_refs: string[]; human_exceptions: string[] };
}
