# Working with a readable Plan

Start with `/plan` followed by what you want to do. The planner asks at most one currently blocking question, states reasonable nonblocking defaults, and saves the current requirements with a short checklist. A simple request may have just one task. Planning alone does not start implementation.

| Action | How |
|---|---|
| Change requirements | Describe the change, or use `/plan:edit …` |
| Open an existing file | `/plan:open plans/001-example.md` |
| See progress | `/plan:status` |
| Review current code changes | `/plan:review` or `/plan:review focus on negative weights` |
| Mark ordinary completion | `/plan:task T001 done`, or edit `[ ]` to `[x]` |
| Reopen work | `/plan:task T001 open` |
| Continue current work | Ask to execute the ready Plan (for example “继续” or “开始做”), or use `/plan:next` |

After a ready Plan, a request to begin or continue implementation tells the Agent to call `plan_continue` and then use ordinary work tools. It receives the current requirements, checklist and first unfinished subtask position. `/plan:next` supplies the same handoff directly. Natural-language intent is interpreted by the model: continuing clarification or discussion does not start implementation, and merely approving a Plan is not an execution request. If the selected file cannot be read, the Agent receives the error and should recover the file or clarify its path rather than guess the work. Other ordinary work remains available.

Refine by need and proximity: make current work actionable, add already-known detail to nearby unfinished tasks when useful, and keep distant goals coarse. A clear directly executable task stays one line. There is no mandatory lookahead window or subtask count. When splitting helps tracking, usually 2–4 meaningful actions suffice; avoid mechanical read/analyze/implement/verify lists. More concrete does not mean more items. Keep two levels and do not invent deliverables while refining. Completed tasks retain their subtasks and each subtask’s checkbox, so the work remains readable later. During authorized ordinary work, the Agent updates each finished subtask without waiting for a separate Human checkbox request. The last completed subtask automatically checks its parent; reopening a child reopens its parent. Unfinished or failed work stays unchecked. Tasks without children can be completed directly. Explicit Human/manual parent checks remain available. Reopening or selecting a task also preserves recorded children. `plan_refine` accepts an unfinished `task_id`, defaulting to the current task when omitted. Refining another task does not select it. Completed tasks must be reopened before using this refinement tool; `plan_update` can redefine completed work and reopen affected completion as before. Redundant unfinished subtasks may be merged or rewritten in place, while completed children remain recorded. Changing requirements replaces the old wording in place; affected completed work reopens by default. You remain free to mark work complete yourself. Edits normally report only their changes and impact rather than printing the entire Plan again.

The ordinary tools are `plan_set_mode`, `plan_start`, `plan_get`, `plan_update`, `plan_refine`, `plan_set_task_status`, `plan_select`, `plan_status`, and `plan_continue`. They work without a signing key, journal, execution approval or hidden state. A copied readable file can be opened in a fresh session. If another editor changes a file after it was read, reread it before retrying the edit. No command blocks ordinary host tools merely because a Plan is selected.

Model preferences for planning, normal execution and review are configured globally through environment variables read when the extension loads. Set them in your shell startup file before launching Pi, then restart/reload the extension after changing them. A running process does not reread later shell changes. The file never stores model settings.

| Stage | Provider | Model ID | Thinking level |
|---|---|---|---|
| Planning | `PI_TASK_PLAN_PLANNING_MODEL_PROVIDER` | `PI_TASK_PLAN_PLANNING_MODEL_ID` | `PI_TASK_PLAN_PLANNING_THINKING` |
| Execution | `PI_TASK_PLAN_NORMAL_MODEL_PROVIDER` | `PI_TASK_PLAN_NORMAL_MODEL_ID` | `PI_TASK_PLAN_NORMAL_THINKING` |
| Review | `PI_TASK_PLAN_REVIEW_MODEL_PROVIDER` | `PI_TASK_PLAN_REVIEW_MODEL_ID` | `PI_TASK_PLAN_REVIEW_THINKING` |

All three built-in presets use the locally registered Qwen 3.8 model `custom-qwen/qwen38-27b-fp8`, with thinking `high` for planning/review and `medium` for execution. The local model registration must enable reasoning; a `reasoning: false` setting does not establish that the model lacks thinking support. These values reproduce the presets; replace the IDs/providers with models configured in your Pi installation:

```sh
export PI_TASK_PLAN_PLANNING_MODEL_PROVIDER=custom-qwen
export PI_TASK_PLAN_PLANNING_MODEL_ID=qwen38-27b-fp8
export PI_TASK_PLAN_PLANNING_THINKING=high
export PI_TASK_PLAN_NORMAL_MODEL_PROVIDER=custom-qwen
export PI_TASK_PLAN_NORMAL_MODEL_ID=qwen38-27b-fp8
export PI_TASK_PLAN_NORMAL_THINKING=medium
export PI_TASK_PLAN_REVIEW_MODEL_PROVIDER=custom-qwen
export PI_TASK_PLAN_REVIEW_MODEL_ID=qwen38-27b-fp8
export PI_TASK_PLAN_REVIEW_THINKING=high
```

Existing `PI_TASK_PLAN_MODEL_PROVIDER` and `PI_TASK_PLAN_MODEL_ID` remain common fallbacks; explicit stage variables override them. Existing `PI_TASK_PLAN_THINKING` remains a planning alias. Thinking values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` (existing aliases remain accepted). Explicit host configuration overrides environment values per preset field. `PI_TASK_PLAN_MODEL_SWITCH=0` disables automatic model switching. The default `PI_TASK_PLAN_RESTORE_MODE=configured` selects the configured execution model; `previous` instead restores the model and thinking level saved before entering planning or review.

`/plan` and `/plan:edit` select planning; `/plan:next` and `plan_continue` select execution; `/plan:review` selects review. For natural-language activities the Agent is instructed to call `plan_set_mode` before drafting, implementation or review; natural-language selection still depends on the model following that instruction. Recording execution progress alone does not switch back to planning. Missing models or authentication produce a notice and leave ordinary work on the current model.

Ordinary `/plan:review` asks the current session to inspect actual changes and report findings without editing files or checklist. It is not independent Harness acceptance. Optional governed review receives the review preset through its trusted reviewer callback, rather than changing the implementer model; the embedding host must honor that request when launching the independent reviewer (see the governed guide). The legacy entry retains its existing two-stage command routing; the new ordinary review entry is V3.

The host defaults to V3. `plan_get` and `/plan:open` can also display the title and checklist of existing V1/V2 files without importing their old planning layers into ordinary context. These old files are read-only through the V3 tools; their bytes and execution records stay intact. Unsupported historical sketches are rejected without rewriting them. An explicit migration-preview request can supply a new current brief and checklist to `plan_migration_preview`. The preview writes no file, transfers no execution evidence and has no apply action.

To keep using the original V1/V2 lifecycle, load `extensions/task-plan/legacy-index.ts` instead of the default entry. Existing named legacy APIs are exported there. Programmatic hosts may alternatively `await taskPlanExtension(pi, { legacy: true })`; explicitly configured legacy `creationOptions` or `phase` dependencies take the same awaitable path. `{ creationOptions: { format: "v3" } }` selects V3 even if legacy settings are present. Ordinary host work remains available; the strict legacy lifecycle is not applied to readable completion. [Optional governed execution](v3-governed.md) is separate and never inferred from a checkbox. An unconfigured `/plan:governed` command explains how ordinary work can continue.

See [the format specification](v3-format.md) for the complete file shape. The [legacy guide](legacy-workflow.md) describes the original lifecycle and DocSync support.

For self-hosted Qwen/vLLM, set model `reasoning: true`, `compat.thinkingFormat: "qwen-chat-template"`, and `compat.supportsReasoningEffort: false` if OpenAI effort values are unsupported. Pi sends `chat_template_kwargs.enable_thinking=true` for either high or medium; this mapping does not provide distinct budgets. Reload the Pi model registry after changing its configuration. Server-side thinking and reasoning-output parsing depend on the deployed model/template and vLLM configuration.
