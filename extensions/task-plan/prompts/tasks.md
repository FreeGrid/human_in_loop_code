Draft only current-round stage Tasks from the approved Plan T+0. Do not create stage Tasks for T+1 or later horizons.

List stage Tasks directly as T001/T002 headings; do not add a separate T+0 grouping block. Each Txxx item should be a meaningful larger stage or delivery unit, and its smaller work items should be listed under `#### Tasks`.

Use this concise structure:

### T001 — Stage-oriented title [ ]
#### Tasks
- Smaller task or step [ ]
- Smaller task or step [ ]
#### Acceptance
- [ ] Checkable stage-level criterion
#### Depends On
None.

### T002 — Next stage [ ]
#### Tasks
- Smaller task or step [ ]
#### Acceptance
- [ ] Checkable stage-level criterion
#### Depends On
- T001

Use `[ ]` for open stage Tasks and `[x]` only for completed historical stage Tasks. Use the same trailing marker style for smaller tasks under `#### Tasks`, for example `- Smaller task [ ]`; do not use leading checkboxes like `- [ ] Smaller task`. Do not put completion in a separate field.

For later rounds after roll-forward, add only the hidden metadata line `<!-- pi-plan:round:RNNN -->` immediately below each new stage Task heading; do not add a visible Round section.

Task IDs are globally increasing across the whole Plan. Keep stage Tasks concise: do not add Round, Outcome, Why, Inputs, Work, or Outputs fields.
