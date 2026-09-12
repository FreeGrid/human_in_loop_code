# Control Init：先让每份材料有自己的归属

[返回首页](../../README.md) · [第一次使用](../../docs/getting-started.md)

研究项目常常从一个代码目录开始。几次讨论之后，计划、验证脚本、参考资料和临时实验都放了进去；开始写论文时，又多出正文和投稿材料。整理起来并不只是“删掉几个文件”：你仍然需要保留这些过程，只是不希望它们跟着代码一起开源，也不希望两篇论文的修改缠在一份代码历史里。

Control Init 用独立的 Git 仓库表达这些归属。Git 仓库可以理解为“一个目录及其自己的版本历史”。分开以后，提交程序修改不会顺便带上论文草稿；control 中的验证记录也有自己的历史。它的工作是建立绑定和规则，已有的混杂文件仍需要你明确安排迁移，不能认为运行一次初始化就清理了目录或 Git 历史。

## 选择适合项目的结构

默认的 `control-code` 适合先做程序的项目。control 通常保持私有，保存需求计划、测试、测试数据、验证工具、证据和交付管理记录。code 保存生产代码、运行所需资源、包信息和给使用者看的说明。control 可以测试 code，code 必须能够脱离 control 独立运行。

需要论文时选择 `control-code-latex`。它在同一份代码旁增加论文仓库，每篇文章独立保存正文、参考文献表、图件、投稿材料和直接相关的写作记录。两篇文章可以使用同一份代码，论文之间不建立运行依赖。LaTeX 是常用的论文排版方式；即使你还不会写 LaTeX，也可以先理解为“这篇文章专用的文件目录和版本历史”。

```text
research/
├── matching_control/      # 计划、实验检查、测试、研究资料整理
├── matching_code/         # 程序、运行资源、用户说明
├── matching_paper_a/      # 论文 A：正文、引用、图、投稿材料
└── matching_paper_b/      # 论文 B：独立修改，引用同一份代码
```

例如比较算法正确性的测试放在 control，代码用户如何输入数据的说明放在 code，论文最终使用的参考文献表和图放进对应 paper。大体积临时数据是否纳入版本管理仍由项目决定；仓库分离不要求把每一个临时文件都提交。`private` 等可见性字段记录的是工作约定，初始化不会替你在 GitHub 创建仓库或调整远端权限。

只有上述结构表达不了需求时，才使用 `custom`。自定义结构要明确每个仓库的路径、角色、可见性、材料归属和关系；循环关系、受保护的反向运行依赖、重复归属等会被拒绝。第一次使用通常不需要进入这个选项。

## 新建一个项目

在终端进入用来容纳项目的父目录，再启动 Pi。在 Pi 的输入框中运行：

```text
/control:init
```

普通项目选择 `Recommended — control + code`，接着选择从名称创建的选项，输入 `matching`。程序只在 Pi 当前目录下准备 `matching_control` 和 `matching_code` 两个不存在的目录。不要给名称再加角色后缀；如果名称已被占用，换一个名称，或者使用已有目录入口。

最后的预览会列出实际路径、归属规则，以及准备写入的 `CONTROL_INDEX.json` 和 `AGENTS.md`。前者是仓库关系表，后者是给后续 Agent 阅读的持久工作说明。看清预览后选择 `Apply the shown initialization`；也可以返回修改或取消。确认预览只批准这次初始化，不会开始写产品代码。

初始化可以创建本地 Git 元数据，但不会创建远端、commit、push、PR、合并或发布。正常成功后，Pi 会续接当前对话并进入 control，连读文件、shell 工作目录、项目指令和底栏也一起切换。即使 `/control:init` 是新 Pi 会话的第一个命令，内存里还没写盘的对话也会保留，原会话不被改写。

也可以用自然语言说：

```text
创建名为 matching 的本地工作空间，使用独立的 control 和 code 仓库。
```

模型调用的初始化工具不弹交互框，会返回已应用、还需输入或存在冲突等状态。缺少信息时，模型应只询问返回的问题。工具不能在一次模型执行中直接替换会话，初始化完成后需要按提示运行 `/control:enter`。

## 用 Herdr 管理子 Agent

希望把子 Agent 放进 Herdr pane，并通过 Herdr 创建、通信和等待时，在 Pi 输入框使用新增入口：

```text
/control-init-herdr
```

它使用同一套仓库选择、预览、取消和进入 control 的流程，但生成 Herdr 专用的协作指令。原 `/control:init` 保留：生成的默认规则按当前宿主使用原生机制，Pi 用 Pi 的协作工具，Codex 和 Claude 保留各自的 spawn subagent 机制。选择 Herdr 后，无论控制者或子 Agent 是 Pi、Codex 还是 Claude，都统一走 Herdr，不再混用这些宿主的原生多 Agent 工具。何时委派、何时复用、独立审查必须使用新会话等规则，两种模式共用。

先安装 Herdr，并让实际执行委派的控制者运行在 Herdr 内。Herdr skill 可按上游提供的方式安装：

```bash
npx skills add herdrdev/herdr --skill herdr -g
```

安装时选择需要使用的宿主，并确认它能够读取该 skill。上游的 [v0.9.0 skill](https://github.com/herdrdev/herdr/blob/v0.9.0/skills/herdr/SKILL.md) 是本功能的参考；上面的安装命令未固定版本，实际命令语法应读取安装后的 skill 和 `herdr --help`。skill 安装不等于安装 Herdr 程序。初始化不会执行这条全局安装命令，也不会启动、拆分或控制终端；仅生成规则时不要求身处 Herdr，真正操作前则必须检查 `HERDR_ENV=1`。

选择记录在 `CONTROL_INDEX.json` 的 `agents.delegation_backend`，值为 `herdr` 或 `native`；旧索引没有此字段时按 `native` 解释。`/control:update` 更新名称、论文绑定或要求时会保留该选择。已初始化的工作空间不要重跑初始化来切换：可以明确要求助手使用 `control_workspace_update`，传入 `delegationBackend: "herdr"` 或 `"native"`。生成的托管块会替换为对应模式；若自己写在托管块之外的旧指令指定了另一套工具，需要一并检查并解决冲突。

自然语言初始化也可以明确要求 Herdr，模型应向 `control_workspace_init` 传入 `delegationBackend: "herdr"`。上述 slash 入口属于 Pi 扩展；它们不会自动成为 Codex 或 Claude 的命令。换宿主后，确保当前会话实际加载 control 中的工作指令；Herdr 子 Agent 的任务包也必须携带后端选择和相关 control 规则，不能假设 code 目录会自动读取 control 的 AGENTS.md。

## 绑定已有代码，稍后再增加论文

已有工程不需要搬空重来。运行 `/control:init`，选择使用已有目录，再提供 control 和 code 的具体路径。相对路径从 Pi 当前工作目录解析，第一次操作更建议使用完整路径。已有非 Git 目录可以在确认后原地 `git init`，已有文件保持不变；这仍不会产生远端或第一次提交。

例如，代码在 `/data/research/matching_code`，准备把管理过程放在 `/data/research/matching_control`，可以明确这样请求：

```text
把 /data/research/matching_control 作为 control，
把 /data/research/matching_code 作为 code，初始化工作空间。
先展示两个实际路径及要写入的规则。
```

不要期待这个步骤自动识别所有旧测试、证据和草稿并移动它们。绑定完成后，可以单独规划一项整理任务，在保留历史与可运行性的前提下逐步迁移。code 中本来就属于使用者的说明应继续留在 code。

若一开始就要写论文，在初始化向导选择 `Optional — control + code + one LaTeX repository per paper`。填写论文数量，再为每篇论文输入短 ID 和实际目录；论文路径不会只凭名称自动猜出来。缺失目录需要确认确切创建位置。

已有工作空间后来新增第二篇论文时，在 control 中运行：

```text
/control:update
```

选择 `Add one paper repository`，输入短 ID（如 `paper-b`）和具体目录。检查预览后应用。也可以直接提出“给当前工作空间增加一个独立论文仓库，路径为……”。移除论文绑定使用对应的 remove 选项，它只解除关系，不删除论文目录或 Git 数据。

## 重启后，进入同一个工作空间

刚初始化的同一个 Pi 会话记得目标位置，可以直接运行：

```text
/control:enter
```

重启 Pi，或初始化成功后仍停在旧目录时，提供完整路径：

```text
/control:enter /完整路径/xxx_control
```

例如：

```text
/control:enter /data/research/matching_control
```

**已经初始化的仓库不用再次 `/control:init`。** 明确提供的路径优先于会话记忆；在新会话里没有目标记忆时，程序会要求你给出路径，不会擅自另建仓库。使用 `--no-session` 的 Pi 关闭了会话保存，无法采用这种续接方式，需要回到终端按提示执行 `cd ... && pi`。

最简单的日常习惯是在终端先进入 control，再启动 Pi。后续 `/control:status`、`/control:doctor` 和 `/control:update` 就可以直接找到工作空间。

## 哪个命令解决哪个问题

| 你要做的事 | Pi 命令 | 模型使用的工具 |
| --- | --- | --- |
| 建立或绑定工作空间 | `/control:init` | `control_workspace_init` |
| 初始化 Herdr 协作规则 | `/control-init-herdr` | `control_workspace_init`，指定 `delegationBackend: "herdr"` |
| 进入已经初始化的 control | `/control:enter [control路径]` | 需要命令上下文，模型工具不直接切会话 |
| 查看路径、Git 状态和待处理项 | `/control:status [control路径]` | `control_workspace_status` |
| 检查目录、身份和规则是否一致 | `/control:doctor [control路径]` | `control_workspace_doctor` |
| 改路径、加论文、更新规则 | `/control:update [control路径]` | `control_workspace_update` |

方括号表示可省略参数，不要把方括号本身输入命令。自然语言更方便描述需求，命令则提供直接入口。`init` 和 `update` 工具在同一 Pi 进程内串行执行；另外也会检查落盘前的文件是否仍然等于读到的版本，避免两个进程相互覆盖。

## 更新现有工作空间的规则

安装新版本工具包不会自动改写已有 `AGENTS.md`。如果你希望旧项目获得新的 readable Plan 或文档同步规则，在 Pi 中运行 `/control:update`，选择 `Advanced or combined structured update`，保持预填的 `name` 不变，再审阅重新生成的预览并应用。这会刷新规则模板，而不要求换名字或重绑仓库。

扩展只拥有 `AGENTS.md` 中这对标记之间的内容：

```text
<!-- control-init:managed:start version=1 -->
此处由 Control Init 管理
<!-- control-init:managed:end -->
```

标记外的人工内容会保留。已有 AGENTS 没有标记时，要明确选择追加；人工修改过标记内内容时，更新会要求决定保留、重新生成或手工合并，不会静默覆盖。doctor 发现旧模板与新模板不同，也不意味着普通文件工作必须停下来。

移动仓库或修改 Git 远端，应通过 update 确认新路径或接受的新身份。新增远端也会被当作需要确认的变化；仅把目录名字改得相似不能让它自动成为原仓库。关系表使用 `human-in-loop/control-index/v1` 格式，未知版本和未知字段不会被擅自重写。

## 预览之后发生了变化怎么办

初始化的预览绑定了当时的路径、Git 身份和文件内容。如果你在确认前又改了文件或远端，程序可能返回 `preview-stale`。重新运行命令，阅读更新后的预览再决定即可。取消会保留原状；输入不合法的自定义 JSON 时会保留草稿，让你继续改。

程序不会扫描整个用户目录猜工作空间。路径不存在时，最多给出指定父目录下的少量相近候选，候选不会被自动采用。嵌套仓库绑定、符号链接别名、越出工作空间的相对路径等可能被拒绝，以免把检查或写入导向另一份数据。

写入关系表和规则时使用锁与前后检查，失败时只回滚本次仍未被外部修改的内容。异常退出后可能留下 `.control-init.transaction.lock`：先确认没有初始化或更新进程仍在运行，再处理残留锁并运行 doctor。若文件已经应用而只是锁清理失败，工具会明确报告恢复提示；不要把它当作必须重复创建仓库的信号。

## 计划批准、实施与交付，是不同决定

生成的规则建议先读懂计划，再明确委派实施。批准计划只接受文字；明确要求执行后，Agent 才应在范围内完成实现和验证，分成可审阅的提交与 PR。大项目可以分成多个交付片，避免一个 PR 包含所有工作。验证记录在 control，产品改动在 code，两边用具体提交对应起来。

这些是持久工作说明，并不意味着 Control Init 拦截了任意 shell 命令。扩展自身也不是 Git 执行器。更大范围、破坏性操作、合并和发布仍需单独的人类决定；需要程序约束执行过程时，再看 [受治理执行](../task-plan/v3-governed.md)。

## 在其他编辑器中继续同一份 Plan

<a id="use-the-same-plan-in-codex"></a>
生成的 `AGENTS.md` 也说明了如何通过普通 Markdown 编辑继续 readable Plan。你可以在 **control 目录**打开 Codex 等能读取这些指令的工具，明确说“阅读 AGENTS.md 和 plans/001-km.md，继续当前任务”。新的工具不必原生认识 `pi-plan/v3`，也能从当前需求与 checkbox 了解进展。

`/control:init` 和 `/plan:next` 是 Pi 命令，不会因为换了编辑器而在那里出现。其他宿主依靠模型遵循文件说明，也不会自动继承 Pi 的模型配置或程序状态汇总。初始化只在 control 安装这份 AGENTS，不在 code 写第二份。规则、普通编辑与 Pi 的执行约束应分清，不能把文件可读性当作跨宿主的全部保证。

## 兼容与卸载

核心操作曾以 Pi 开发依赖 0.73.1 验证；新会话目录切换另在实际 Pi 0.84.4 上验证了初始化、会话续接、相对读取和 shell 工作目录。不同版本的安装要求以 [入门教程](../../docs/getting-started.md) 和宿主说明为准，不再将旧版 Node 最低要求当作当前 Pi 的安装条件。

扩展没有要求用户运行的常驻服务或数据库。使用 `pi config` 可以停用，使用与安装相同来源的 `pi remove` 可以卸载。移除扩展不会删除 `CONTROL_INDEX.json`、AGENTS、论文、代码或任何 Git 历史；要清理这些持久材料，应单独审阅其用途。
