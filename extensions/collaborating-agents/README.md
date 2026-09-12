# 多 Agent 协作：让分工和交接看得见

[返回首页](../../README.md) · [先跑通一个项目](../../docs/getting-started.md) · [模型配置](../../docs/models.md)

一个研究任务可能同时需要调查代码、补测试、写论文说明和审阅实现。全塞进一个会话，局部细节会越积越多；随意启动很多会话，又可能让两个 Agent 同时改一个文件，彼此不知道对方正在做什么。协作扩展提供的是分工、消息、文件预留和结果交接，让并行工作能够被观察。

Agent 是一个可以调用工具的模型会话。父 Agent 负责协调，子 Agent 接受一项具体任务。小而直接的工作通常由一个会话完成即可；适合分出去的，是有清楚输入、交付物和文件范围的工作。例如，一个会话只核对 KM 负权案例，另一个只整理已有命令行说明。需要共同决定接口或写同一个文件时，先讨论清楚，再依次执行，未必开得越多越快。

## 先确认协作后端

本文下面的 `/subagent`、`/agents`、`agent_message`、角色 TOML、文件预留与 process/cmux 配置，均适用于 **Pi native 后端**。默认 `/control:init` 生成 native 规则；在 Codex、Claude 中则使用各自原生协作机制，Pi 命令不会自动成为其他宿主的命令。

可选的 `/control-init-herdr` 生成统一使用 Herdr 的规则，无论控制者或子 Agent 使用哪种宿主，都按已安装的 Herdr skill 创建、通信、等待和收集结果，不混用本文的 Pi 原生工具或 cmux 流程。初始化只生成规则；Herdr 程序、skill 和实际委派所需的 `HERDR_ENV=1` 环境，以及已有工作空间的后端切换方式，见 [Herdr 初始化说明](../control-init/README.md#用-herdr-管理子-agent)。任务包需携带后端选择和相关 control 规则，不能假设 code 会自动读取 control 的 AGENTS.md。

两种后端都应优先跟进上下文仍适用的熟悉 Agent，先补充信息或纠偏；反复偏离要求或任务已不适合原上下文时，再通过实际后端另开会话。普通跟进不必等待验收，也无需额外日志、工作流标识或交接文档。独立审查从不继承实现者对话的新会话开始，Reviewer 不实现自己裁定的改动，但可以继续复核修复。最终由控制者核对结果，并保留明确指定的 Human 或独立验收权限。

## 先派出一个范围清楚的任务（Pi native）

确认 `pi config` 已启用 `collaborating-agents` 与 `collaborating-agents-system`。在 Pi 中输入：

```text
/subagent 阅读 ../matching_code 中的 KM 实现，只检查负权处理，报告具体位置和理由，不修改文件。
```

没有指定类型时使用默认 worker，通常继承父会话模型。成功启动后会看到运行名称、Batch ID 和子任务 Run ID。默认后台执行，父会话会自动收集子 Agent 的最终输出；子 Agent 不需要再发送一条重复的最终消息，但遇到阻塞或需要决策时可以主动联系父 Agent。

结果返回只表示这个工作单元交付了答复，不能自动批准实现或合并 PR。若它声称测试通过，应查看实际运行依据；独立审阅需要不同会话、合理信息边界和真实检查，不靠名字叫 `reviewer` 就自动成立。

也可指定已配置的角色：

```text
/subagent scout 查找读取命令行参数的入口，只返回相关文件与函数。
/subagent documenter 检查命令行指南是否与当前参数一致，先报告差异。
/subagent reviewer 审阅这次提交，关注负权和输入边界，暂不改文件。
```

只有第一个词匹配已知角色时，才按角色解释，否则整段输入都作为任务。自带角色可能指定了你没有配置的模型；先使用默认 worker，或按下文覆盖角色模型，再尝试专用角色。Task Plan 的三个阶段预设不会自动覆盖这些角色文件。

## 打开协作面板

在 Pi 输入 `/agents`，可以看到四个页签。`Agents` 显示会话和状态，可切换到选中的活跃会话；`Feed` 展示消息流；`File reservations` 展示文件预留；`Chat` 用来直接与其他 Agent 沟通。启用扩展的会话启动后会登记；刚启动但还没有持久会话文件的记录可能显示 `session pending`。

Chat 中使用 `@名称` 私信，`@all` 广播。例如把面板中真实名称替换进下面的 `BlueFalcon`：

```text
@BlueFalcon 请先暂停修改，输入格式还需要确认。
@all T001 的接口已确认，可以按各自范围继续。
@BlueFalcon !! 请立即停止修改 src/cli/，有人正在处理同一处冲突。
```

普通消息排队到接收者本轮结束后处理，`!!` 标记的紧急消息通过 steering 尽快打断当前活动。不要用广播代替每项任务的清楚交接。已完成子 Agent 会保留在面板中一段时间，下一次协调者启动新子任务时会清理旧的面板历史项；持久运行记录用于之后的定位。

## 文件预留解决协作冲突，不代替权限隔离

开始修改前，Agent 可以预留具体文件或小目录。另一活跃 Agent 用 Pi 的 `write` 或 `edit` 写入匹配路径时会被拦住，并得到占用者和原因，随后可以发送消息协调。读取仍允许。

预留只覆盖这个工具钩子，不拦截所有 shell、外部编辑器或其他进程的写入；它不是操作系统沙箱。空模式会被拒绝，过宽的 `.`、`/` 或顶层目录会给出警告。尽量预留实际负责的文件，做完释放，避免用一个很大的范围阻塞所有人。

同一个 control/code 工作空间里，委派时说清目标目录：实现进 code，测试进 control，论文进对应 paper。公共运行状态目录可以让会话彼此发现，但目录共用本身不授予跨项目修改权限。

## 查看子任务，不扫描全部聊天记录

模型可以用 `agent_message` 查询当前协调者范围内的子运行记录，再查看短尾部。人可直接要求“查看刚才子任务的最新输出”，无需自己翻 `~/.pi/agent/sessions`。下面是工具调用形式，供理解和排障，不是需要在终端运行的 TypeScript：

```ts
agent_message({ action: "sessions" })
agent_message({ action: "sessions", includeCompleted: false })
agent_message({ action: "session", runId: "子任务运行ID" })
agent_message({ action: "tail", runId: "子任务运行ID" })
```

默认列表包括完成或失败记录，`includeCompleted: false` 只看活跃运行。精确选取可用 child run id（也称 `recordId`）、display name（显示名）、canonical name（运行名称）、session id prefix（会话 ID 前缀）或 `latest`。batch id 只有恰好对应一个孩子时才能唯一解析；并行批次会要求选择具体 Run ID，不能随意挑一份输出。

后台 process 子会话通常要等孩子登记或按会话 ID 发现文件后才能读取尾部。若出现 `Process-mode session file unavailable until child registration or fallback discovery provides one.`，先查看运行状态，稍后再用 Run ID 查询，不要用不相关会话文件补上。cmux 模式有显式会话文件，也要等文件实际出现。

## 常用工具对照

| 模型工具或动作 | 用途 |
| --- | --- |
| `subagent` 的 `task` | 启动一项任务，可带 `type`、`cwd` |
| `subagent` 的 `tasks` | 启动多项并行任务，每项可给 `cwd`；顶层 `type` 应用于这批任务 |
| `sessionControl` | 是否给孩子传 `--session-control`，默认 true |
| `agent_message`：`status` / `list` | 当前身份、对方状态与预留数量 |
| `sessions` / `session` / `tail` | 查询子运行记录与短输出 |
| `send` / `broadcast` | 私信或广播；可用 `urgent`，私信可用 `replyTo` |
| `feed` / `thread` | 查看近期全局消息或与指定 Agent 的消息，可给 `limit` |
| `reserve` / `release` | 预留或释放 `paths`；省略 release 的路径表示释放全部 |

适合并行时，可以让协调者调用下面这样的工具参数；输入是任务说明，不是对全部仓库的笼统授权：

```json
{
  "tasks": [
    { "task": "只读核对负权测试覆盖，报告缺口", "cwd": "/data/research/matching_control" },
    { "task": "只读核对命令行指南的参数例子，报告差异", "cwd": "/data/research/matching_code" }
  ]
}
```

## 角色配置：给特定工作一份稳定说明

角色文件是 TOML，一种简单的配置文本。一个文件对应一个角色，普通用户可以从例子修改，不必写扩展源码。以下内容保存为 control 中 `.pi/agents/km-reviewer.toml`，然后在该 control 目录启动 Pi：

```toml
name = "km-reviewer"
description = "只读检查 KM 算法和需求的一致性"
model = "custom-qwen/qwen38-27b-fp8"
reasoning = "high"
prompt = """先阅读当前需求与限定范围的代码。
检查负权、匹配完整性和输入输出边界，不改文件。
报告具体问题、位置、依据和未能检查的部分。
需要更多上下文时向父 Agent 说明，不扩大任务。"""
```

调用 `/subagent km-reviewer 检查当前实现是否满足已确认的 KM 需求` 即使用这个角色。示例模型要先在 Pi 登记；不指定 `model` 时继承父模型。角色的 `reasoning` 接受 `low`、`medium`、`high`、`xhigh`，与 Task Plan 可接受的全部等级并不相同。部署模型如何响应 thinking，仍取决于 [模型接入](../../docs/models.md)。

配置按从低到高覆盖同名角色：包内 `examples/subagents/*.toml`；用户目录 `~/.pi/agent/subagents`、`~/.pi/subagents`、`~/.pi/agents`；从当前目录向上寻找的项目 `.pi/subagents`、`.pi/agents`。新配置推荐最后两种 `agents` 路径。没有指定角色时，优先用户/项目覆盖的 worker，再考虑覆盖的 default，然后使用包内 worker 与兜底实现。

自带角色和实际模型配置见 [角色示例目录](../../examples/subagents)。例如当前 scout 配置了 `openai-codex/gpt-5.4-mini`，documenter/reviewer 配置了 `openai-codex/gpt-5.5`；它们不是账号赠送或可用性保证，应该按自己的可用模型覆盖。

## 后台运行还是可见终端（Pi native）

默认 `process` 在后台启动 Pi 子进程，适合先跑通流程。如果你使用支持分屏的 cmux 终端，并且父 Pi 已经运行在 cmux 内，可选择 `cmux-pane`，每个子任务都有可见的 Pi 终端。没有 cmux 环境时不要开启这个选项。

配置从默认值、全局 `~/.pi/agent/collaborating-agents.json`、当前目录 `.pi/collaborating-agents.json` 依次覆盖。项目文件相对**实际 cwd**，不像角色搜索那样寻找最近祖先。下面是完整的基础示例，保存后重启 Pi：

```json
{
  "messageHistoryLimit": 400,
  "subagentLaunchMode": "process",
  "closeCompletedCmuxPanes": true
}
```

`messageHistoryLimit` 决定面板默认读取的消息数量，必须为正数；更大意味着一次读取和显示更多内容。`subagentLaunchMode` 只接受 `process` 或 `cmux-pane`。`closeCompletedCmuxPanes` 默认 true，成功子任务结果被收集并经过短暂空闲后关闭面板；设 false 则保留。失败、非零退出或无法确认空闲时会保留诊断窗口。无效配置值回退默认。

cmux 模式会尝试平衡新分屏的位置，并在手动移动或关闭面板后尽力重新整理受管理面板。这不保证任意桌面布局都原样不动；希望保持人工布局时，可使用后台模式。

| 环境变量 | 作用 |
| --- | --- |
| `COLLABORATING_AGENTS_DIR` | 改共享状态根目录，默认 `~/.pi/agent/collaborating-agents`；可用不同位置隔离项目 |
| `PI_AGENT_NAME` | 显式指定运行名称；日常可保留自动生成 |
| `PI_COLLAB_SUBAGENT_DEPTH` | 当前子任务层级，由运行流程传递 |
| `PI_COLLAB_SUBAGENT_MAX_DEPTH` | 默认最多 2 层，当前深度达到上限后不再生成孩子 |

状态根目录包含 `registry/` 登记、`inbox/` 消息队列、`runs/` 子运行记录和 `messages.jsonl` 消息历史。这些属于协作运行状态，不写入 readable Plan。修改存储位置后，只有使用相同位置的会话才能共享这些记录。

<details>
<summary>维护者：兼容术语与人工核对入口</summary>

会话检索规则：Do not scan `~/.pi/agent/sessions` manually。请通过运行记录选择子会话，避免混入其他项目。

现有上游验证入口（在本工具源码检出中运行；不要求新手执行）：

```bash
bun test extensions/collaborating-agents/docs.test.ts
bun test extensions/collaborating-agents/index.test.ts --test-name-pattern "tool documentation metadata|agent_message subagent sessions|subagent launch identity"
bun test extensions/collaborating-agents/session-tail.test.ts
npm pack --dry-run
```

Manual smoke: process mode：用默认后台模式启动一项只读任务，核对 Run ID、登记和短输出。

Manual smoke: parallel ambiguity：两项并行任务共用 batch id 时应要求选择孩子，再用 child Run ID 读取。

Manual smoke: cmux mode：在 cmux 内启动可见子会话，核对窗口、会话文件、结果收集和成功关闭行为。

</details>
