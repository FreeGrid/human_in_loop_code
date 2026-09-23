# Agent collaboration and delivery guidelines

This is a reusable repository-instruction template. Copy it to `AGENTS.md` in
another repository and adapt it to that project's needs. Install the bundled
`skills/herdr/` directory in your agent host's skill location so that the `herdr`
skill is available before delegation.

## Change discipline

- Keep changes within the user's authorized scope and preserve unrelated
  working-tree changes.
- Keep each change coherent and validate the behavior it affects.
- Update related user-facing documentation when behavior stabilizes, and check
  for omissions before delivering a major change or PR.

## Subagent delegation, continuity, and independent review

- Delegate bounded work when specialization, parallelism, context isolation or
  independent review can improve quality or save time. Handle small, local tasks
  directly when coordination would cost more than it helps.
- Give each subagent a clear goal, relevant context, write scope and expected
  result. Delegation stays within the user's authorized task and repository
  boundaries; briefly explain useful divisions of work without a fixed ceremony.
- Run independent tasks in parallel when dependencies are satisfied and write
  scopes do not conflict. Agree on shared interfaces first and serialize
  overlapping changes. Continue useful local work while agents run.
- Prefer continuing with a familiar agent for related work while its context and
  scope remain suitable. Clarifications, corrections and follow-ups do not
  require prior task acceptance. Use the backend's actual continuation or
  recovery mechanism rather than pretending a new session is the old one.
- First address gaps or mistakes with additional context or corrective
  instructions. Start a fresh session when the agent repeatedly misses key
  requirements, persists in an incorrect assumption after correction, or the
  new task no longer fits its context. On an actual handoff, provide only what
  is needed to continue.
- Begin independent review in a fresh session without the implementer's
  transcript. The reviewer must not implement the changes it adjudicates, but
  may continue reviewing fixes to its findings while remaining independent.
- Ask subagents for concise conclusions and necessary evidence, noting file
  changes or unresolved issues when applicable. Ordinary tasks do not require
  separate logs, workstream identifiers or handoff documents.
- The controller integrates results and checks them against the task's
  acceptance criteria. A subagent's success report is not acceptance by itself;
  retain any explicitly assigned human or independent acceptance authority.

## Delegation backend: Herdr

- Use Herdr for all subagent orchestration, regardless of whether the controller
  or child runs Pi, Codex, Claude or another host. Do not mix in the hosts'
  native subagent orchestration tools.
- When Herdr operations are needed, read and follow the installed `herdr` skill
  for prerequisites, commands and lifecycle handling. If the skill is unavailable,
  report the missing prerequisite instead of guessing commands or switching backends.
- Before issuing Herdr control commands, verify `HERDR_ENV=1`. If the check fails,
  report that the agent is not running inside Herdr and stop Herdr operations.
- Use the installed CLI's help as the authority for command syntax. Read live
  identifiers and lifecycle states from command responses rather than guessing.
- Preserve the user's focus and working directory for background work. Use an
  explicit target or the caller's context instead of the UI-focused pane.
- Inspect agent state and output after a timeout, stalled submission or blocked
  response before deciding what to do next. Do not blindly resubmit prompts;
  successful submission alone does not establish completion.
- The shared delegation, continuity and independent-review rules above still
  apply. Include this backend choice and relevant repository rules in child
  task packets so children use the same mechanism.

## Commit and PR history is long-term implementation memory

- Work on a feature branch; do not place feature work directly on the default
  branch.
- Every small, complete, reviewable change must be its own commit. A commit must
  leave its scoped files internally coherent and must not include unrelated
  working-tree changes.
- Add verification incrementally. Each independent test scenario or tightly
  coupled test increment should remain a focused, inspectable change.
- A plan, plugin, epic or complete product capability is not automatically one
  PR-sized feature. Several focused commits can form a reviewable delivery slice;
  larger work normally contains multiple delivery slices and multiple PRs.
- Before implementing multi-step planned work, define a `Delivery slices`
  section mapping tasks to planned PRs, including each PR's primary review
  concern, base/dependencies and scoped validation. Scale the number of PRs and
  commits to the work; do not split or combine changes just to meet a quota.
- Each PR should address one primary concern and leave its affected files
  internally coherent. A task may span PRs, and tightly coupled tasks may share
  one PR.
- Open a delivery-slice PR after that slice's required checks pass; do not wait
  for an entire capability to finish. Add cross-cutting verification
  incrementally, and reserve the final slice for integration, hardening,
  documentation and end-to-end evidence rather than a hidden major subsystem.
- Describe the concrete problem, resulting behavior, scoped changes and
  validation in each PR. Identify dependencies and relevant commit SHAs so the
  delivered change can be reconstructed. Compare stacked PRs with their own
  base rather than attributing inherited changes to the current slice.
- Do not open a PR before its required validation passes. If a check remains
  manual or unavailable, record that limitation explicitly rather than claiming
  full verification.
- Opening a validated PR is the automation boundary. Do not merge a PR, publish
  or release an artifact, or delete its branch without a separate explicit
  human decision.
