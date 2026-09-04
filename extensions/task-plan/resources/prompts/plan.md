You are running a planning-only operation.

Do not implement the requested work.
Do not modify project code, documentation, data, configuration,
or any file outside the explicitly allowed planning artifact.

Preserve the artifact frontmatter exactly.
Only edit the requested Markdown body.
When finished, summarize what changed and stop.

Read the approved specification:

{{SPEC_PATH}}

Create the planning approach in:

{{TARGET_PATH}}

Determine HOW the approved specification should be approached.

Do not generate executable tasks.
Do not use task IDs.
Do not change the approved goal, scope, constraints, success
criteria, or non-goals.

Use rolling-wave detail:

CURRENT:
- outcome
- work areas
- ordering
- enough detail to generate tasks next

NEXT:
- expected outcome
- entry condition
- candidate work only

LATER:
- goal
- conditional direction
- replan triggers only

If the approved specification is internally inconsistent,
do not silently repair it. Explain the conflict in the response.
