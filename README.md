# Collaborating Agents: An Extension for the Pi Coding Agent

This is an extension for Pi for spawning subagents, and for them to reserve files and send/receive messages to one another.

All sessions auto-register immediately when they start; so when a new Pi session is started, it is already part of the collaborating agents system.

## Quick Start

Install this extension and its included skill using **either** npm (recommended) or the git URL.

### Option 1: Install from npm

```bash
pi install npm:@baochunli/pi-collaborating-agents
```

### Option 2: Install from git URL

```bash
pi install https://github.com/baochunli/pi-collaborating-agents
```

Use the command:

```bash
pi config
```

To confirm that the `collaborating-agents` extension and the `collaborating-agents-system` skill have been activated. Use `Esc` to leave the configuration session.

To uninstall this extension:

```bash
pi remove npm:@baochunli/pi-collaborating-agents
```

or (if you installed using git URL):

```bash
pi remove https://github.com/baochunli/pi-collaborating-agents
```


## Setting up `AGENTS.md`

Use `pi config` to activate both the `pi-collaborating-agents` extension and the `collaborating-agents-system` skill, and (optionally) add the following to `AGENTS.md` for more specific instructions.

```text
Before handling the task, first learn the `collaborating-agents-system` skill. Use it to understand the available collaboration capabilities, including:

- spawning and coordinating subagents
- parallelizing suitable tasks
- sending direct and broadcast messages between agents
- reserving and releasing files/directories before edits

Then execute the task under these rules:

1. Prefer parallelism for read-heavy exploration and review tasks.
2. Reserve files/directories before any write.
3. Keep process logging single-writer when possible.
4. Use direct messages for blockers and decisions.
5. Use broadcasts for shared status updates.
6. Prefer low-coupling task decomposition; avoid conflicting parallel edits.

Choose an appropriate split of work, coordinate subagents carefully, and keep the execution process organized and auditable.
```

## Opening the _Agents and Messages_ Overlay with the `/agents` Command

The `/agents` slash command opens an integrated _agents and messages_ overlay with four tabs:

  - `Agents` tab contains a list of all active and recently completed agents, and it allows the user to switch to the selected active session and tracks the target session in real time.
  - `Feed` tab shows recent message activity across agents.
  - `File reservations` tab shows active reservation patterns and which agent currently owns each one.
  - `Chat` tab provides a shared chat stream and input box for `@all` broadcasts and direct `@AgentName` messages.

Newly-started agents show up immediately; if their transcript file is not persisted yet they are marked `session pending`. Completed subagents remain visible in the `Agents` tab as `completed` until the next time an orchestrator agent spawns new subagents, which clears prior historical completed-subagent entries from that list.

Messaging input is available in the `Chat` tab. Use `@AgentName message` for direct messages or `@all message` for broadcast. Prefix the message body with `!!` to mark it urgent.

Examples:

- Direct: `@BlueFalcon Status update: parsing complete.`
- Direct + urgent: `@BlueFalcon !! Need your decision now.`
- Broadcast: `@all Wave 2 complete.`
- Broadcast + urgent: `@all !! Stop edits in src/server/ until migration finishes.`

## Spawning a subagent via the `/subagent` command

The user can spawn a single subagent manually using the `/subagent [type] <task>` slash command. By default it runs as a background child process, but you can switch it to a visible cmux pane with `subagentLaunchMode`. When no type is specified, the extension resolves the default subagent type (`worker`/`default`) using the normal override order described below. In slash-command usage, the first token is treated as a type only if it matches a known subagent type; otherwise the full input is treated as the task. All agents use readable two-word callsigns (for example: `SilverHarbor`). An immediate `Spawning subagent ...` status message with runtime name and prompt will be shown immediately.

If you want spawned agents to appear in a visible cmux pane instead of only running as background child processes, set `subagentLaunchMode` to `"cmux-pane"` in your collaborating-agents config. That mode uses `cmux new-split` plus `cmux send`, then launches a real `pi` session directly in the new pane so you see Pi's own terminal output there while the orchestrator still collects the final subagent response automatically. The extension now applies a two-phase layout strategy: it first chooses a balanced split target from the current managed pane tree, then runs a best-effort reconciliation pass with `cmux list-panes`, `cmux list-pane-surfaces`, `cmux move-surface`, and `cmux reorder-surface` so existing managed surfaces are moved back into the intended panes if the workspace drifted. This mode must be invoked from a Pi session that is already running inside a cmux terminal surface; otherwise subagent launch fails.

### Usage

```bash
# Use default subagent type
/subagent "Implement user authentication"

# Use a specific subagent type
/subagent scout "Find all TypeScript files in the project"
/subagent documenter "Write API documentation for the auth module"
/subagent reviewer "Check for security issues in src/auth/"
```

The parent (orchestrator agent) sessions automatically collect final subagent outputs on completion (single and parallel), without requiring subagents to send a separate final direct message summary. All direct subagent → parent status messages are optional, but are useful for blockers/questions only. Inbox delivery uses Pi's message routing: normal messages are queued with `followUp`, and `urgent: true` messages interrupt immediately with `steer`.

## Autonomous Tool API for Agents

The following tools are provided for agents to call autonomously. Users should use the slash commands above.

### The `agent_message` Tool

The extension provides a dedicated **`agent_message`** tool for autonomous agent-to-agent messaging.

Actions:

- `status` – current identity, focus mode, peer count, and your reservation count
- `list` – list active agents (includes reservation counts when present)
- `sessions` – list scoped subagent run/session records; completed/failed are included by default, set `includeCompleted: false` for active runs only
- `session` – resolve one subagent run/session record
- `tail` – read a concise transcript tail for one resolved subagent run/session
- `send` – send direct message (`to` + `message`, optional `replyTo`, optional `urgent`)
- `broadcast` – send to all active peers (`message`, optional `urgent`)
- `feed` – recent global message log (`limit` optional)
- `thread` – direct-message thread with one peer (`to`, `limit` optional)
- `reserve` – reserve files/directories for write/edit coordination (`paths`, optional `reason`)
- `release` – release reservations (`paths` optional; omit to release all)

Reservation patterns are validated. Empty patterns are rejected, and broad patterns (for example `.`, `/`, `./`, `../`, or a top-level directory like `src/`) are allowed but return warnings.

Examples:

```ts
agent_message({ action: "list" })
agent_message({ action: "sessions" })
agent_message({ action: "sessions", includeCompleted: false })
agent_message({ action: "session", runId: "subagent-run-id" })
agent_message({ action: "tail", runId: "subagent-run-id" })
agent_message({ action: "tail", to: "latest" })
agent_message({ action: "send", to: "BlueFalcon", message: "I finished parsing" })
agent_message({ action: "send", to: "BlueFalcon", message: "Following up on your last note", replyTo: "msg-123" })
agent_message({ action: "send", to: "BlueFalcon", message: "Need your decision now", urgent: true })
agent_message({ action: "broadcast", message: "Wave 2 complete" })
agent_message({ action: "thread", to: "BlueFalcon", limit: 10 })
agent_message({ action: "reserve", paths: ["src/server/", "src/routes/account.tsx"], reason: "auth refactor" })
agent_message({ action: "release", paths: ["src/server/"] })
agent_message({ action: "release" })
```

### Subagent Session Inspection

Coordinators should inspect spawned subagents with `agent_message` instead of searching transcript files directly. Do not scan `~/.pi/agent/sessions` manually for normal subagent inspection; use the run registry so selectors stay scoped to the current coordinator.

Common calls:

```ts
agent_message({ action: "sessions" })
agent_message({ action: "sessions", includeCompleted: false })
agent_message({ action: "session", runId: "subagent-run-id" })
agent_message({ action: "tail", runId: "subagent-run-id" })
agent_message({ action: "tail", to: "latest" })
```

Selectors accepted by `session` and `tail`:

- child run id / `recordId`: the stable per-child id returned by `subagent` and launch notices
- display name: the readable subagent name shown in launch/completion output
- canonical name: the runtime subagent name recorded by the extension
- batch id: accepted only when it resolves to one child; parallel batches are ambiguous and return candidates
- session id prefix: matches the reported Pi session id prefix
- `latest`: newest subagent run for the current coordinator

`sessions` lists active, completed, and failed records for the current coordinator by default. Pass `includeCompleted: false` to show only launching/running runs. `session` returns run metadata, session id, session file status, launch mode, cwd, and task preview. `tail` reads and formats the resolved session JSONL tail; it rejects raw file paths so agents do not bypass selector scoping.

Process-mode subagents are launched as background `pi` child processes without a deterministic `--session` file. The extension records the session id from child output and attaches a session file only after child self-registration or fallback discovery by session id. Until then, tailing can report: `Process-mode session file unavailable until child registration or fallback discovery provides one.` In `cmux-pane` mode, the extension creates an explicit session file under `~/.pi/agent/sessions/collaborating-agents-subagents/` and tails that file after it appears.

### The `subagent` Tool

The extension also provides a lightweight **`subagent`** tool for agents to call when they need to spawn subagents.

Modes:

- Single: `{ task }` or `{ type, task }`
- Parallel: `{ tasks: [{ task, cwd? }, ...] }` or `{ type, tasks: [...] }`

Parameters:

- `task` (string, optional) – Task prompt for single-mode
- `tasks` (array, optional) – Array of task objects for parallel-mode
- `type` (string, optional) – Subagent type to use (e.g., "scout", "documenter", "reviewer")
- `cwd` (string, optional) – Working directory for spawned subagents
- `sessionControl` (boolean, optional) – Spawn with `--session-control` (default: true)

Examples:

```ts
// Default subagent type
subagent({ task: "Implement auth tags and report back via agent_message" })

// With specific subagent type
subagent({
  type: "scout",
  task: "Find all TypeScript files in the project"
})

// Parallel subagents
subagent({
  tasks: [
    { task: "Implement backend pieces" },
    { task: "Implement frontend pieces" }
  ]
})

// Parallel with specific type (applies to all tasks)
subagent({
  type: "documenter",
  tasks: [
    { task: "Document backend API" },
    { task: "Document frontend components" }
  ]
})
```

Launch responses and background launch notices include a Batch ID plus one child Run ID per spawned subagent. Prefer those Run IDs for `agent_message({ action: "session", runId: "..." })` and `agent_message({ action: "tail", runId: "..." })`; use `agent_message({ action: "sessions" })` to rediscover active and recent completed runs, or `includeCompleted: false` for active runs only.

## Subagent Type Configuration

You can define custom subagent types using TOML configuration files. These allow you to create specialized subagents with different prompts, models, and reasoning levels.

### Configuration locations

Subagent type configurations are loaded in precedence order (later entries override earlier ones when names match):

1. **Bundled defaults**: `examples/subagents/*.toml` (included with this extension)
2. **User overrides**:
   - Legacy: `~/.pi/agent/subagents/*.toml`
   - Also supported: `~/.pi/subagents/*.toml`
   - Preferred: `~/.pi/agents/*.toml`
3. **Project overrides** (nearest ancestor from current cwd):
   - Legacy: `.pi/subagents/*.toml`
   - Preferred: `.pi/agents/*.toml`

If no override directory contains a matching type, the extension falls back to the included `examples/subagents` configuration files.

### TOML format

Each `.toml` file defines one subagent type:

```toml
name = "scout"
description = "Exploration specialist for finding files and patterns"

# Optional: Override the model (defaults to parent session's model)
model = "openai/gpt-4o-mini"

# Optional: Set reasoning level (low, medium, high, xhigh)
reasoning = "low"

# Required: The system prompt for this subagent type
prompt = """You are a Scout subagent specialized in exploration...

## Guidelines
- Be quick and focused
- Use bash, find, grep efficiently
- Report findings in structured format
"""
```

### Default subagent type

When no type is specified, the extension resolves the default in this order:

1. the highest-precedence non-bundled `worker.toml` override found in user/project directories
2. otherwise the highest-precedence non-bundled `default.toml` override found in user/project directories
3. bundled discovered `worker`
4. bundled `examples/subagents/worker.toml`
5. Emergency inline fallback (only if bundled files are unavailable)

To customize the default behavior, create `worker.toml` in one of the supported user or project override directories.

### Example subagent types

The extension includes example configurations for common use cases:

| Type | Purpose | Reasoning |
|------|---------|-----------|
| `worker` | General-purpose development tasks | medium |
| `scout` | Exploration and discovery | low |
| `documenter` | Documentation writing | medium |
| `reviewer` | Code review and analysis | high |

See the `examples/subagents/` directory for complete example configurations.

### Using subagent types

**Via slash command:**
```bash
/subagent scout "Find all API endpoints in src/"
/subagent documenter "Write README for the auth module"
/subagent reviewer "Check src/auth.ts for security issues"
```

**Via the `subagent` tool:**
```ts
// Single subagent with type
subagent({
  type: "scout",
  task: "Find all TypeScript files"
})

// Parallel subagents with types
subagent({
  tasks: [
    { task: "Document auth module" },  // uses default/worker type
    { task: "Review auth module" }     // uses default/worker type
  ],
  type: "documenter"  // applies to all tasks
})
```

## Configuration

This extension supports both **JSON config files** and **environment variables**.

### Configuration file locations and precedence

The extension loads and merges configuration in this order:

1. Built-in defaults
2. Global config: `~/.pi/agent/collaborating-agents.json`
3. Project config: `<cwd>/.pi/collaborating-agents.json` (overrides global)

Invalid config values fall back to defaults. Numeric fields such as `messageHistoryLimit` must be positive.

### Config keys

#### `messageHistoryLimit` (number, default: `400`)

Default history depth used by the overlay feed/chat loader.

- Larger values allow more history at once but increase read/format work.
- Smaller values keep UI snappier in very high-message sessions.

This is a default baseline; runtime calls may still request larger limits.

#### `subagentLaunchMode` (`"process" | "cmux-pane"`, default: `"process"`)

Controls how spawned subagents are launched.

- `"process"` keeps the current behavior: spawn a background `pi` child process directly.
- `"cmux-pane"` launches the subagent in a new visible cmux split pane in the current workspace by calling `cmux new-split` and then sending a real `pi` launch command into that pane.
- In `"cmux-pane"` mode, the extension tracks the orchestrator pane plus visible subagent panes in the workspace and picks the shallowest managed pane for the next split (preferring subagent panes over the orchestrator on ties). It alternates horizontal and vertical split directions by tree depth so the layout trends toward a balanced grid instead of repeatedly slicing columns off the orchestrator pane.
- After each new pane is created, the extension also snapshots live cmux panes/surfaces and performs a best-effort rebalance pass. If managed surfaces drifted because of manual pane moves or closes, it uses `move-surface`/`reorder-surface` to restore the planned arrangement before continuing.

Use `"cmux-pane"` when you want every spawned agent to have a real visible terminal in cmux while still preserving automatic result collection in the parent session. The pane shows Pi's native terminal session output instead of a custom JSON renderer.

By default, successfully completed `"cmux-pane"` subagents are auto-closed after the orchestrator has collected their final output and the pane has stayed idle for a short grace period. If the pane reports a non-zero post-output exit during that grace period, or if close/idle detection fails, the pane is left open so you can inspect diagnostics.

`"cmux-pane"` requires the orchestrator itself to be running inside cmux so the extension can split the current workspace.

Example:

```json
{
  "subagentLaunchMode": "cmux-pane",
  "closeCompletedCmuxPanes": true
}
```

#### `closeCompletedCmuxPanes` (boolean, default: `true`)

Controls whether successfully completed `"cmux-pane"` subagents automatically close their terminal surface after the parent orchestrator has collected the final output and the pane has remained idle for a short grace period.

- `true` closes successful completed panes by calling `cmux close-surface --surface <ref>` after turn-finished output plus a short idle grace.
- `false` keeps completed panes open for manual inspection.

This setting only affects `"cmux-pane"` launch mode. Failures or non-zero exits detected during the idle grace leave panes open so logs remain visible.

### Environment variables

#### `COLLABORATING_AGENTS_DIR`

Overrides the storage root used by the extension. Default:

- `~/.pi/agent/collaborating-agents`

This affects:

- `registry/` (active agent registrations)
- `inbox/` (per-agent inbound queue)
- `runs/` (durable subagent run/session records)
- `messages.jsonl` (global append-only message log)

Use this to isolate per-project state or relocate agent data.

#### `PI_AGENT_NAME`

Forces an explicit runtime agent name instead of auto-generated names.

Useful for deterministic scripts/tests or named coordinator sessions.

#### `PI_COLLAB_SUBAGENT_DEPTH` and `PI_COLLAB_SUBAGENT_MAX_DEPTH`

Recursion guard for nested subagent spawning.

- `PI_COLLAB_SUBAGENT_DEPTH` tracks current depth.
- `PI_COLLAB_SUBAGENT_MAX_DEPTH` sets max allowed depth (default max is `2`).

If `depth >= max`, subagent spawn is blocked.

## How It Works

Messages use Pi's delivery system: normal messages queue until the recipient finishes their current turn, urgent ones interrupt immediately. No polling is needed.

Reservations are enforced by hooking Pi's edit and write tools. When an agent tries to edit a reserved file, the tool call gets blocked and the agent sees who reserved it, why, and a suggestion to coordinate via the `agent_message({ action: "send", ... })` tool. Write and edit calls are blocked when another active agent has a matching reservation. Reads remain allowed.

States in this extension are stored at `~/.pi/agent/collaborating-agents/`:

```
.pi/agent/collaborating-agents/
├── registry/          # One JSON file per agent
├── inbox/{name}/      # Inbound messages as JSON files, watched with fs.watch, one directory for each agent
├── runs/              # Durable subagent run/session records, one JSON file per child run
└── messages.jsonl     # Append-only log of all messages in the system
```

## Human-gated task planning

The package also includes the `task-plan` extension. It converts one rough goal
into three reviewable Markdown artifacts without executing the resulting work:

```text
/plan:new <goal>
  -> spec.md (What and Why)
  -> Human approval
  -> plan.md (How, with Current / Next / Later horizons)
  -> Human approval
  -> tasks.md (Current only)
  -> optional convergence
  -> final Human approval
```

Only the `Current` horizon becomes tasks. `Next` and `Later` remain deliberately
coarse until a future planning cycle. A task is an observable outcome with
inputs, outputs, acceptance checks, and valid acyclic dependencies—not merely a
request to edit a file.

### Commands

| Command | Purpose |
|---|---|
| `/plan:new <goal>` | Create the only active work item and ask Pi to draft `spec.md`. |
| `/plan:status` | Show its stage, artifact statuses, validation summary, and next action. |
| `/plan:revise <instruction>` | Revise the current draft without advancing or approving it. |
| `/plan:validate` | Run deterministic structure and dependency checks without calling a model. |
| `/plan:approve` | Open an explicit interactive Human Gate and advance one stage. |
| `/plan:converge` | Minimally repair task coverage, necessity, atomicity, dependencies, verifiability, and scope. |

There is no `--yes` approval path. `/plan:approve` is rejected in non-interactive
mode, and approved artifacts are frozen in V1.

### Workspace and artifacts

Run Pi from the project root that should own the plan. The extension writes only
under that project's `planning/` directory:

```text
planning/
├── .current
├── active/
│   └── W-YYYYMMDD-HHMMSS-goal/
│       ├── spec.md
│       ├── plan.md
│       └── tasks.md
└── completed/
    └── W-YYYYMMDD-HHMMSS-goal/
        ├── spec.md
        ├── plan.md
        └── tasks.md
```

Each artifact begins with plugin-owned metadata:

```yaml
---
harness: task-plan/v1
work_id: W-20260903-090000-main-experiment
stage: spec
status: draft
---
```

Review the Markdown body directly. Do not hand-edit `harness`, `work_id`,
`stage`, or `status`; the extension owns workflow state. On final approval it
marks `tasks.md` approved, moves the work directory to `planning/completed/`,
and removes `.current`.

### Example planning session

```text
/plan:new Verify that the main experiment can be reproduced reliably
/plan:validate
/plan:approve
/plan:validate
/plan:approve
/plan:converge
/plan:validate
/plan:approve
```

After every generation or convergence turn, inspect the artifact or diff before
approving it. Convergence can run more than once and never approves tasks
automatically.

### Local development loading

From a clone of this package, either install the whole local package:

```bash
pi install /absolute/path/to/human_in_loop_code
```

or load only the planning extension for a one-off smoke test:

```bash
pi -e /absolute/path/to/human_in_loop_code/extensions/task-plan/index.ts
```

Remove a local package with the exact source used during installation:

```bash
pi remove /absolute/path/to/human_in_loop_code
```

### Common planning errors

- `active work already exists`: finish or deliberately repair the work named by
  `planning/.current`; V1 does not allow parallel active plans.
- `invalid frontmatter` or `stage mismatch`: restore the four metadata fields
  and rerun `/plan:validate`; the extension will not guess or silently repair
  workflow state.
- validation errors: fix every error before approval. Warnings are shown at the
  Human Gate and require human judgment.
- missing `plan.md` or `tasks.md` after an interrupted generation: the created
  draft remains the current stage; use `/plan:revise <instruction>` to restart
  generation for that artifact.

### Safety boundary and compatibility

Pi extensions run with high local privileges. Review third-party package source
before installing it. During a planning turn, this extension blocks Pi's `bash`
tool and allows the built-in `write` and `edit` tools only for the current
planning artifact after canonical path checks. That guard is a narrow V1
mistake-prevention mechanism, not a complete sandbox: it does not prevent the
human, another process, or another extension/custom tool from changing files.

The implementation was verified against the locally installed
`@mariozechner/pi-coding-agent@0.73.1` API. It uses `registerCommand`,
`sendUserMessage`, `tool_call`, `ctx.isIdle()`, `ctx.hasUI`, and
`ctx.ui.confirm()`. Pi 0.73.1 exposes `agent_end` rather than the proposed
`agent_settled` event, so the transient generation guard clears on `agent_end`.

Non-goals for V1 include task execution, subagent orchestration, databases,
multiple active plans, background work, Git commits, and automatic project-code
or paper modification. The separate collaborating-agents extension remains
available, but the planning workflow itself does not invoke it.

## Template-first control workspace initialization

The control-init extension turns an explicitly named set of repositories into a
durable, auditable workspace. Natural-language requests are the primary entry:
Pi selects a built-in topology and calls a structured tool. The extension asks
only for facts that the template and current context cannot determine.

Examples:

```text
Use this directory as control and ../my-app as code. Initialize the workspace.
Initialize one code/control workspace and add separate paper-a and paper-b LaTeX repositories.
Show the current control workspace status.
The code repository moved to ../my-app-v2; update its binding.
```

### Agent tools and command fallback

| Agent tool | Human command | Behavior |
| --- | --- | --- |
| `control_workspace_init` | `/control:init` | Initialize `CONTROL_INDEX.json`, a managed `AGENTS.md` block, and any explicitly approved local Git repositories. |
| `control_workspace_status` | `/control:status [control-path]` | Read repository bindings, Git state, policies, warnings, and incomplete items. |
| `control_workspace_doctor` | `/control:doctor [control-path]` | Deterministically check schema, canonical paths, Git roots, remote identity, repository boundaries, and managed-block drift. |
| `control_workspace_update` | `/control:update [control-path]` | Preview and apply binding, topology, policy, requirement, or managed-block changes while preserving unaffected state. |

Structured tools never open dialogs. They return one of `applied`,
`needs_input`, or `conflict`; Pi should ask only the returned questions and then
retry. The `init` and `update` tools run sequentially so concurrent tool calls
in one Pi process cannot race one another. Byte-for-byte index and AGENTS
preconditions also reject stale writes from another process.

The slash commands are the Human-UI fallback. `/control:init` shows the full
profile contract, collects exact directories and one optional exception note,
renders the candidate index plus the exact managed AGENTS content, and asks for
final confirmation before any write.
`/control:update` prints the current state first, retains the user's original
change description, clarifies only the affected category, prints before and
after state, and asks for final confirmation. Cancelling either command leaves
the workspace unchanged. Print/JSON modes without a Human UI refuse the
interactive commands; an RPC host may use them only if it implements Pi's
extension UI request/response protocol.

### Built-in profiles

`control-code` is the recommended default:

- `control` is private by default and owns plans, tests, fixtures, verification
  tools, documents, evidence, implementation records, and release records.
- `code` contains only delivered production source, runtime-required resources,
  package metadata, and user-facing product documentation. It may become public
  and must never depend on control at runtime.

`control-code-latex` inherits that contract and adds one independent private
LaTeX repository per paper. Each paper repository owns only its manuscript,
bibliography, paper figures, submission materials, and directly related writing
records. Multiple papers may refer to the same code repository; code never
depends on a paper repository, and paper repositories do not depend on one
another.

Select `custom` only when those contracts cannot express the requested
topology. Custom initialization requires an explicit directory, role,
visibility, ownership list, and relationships for every repository. Circular
or protected runtime dependencies and multiple owners for the same artifact
class are rejected deterministically. Custom input may also choose from the
shipped AGENTS focus modules; built-in profiles retain the complete V1 set.

### Authoritative files and safe updates

`CONTROL_INDEX.json` uses schema `human-in-loop/control-index/v1`. It records
stable repository IDs, portable control-relative paths where possible, kinds,
visibility, redacted remote identities, artifact owners, relationships,
policies, and the exact SHA-256 hash of the generated AGENTS block. Unknown
schema versions and fields are not rewritten.

The extension owns only this marker-bounded portion of `AGENTS.md`:

```text
<!-- control-init:managed:start version=1 -->
...
<!-- control-init:managed:end -->
```

Existing bytes outside the markers are preserved. An existing AGENTS file with
no markers requires an explicit append choice. Manual changes inside the block
produce drift; update requires an explicit preserve, regenerate, or hand-merge
decision and never silently repairs it. Moving a repository or changing its
remote is handled through update with an explicit new path or accepted remote
identity. A new path is still checked against the previously recorded remote,
and doctor re-renders the canonical managed block to detect an index edited
without its corresponding AGENTS update. Removing a binding never deletes its
directory or Git data.

### Directory and Git safety

Every directory must be explicit. The extension does not scan the home folder
or infer a code/paper directory from its name. A missing path triggers at most
three similar candidates from the specified parent's direct children. A
candidate is never adopted automatically. If none is correct, the exact
canonical path must be approved before directory creation and local `git init`.

An existing non-Git directory can be initialized in place after confirmation;
all existing files remain byte-for-byte unchanged. Preview includes the exact
path and explains that `git init` creates no remote, commit, or push. Symlink
aliases, relative traversal above the workspace parent, duplicate/nested
bindings, invalid Git metadata, and paths that appear or change after preview
are rejected. Status, doctor, and update re-check persisted relative paths
before Git inspection, so an edited path cannot escape the workspace boundary
or cause an outside repository to be inspected. File persistence uses temporary
files, exclusive creation, a cross-process `.control-init.transaction.lock`,
post-write parsing/doctor checks, and cross-file rollback. The lock is removed
on normal success or failure. If the authoritative files were applied and
verified but lock cleanup alone fails, the result remains `applied` and carries
a recovery warning instead of falsely reporting that the write failed. After an
abrupt process termination, confirm that no control-init operation is running
before manually removing a leftover lock and rerunning doctor. Bootstrap rollback
removes only unchanged metadata or repositories created by the current
operation; externally changed content is preserved and reported.

### Generated Agent workflow and Human gates

The generated AGENTS block does not make the extension a task or Git executor.
The four extension operations never create a remote, commit, push, open a PR,
merge, release, or run product work. Instead, the durable rules distinguish two
human decisions:

- Approving a plan accepts only its text and does not start implementation.
- Explicitly assigning a task authorizes the Agent to complete that scoped task,
  verify it, make focused commits on a feature branch, push them, and open a PR
  after validation.

The PR is the automation boundary. New remotes, broader scope, destructive
operations, merge, and release still require an explicit human decision.
Multi-repository changes use separate commits and cross-reference the product
and control SHAs plus honest verification results.

### Compatibility and removal

Control-init was verified against
`@mariozechner/pi-coding-agent@0.73.1` on Node.js `>=20.6.0`. Other Pi versions
are unverified. Internal JSON and Markdown templates load relative to the
extension module and are included in the npm package; startup registration does
not read or write the user's workspace.

The extension has no daemon or database. Remove the installed package with the
same source used at installation, for example:

```bash
pi remove npm:@baochunli/pi-collaborating-agents
```

Removing the package does not delete `CONTROL_INDEX.json`, the managed AGENTS
block, or any repository. Remove or revise those durable files manually only
after reviewing the workspace contract they preserve.

## Validation

Use `bun test` for implementation and docs validation. Useful focused checks for the subagent session inspection surface:

```bash
bun test extensions/collaborating-agents/docs.test.ts
bun test extensions/collaborating-agents/index.test.ts --test-name-pattern "tool documentation metadata|agent_message subagent sessions|subagent launch identity"
bun test extensions/collaborating-agents/session-tail.test.ts
bun test
npm pack --dry-run
```

Keep `npm pack --dry-run` as the packaging check before publishing or validating package contents.

Manual smoke: process mode

1. Use default `subagentLaunchMode: "process"` and spawn a single subagent.
2. Confirm the launch notice shows Batch ID, Run ID, runtime name, and session status.
3. Run `agent_message({ action: "sessions" })`, then `agent_message({ action: "session", runId: "<run-id>" })`.
4. Run `agent_message({ action: "tail", runId: "<run-id>" })`; if the session file is still unavailable, confirm the process-mode unavailable reason is shown.

Manual smoke: parallel ambiguity

1. Spawn at least two parallel subagents in one batch.
2. Run `agent_message({ action: "session", runId: "<batch-id>" })` and confirm it reports an ambiguous selector with candidate child Run IDs.
3. Run `agent_message({ action: "tail", runId: "<child-run-id>" })` for a specific child.

Manual smoke: cmux mode

1. When running inside cmux, set `subagentLaunchMode: "cmux-pane"` and spawn a subagent.
2. Confirm a visible pane opens and the launch/session-ready notices include a session file.
3. Run `agent_message({ action: "tail", runId: "<run-id>" })` and confirm it tails the cmux session file.
