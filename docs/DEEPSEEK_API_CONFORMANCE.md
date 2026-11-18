# DeepSeek 官方 API 对齐清单

> 依据：`https://api-docs.deepseek.com/zh-cn/guides/*` 与 `/zh-cn/api/create-chat-completion`（2026-11-18 查阅）。
> 对应实现：`src-tauri/src/api.rs::build_chat_body`（**所有请求体的唯一构造处**）。
>
> 本文的价值在于「每条官方约束都指向一处代码 + 一条测试」，而不是记流水账。

---

## 1. 已经踩到/修掉的问题

### 1.1 关不掉思考模式（真 bug）

官方（`/api/create-chat-completion`）：

> 省略 `thinking` 或传 `null` 时，模式由 `reasoning_effort` 决定；**如果 `reasoning_effort` 也未提供，则默认开启思考模式**。

我们的旧实现：`thinkingEnabled=false` 时**两个字段都不发** —— 于是官方按默认**开启**思考。
表现：用户点了「关闭思考」，模型照样先思考；收尾轮 `noThinking` 想省输出预算的设计**完全没生效**
（8192 token 被思维链吃光、正文空的场景依旧可能发生）。

**修法**：DeepSeek 端点上一律显式发 `thinking: {type: "enabled" | "disabled"}`。
`reasoning_effort` 只在开启时发（关闭时发它反而可能把模式拉回开启）。

**证据**：真机测试 `api::tests::live_thinking_toggle_respects_disabled`
（`cargo test --lib api::tests::live_thinking_toggle -- --ignored --nocapture`）：

```
[live] thinking=off content="9.11" reasoning_len=0 cache_hit=0 cache_miss=27
[live] thinking=on  content_len=3   reasoning_len=114
```

关掉之后 `reasoning_len=0`，打开之后 `reasoning_len=114` —— 开关是真的在起作用了。

### 1.2 思考模式仍发 `temperature`（假生效）

官方：思考模式**不支持** `temperature` / `presence_penalty` / `frequency_penalty`，
「设置不会报错，但也不会生效」。

旧实现无条件发 `temperature` —— 用户以为自己调过温度，其实是噪音参数。
**修法**：思考模式下不发 `temperature`；非思考模式照发。

### 1.3 思考模式 `max_tokens` 太小会把正文挤掉

官方：`max_tokens` 未设置时，非思考模式默认 8K、**思考模式默认 64K**（`effort=max` 时 128K）。
我们按用户设置发（常见 8192）→ 思考模式下思维链先吃掉 8K，正文只剩半句，
表现为 `finish_reason=length` 反复续写。

**修法**：思考模式给 `max_tokens` 一个下限 `THINKING_MIN_OUTPUT_TOKENS = 16384`（低于它按它发）。

### 1.4 本地兜底被塞了 DeepSeek 专有字段

`thinking` / `reasoning_effort` 是 **DeepSeek 扩展**。本地（llama.cpp / LM Studio / vLLM）
与多数第三方网关不认识这些字段，轻则忽略、重则 `400 unknown field`。

**修法**：`is_deepseek_endpoint(base_url)` 判定（`deepseek.com`）。
非官方端点只发标准 OpenAI 字段（`model/messages/stream/max_tokens/temperature/tools/tool_choice`），
并且**不把 `thinkingEnabled` 当思考模式处理**（否则会去掉温度、抬高 max_tokens，
把本地模型的行为变得不可解释）。

### 1.5 `reasoning_effort` 值域与映射

官方值域：`none | low | high | max`；兼容映射：`minimal → low`、`medium/xhigh → high`；
`none` 关闭思考。默认 `high`。

**修法**：`normalize_reasoning_effort()` 把 UI 里可能存在的旧值全部归一到官方值域，
未知值降级到 `high` —— **绝不把未知字符串原样发出去当实验**。

### 1.6 带 `tools` 时必须回传 `reasoning_content`（质量 + 成本）

官方：

> 若请求携带 `tools` 参数：历史轮次的 `reasoning_content` 均应回传给 API，并会被拼接进上下文。
> 若请求未携带 `tools` 参数：`reasoning_content` 无需回传；即使传入也会被忽略。

旧实现：`ChatMessage` 结构里**没有这个字段**，多轮工具循环里模型「忘了自己刚才怎么想的」
（典型表现：同一份文件反复读、同一个错法反复试）。

**修法**：`ChatMessage` 增加 `reasoning_content`（`None` 时序列化省略），
`streamRound` 返回本轮思维链，`handleNativeRound` 把它放进带 `tool_calls` 的 assistant 消息。
回传的这段还是**前缀的一部分**，能命中 KV 缓存。

---

## 2. 已确认「不需要改」的项

| 官方约束 | 我们的做法 | 结论 |
|---|---|---|
| `stream_options.include_usage` | 官方说明：**无论是否设置**，`data: [DONE]` 前的最后一块总会带 usage | 不需要设置 |
| KV 缓存（`prompt_cache_hit/miss_tokens`） | `assembleRequest` 保证前缀稳定（易变内容只追加到最后一条 user） | 已对齐；命中率在「用量统计」里可见 |
| `tool_choice: required` / 指定具体 tool | 思考模式下会 **400** | 我们只用 `auto` |
| `top_p` 生效范围随模型/模式变化 | 我们从不发 `top_p` | 交给服务端默认 |
| 历史拼接（无状态 API，需自带全部历史） | 前端自带 `messages` 全量 | 已对齐 |
| `frequency_penalty` / `presence_penalty` | 官方标记 deprecated，传了无效果 | 我们不传 |

---

## 3. 观察到但暂不采用

| 项 | 为什么暂不采用 |
|---|---|
| **strict 模式（Beta）** | 需把 `base_url` 换成 `/beta`，且要求所有 function 带 `strict:true` 与 `additionalProperties:false`。我们现有 90+ 内置工具的 schema 不是全部满足，一旦某个不合法整轮 400。**收益（参数更守规矩）不如风险大**，等 schema 全量收敛后再评估。 |
| `response_format: {type:"json_object"}` | 官方警告：输出无法识别为 JSON 时会把非 JSON 内容**替换成空格**（可能得到空正文）。我们的工作流挖掘/自优化已用宽松解析（`parseMinedGraph`）兜住格式抖动，改用 JSON 模式反而可能把"半对"的输出变成空。 |
| `logprobs` | 没有消费场景。 |
| Anthropic 格式 `/messages` 或 Responses API | Chat Completion 已够用；换格式要重做整个请求/解析层，收益是「中间插入工具调用」，而我们的工具循环不需要。 |

---

## 4. 改动清单（本轮）

| 文件 | 改动 |
|---|---|
| `src-tauri/src/api.rs` | 新增 `is_deepseek_endpoint` / `normalize_reasoning_effort` / `THINKING_MIN_OUTPUT_TOKENS` / `build_chat_body`；`stream_chat`、`chat_once`、`probe_native_tools` 三处改用它（此前三份拷贝，probe 还发着无效 `temperature`）；`ChatMessage` 增加 `reasoning_content` |
| `src/stores/chat.ts` | `AgentMsg` 增加 `reasoning_content`；`streamRound` 返回 `reasoning`；`handleNativeRound` 回传思维链 |
| 测试 | `api::tests` 新增 7 条参数语义测试 + 1 条真机 `live_thinking_toggle_respects_disabled`；`test-tools-contract` 钉住「请求体只有一处构造」「必须有 disabled 分支」 |

---

## 5. 顺带修掉的另一件事：主循环步进决策抽成纯函数

同一轮把主循环里**顺序敏感**的五个纠偏分支（计划纠偏 → 格式无效 → 意图未闭合 → 正文空洞 → 假完成）
抽到 `src/utils/loop-steps.ts`（`decideNoToolStep` / `decideNativeStep`），
`isVagueBody` 与 `BIG_WRITE_SPLIT_HINT` 也收敛到那里（此前一个在 `chat.ts` 里、一个在循环体内）。

理由与模型无关，但同样属于"正确性靠约定、没人能验证"：顺序一改就会出真 bug
（例如「意图未闭合」排到「正文空洞」之后，半截 `<tool_call>` 会被当成空洞反复重试，永远补不上）。
现在 18 项单测逐条钉住顺序与次数约束。
