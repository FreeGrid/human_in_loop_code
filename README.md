# Human-in-the-Loop Toolkit for Pi

This package adds Pi extensions for durable workspace governance and
coordinated multi-agent execution.

The extensions can be used independently, but together they address a common
problem: an agent can produce changes quickly while repository boundaries,
human approval points, and execution history remain implicit. This toolkit makes
those decisions visible, reviewable, and recoverable.

## From ownership to approved execution

```text
repository boundaries     durable Human gates      coordinated execution
    control-init       ->       task-plan        ->  collaborating-agents
```

The arrows show the recommended sequence, not runtime dependencies. The three
extensions can be used independently: workspace governance establishes ownership,
Task Plan records approval and progress, and collaborating Agents carry out
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

### 3. Task Plan: preserve decisions across planning and execution

A long planning conversation should not be the only place that knows what was
approved or what remains unfinished. Task Plan keeps requirements, the staged
approach, executable work and acceptance criteria in one Markdown file. Planning
approval and execution authorization are separate Human gates.

`/plan:execute [plan-path]` starts or resumes one approved phase. Work reports
leave bounded notes in that Plan; “implemented” does not prematurely mean “done”.
`/plan:finalize T001` checks the entire phase before writing its completion markers
together. Resume retains the original execution identity, repository binding and
DocSync decision rather than silently starting a fresh comparison baseline.

**Current delivery boundary:** the phase services and provider interfaces are
present, but the production Git baseline engine, DocSync gate and Maintainer
writer are not yet supplied. Missing providers fail closed; this is not a complete
document-synchronization product. Planning remains available. Disabling DocSync
cannot bypass a missing baseline or Task acceptance.

[Read the Task Plan execution guide](extensions/task-plan/README.md)

`/plan` switches the current main session to a dedicated planning preset before
it queues plan drafting. By default the planning preset is
`openai-codex/gpt-6-astra` with thinking level `xhigh` (Extra high). When the
plan enters execution, completes, or is abandoned, the extension switches back
to the normal coding preset: `openai-codex/gpt-6-astra` with thinking level
`medium`.

The switch uses Pi's current-session model API, not a subagent, so the
conversation context stays in the main Agent.

Configuration is available through environment variables:

```bash
# Disable automatic model switching if needed.
export PI_TASK_PLAN_MODEL_SWITCH=0

# Planning preset.
export PI_TASK_PLAN_MODEL_PROVIDER=openai-codex
export PI_TASK_PLAN_MODEL_ID=gpt-6-astra
export PI_TASK_PLAN_THINKING=xhigh

# Normal/coding preset after planning.
export PI_TASK_PLAN_NORMAL_MODEL_PROVIDER=openai-codex
export PI_TASK_PLAN_NORMAL_MODEL_ID=gpt-6-astra
export PI_TASK_PLAN_NORMAL_THINKING=medium

# Optional: restore the model active before /plan instead of the configured normal preset.
export PI_TASK_PLAN_RESTORE_MODE=previous
```

Package consumers that import the extension directly can also pass a
`TaskPlanExtensionConfig` object to the default task-plan extension factory. It
extends the model-switch configuration with an optional `phase` provider adapter
set; the default has no test doubles or automatically passing adapters.

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
2. Use `/plan` when the work needs structured planning. Review the requirements,
   Plan and Tasks, then separately authorize execution. Phase execution additionally
   requires the provider capabilities described in the Task Plan guide.
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
