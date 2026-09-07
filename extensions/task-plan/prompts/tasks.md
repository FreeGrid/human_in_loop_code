Native v2 format takes precedence over the legacy guidance below: inspect snapshot.format. Submit shared Strategy with plan_submit_section and exactly one canonical node with plan_submit_node. Native source has Work, Outcome, Round, Progress and Depends On (last); do not create a second Tasks projection. Use plan_review with the selected task_id, then wait for separate Human contract approval and execution authorization. V1 documents retain their existing sections.

Draft only the current stage's executable Tasks from the approved Plan, normally replacing/expanding the Plan's `T001` current stage. Do not expand T002 or later stages yet.

Use the same stage ID as the Plan current stage and add the completion marker only here. The smaller executable tasks go under `#### Tasks`.

Use this concise structure:

### T001 — Current stage title [ ]
#### Tasks
- Smaller task or step [ ]
- Smaller task or step [ ]
#### Acceptance
- [ ] Checkable stage-level criterion
#### Depends On
None.

Use `[ ]` for open stage Tasks and `[x]` only for completed historical stage Tasks. Use the same trailing marker style for smaller tasks under `#### Tasks`, for example `- Smaller task [ ]`; do not use leading checkboxes like `- [ ] Smaller task`. Do not put completion in a separate field.

For later rounds after roll-forward, add only the hidden metadata line `<!-- pi-plan:round:RNNN -->` immediately below each new stage Task heading; do not add a visible Round section.

Task IDs are globally increasing across the whole Plan. Keep stage Tasks concise: do not add Round, Outcome, Why, Inputs, Work, or Outputs fields.
