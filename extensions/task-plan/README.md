# Task Plan

A Plan keeps the current requirements and a rolling checklist in one readable file. It replaces superseded wording instead of accumulating analysis, strategy, review or execution records.

Use `/plan` with a natural-language request. The Planner asks at most one currently blocking question, states nonblocking defaults and creates a few tasks. One task is enough for simple work. Only the current task expands; completed tasks retain their checked line.

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

- [Ordinary commands and editing](v3-workflow.md)
- [Minimal format and checkbox semantics](v3-format.md)
- [Optional governed execution](v3-governed.md) for configured hosts that need additional execution controls
- [Explicit legacy V1/V2 workflow](legacy-workflow.md)

V1/V2 files are read-only through ordinary V3 tools. Explicit migration preview uses supplied current requirements and never writes the old file. The legacy entry retains the original execution lifecycle. No automatic migration, commit, merge or release follows from a Plan command.
