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
