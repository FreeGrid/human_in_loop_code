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

Only the current task is expanded. After completion, only its checked line remains. The next task is expanded when needed. Changing requirements replaces the old wording in place; affected completed work reopens by default. You remain free to mark work complete yourself. Edits normally report only their changes and impact rather than printing the entire Plan again.

The ordinary tools are `plan_start`, `plan_get`, `plan_update`, `plan_refine`, `plan_set_task_status`, `plan_select`, `plan_status`, and `plan_continue`. They work without a signing key, journal, execution approval or hidden state. A copied readable file can be opened in a fresh session. If another editor changes a file after it was read, reread it before retrying the edit. No command blocks ordinary host tools merely because a Plan is selected.

Preferred planning/execution model settings are optional. If that model is unavailable, the current model can still plan and work. The file never stores model settings.

The host now defaults to V3. Existing integrations that explicitly configure legacy `creationOptions` or legacy `phase` dependencies continue on the V1/V2 path; `{ creationOptions: { format: "v3" } }` explicitly selects V3. The strict legacy lifecycle is not applied to ordinary readable completion. Optional governed execution is a separate integration and never inferred from a checkbox.

See [the format specification](v3-format.md) for the complete file shape. The remaining historical task-plan documentation describes the legacy lifecycle.
