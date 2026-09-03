# Task Plan

[← Back to the toolkit overview](../../README.md)

The `task-plan` extension converts one rough goal
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

## Commands

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

## Workspace and artifacts

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

## Example planning session

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

## Local development loading

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

## Common planning errors

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

## Safety boundary and compatibility

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
