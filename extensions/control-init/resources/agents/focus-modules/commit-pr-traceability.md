### Branch, commit and PR traceability

Work on a feature branch. Make each small, complete and reviewable change a focused commit, then push it.

A plan, plugin, epic or complete product capability is not automatically one PR-sized feature. Before implementing planned work, define reviewable delivery slices that map every task ID to one or more PRs, with each PR's primary review concern, base or dependencies and scoped validation. A medium-sized plan should normally produce four to six product PRs, targeting five; record why another count is more reviewable.

Each PR should address one primary concern, leave its affected files internally coherent and normally contain three to eight focused commits. A task may span PRs, and tightly coupled tasks may share one PR. Open each delivery-slice PR after its own required checks pass instead of waiting for the entire plugin or plan. Add verification incrementally, and keep the final slice for integration, hardening, documentation and end-to-end evidence rather than a hidden major subsystem.

For multi-repository work, keep separate scoped commits. Every product delivery-slice PR must cross-reference its exact control verification commit SHAs and results. Control evidence may accumulate in one final verification PR when its independent test increments remain separately committed. Do not merge or release without the required Human decision.
