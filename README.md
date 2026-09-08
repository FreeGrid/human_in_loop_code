# Human-in-the-Loop Toolkit for Pi

This package adds Pi extensions for durable workspace governance and
coordinated multi-agent execution.

The extensions can be used independently, but together they address a common
problem: an agent can produce changes quickly while repository boundaries,
human approval points, and execution history remain implicit. This toolkit makes
those decisions visible, reviewable, and recoverable.

## From ownership to approved execution

```text
repository boundaries     current requirements     coordinated execution
    control-init       ->       task-plan        ->  collaborating-agents
```

The arrows show the recommended sequence, not runtime dependencies. The three
extensions can be used independently: workspace governance establishes ownership,
Task Plan keeps current requirements and progress, and collaborating Agents carry out
scoped work. A subagent result is evidence to review, not automatic acceptance.

### 1. Control Init: make ownership and boundaries durable

**Why it matters.** Work that spans product code, private plans, tests,
verification evidence, or manuscripts becomes risky when repository ownership
exists only in conversation history. A later Agent can easily put an artifact
in the wrong repository, trust a moved path, or cross a privacy boundary.

**What it does.** Control Init creates a versioned `CONTROL_INDEX.json` and a
marker-bounded managed section in `AGENTS.md`. It supports built-in
code/control and code/control/LaTeX topologies, explicit custom topologies,
status and doctor checks, safe updates, drift detection, and human-reviewed
local Git bootstrap. It never commits, pushes, opens PRs, merges, releases, or
runs product work by itself.

[Read the Control Init guide](extensions/control-init/README.md)

### 2. Collaborating Agents: coordinate execution without losing control

**Why it matters.** Parallel and specialized Agents are useful only when their
identity, messages, write ownership, and results remain observable. Otherwise,
parallelism creates conflicting edits, duplicated work, and hidden context.

**What it does.** Collaborating Agents can spawn single or parallel subagents,
route direct and broadcast messages, reserve files before edits, inspect scoped
subagent sessions, and automatically return child results to the parent. The
`/agents` overlay exposes Agents, messages, reservations, and shared chat.
Subagents can run as background processes or in visible cmux panes, with
configurable specialist roles.

[Read the Collaborating Agents guide](extensions/collaborating-agents/README.md)

### 3. Task Plan: keep current requirements and a rolling checklist

Use `/plan` with a natural-language request to create a readable V3 file. The
Planner consolidates the current requirements, asks at most one blocking question
and adds detail in place only when useful: current work is actionable, nearby work
may have known subtasks, and distant work stays coarse. Simple requests may have
one task without subtasks. Changes
replace old wording in place; completed work keeps its subtasks, and child progress automatically completes the parent without
results, summaries or execution records.

Humans may check tasks directly. `/plan:task T001 done` records ordinary completion,
`/plan:status` shows the short checklist, and `/plan:next` continues ordinary work.
A copied Plan needs no hidden runtime or certification. Planning alone does not
request implementation.

Configured hosts may explicitly choose an additional governed flow, retaining
Human authority, scoped execution, actual verification and independent review
behind the readable file. Its unavailable state does not block ordinary work.
Existing V1/V2 files have a read-only view and explicit migration preview; their
original lifecycle remains available through `legacy-index.ts`.

[Read the ordinary Task Plan guide](extensions/task-plan/README.md) ·
[Optional governed execution](extensions/task-plan/v3-governed.md) ·
[Legacy execution and DocSync](extensions/task-plan/legacy-workflow.md)

Planning, ordinary execution and review have separate global model presets. All
three currently default to the locally registered Qwen model
`custom-qwen/qwen38-27b-fp8` (Qwen 3.8), with thinking `high` for planning/review
and `medium` for execution. This provider/model must exist in your Pi model registry;
otherwise a notice is shown and ordinary work continues with the current model.

- `/plan` and `/plan:edit` select the planning model.
- `/plan:next` and `plan_continue` select the execution model.
- `/plan:review` selects the ordinary code-review model. Natural-language stage
  changes use the Agent's `plan_set_mode` tool.
- Optional Harness review passes the review preset to its independent reviewer
  callback; the embedding host must launch that model. Switching the current
  session alone is not independent review.

Set these environment variables before starting Pi (for example in `~/.zshrc`):

```bash
export PI_TASK_PLAN_MODEL_SWITCH=1
export PI_TASK_PLAN_PLANNING_MODEL_PROVIDER=custom-qwen
export PI_TASK_PLAN_PLANNING_MODEL_ID=qwen38-27b-fp8
export PI_TASK_PLAN_PLANNING_THINKING=high
export PI_TASK_PLAN_NORMAL_MODEL_PROVIDER=custom-qwen
export PI_TASK_PLAN_NORMAL_MODEL_ID=qwen38-27b-fp8
export PI_TASK_PLAN_NORMAL_THINKING=medium
export PI_TASK_PLAN_REVIEW_MODEL_PROVIDER=custom-qwen
export PI_TASK_PLAN_REVIEW_MODEL_ID=qwen38-27b-fp8
export PI_TASK_PLAN_REVIEW_THINKING=high
export PI_TASK_PLAN_RESTORE_MODE=configured
```

For a self-hosted Qwen/vLLM endpoint, the model entry in Pi's `models.json`
must have `reasoning: true` and `compat.thinkingFormat: "qwen-chat-template"`.
Keep `compat.supportsReasoningEffort: false` when the endpoint does not accept
OpenAI-style effort values. Pi then sends `chat_template_kwargs.enable_thinking`
(and preserves thinking history). In this format high/medium both enable thinking;
they do not set different token budgets. These are client request settings, not
proof of how the deployed server/model handles reasoning. See the
[Qwen vLLM deployment guide](https://github.com/QwenLM/Qwen3/blob/main/docs/source/deployment/vllm.md).

Each stage can be changed independently. Existing `PI_TASK_PLAN_MODEL_PROVIDER`
and `PI_TASK_PLAN_MODEL_ID` remain common fallbacks; explicit stage variables win.
`PI_TASK_PLAN_THINKING` remains a planning alias. Explicit host configuration wins
over environment fields. Set `PI_TASK_PLAN_MODEL_SWITCH=0` to disable switching,
or `PI_TASK_PLAN_RESTORE_MODE=previous` to restore the model active before planning
or review instead of using the configured execution preset. Environment changes
require a new Pi process with the updated environment. No model configuration is
written to the readable Plan. See the [workflow guide](extensions/task-plan/v3-workflow.md)
for accepted thinking levels and ordinary/independent review boundaries.

Package consumers that import the extension directly can also pass a
`TaskPlanExtensionConfig` object to the default task-plan extension factory. It
extends model preferences with an optional trusted `governed` factory. Explicit
legacy configuration is awaitable; the default has no test doubles or automatically
passing verification adapters.

## Installation

Choose one source below. A version of this package that contains the current
toolkit enables all three extensions and the bundled `collaborating-agents-system`
skill with one installation.

### Option 1: npm

```bash
pi install npm:@baochunli/pi-collaborating-agents
```

### Option 2: this Git repository

```bash
pi install https://github.com/FreeGrid/human_in_loop_code
```

The npm package name is retained for compatibility with the original
Collaborating Agents package. Use the Git source when you need the current
state of this repository before it is published to npm; a published npm version
may lag features listed as Unreleased in the [changelog](CHANGELOG).

### Option 3: original upstream Git source

```bash
pi install https://github.com/baochunli/pi-collaborating-agents
```

This preserves the original Git installation route for the upstream
Collaborating Agents release line. Use this repository's Git source above when
you specifically need the complete toolkit documented here.

### Option 4: a local checkout

```bash
pi install /absolute/path/to/human_in_loop_code
```

After installation, run:

```bash
pi config
```

Confirm that the following are enabled:

- `collaborating-agents`
- `control-init`
- `task-plan`
- `collaborating-agents-system`

If one of the extensions is absent, the selected source predates that
extension; install this repository's current Git source or local checkout.

Press `Esc` to leave the configuration screen. Start a new Pi session after
installing or updating the package so the extensions and skill are reloaded.

## A minimal first workflow

1. Run `/control:init` or ask Pi in natural language to initialize the named
   repositories. Review the complete preview before approving any write.
2. Use `/plan` to keep current requirements and a rolling checklist. Refine the
   current task when ready to work, and check completed tasks yourself. Request
   implementation separately; the additional governed flow is optional.
3. Explicitly assign approved work. Use `/subagent` or let an orchestrator use
   the `subagent` tool when delegation or context isolation is worthwhile.
4. Use `/agents` to inspect active Agents, messages, and file reservations;
   verify the result before accepting delivery.

Control Init does not automatically spawn Agents or run product work. Those
boundaries are intentional human gates.

## Updating and removing

Re-run `pi install` with the same source to update an installation. To remove
the package, pass the exact source originally used:

```bash
pi remove npm:@baochunli/pi-collaborating-agents
pi remove https://github.com/FreeGrid/human_in_loop_code
pi remove https://github.com/baochunli/pi-collaborating-agents
pi remove /absolute/path/to/human_in_loop_code
```

Use only the matching line. Removing the package disables its runtime extensions but does not delete
`CONTROL_INDEX.json`, managed `AGENTS.md` content, repositories, commits, or
other durable artifacts created while using it.

## Safety and compatibility

Pi extensions run with high local privileges. Review third-party source before
installing it, keep repository paths explicit, inspect Human Gate previews, and
review changes before committing or publishing them.

Control Init was verified against `@mariozechner/pi-coding-agent@0.73.1` and
requires Node.js `>=20.6.0`. See each extension guide for its precise safety
boundary, compatibility notes, configuration, commands, and validation
procedures.

## License

[MIT](LICENSE)
