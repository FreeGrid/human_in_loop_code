# Task Plan

A Plan keeps the current requirements and a rolling checklist in one readable file. It replaces superseded wording instead of accumulating analysis, strategy, review or execution records.

Use `/plan` with a natural-language request to update the selected Plan; it creates a file only when none exists. New requirements, changed goals and scope changes remain in that same Markdown, even if all tasks are complete. Only an explicit request for another Plan or `/plan:new` creates a separate file. Read failures or ambiguous selection require recovery/selection, not silent creation. The Planner asks at most one currently blocking question, states nonblocking defaults and creates a few tasks. One task is enough for simple work. Current work should be actionable; nearby unfinished tasks may receive known detail when useful, while distant work stays coarse. A clear task can remain one line, even when current. There is no required number of expanded tasks or subtasks; completed tasks retain their subtasks and checkboxes. During ordinary execution, the Agent records each finished subtask and the parent is checked automatically after the last one.

```markdown
---
format: pi-plan/v3
plan_id: P001
---

# KM 算法程序

实现不超过 100 行的 C++17 单文件 KM 程序，求 n×n 完全二分图的最大权完美匹配。整数权值允许负数。输入 n 和权值矩阵，输出最大总权值及匹配结果。不支持缺边、非方阵或非完美匹配。

- [ ] T001 实现程序
  - [ ] 完成核心算法与输入输出
  - [ ] 检查实现符合需求
```

Change requirements in place with `/plan:edit …`. Use `/plan:status` for progress, `/plan:task T001 done` to check a task, and `/plan:next` to continue ordinary work. You can edit and check the Markdown yourself. Ordinary completion needs no hidden state or certification; a copied Plan remains usable in a fresh session. Planning alone does not request implementation.

Planning, execution and review have separate global model preferences. They currently
all default to `custom-qwen/qwen38-27b-fp8` (the locally registered Qwen 3.8 model),
with thinking `high` for planning/review and `medium` for execution. Enable reasoning
in the Pi model registration; for vLLM use `qwen-chat-template` compatibility.
That format maps both levels to thinking enabled, not separate token budgets.
Use the exact provider/model registered in your Pi installation.

| Stage | Model ID variable | Entry |
|---|---|---|
| Planning | `PI_TASK_PLAN_PLANNING_MODEL_ID` | `/plan`, `/plan:edit` |
| Execution | `PI_TASK_PLAN_NORMAL_MODEL_ID` | `/plan:next`, `plan_continue` |
| Review | `PI_TASK_PLAN_REVIEW_MODEL_ID` | `/plan:review` |

Each stage also supports the corresponding `_MODEL_PROVIDER` and `_THINKING`
variables. Set them before starting Pi; explicit stage variables override the older
common aliases. `PI_TASK_PLAN_MODEL_SWITCH=0` disables switching. Missing model
preferences do not block ordinary work. `/plan:review` is ordinary review, while
Harness review forwards the preset to a separately configured independent reviewer.
See the [root README configuration example](../../README.md) for all variables.
Model settings stay outside the Plan file.

- [Ordinary commands and editing](v3-workflow.md)
- [Minimal format and checkbox semantics](v3-format.md)
- [Optional governed execution](v3-governed.md) for configured hosts that need additional execution controls
- [Explicit legacy V1/V2 workflow](legacy-workflow.md)

V1/V2 files are read-only through ordinary V3 tools. Explicit migration preview uses supplied current requirements and never writes the old file. The legacy entry retains the original execution lifecycle. No automatic migration, commit, merge or release follows from a Plan command.
