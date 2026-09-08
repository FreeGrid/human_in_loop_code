import type { BaselineReference, PhaseContext } from "../phase-contracts.ts";

export type DocumentTarget = string | { path: string; section_id: string };
export interface Concept { sources: string[]; docs: DocumentTarget[] }
export interface HardRule extends Concept { id: string; user_visible: boolean }
export interface DocSyncConfig {
  version: 1;
  concepts: Record<string, Concept>;
  hard_rules: HardRule[];
  readme: DocumentTarget;
  classification: { code: string[]; tests: string[]; docs: string[] };
}
/** Policy errors are facts, not Git baseline failures. IO/integrity/security errors throw. */
export interface ConfigurationState { version: string; config?: DocSyncConfig; errors: string[] }
export type ContentIdentity = { kind: "missing" } | { kind: "file" | "symlink"; mode: string; oid: string; domain: "git-sha1" | "git-sha256" };
export interface ContentChange { path: string; before: ContentIdentity; after: ContentIdentity }
export interface DocumentRead { file_version: string; identity: string | null; error?: string }
export interface DocumentEvidence { target: DocumentTarget; before: string | null; after: string | null; error?: string }
export interface RepositoryFacts {
  context: PhaseContext;
  baseline: BaselineReference;
  content_version: string;
  configuration: ConfigurationState;
  changes: ContentChange[];
  documents: Record<string, DocumentEvidence>;
}
export interface CandidateTrigger { kind: "concept" | "hard_rule" | "change_type" | "code_fallback" | "unknown_classification"; source: string }
export interface DocumentationCandidate {
  id: string;
  evidence_id: string;
  kind: "document" | "readme_narrative";
  target: DocumentTarget;
  urgency: "hard" | "normal";
  resolution: "pending";
  triggers: CandidateTrigger[];
  evidence: DocumentEvidence;
  question?: string;
}
export type CandidateResult =
  | { status: "blocked"; errors: string[] }
  | { status: "ready"; execute_id: string; content_version: string; configuration_version: string; notes_version: string; candidates: DocumentationCandidate[]; uncovered: Array<{ path: string; reason: string }> };
