# Choosing governed execution

Ordinary Plan use needs no setup or certification. A Human may check a task directly, and a copied Plan works in a fresh session. Governed execution is an optional host integration for additional authorization, scope, verification and independent review. Its unavailable or invalid state affects that flow only.

An embedding host supplies `TaskPlanExtensionConfig.governed`, a trusted factory `(canonicalPlanPath, extensionContext) => V3Governed`. The ordinary entry imports the adapter only when used. The factory must construct `createV3Governed` with the selected Plan's `createV3Runtime`, persistent runtime and evidence keys, a stable implementer identity, reviewed policy, a real execution sandbox, process-bound verification handles and an independent reviewer handle. The runtime must never depend on a private control repository. Factories, keys, capabilities and review/verification providers are not model tool arguments.

After opening a V3 Plan, an explicitly configured host provides:

| Command | Effect |
|---|---|
| `/plan:governed prepare` | Prepare a hidden contract for the current task |
| `/plan:governed approve` | Review the concrete definition and policy, then approve the contract |
| `/plan:governed authorize` | Separately authorize the displayed execution boundaries |
| `plan_governed_run` | Run an allowed child process after explicit selection and authorization |
| `/plan:governed verify` | Execute the configured verification methods |
| `/plan:governed review` | Obtain independent review bound to current evidence |
| `/plan:governed finalize` | Check readiness, request final confirmation, then check the retained current subtasks and parent |
| `/plan:governed status` | Inspect this optional flow |
| `/plan:governed recover` | Confirm recovery of an interrupted operation without replacing later manual edits |

Human decisions require a confirmation UI. Confirmation shows the current brief/task, target and governance roots, read/write/forbidden scopes, allowed executables and quoted verification criteria. A decision binds the displayed definition and action; edits while the dialog is open cannot acquire fresh authority automatically. Recovery instead displays the inspected operation's target and exact recovery semantics. Approval is never inferred from a model string or boolean. Model run requests cannot initialize or discover actors, and session replacement clears actor selection.

The trusted policy must test the user's current requirements rather than add deliverables. Exact quotations and complete subtask coverage provide structural checks; a reviewed policy and Human decision remain necessary to assess method meaning. Permission to write a path does not turn it into a requested deliverable. A new requirement belongs in the brief before a new contract is prepared.

Verification failure, stale inputs, out-of-scope writes, invalid authority and missing review prevent governed completion. Finalize repeats readiness checks after confirmation, durably records acceptance and pending projection, then checks all retained subtasks of the accepted task and finally its parent. Other tasks and their recorded children remain unchanged. No result summary is appended. Ordinary `[x]` never synthesizes verified evidence. An observed material definition change retires old evidence even if the text is later restored.

The sandbox currently supports Darwin launched child processes, with allowed executables and protected runtime/Plan/key paths. It does not isolate the whole host. Cancellation terminates the child; partial permitted writes still require verification. Unsupported platforms/files/aliases and missing providers reject the governed action while ordinary work remains available. The raw scope inventory is deliberately conservative, including ignored files. Full authenticated-store rollback requires an external detection anchor; edits never observed by the kernel cannot be detected retrospectively.

Contract and runtime details are in [the integration boundary](v3-kernel.md). The ordinary [workflow](v3-workflow.md) and [file format](v3-format.md) remain independent of these controls. DocSync continues in the explicitly selected legacy integration; no DocSync state enters V3.

When model switching is enabled, `/plan:governed review` passes the globally resolved review preset as `request.model` to `V3GovernedConfiguration.reviewer`. The callback must use its `provider`, `model` and optional `thinkingLevel` when launching the independent review session, or report that it cannot satisfy the request. The library forwards an isolated preset; it does not launch that external model or prove that a custom callback honored it. It does not switch the implementer session to the reviewer model. Fresh-session identity and evidence validation still apply; a model selection alone never grants review authority. With model switching disabled, or old direct `review()` calls, the optional model field is omitted and the trusted host keeps its own selection. Existing two-argument factories remain compatible.
