# Readable Plan V3

A Plan records the current requirements and a rolling checklist. It is an ordinary Markdown file and remains useful without execution state or a configured Controller.

```markdown
---
format: pi-plan/v3
plan_id: P001
---

# C++ KM matching

Write a C++17 single-file program within 100 lines for maximum-weight perfect
matching on a square complete bipartite graph. Integer weights may be negative.
Read the size and weight matrix; output the total weight and matching.

- [ ] T001 Implement the algorithm
  - [ ] Initialize labels and matching
  - [ ] Maintain slack and augment
- [ ] T002 Add input and output
- [ ] T003 Check the implementation
```

Only `format` and `plan_id` are allowed in frontmatter. The body has one title, prose requirements and a two-level checkbox tree. There are no section markers or hidden records. Put each requirement in one place; task labels describe work without repeating the requirements.

The first unchecked top-level task is current. Only that task receives new small work. Future tasks not yet refined remain one line; recorded children remain visible under completed or previously selected tasks. A simple Plan may contain one task and no subtasks. IDs remain attached to tasks when their order changes; they do not determine which task is current.

`[x]` means currently considered complete. Humans may check a task directly, including in an external editor. Ordinary completion does not need authentication or evidence. During ordinary execution, the Agent records each completed subtask immediately. A child status update automatically checks its parent when every child is checked; reopening a child reopens its parent. This upward update preserves every subtask's text and order. A task with no subtasks is completed directly. Reading, saving, reopening or selecting another task does not remove recorded children. An explicit Human/manual parent edit remains valid and does not automatically change child checkboxes. Pure reads and unrelated edits do not overwrite that choice. Ordinary aggregation is not governed evidence. Explicitly editing the current subtask list can still revise or remove items. Do not append results, summaries or verification details. A substantive requirement or task edit normally reopens affected work; the Human may mark it complete again.

The codec and file APIs are independent of legacy formats and execution state. Reads never create a runtime or acquire a write lock. Writes validate the complete candidate, compare the original file bytes and atomically replace it under a cooperative per-file lock. A stale edit must reread the current file before retrying. An unknown lock affects that write only; it does not prevent reading or ordinary editing with another editor. These locks do not make arbitrary external writers transactional. A post-replacement durability error is reported as uncertain rather than falsely claiming that no write occurred.

V1/V2 retain their own format and identity interpretation. V3 file writers refuse to overwrite a legacy document. Creating a V3 Plan allocates the next flat `plans/NNN-title.md` identity without rewriting old files. No automatic migration is performed.

Optional governed execution can maintain stricter contracts and authenticated evidence outside this file. Such evidence is not implied by a handwritten checkbox and is never required for ordinary use.
