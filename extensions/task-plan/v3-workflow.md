# Working with a readable Plan

Start with `/plan` followed by what you want to do. The planner asks at most one currently blocking question, states reasonable nonblocking defaults, and saves the current requirements with a short checklist. A simple request may have just one task. Planning alone does not start implementation.

| Action | How |
|---|---|
| Change requirements | Describe the change, or use `/plan:edit …` |
| Open an existing file | `/plan:open plans/001-example.md` |
| See progress | `/plan:status` |
| Mark ordinary completion | `/plan:task T001 done`, or edit `[ ]` to `[x]` |
| Reopen work | `/plan:task T001 open` |
| Continue current work | `/plan:next` |

Only the current task receives new detail. Completed tasks retain their subtasks and each subtask’s checkbox, so the work remains readable later. Marking a parent complete changes only its own checkbox. Reopening or selecting a task also preserves recorded children. The next task is refined when needed. Changing requirements replaces the old wording in place; affected completed work reopens by default. You remain free to mark work complete yourself. Edits normally report only their changes and impact rather than printing the entire Plan again.

The ordinary tools are `plan_start`, `plan_get`, `plan_update`, `plan_refine`, `plan_set_task_status`, `plan_select`, `plan_status`, and `plan_continue`. They work without a signing key, journal, execution approval or hidden state. A copied readable file can be opened in a fresh session. If another editor changes a file after it was read, reread it before retrying the edit. No command blocks ordinary host tools merely because a Plan is selected.

Preferred planning/execution model settings are optional. If that model is unavailable, the current model can still plan and work. The file never stores model settings.

The host defaults to V3. `plan_get` and `/plan:open` can also display the title and checklist of existing V1/V2 files without importing their old planning layers into ordinary context. These old files are read-only through the V3 tools; their bytes and execution records stay intact. Unsupported historical sketches are rejected without rewriting them. An explicit migration-preview request can supply a new current brief and checklist to `plan_migration_preview`. The preview writes no file, transfers no execution evidence and has no apply action.

To keep using the original V1/V2 lifecycle, load `extensions/task-plan/legacy-index.ts` instead of the default entry. Existing named legacy APIs are exported there. Programmatic hosts may alternatively `await taskPlanExtension(pi, { legacy: true })`; explicitly configured legacy `creationOptions` or `phase` dependencies take the same awaitable path. `{ creationOptions: { format: "v3" } }` selects V3 even if legacy settings are present. Ordinary host work remains available; the strict legacy lifecycle is not applied to readable completion. [Optional governed execution](v3-governed.md) is separate and never inferred from a checkbox. An unconfigured `/plan:governed` command explains how ordinary work can continue.

See [the format specification](v3-format.md) for the complete file shape. The [legacy guide](legacy-workflow.md) describes the original lifecycle and DocSync support.
