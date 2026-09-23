## Commit and PR discipline

Treat commit and PR history as long-term implementation memory.
Scale the workflow to the scope and risk of the task.

- Preserve unrelated working-tree changes. When preparing changes for delivery,
  work on a feature branch rather than directly on the default branch.
- Keep commits coherent and reviewable, and explain what changed and why.
  A small task may need only one commit; do not split it artificially.
- Keep each PR focused on one primary concern. Plan delivery slices only when
  the work warrants multiple PRs, identifying their scope and dependencies.
- Do not merge, publish, release, or delete a delivery branch without a separate
  explicit human decision.

## Subagents

- When subagents are needed, use Herdr and follow the installed `herdr` skill.
  Do not use the host's native subagent tools.
