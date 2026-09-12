# 使用中卡住了，从这里找

[返回文档导航](README.md) · [从零开始](getting-started.md)

先判断卡在什么位置：Pi 能否调用模型，扩展命令有没有加载，当前目录是否为 control，选中的 Plan 是否正确。通常不需要删除计划、重建仓库或清空状态。下面按实际遇到的现象给出最短检查路径。

## 输入命令没有出现功能

`pi install` 和 `pi config` 是终端命令；`/control:init`、`/plan:next` 是 Pi 输入框里的命令。确认没有用错位置，再在终端运行 `pi config` 查看三个扩展是否启用。安装或修改来源后重新启动 Pi。如果装的是原上游或较旧 npm 发布，它可能没有本仓库最新功能；使用 [入门教程](getting-started.md) 的 FreeGrid Git 来源或本地检出。

如果同时加载 Pi 示例 `plan-mode` 和这里的 Task Plan，先在配置界面禁用示例项，避免计划行为混杂。不要为了排查一个扩展而清空整个 Pi 配置。

## 初始化成功，目录却没有切换

普通持久会话中的 `/control:init` 和 `/control-init-herdr` 应自动进入 control，包含刚启动 Pi 的首个命令场景。自然语言通过工具初始化后，需要按提示再运行 `/control:enter`。刚初始化的同一会话可省略路径；重启以后使用：

```text
/control:enter /完整路径/xxx_control
```

替换成真正的 control 路径，不用重新初始化。也可以退出 Pi，在终端先 `cd` 到 control 再启动。`--no-session` 明确关闭了会话保存，无法使用续接切目录，应采用提示的 `cd ... && pi`。核对绑定用 `/control:status`，结构检查用 `/control:doctor`。完整说明见 [Control Init](../extensions/control-init/README.md)。

## “继续”只是得到一段说明

自然语言不是硬编码命令。先确认你已明确请求实施，而不仅仅是批准计划文字；然后使用 `/plan:next` 给出直接的执行交接。如果当前文件的所有任务都已经勾选，先添加实际新需求或重开相应任务，不要期待它自动制造下一阶段。

出现多份 Plan 时使用 `/plan:open plans/001-km.md` 指定文件。已选文件打不开，应恢复或改选；读取失败不该导致另建一份计划。在已请求的 Plan 流程内，新增需求默认仍修改同一份，明确 `/plan:new` 才另建。见 [Plan 工作流](../extensions/task-plan/v3-workflow.md)。

## 只让它运行命令，却先建 Plan 或切模型

独立问答、文件查看、运行命令、启动子 Agent 或等待，应直接使用普通工具，不因已有 Plan 而读取、创建、修改或继续它，也不先调用 `plan_set_mode`。只有要求规划或上下文明确定义为当前 Plan 的工作才进入 Plan 流程。

明确编写或修改 Plan、请求代码审阅，或从规划/审阅恢复实施时，才选择对应阶段；继续 Plan 实施用 `plan_continue`，已包含 normal 切换。阶段切换后还应在同一轮继续完成请求。自然语言路由依赖模型遵循说明；若仍走错，先核对已加载版本和工作指令，不必为临时请求另建 Plan。

## 子任务做完了，为什么父任务没有更新

先检查模型是否真的调用了状态工具。普通执行的提示要求 Agent 及时记进度，但程序不能凭聊天里一句“做完了”自动知道事实。调用子任务状态工具后，全部孩子完成才会汇总父任务；打开一个孩子也会重新打开父任务。

外部编辑器直接改 Markdown 没有调用这条工具规则。手工改父任务也不会把孩子一起勾选。对这种普通完成，按真实进度自行调整即可，不需要认证；不要把手动勾选当作测试证据。定义修改后重开的细节见 [格式与状态](../extensions/task-plan/v3-format.md)。

## 提示找不到 Qwen，或切换后模型没变

扩展内置了默认 provider/ID，但没有下载模型或启动 vLLM。先用 `/model` 看实际可用项，再检查三个阶段的 provider/ID 是否与登记一致。缺模型或认证时会保留当前模型，所以普通工作仍能进行。先想沿用手动选择的模型，可在终端运行：

```bash
PI_TASK_PLAN_MODEL_SWITCH=0 pi
```

长期配置要在启动 Pi 前设置环境；改 `~/.zshrc` 后旧进程不会自动继承。Pi 0.84.4 的 `models.json` 用 `"$VLLM_API_KEY"` 读取密钥环境变量，不是裸变量名。Qwen 的 `qwen-chat-template` 映射里 high/medium 都打开 thinking，没有从这个等级表自动分配不同预算。按 [模型指南](models.md) 逐层排查。

Pi native 后端的子 Agent 仍使用另一个模型时，再检查其 `.pi/agents/*.toml`：角色可覆盖父模型，不由 Plan 阶段配置统一接管。见 [协作配置](../extensions/collaborating-agents/README.md)。

## DocSync 没找到文档，或者范围太大

先看报告的未解决问题。默认文档搜索只覆盖 `README.md` 和 `docs/**`，文档放在别的位置，需要扩展 `docPaths`。检查 `root` 是否为 code，提交是否在本地，PR 范围是否取了正确基点，工作区是不是预期版本。纯本地检查可以用 `ranges: []` 并明确相关 `localPaths`，不必伪造提交范围。

没有文档就从本次用户可见行为的最小说明开始；没有标记可以用整文件目标，不用先给所有文件加标记。达到读取上限应缩小范围或分次核对，空候选与已触及文档都不能当作语义正确的证明。CLI 报不支持 `.ts` 时确认 Node 支持 TypeScript 加载，本文 CLI 路径在 Node 25.9.0 验证。具体输入与限额见 [交付检查](../extensions/task-plan/docsync/delivery.md)。

## 为什么交付前没有自动文档提醒

普通模式首先依靠工作指令。可选提醒只有在本会话明确设置 `watch`，并且对应已有大任务通过 Plan 工具变为完成时触发。换会话、手写 checkbox、任意 shell 提交和独立 governed finalize 不在这个入口里。准备 PR 时没有被监听的转换，就显式检查一次当前相关范围。

这个助手不是强制发布门禁。要判断是不是需要更强机制，读 [Harness 的保证范围](harness.md)，不要把没有提醒当作“所有文档都已检查”。

## `/plan:governed` 提示没有配置

这是正常的能力提示。默认安装提供普通 Plan，受治理执行还需要可信宿主配置真实沙箱、验证和独立 reviewer。没有这些服务时继续使用普通命令；不要填一个自动通过的假验证器来消除提示。旧 DocSync 的 on 也不等于完整的新强制模式已经可用。见 [受治理接入](../extensions/task-plan/v3-governed.md)。

## 更新了工具，旧 AGENTS 还是原样

包更新不自动改写工作空间规则。进入 control，运行 `/control:update`，通过高级结构化更新保留原名称并审阅重新生成的规则。标记外的人工内容会保留；标记内有手工修改时需要明确解决差异。出现 `preview-stale` 就重新读取预览，不要覆盖并发变化。步骤见 [规则更新](../extensions/control-init/README.md#更新现有工作空间的规则)。

## 选了 Herdr，助手却仍使用原生协作工具

先看 control 的 `CONTROL_INDEX.json`：`agents.delegation_backend` 应为 `herdr`，缺少字段按 `native` 解释。默认 `/control:init` 不启用 Herdr；已有工作空间应通过 `control_workspace_update` 明确设置 `delegationBackend: "herdr"`，不要重新初始化。普通规则更新保留现有后端。

确认当前宿主加载了 control 的工作指令，并检查托管块外是否还有冲突的旧规则。Herdr 子 Agent 的任务包也要携带后端选择和相关 control 规则；在 code 启动并不保证自动加载它们。Herdr 模式统一通过 Herdr 创建、通信、等待和收集结果，不使用 `/subagent`、`/agents` 或 cmux 流程。

初始化只生成规则，不安装 Herdr 程序或 skill。实际委派前检查 skill 可读、控制者身处 Herdr 且 `HERDR_ENV=1`；缺少前提时按 [Herdr 初始化说明](../extensions/control-init/README.md#用-herdr-管理子-agent) 补齐，不猜命令或自动切回 native。

## 子 Agent 启动了，却找不到输出文件（Pi native）

新子会话可能还没落盘。先用 `/agents` 查看状态，或让父 Agent 按 Run ID 查询 `sessions`、`session`、`tail`；不要遍历所有用户聊天记录寻找“看起来像”的文件。并行 batch id 可能对应多个孩子，应选择明确的 child Run ID。

cmux 模式要求父 Pi 本就在 cmux 中；没有这个终端时用默认 process。预留文件导致写入被拦住，应联系占用者或等其释放，而不是用 shell 绕过协调。见 [协作指南](../extensions/collaborating-agents/README.md)。
