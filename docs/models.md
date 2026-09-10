# 为规划、执行和审阅分别选择模型

[返回首页](../README.md) · [Plan 工作流](../extensions/task-plan/v3-workflow.md) · [首次使用](getting-started.md)

规划需要把含糊的要求说清，执行需要持续完成具体修改，审阅需要停下来找遗漏。它们对模型的要求不完全一样。Pi 可以连接不同提供方，Task Plan 在此基础上提供三个阶段的全局预设。你可以给每个阶段选不同模型，也可以先都使用一台自部署服务，再按体验调整。换模型不会在 Plan 中增加配置或执行记录。

这里有两层设置。**Pi 的模型登记**回答“这个模型在哪里，怎么连接”；**Task Plan 的阶段预设**回答“现在做计划或执行时，应该选已登记的哪一个”。只改第二层不会下载模型、启动服务器或创建账号。第一次用已有的 Pi 模型，先运行 `PI_TASK_PLAN_MODEL_SWITCH=0 pi` 就能关闭自动切换，等普通功能跑通后再配置。

## 先分清三个名字

以自部署 Qwen 为例，`Qwen/Qwen3.8-27B-FP8` 是模型权重仓库名，`qwen38-27b-fp8` 可以是你给服务设置的模型 ID，`custom-qwen` 则是你在 Pi 中定义的提供方名称。后两者必须与你的真实配置一致；它们不是安装本工具后自动出现的服务。

当前内置预设如下。这是在源码中提供的默认组合，不意味着你的电脑已经有这些模型：

| 阶段 | Pi provider / model ID | thinking |
| --- | --- | --- |
| 规划 `planning` | `custom-qwen` / `qwen38-27b-fp8` | `high` |
| 普通执行 `normal` | `custom-qwen` / `qwen38-27b-fp8` | `medium` |
| 审阅 `review` | `custom-qwen` / `qwen38-27b-fp8` | `high` |

模型不存在或没有可用认证时，扩展会通知并继续保留当前模型，不会因为一个预设无效就禁止普通工作。观察 `/model` 的实际选择和通知，可以判断切换是否成功。

## 设置三个阶段

环境变量是启动程序时传给它的设置。macOS 默认 zsh 可以把下面的内容放进自己的 `~/.zshrc`；其他 shell 使用对应的启动文件。也可以先在当前终端粘贴，再从这个终端运行 `pi`。这个例子重现当前默认组合，替换 provider 和 ID 即可选择你已经登记的其他模型。

```bash
export PI_TASK_PLAN_MODEL_SWITCH=1
export PI_TASK_PLAN_PLANNING_MODEL_PROVIDER=custom-qwen
export PI_TASK_PLAN_PLANNING_MODEL_ID=qwen38-27b-fp8
export PI_TASK_PLAN_PLANNING_THINKING=high
export PI_TASK_PLAN_NORMAL_MODEL_PROVIDER=custom-qwen
export PI_TASK_PLAN_NORMAL_MODEL_ID=qwen38-27b-fp8
export PI_TASK_PLAN_NORMAL_THINKING=medium
export PI_TASK_PLAN_REVIEW_MODEL_PROVIDER=custom-qwen
export PI_TASK_PLAN_REVIEW_MODEL_ID=qwen38-27b-fp8
export PI_TASK_PLAN_REVIEW_THINKING=high
export PI_TASK_PLAN_RESTORE_MODE=configured
pi
```

例如你后来给 Pi 登记了一个执行专用模型，只需改 `NORMAL` 对应的 provider、ID 和 thinking；规划与审阅保持原值。不要把页面上的示意名字当作公开服务必然接受的名字，先在 Pi `/model` 中确认它确实可选。

改完 shell 文件，要退出旧 Pi，在加载了新环境的终端里重新启动。旧进程不会继承后来编辑的环境；单独在旧会话 `/reload`，不能让它读到新终端的变量。`models.json` 的重新加载是另一回事：Pi 0.84.4 中再次打开 `/model` 会重新读取该文件。

## 完整配置对照

| 设置 | 含义与优先级 |
| --- | --- |
| `PI_TASK_PLAN_MODEL_SWITCH` | 默认启用；精确写 `0` 或 `false` 关闭切换 |
| `PI_TASK_PLAN_PLANNING_MODEL_PROVIDER` / `PI_TASK_PLAN_PLANNING_MODEL_ID` | 规划阶段提供方与模型 |
| `PI_TASK_PLAN_NORMAL_MODEL_PROVIDER` / `PI_TASK_PLAN_NORMAL_MODEL_ID` | 普通执行阶段提供方与模型 |
| `PI_TASK_PLAN_REVIEW_MODEL_PROVIDER` / `PI_TASK_PLAN_REVIEW_MODEL_ID` | 审阅阶段提供方与模型 |
| `PI_TASK_PLAN_PLANNING_THINKING` / `PI_TASK_PLAN_NORMAL_THINKING` / `PI_TASK_PLAN_REVIEW_THINKING` | 分别配置三个阶段的思考设置 |
| `PI_TASK_PLAN_MODEL_PROVIDER` / `PI_TASK_PLAN_MODEL_ID` | 三个阶段的共用后备值；阶段专用变量优先 |
| `PI_TASK_PLAN_THINKING` | 旧别名，只给规划阶段兜底，不覆盖执行与审阅 |
| `PI_TASK_PLAN_RESTORE_MODE` | 默认 `configured`，进入执行时选执行预设；`previous` 恢复进入规划或审阅前保存的模型和思考值 |

本扩展接受 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`。大小写与常见分隔符会归一化，旧别名 `media` 和 `extrahigh` 仍被接受；无效值回退到相应后备或默认值。不要因为 Pi 本身某版本还接受其他等级，就推断本扩展也接受，例如这里没有 `max`。

如果有团队用代码嵌入扩展，宿主可传 `enabled`、`planning`、`normal`、`review`、`restoreMode`，其中各阶段包含 `provider`、`model` 和可选 `thinkingLevel`。显式宿主字段逐项覆盖环境变量；因此受管理环境里先检查宿主配置，不要反复改环境却忽略了更高优先级。这是集成者入口，普通用户无需写 TypeScript。

## 自部署 vLLM：先有服务，再登记给 Pi

vLLM 是运行模型并提供请求接口的服务程序。下面是已经具备适合 GPU、依赖和模型访问条件的部署示例，不是要求每个新手在自己的笔记本上运行 27B 模型。硬件与 vLLM 版本先按 [Qwen3.8 专用部署说明](https://recipes.vllm.ai/Qwen/Qwen3.8-27B) 准备；模型信息见 [Qwen 官方模型卡](https://huggingface.co/Qwen/Qwen3.8-27B-FP8)。

```bash
vllm serve Qwen/Qwen3.8-27B-FP8 \
  --host 127.0.0.1 \
  --port 8000 \
  --served-model-name qwen38-27b-fp8 \
  --max-model-len 32768 \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder
```

这个例子把服务放在本机端口 8000，给接口设置 `qwen38-27b-fp8` 这个名字，并选择与模型匹配的思考和工具调用解析方式。它没有设置服务认证，只用于本机示例。实际远端部署应使用管理员给你的地址与认证；这里不会替你开放端口或配置服务器。

然后在本地 `~/.pi/agent/models.json` 中登记。若文件已有其他 provider，应把 `custom-qwen` 合并进原来的 `providers`，不要覆盖其他模型：

```json
{
  "providers": {
    "custom-qwen": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "api": "openai-completions",
      "apiKey": "EMPTY",
      "models": [
        {
          "id": "qwen38-27b-fp8",
          "name": "Qwen3.8 27B FP8 (local)",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 32768,
          "maxTokens": 8192,
          "compat": {
            "supportsDeveloperRole": false,
            "supportsReasoningEffort": false,
            "thinkingFormat": "qwen-chat-template"
          }
        }
      ]
    }
  }
}
```

`baseUrl` 是接口地址，`id` 要与服务模型名相同。`contextWindow` 和 `maxTokens` 是客户端预算声明，要与服务器能力协调；示例中的数字不是模型能力评测，也不会替服务扩容。`input: ["text"]` 把这个例子限制为文字输入。`EMPTY` 只对应上面没有认证的本机服务。

如果服务要求密钥，Pi **0.84.4** 可以把 `apiKey` 写成 `"$VLLM_API_KEY"`，并在启动 Pi 前设置这个环境变量。裸字符串 `"VLLM_API_KEY"` 在该版本是字面量，不会读取环境。旧 0.73.1 的说明使用过不同写法，不应混抄。字段解释与版本差异请对照 [Pi 模型配置文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)。

登记后在 Pi 运行 `/model`，选到这个模型，先确认它能正常回答并使用工具，再启用三个阶段切换。这样遇到问题时，能分清是服务连接失败，还是阶段预设选错。

## Thinking 打开了吗

`reasoning: true` 告诉 Pi 这是支持思考的模型；`thinkingFormat: "qwen-chat-template"` 决定客户端如何表达思考请求。在这里核对的 Pi 映射中，`high` 和 `medium` 都会发送 `chat_template_kwargs.enable_thinking=true`，并保留思考历史；`off` 则请求关闭。这个映射没有给 high 和 medium 分配不同 token 预算，所以不能把表里的两个等级理解为服务器必然花了不同的推理成本。

这也不意味着模型本身不支持更细的 effort。服务端能力与当前客户端映射是两件事；要看真实请求、模板和服务器解析是否匹配。示例设置 `supportsReasoningEffort: false` 与当前接入方式一致，不靠一个标签声称模型已经按预期思考。这里核对了配置和客户端实现，没有在你的 GPU 上部署或测量推理效果。

## 切换审阅模型不等于独立审阅

`/plan:review` 改变当前会话的模型并要求它审查真实改动，适合普通代码检查。它仍然看得到当前会话上下文，不能仅因为换了模型，就算作独立接受。

可选 Harness 的 reviewer 回调会收到审阅预设，由受信任宿主真正启动独立的审阅会话。如果宿主无法满足模型要求，应报告无法执行，而不是假装用了指定模型。配置只是请求，独立身份、证据和最终接受规则仍需 [受治理执行集成](../extensions/task-plan/v3-governed.md)。
