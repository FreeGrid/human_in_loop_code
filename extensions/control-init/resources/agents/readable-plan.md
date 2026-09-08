### Readable Plan and continuation (Pi / Codex)

Use the same Markdown Plan in Pi and Codex. Read these rules and the current file when starting or resuming work; do not depend on chat memory. Codex may edit it with ordinary file tools. No Skill, Plan command, MCP server, execution state or Harness is required for ordinary use. These are Agent instructions, not program-enforced guarantees.

- Reuse the current Plan for added requirements and changed goals, even when all tasks are complete. Create a separate Plan only when no Plan exists or the Human explicitly requests a new one. Use the explicitly selected path first; without one, inspect the declared plans location and use the sole unfinished Plan, or the sole completed Plan if none is unfinished. If selection is ambiguous, ask which file; if the selected file cannot be read, report that problem instead of silently creating another.
- Keep new readable Plans directly in the repository that owns plans, under `plans/NNN-kebab-case-name.md`, using the next unused number. Do not renumber or overwrite old files. For V3, use only `format: pi-plan/v3` and a unique `plan_id: PNNN` in frontmatter, one title, current deduplicated requirements in prose, and a two-level checkbox tree. Use stable `TNNN` IDs for top-level tasks; preserve IDs when reordering. Existing legacy or management documents retain their own format; do not automatically migrate or strip their fields.
- Each fact has one home. Replace superseded requirements in place. Do not append Original Request, What/Why, Strategy, Acceptance, Verification, result summaries, history, hashes, receipts or runtime records. Required delivery slices, verification and release records belong in separate control management documents, linked from those documents to the Plan's task IDs, not in the readable Plan.
- The first unchecked top-level task is current. Refine nearby unfinished tasks in place as their work becomes clear; keep distant tasks coarse. A simple Plan may have one task and no children. Usually two to four useful actions suffice when children help; this is guidance, not a quota. Do not manufacture stages or additional deliverables just to fill a checklist.
- When the Human says “continue” / “继续” to proceed with a ready Plan, treat that as an execution request for the next pending work. Read the file, select the current task and its first unchecked child, and begin work in the same turn. If no children are needed, execute the task directly. If a reopened parent has all children checked, inspect its remaining goal rather than declaring it complete automatically. If everything is checked, say so; do not invent more work. Continuing a planning discussion is not an implementation request; ask only a genuinely blocking question. Plan approval alone does not authorize execution, and existing Human permission boundaries still apply.
- Record each completed child with `[x]` promptly; once all children are complete and the parent goal is achieved, check the parent. Reopening a child reopens its parent. Preserve completed children, their wording and order; never delete them merely because work finished. Tasks without children can be checked directly. Completion adds no result or verification text to the Plan.
- Humans may check or reopen items directly. Respect an explicit Human parent checkbox without silently rewriting its children during reads or unrelated edits. Ordinary `[x]` means considered complete, not authenticated verification or independent Review. Report actual test failures honestly in the conversation or required execution records; never describe a failed check as passing. Optional Harness rules apply only when that workflow is selected; missing Harness state does not block ordinary planning or editing.
- Apply requirement changes only to the affected prose and tasks. Reopen completed work whose definition materially changes (and its parent where applicable); unaffected completion remains. Reply with the changes and their impact rather than reprinting the whole Plan. Reread before editing to preserve Human or other Agent changes.

Example readable Plan (the input/output and matching assumptions below are specific to this example, not defaults for other requests):

```markdown
---
format: pi-plan/v3
plan_id: P001
---

# C++ KM matching

Implement a C++17 single-file program within 100 lines for maximum-weight
perfect matching on a square complete bipartite graph. Integer weights may be
negative. Read n and its weight matrix; output the total weight and matching.

- [ ] T001 Implement the algorithm
  - [ ] Initialize labels and matching
  - [ ] Maintain slack and augment
- [ ] T002 Add input and output
```
