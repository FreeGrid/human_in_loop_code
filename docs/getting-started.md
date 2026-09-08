# 从零开始：安装并完成第一个项目

[返回首页](../README.md) · [仓库与论文指南](../extensions/control-init/README.md) · [遇到问题](troubleshooting.md)

这份教程从一个空目录开始。你将建立彼此独立的 control 和 code 仓库，把“百行内 KM 算法”写成可读计划，再明确要求 Agent 开始工作。暂时不需要配置多 Agent、文档映射或受治理执行。先走通这一小圈，就能知道每个工具在什么时候出现。

## 终端、Pi 和模型，分别负责什么

终端是输入系统命令的窗口，macOS 可以打开“终端”应用；Linux 使用自己的终端。`cd` 用来进入目录，`mkdir` 创建目录。Pi 在这个窗口中运行，连接你选择的模型，并让模型调用读写文件等工具。模型服务可能来自一个在线提供方，也可能由你自己部署；安装 Pi 本身不会提供模型账号或运行模型的服务器。

下文标为 `bash` 的代码在**终端**执行，标为 `text` 且以 `/` 开头的命令在**Pi 的输入框**里输入。不要把 `/control:init` 当作终端命令。没有 `/` 的中文示例则可以直接作为给 Agent 的要求。

## 安装并确认 Pi 能回答问题

先安装 [Node.js](https://nodejs.org/en/download) 和 [Git](https://git-scm.com/downloads)。Node.js 是运行 Pi 的程序环境，会一起提供 `npm` 安装命令；Git 负责文件版本记录。这里的安装示例以已验证目录切换的 Pi **0.84.4** 为基准，它要求 Node.js **22.19.0 或更高版本**。Windows 用户先参考 [Pi 的平台说明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/windows.md)；本文 shell 示例按 macOS/Linux 编写。

```bash
node --version
git --version
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4
pi --version
pi
```

在 Pi 内输入 `/login`，选择你已有账号支持的提供方并完成登录；也可以按照提供方说明设置 API Key。接着输入 `/model` 选择可用模型，再发一句普通问题确认能收到回答。自部署服务需要先在 `~/.pi/agent/models.json` 登记地址和模型，配置入口见 [模型指南](models.md)。这里的 `~` 表示你的用户目录，配置属于你自己的 Pi，不能把真实密钥提交到项目仓库。

安装与登录方式以 [Pi 官方入门](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#quick-start) 为准。本文核对的是上面的版本，不代表所有历史或未来版本行为相同。

## 安装这个工具包

退出 Pi 回到终端，安装本仓库：

```bash
pi install https://github.com/FreeGrid/human_in_loop_code
pi config
```

配置界面里应能看到并启用 `control-init`、`task-plan`、`collaborating-agents` 三个扩展，以及 `collaborating-agents-system` 技能。扩展增加命令与工具，技能提供协作时的工作说明。按 `Esc` 离开配置，再重新启动 Pi 加载它们。

如果以前安装过 Pi 示例 `plan-mode`，建议在 `pi config` 中禁用那一项，只保留这里的 Task Plan，避免两个计划功能同时影响操作。你不需要卸载其他无关扩展。源安装与开关的含义见 [Pi 包管理文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)。

已经把本仓库下载到本地的人也可以改用下面的来源。二者选一个，不要重复加载同一份扩展：

```bash
pi install /绝对路径/human_in_loop_code
```

历史 npm 名称 `@baochunli/pi-collaborating-agents` 与原上游 Git 地址仍然存在，但它们可能尚未发布本文的新功能。第一次体验这套完整流程，优先使用上面的 FreeGrid Git 来源。

## 给工作建立清楚的归属

先选一个用来容纳项目的普通目录。例如：

```bash
mkdir -p ~/research/matching
cd ~/research/matching
pi
```

在 Pi 中输入：

```text
/control:init
```

向导目前的按钮文字可能是英文。先选择 `Recommended — control + code`，再选择从工作空间名称创建仓库的选项，名称输入 `matching`。它会在当前目录下准备 `matching_control` 和 `matching_code`。名称中不用再加 `_control` 或 `_code`；如果目标已经存在，改用“使用已有目录”，不要强行重复创建。

向导最后会展示实际路径和将写入的文件。看清楚 control 保存管理过程、code 保存交付物以后，再选择 `Apply the shown initialization`。如果路径不对，可以返回修改；也可以取消。此时只建立本地 Git 仓库和工作规则，没有创建 GitHub 仓库，没有提交或推送你的文件。

成功后 Pi 会将当前会话续接到 control 目录，后续读文件和 shell 命令也以该目录为工作位置。你可以运行 `/control:status` 查看绑定，运行 `/control:doctor` 检查路径与规则是否一致。需要一开始就配论文，或者已有代码工程，请继续读 [Control Init 的具体例子](../extensions/control-init/README.md)。

自然语言也可以发起初始化，例如“创建一个名为 matching 的本地 control 和 code 工作空间”。这种工具调用不能在模型执行中直接替换会话，完成后按提示输入 `/control:enter`，再继续规划。

## 先读懂计划，再让模型执行

在 Pi 中输入以下完整需求。算法细节本身不是本教程的重点；这个例子刻意把输入、输出和边界说清，方便你判断模型有没有自行增加内容。

```text
/plan 实现一个不超过 100 行的 C++17 单文件 KM 程序，求 n×n 完全二分图的最大权完美匹配。整数权值允许负数。输入 n 和权值矩阵，输出总权值和匹配结果。不支持缺边、非方阵和非完美匹配。先做计划，暂不写代码。
```

Plan 保存在 control 下的 `plans/` 中，通常形如 `001-km.md`。它应是一段当前需求加一棵勾选任务树，而不是逐轮追加的分析报告。**把需求和每一条任务完整读一遍。** 发现多出的限制、文件或功能，先让它改计划。例如：

```text
仍然修改当前计划：不需要性能基准报告，不要增加额外的用户功能。
```

计划符合你的意思后，另行明确开始执行：

```text
按这份计划开始执行当前任务。实现放在 code，测试与验证放在 control。
```

后续可以说“继续”。自然语言的继续依赖模型调用正确工具；如果它没有行动，直接输入：

```text
/plan:next
```

这个命令给 Agent 当前任务和必要工作上下文；它不代表任务瞬间完成。执行时完成一个子任务就记录一个，所有子任务完成后程序汇总父任务。完成的子任务仍然保留。你可以输入 `/plan:status` 看短进度，也可以直接打开 Markdown。普通 `[x]` 表示当前认为完成，不自动表示测试或独立审阅通过。更完整的修改和状态规则见 [Task Plan](../extensions/task-plan/README.md)。

本工具默认预设了一个自部署 Qwen 模型标识。如果你的 Pi 没有登记它，会提示切换失败并保留当前模型，普通使用仍可继续。先只使用已经选好的模型时，可以在终端这样启动：

```bash
PI_TASK_PLAN_MODEL_SWITCH=0 pi
```

这行设置仅影响本次 Pi 进程。要长期设置三个阶段，按 [模型指南](models.md) 配置，不需要改源码。

## 明天继续，不重新建立一遍

第二天最直接的做法，是在终端进入 control，再启动 Pi：

```bash
cd ~/research/matching/matching_control
pi
```

如果 Pi 已经在其他目录启动，可以在 Pi 中输入：

```text
/control:enter /完整路径/matching/matching_control
```

把示例替换成你机器上的完整路径。刚刚初始化的同一会话可以省略路径；重启后应明确提供。已经初始化过的仓库不需要再次运行 `/control:init`。若使用 `--no-session` 关闭了会话保存，就按扩展显示的 `cd ... && pi` 命令重新启动，不能通过会话续接切换目录。

接着明确指定要继续的文件，例如“阅读 AGENTS.md 和 plans/001-km.md，继续当前未完成任务”。普通 Plan 不依赖某次聊天的隐藏记录，所以换一个会话仍能看懂。切换工程时，应重新确认工作目录与所选 Plan。

## 交付前走完最后一小步

实现中的用户可见行为稳定后，就让 Agent 更新 code 中相关说明；准备交付当前大任务或 PR 时，再核对相关变化是否有文档遗漏。PR 可以理解为“把这一组提交交给人审阅的申请”。不是每个小任务都要再生成一篇报告；小而完整的提交组成一个可审阅的交付片即可。

初始化生成的规则会要求明确授权、按范围实施、验证后提交 PR，并把合并、发布和破坏性操作留给人单独决定。这些是给 Agent 的持久指令；Control Init 本身不会替你运行实现或 Git 发布。普通流程已经够用时，不需要额外搭建 Harness。需要程序提供文档候选位置时，读 [文档检索指南](../extensions/task-plan/docsync/delivery.md)。

## 更新或停用

Git 来源安装在 Pi 管理的本地副本中，不会因为远端刚合并就自动出现在当前会话。Pi 0.84.4 可以针对同一来源更新：

```bash
pi update https://github.com/FreeGrid/human_in_loop_code
```

本地路径安装则跟随那份检出的文件；先让检出更新到需要的版本，再重启 Pi。安装包更新不会偷偷重写已有工作空间的 `AGENTS.md`，模板更新流程见 [Control Init](../extensions/control-init/README.md#更新现有工作空间的规则)。

只想暂时停用某一扩展时使用 `pi config`。要删除整个包，使用安装时的同一个来源，例如：

```bash
pi remove https://github.com/FreeGrid/human_in_loop_code
```

卸载只移除扩展加载关系，不会删除你的 control、code、论文、Plan 或 Git 记录。
