# 中文文档导航

[返回项目首页](../README.md)

如果你还不知道这个工具为什么值得使用，先读首页的研究项目故事。如果已经准备试一试，从首次使用教程开始。功能指南再解释各自的选择与例子，进阶资料留给确实要接入内部机制的人；不需要从底层接口开始学习。

## 按一个项目的顺序读

| 阶段 | 读完后应能做到 | 指南 |
| --- | --- | --- |
| 认识工具 | 分清 Pi、模型、Agent 和 Harness | [首页](../README.md) |
| 第一次启动 | 安装、连接模型、区分终端与 Pi 命令 | [入门](getting-started.md) |
| 安排材料 | 创建 control/code、绑定已有代码、为每篇论文建独立仓库 | [Control Init](../extensions/control-init/README.md) |
| 对齐需求 | 完整阅读短 Plan，逐步细化、修改、继续与记录进度 | [Task Plan](../extensions/task-plan/README.md) |
| 分配模型 | 设置规划、执行、审阅预设，理解 Qwen/vLLM 配置 | [模型指南](models.md) |
| 交付说明 | 通过相关 PR、映射和引用找到要更新的文档 | [文档同步](../extensions/task-plan/docsync/delivery.md) |
| 选择约束 | 分清普通完成、可选提醒和受治理接受 | [Harness](harness.md) |
| 扩大分工 | 区分 native 与 Herdr，再按所选后端派发和跟进子任务 | [协作指南](../extensions/collaborating-agents/README.md) |
| 遇到卡点 | 找到常见症状对应的最短检查路径 | [排障](troubleshooting.md) |

这条路径中的 matching 是示例项目，不是安装工具包的目录。你可以把名称换成自己的课题。原则保持一致：过程留在 control，交付给程序使用者的内容留在 code，每篇文章有独立的论文仓库；目录和模型名称都使用你的真实配置。

独立小请求可直接完成，无需 Plan 或 `plan_set_mode`；已有 Plan 也不会自动收纳它们。需要规划或明确继续当前 Plan 时，再读 Plan 工作流。

默认 `/control:init` 保留宿主原生（native）协作；可选的 [`/control-init-herdr`](../extensions/control-init/README.md#用-herdr-管理子-agent) 生成统一使用 Herdr 的规则。Herdr 用户从该初始化说明准备程序与 skill；协作指南中的 `/subagent`、`/agents`、角色配置和 cmux 用法仅适用于 Pi native 后端。

## 经常查的参考

[Plan 命令与更新规则](../extensions/task-plan/v3-workflow.md) 集中解释当前任务选择、状态和自然语言路由；[V3 文件格式](../extensions/task-plan/v3-format.md) 用于手动写或检查 Plan。模型变量与默认值统一放在 [模型指南](models.md)，协作角色配置放在 [协作指南](../extensions/collaborating-agents/README.md)，避免把同一份大配置复制到每一页。

当前用户指南以中文撰写，命令、配置键和界面中的英文按钮保留原名，方便对照真实操作。文档中的示例配置不携带账号密钥，也不代表工具替你注册了模型、部署了服务器或开通了远端仓库。

## 集成者与旧版本维护者

可选受治理执行先读 [命令与前提](../extensions/task-plan/v3-governed.md)，再看 [内核接口](../extensions/task-plan/v3-kernel.md)。它需要真实的执行能力和可信策略，不是普通使用的前置条件。

以下是保留的旧版或底层英文技术资料。它们用于理解已有机制，不应被当作新手必须经历的 What/Why、Strategy 或认证流程：

| 技术问题 | 参考 |
| --- | --- |
| 继续原来的 V1/V2 生命周期 | [Legacy workflow](../extensions/task-plan/legacy-workflow.md) |
| 旧 DocSync baseline、候选与区域身份 | [旧 DocSync 参考](../extensions/task-plan/docsync/README.md) |
| 执行范围及旧生命周期约束 | [Execution boundaries](../extensions/task-plan/execution-boundaries.md) |
| 稳定节点与身份 | [Domain identity](../extensions/task-plan/domain-identity.md) |
| 中断恢复与操作日志 | [Operation journal](../extensions/task-plan/operation-journal.md) |

更新记录见 [CHANGELOG](../CHANGELOG)。指南描述已实现能力；不存在的强制开关、通用模型保证或未来流程，不作为当前可用特性承诺。
