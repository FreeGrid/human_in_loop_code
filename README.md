# Human-in-the-Loop Toolkit for Pi

This package adds three complementary extensions to the
[Pi coding agent](https://github.com/badlogic/pi-mono): durable workspace
governance, human-gated planning, and coordinated multi-agent execution.

The extensions can be used independently, but together they address a common
problem: an agent can produce changes quickly while the reasons for the work,
the boundaries between repositories, the human approval points, and the
execution history remain implicit. This toolkit makes those decisions visible,
reviewable, and recoverable.

## The three layers

```text
repository boundaries       approved work                 coordinated execution
    control-init       ->       task-plan       ->       collaborating-agents
```

The arrows show the recommended sequence, not a runtime dependency. Installing
the package enables all three extensions, and each extension remains useful on
its own.

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

### 2. Task Plan: turn a rough goal into approved work

**Why it matters.** A plausible implementation plan is not the same thing as
human authorization to execute it. Without explicit stages, scope and
acceptance criteria tend to blur together, and long-range ideas prematurely
become detailed tasks.

**What it does.** Task Plan converts one goal into a reviewable `spec.md` →
`plan.md` → `tasks.md` workflow. Human approval separates every stage;
deterministic validation checks structure and dependencies; convergence repairs
task quality without approving it. Only the `Current` horizon becomes tasks,
and the extension does not execute those tasks.

[Read the Task Plan guide](extensions/task-plan/README.md)

### 3. Collaborating Agents: coordinate execution without losing control

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

## Installation

Choose one source below. A version of this package that contains the complete
toolkit enables all three extensions and the bundled
`collaborating-agents-system` skill with one installation.

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
- `task-plan`
- `control-init`
- `collaborating-agents-system`

If one of the three extensions is absent, the selected source predates that
extension; install this repository's current Git source or local checkout.

Press `Esc` to leave the configuration screen. Start a new Pi session after
installing or updating the package so the extensions and skill are reloaded.

## A minimal first workflow

1. Run `/control:init` or ask Pi in natural language to initialize the named
   repositories. Review the complete preview before approving any write.
2. Run `/plan:new <goal>`. Review and explicitly approve the spec, plan, and
   current tasks one stage at a time.
3. Explicitly assign approved work. Use `/subagent` or let an orchestrator use
   the `subagent` tool when delegation or context isolation is worthwhile.
4. Use `/agents` to inspect active Agents, messages, and file reservations;
   verify the result before accepting delivery.

Control Init does not automatically start planning, and Task Plan does not
automatically spawn Agents. Those boundaries are intentional human gates.

## Updating and removing

Re-run `pi install` with the same source to update an installation. To remove
the package, pass the exact source originally used:

```bash
pi remove npm:@baochunli/pi-collaborating-agents
pi remove https://github.com/FreeGrid/human_in_loop_code
pi remove https://github.com/baochunli/pi-collaborating-agents
pi remove /absolute/path/to/human_in_loop_code
```

Use only the matching line. Removing the package disables its runtime
extensions but does not delete plans, `CONTROL_INDEX.json`, managed `AGENTS.md`
content, repositories, commits, or other durable artifacts created while using
it.

## Safety and compatibility

Pi extensions run with high local privileges. Review third-party source before
installing it, keep repository paths explicit, inspect Human Gate previews, and
review changes before committing or publishing them.

Task Plan and Control Init were verified against
`@mariozechner/pi-coding-agent@0.73.1`; Control Init requires Node.js `>=20.6.0`.
See each extension guide for its precise safety boundary, compatibility notes,
configuration, commands, and validation procedures.

## License

[MIT](LICENSE)
