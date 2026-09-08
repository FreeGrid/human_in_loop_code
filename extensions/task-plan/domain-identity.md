# Native nodes and execution identity

New Plans default to `harness: pi-plan/v2`, `format: pi-plan/v2` and
`identity_policy: node-v1`. The strict native codec persists What / Why, shared
Strategy, one Nodes region, and Review. The Tasks/Plan views in snapshots are
read-only projections. `plan_submit_node` edits one canonical candidate;
`plan_submit_section` edits native What / Why or shared Strategy. Modern V1 can submit an unrelated future Tasks candidate while executing (or select `section: plan`); every existing execution contract and its records must remain unchanged before the CAS can commit. The trusted
host may explicitly create V1 documents; new V1 documents also use node-v1.

Existing V1 documents without identity_policy retain the original aggregate
phase identity, task-only receipt identity and git-v1 baseline algorithm.
Ordinary CAS writes cannot change format or identity_policy. Migration apply
remains disabled. Read-only proposals reject unrepresentable execution history,
records, policies and fields; they confer no authority.

`plan-domain.schema.json` describes the domain payload. The native reader also
enforces marker ownership, unique ordered node IDs, dependency existence/cycles,
checklist grammar, record ownership and the frontmatter lifecycle schema before
any write. Native nodes use Round, Outcome, Work, Acceptance, optional declared
Verification/Scopes/Forbidden/Non-Goals/Review Policy, Progress and Depends On
(last). Future outline nodes cannot own execution records.

The three node-v1 identities are:

- Outline: the node's title, outcome, outline fields and dependencies.
- Declared contract: outline, work, Acceptance, round, boundaries, verification,
  review policy, and all shared What / Why and Strategy.
- Effective execution contract: declared contract, trusted risk floor and
  `EvidenceRuntime.policy_id`, plus authenticated transitive finalize references.

The existing receipt `contract_hash` field stores the **effective execution
contract** for node-v1. It keeps its historical task-only meaning for absent
policy V1. Every Review, verification, Human node approval and finalize uses
that same selector. Runtime policy defaults to `controller-evidence/v1`; a host
changing verification or review semantics must change policy_id. Unknown risk
keeps its strict independent-review requirement.

For node-v1, `plan_review` selects one explicit task_id (omission is allowed only
for one open node). Its dependencies must already have authenticated finalize
receipts. Passing Review sets pending_node. Human approve_contract writes the
node's contract authorization reference, and separate authorize_execution sets
selected_node. Phase operations require that node's matching authorization and
Review. Finalize never starts another node; remaining work returns to selection
and Review. A future-node edit preserves active authority if the effective
contract is unchanged. Every mutation still requires current full-byte CAS.

GitBaselineProvider receives a trusted planIdentityResolver over exact parsed
source text. Node-v1 captures use schema 2 / git-v2 and the same semantic Plan
bytes in repository changes, governance Plan identity and configured whole-file
Plan targets. Arbitrary section targets on a scoped Plan are rejected. Exact
source digests remain in race detection, while unrelated node changes do not
alter the content version. Schema-1 captures are read without conversion or
recapture. Missing resolver or a saved policy mismatch fails closed.

Reads only diagnose invalidations. Explicit reconcile persists a proposed
invalidation; it cannot invent a new baseline or approve the changed contract.
If an execution's own contract changed, restore its original contract or use a
future explicit recovery contract. Never delete its record to force recapture.
