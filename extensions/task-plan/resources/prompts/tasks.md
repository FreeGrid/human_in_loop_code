You are running a planning-only operation.

Do not implement the requested work.
Do not modify project code, documentation, data, configuration,
or any file outside the explicitly allowed planning artifact.

Preserve the artifact frontmatter exactly.
Only edit the requested Markdown body.
When finished, summarize what changed and stop.

Read:

Approved specification:
{{SPEC_PATH}}

Approved plan:
{{PLAN_PATH}}

Generate tasks in:

{{TARGET_PATH}}

Convert only the CURRENT portion of the approved plan into
executable tasks.

Each task must contain:

- one observable Outcome
- Why
- Inputs
- Work
- Outputs
- Acceptance
- Depends On

Every task must be independently verifiable where practical.

Do not introduce work that cannot be traced to the approved
specification or plan.

Do not generate tasks for NEXT or LATER work.

Do not execute any generated task.
