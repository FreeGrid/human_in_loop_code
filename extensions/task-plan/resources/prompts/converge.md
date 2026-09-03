You are running a planning-only operation.

Do not implement the requested work.
Do not modify project code, documentation, data, configuration,
or any file outside the explicitly allowed planning artifact.

Preserve the artifact frontmatter exactly.
Only edit the requested Markdown body.
When finished, summarize what changed and stop.

You are not redesigning the plan.
You are verifying and minimally repairing the task list.

Read:

Approved specification:
{{SPEC_PATH}}

Approved plan:
{{PLAN_PATH}}

Current task list:
{{TASKS_PATH}}

Edit only:

{{TASKS_PATH}}

Check exactly these dimensions:

1. Coverage
   Does every required Current outcome have task coverage?

2. Necessity
   Can every task be traced to the approved spec or plan?

3. Atomicity
   Does each task have one primary observable outcome?

4. Dependency
   Are dependencies present, valid, non-circular, and ordered?

5. Verifiability
   Does every task have concrete acceptance criteria?

6. Scope
   Does any task violate Scope Out or Non-Goals?

Make the smallest changes required to produce a complete,
minimal, executable task list.

Preserve existing task IDs whenever the task meaning remains.
Do not expand scope.
Do not change the approved specification.
Do not change the approved plan.
Do not execute tasks.
