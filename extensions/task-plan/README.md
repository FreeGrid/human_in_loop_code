New Plans use a native V2 canonical node format. Existing V1 Plans retain their identity and baseline rules. See [domain and identity contract](domain-identity.md) for creation, node editing, approval selection and baseline compatibility. Migration apply remains disabled.

# Task Plan: recoverable, Human-gated phase execution

Task Plan keeps the approved requirements, staged approach, Tasks, Acceptance and
execution notes in one Markdown file. A new conversation can read that file instead
of inheriting the previous Agent's full transcript. It complements Control Init's
repository boundaries and Collaborating Agents' scoped execution; neither tool's
success automatically accepts a phase.

## Availability and fail-closed boundary

This delivery supplies phase contracts, bounded progress, resume and finalization,
plus a **default real Git BaselineProvider** and deterministic document/README
candidate engine. The DocSync decision/debt gate and restricted Maintainer writer
remain future capabilities; there is no production stub that passes their checks.

New phase execution can capture a supported Git repository's original content.
Finalize with DocSync on still blocks when its gate is absent. Missing/corrupt Git
baselines remain errors even with Human off. Missing or malformed YAML policy is
separate: a trusted Git baseline can exist and Human can switch off, while candidate
construction explicitly reports the policy error. See the [Git and dependency
guide](docsync/README.md) for configuration, support limits and the read-only API.

Applications embedding the extension may override the default Git provider or pass
reviewed gate/runner adapters using the
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
   `change_types`. Reports describe candidates; caller-supplied Acceptance booleans are rejected.
5. A report with `result: completed` records **pending_finalize**, not `[x]`.
   Run `/plan:verify T001.A001` for each approved verification method. Only the configured Controller verifier can issue signed Acceptance receipts. Evidence binds to the provider's content version: repository changes
   before finalize require re-verification, not reuse of old passing assertions.
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
Tasks submission and review must preserve reserved records/notes exactly; they
cannot fabricate Human decisions, rewrite baseline identity or delete prior evidence.
Malformed, oversized, misplaced or unknown fields fail validation. ASCII spaces and
tabs and CRLF are supported for structure; unsupported Unicode/control structural
whitespace is rejected rather than silently shifting item IDs.

A separate phase lock serializes the whole finalize attempt, including the document
gate, so a losing concurrent finalizer cannot continue mutating docs after a winning
receipt. Plan writes acquire an exclusive lock on the canonical file path, recheck the
expected document version and atomically rename a fully prepared replacement.
Symlink aliases share that lock. Stale versions or an existing lock return conflicts;
each individual write is atomic. Report batches currently stop after the first failure and retain earlier successful entries. A lock left after a crashed process is not guessed
stale or automatically stolen: establish that the owner is gone before an explicit
operator recovery removes it. Do not remove another active writer's lock.

Providers exclude this Plan's execution-only metadata from the repository content
identity to avoid self-invalidating evidence; Plan bytes have a separate version check.
All Harness writers cooperate with these locks. Late version checks detect external
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


## Human transition authority

The trusted input adapter issues opaque, short-lived, one-shot capabilities bound to the action, Plan/node, document and contract hashes, and canonical roots. Model tool parameters cannot create a capability. Approval of the detailed Tasks contract and authorization to execute are separate decisions: `/plan:approve` approves the current contract; `/plan:approve execute` authorizes execution; `/plan:execute` then confirms the initial phase and its roots. Resuming an existing unchanged phase retains its original execution identity and baseline.

Reopen, abandon, plan completion, phase finalize, closure edits and DocSync changes require their own capabilities. Slash commands request an actual UI confirmation because other extensions can inject commands. Without UI, only exact trusted interactive/RPC input with an unambiguous existing context can grant authority; first execution requires confirmed roots. A serialized token, boolean or model statement is insufficient. Successful transitions save an authorization receipt in the same CAS write as the state change; failed attempts consume authority and require a new decision where consumption occurred.

V1→V2 apply migration is disabled, including direct calls to the legacy migration module. Read-only migration proposals remain available. Native V2 execution and the full evidence/Controller boundary are not yet a released capability. The Pi write hook is a coordination guard, not a sandbox.


## Trusted verification and review

The Controller supplies `PhaseDependencies.evidence`: an opaque receipt signer,
Implementer session identity, a configured independent reviewer, and a verification
factory. These are host configuration, never model tool parameters. With no trusted
runtime the extension fails closed. `configureProcessVerificationAuthority` freezes
an absolute executable, arguments, working directory and approved verification input;
it records actual output, exit status and artifact hashes. It does not create a sandbox.
The host must isolate verifier/reviewer launchers, signing keys and control configuration.

Each executable Task can declare an optional `#### Verification` JSON field before
`#### Depends On`. Actual verification requires an approved method for every Acceptance:

```json
{"risk":"unknown","verification":{"T001.A001":{"command_or_method":"check output","inputs":[],"expected":"exit status 0"}}}
```

The configured risk floor defaults to `unknown`, requiring fresh independent Review.
Only a trusted Controller may lower that floor; a model changing the contract cannot
reduce it. Review `failed`, `disputed` and `invalidated` receipts remain blocking even
when candidate commentary says passed. Review identities must match the contract's
Implementer and come from the configured trusted launcher. Model summaries are not
Review results.

`plan_verify_acceptance` accepts only Plan hash, Task ID and Acceptance ID. The method,
expected output, actor and result come from the approved contract and trusted adapters.
For an explicit manual method, `/plan:accept T001.A001` displays the actual observation
and requires Human confirmation. Its one-shot capability binds the exact Acceptance,
content version, method, expected/actual values and artifacts as well as Plan, node,
contract, document and roots.

Verification, Review and finalize receipts use strict canonical schemas and
purpose-separated HMAC seals. Provision a key explicitly with `initializeReceiptSigner`
and restore it with `loadReceiptSigner` from a protected canonical runtime path.
Loading never replaces a missing key. Keep that key outside Agent-accessible scopes;
filesystem mode checks alone do not isolate processes running as the same user.
A lost key blocks authentication and needs an explicit operator recovery decision.

Finalization requires current passing signed Verification and Review, valid artifacts,
Human authority and a successful/explicitly skipped DocSync outcome. DocSync mutations
require verification again against the new content version; the original baseline
remains. Dependencies across every round and plan completion authenticate the finalized
contract and the exact current signed evidence referenced by its receipt. Legacy
checkboxes or unsealed records remain readable but do not authorize execution.
Reopening a prerequisite with started dependents, or another node while a phase is
active, is refused before mutation until a coherent dependency recovery transaction exists.

## Read diagnostics and explicit reconciliation

`plan_get`, `plan_status` and session restoration leave Plan bytes unchanged. Reads
return current metadata, validation issues and a proposed reconciliation. Use
`plan_reconcile` with the exact document hash, or `/plan:reconcile`, to persist a
state invalidation. Reconciliation cannot grant contract approval or execution
permission. A changed contract still requires fresh Review and Human gates.

All candidate writes now parse the complete document before installing it. Scalar
YAML rejects duplicate keys and unsupported types; strict UTF-8/Unicode checks,
reserved-marker ownership and canonical machine records prevent a rejected tool
call from first persisting an unreadable Plan. Discovery distinguishes unrelated
Markdown from recognizable corrupt Harness candidates and blocks on the latter.
The parser preserves legacy readable records while execution gates reject missing
trusted evidence.

Writes return an `operation_id`. `plan_recovery_status` can list IDs after a lost
response or inspect exact source/candidate and journal hashes. `/plan:recover`
confirms a concrete inspection; recovery never reruns a gate or captures a baseline.
The Plan binds its external runtime directory, so changing host configuration
cannot hide an unresolved write. See [operation integrity and recovery](operation-journal.md)
for crash checkpoints, Human authority, quiescent-owner checks and the explicit
offline boundary for unknown pre-intent locks.
