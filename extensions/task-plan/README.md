# Task Plan: recoverable, Human-gated phase execution

Task Plan keeps the approved requirements, staged approach, Tasks, Acceptance and
execution notes in one Markdown file. A new conversation can read that file instead
of inheriting the previous Agent's full transcript. It complements Control Init's
repository boundaries and Collaborating Agents' scoped execution; neither tool's
success automatically accepts a phase.

## Availability and fail-closed boundary

This delivery supplies phase contracts, bounded progress, resume and finalization
services, plus `BaselineProvider`, `DocSyncGate` and `MaintainerRunner` interfaces.
It does **not** yet supply the production Git content-comparison engine, document
candidate/debt policy or restricted Maintainer writer.

Consequently, default new phase execution reports `capability_unavailable` when
its baseline provider is absent. Finalize with DocSync on blocks when its gate is
absent. There is no production stub that passes these checks. Planning operations
remain usable; do not confuse a registered command with a working synchronization
backend. Disabling DocSync does not bypass a missing baseline or Task acceptance.

Applications embedding the extension may pass reviewed adapters using the
`phase` property of `TaskPlanExtensionConfig`, or supply `PhaseDependencies` to
`PhaseExecutionService`. Adapter injection is a trusted host API, not a model tool
or an automatic discovery mechanism. Runtime adapters must not depend on any
private control repository, test fixture or acceptance script.

## Workflow

1. `/plan <brief>` starts a one-file plan. Review What / Why, the Plan and then
   the current stage's Tasks. Plan content approval is not execution permission.
2. Separately authorize execution after Tasks review.
3. `/plan:execute [plan-path]` starts or resumes **one** phase. On first start,
   choose the target Git root and governance root containing the Plan using
   absolute paths, then confirm. Multiple open phases require explicit selection.
   No repository directory is created or guessed. A phase with a live execution
   prevents starting another until it is finalized.
4. Work items have IDs such as `T001.W001`; Acceptance IDs are `T001.A001`.
   They are stable within the frozen definition, not across replanning. Bound
   reports specify `work_item_id`, a concise summary, affected `files`, optional
   `change_types`, and Acceptance evidence by stable ID or unambiguous text.
5. A report with `result: completed` records **pending_finalize**, not `[x]`.
   When every work item and Acceptance is ready, use `/plan:finalize T001` or
   `plan_finalize`. One version-checked write completes the phase heading,
   work items and Acceptance together and records the documentation outcome.
6. Stop there. Human decides whether to enter the next phase/round, reopen work,
   or complete the Plan. No automatic commits, PRs, merges or releases are caused
   by these commands.

`/plan:task T001 done` and the existing Human task-status tool use the same finalize
service. They cannot bypass evidence or documentation checks. Human `open` resets
completion evidence while retaining the original execution identity and baseline.
Handwritten checkboxes without a matching finalize receipt are conflicts, not
completion proof. Generic edits to the live Plan remain guarded; use the Plan tools.

### DocSync controls

Each **new** execution defaults to `on` and displays both commands:

```text
/docsync off
/docsync on
```

You can also give an explicit Human input such as `关闭 DocSync`, `开启 DocSync`,
`turn off DocSync`, or `turn on DocSync`. Questions, quoted suggestions and
“Human already approved” assertions are not switch authority. Interactive and RPC
input adapters capture provenance; extension-injected messages do not. Slash
switches require Human UI confirmation because extensions can invoke commands too.

Off means **skipped**, not passed. It skips only documentation checking, retains
existing debt and still requires every Task Acceptance. Resume retains the recorded
off/on decision and does not ask you to approve it again. The `plan_docsync` tool
can apply only a captured Human decision; setting an extra `human_approved` argument
cannot authorize anything.

### Recovery

Use `/plan:execute` with the existing Plan. The service reads current Plan facts and
verifies the original baseline reference, roots and frozen contract. Session entries
retain only lookup identity/model preferences, not another authoritative checklist.

A missing baseline, moved/mismatched root or changed approved definition blocks
recovery. Existing work is preserved. The extension never silently captures a new
baseline to make old work disappear. A missing provider must be restored before
recovery can proceed; changing a task definition requires review and an explicit
resolution of the old execution, not an automatic baseline reset.

## Records, hashes and writes

Work-note and phase-record regions are strict, bounded, canonical JSON inside
reserved Markdown markers. Their contents describe progress, execution identity,
Human decisions and evidence; they cannot redefine work or Acceptance. Only valid
records in their exact permitted locations are excluded from definition hashes.
Malformed, oversized, misplaced or unknown fields fail validation. ASCII spaces and
tabs and CRLF are supported for structure; unsupported Unicode/control structural
whitespace is rejected rather than silently shifting item IDs.

Plan writes acquire an exclusive lock on the canonical file path, recheck the
expected document version and atomically rename a fully prepared replacement.
Symlink aliases share that lock. Stale versions or an existing lock return conflicts;
no partial batch is published. A lock left after a crashed process is not guessed
stale or automatically stolen: establish that the owner is gone before an explicit
operator recovery removes it. Do not remove another active writer's lock.

All Harness writers cooperate with this lock. Late version checks detect external
edits, but ordinary filesystem rename is not a universal compare-and-swap against
arbitrary non-cooperating processes. Keep external editors from writing during the
final commit window. Required gate debt records are saved before the Plan receipt;
this is not a multi-file database transaction.

## Runner selection and compatibility

Capability testing selected an isolated SDK `AgentSession` using exactly
`@earendil-works/pi-coding-agent@0.84.4` on Node v25.9.0. This is the verified target,
not an assertion about every later/earlier version. Tests used the actual SDK event
loop, resource loader, tool dispatch and cancellation with a **scripted model**;
real-model/authentication and documentation writing are not yet verified.

The future Maintainer adapter must explicitly resolve/provision that supported SDK,
keep its Session private, freeze budgets, and expose only authorized local tools.
`start` creates one Session; `step` reuses it; only validated structured replies can
complete protocol steps. Neither the first `turn_end` nor a resolved `prompt()` is
success. The ordinary collaborating-agents socket helper is not this protocol:
stock Pi 0.84.4 rejects its custom `--session-control` option.

`cancel` must revoke authority **before** awaiting `session.abort()`. Abort is
cooperative: an already running tool can ignore it. Future writes need a revocable
lease check inside their mutation lock at the actual commit boundary, plus a
well-defined drain policy. A dedicated SDK process/broker with kill fallback is a
candidate for hard deadlines, not an implemented guarantee in this delivery.

The toolkit's existing `@mariozechner/*@0.73.1` peers have not been replaced or
aliased. The runner capability claim does not cover that older SDK. Missing or
unverified runner capabilities must fail closed; no silent default-worker fallback.
