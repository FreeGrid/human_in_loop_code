import type { BaselineReference, PhaseContext } from "../phase-contracts.ts";
import type { ExecutionNote } from "../execution-notes.ts";
import { GitBaselineProvider } from "./baseline.ts";
import { buildCandidates } from "./candidates.ts";
import type { CandidateResult } from "./contracts.ts";

export * from "./contracts.ts";
export * from "./baseline.ts";
export * from "./candidates.ts";
export * from "./configuration.ts";
export * from "./targets.ts";

/** Read-only candidate API for a future gate. `ready` is not a completion decision. */
export async function collectCandidates(context: PhaseContext, reference: BaselineReference, notes: Record<string, ExecutionNote> = {}, provider = new GitBaselineProvider()): Promise<CandidateResult> {
  try {
    const facts = await provider.inspect(context, reference);
    const result = buildCandidates(facts, notes);
    if (result.status === "ready" && await provider.verify(context, reference) !== facts.content_version) return { status: "blocked", errors: ["content_changed: candidate inputs changed during construction"] };
    return result;
  } catch (error) {
    return { status: "blocked", errors: [error instanceof Error ? error.message : String(error)] };
  }
}
