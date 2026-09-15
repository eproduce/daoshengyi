# 道生一 · Agent 运行健康诊断（2026-09-15）

> 触发：用户反馈「最近一段 agent 工作记录好像有点问题」。
> 数据源：应用数据库 `~/Library/Application Support/com.daoshengyi.app/daoshengyi.db`（会话/消息/tool_audit/workflow_runs/usage_agg）
> 与运行时日志 `…/com.daoshengyi.app/daoshengyi.log`，以及源码交叉验证。

---

---

## 〇、修复进展（2026-09-15 当天已修）

| # | 问题 | 状态 | 修复内容 |
|---|---|---|---|
| 1 | 消息 token 口径 | ✅ 已修 | `api.rs` 分开解析/上报 `prompt_tokens` / `completion_tokens`；`chat.ts` 新增 `RoundUsage`，**按轮累加**（主循环/续写轮/收尾轮三处），消息 `tokens` = 本轮总消耗、新增 `outputTokens` = 回复产出；费用按输入/输出分别计价；气泡悬停给出「输入/输出」细分；新增 Rust 回归测试 |
| 3 | 日志热路径刷屏 | ✅ 已修 | `[sse]` 只在收到 usage 时打印（去掉 `rl/cl` 条件）；`append_log` 加 **8MB×3 轮转** + 单条超长截断（2000 字）；顺手清掉历史 80MB / 114 万行日志；前端「有闭合标记但解析失败」改为每轮只记一条 |
| 4 | 工具失败 | 🟡 部分修 | ① `resolveToolServer` 增加**内置工具名保护**（内置名永不转发给 MCP，修 `fetch_page` → `Tool not found`）；② `tool-schema.ts` 新增 `describeSchemaParams()`，把 MCP 工具的**参数名（含必填标记）写进描述**，治「猜参数名」（`puppeteer_evaluate` 12/17 失败）+ 4 个单测。`command` 60s 超时与 `write_file` 漏参留待后续 |
| 5 | 工作流假成功 | ✅ 已修 | LLM 节点正文为空时先**退回思考内容**（与 `WorkflowDialog` 一致）；仍为空则置 `emptyLlmOutput` → 运行记录标 `failed`，不再假成功 |
| 2 | 单轮无预算 / 超长产物 | ⬜ 待修 | 建议下一步：正文超长折叠+落盘、单轮软预算、启用历史摘要压缩（`memory_summaries` 为空说明该链路未启用） |
| 6 | 工作流产物落 `~` 根 | ⬜ 待修 | 属用户已建工作流（id=4）的路径配置，需在工作流里改为工作区子目录（如 `reports/`） |
| 7 | 网络层无重试 | ⬜ 待修 | 建议 SSE 建连/中途断流按指数退避重试 1~2 次并保留已生成内容 |

验证：clippy `-D warnings` 干净 · cargo test --lib **104 passed** · vue-tsc 干净 · vitest **9 files / 53 passed**。

## 一、结论速览

| # | 问题 | 严重度 | 证据 | 影响 |
|---|---|---|---|---|
| 1 | **消息 token 数口径错误**（把 `total_tokens` 当「回复 token」） | 🔴 高 | 379 字回复记为 **28240** tokens | 显示不可信、**费用估算虚高**、用量统计失真 |
| 2 | **单轮无预算 + 大产物直接进对话** | 🔴 高 | 单轮 **1435 秒**、正文 **55866 字**、思考 **175704 字** | 上下文雪球、成本与延迟失控、体感「卡住」 |
| 3 | **日志热路径刷屏，97% 是诊断日志** | 🔴 高 | 日志 **1,149,331 行 / 80MB**，其中 `[sse] reasoning_len=…` **1,115,187 行（97%）** | 磁盘污染 + 每 chunk 一次文件 open/close 的 I/O 开销 |
| 4 | **工具失败率 10.9%**（54/494） | 🟠 中 | `puppeteer_evaluate` 12/17 失败、`fetch_page` 3/3 失败、`command` 超时 16 次 | agent 绕路、token 与时间浪费 |
| 5 | **工作流「假成功」** | 🟠 中 | `宏观局势分析报告生成器` 多次 `status=success`，节点输出却是「（模型未返回内容）」 | 用户以为成功，实际无产出 |
| 6 | **工作流重复执行 + 产物散落家目录** | 🟠 中 | `全球经济日报` 在 **3 分钟内成功跑了 5 次**；产物写 `/Users/wanghuan/全球经济日报-*.html` | 重复消耗、`~` 根目录被污染 |
| 7 | **网络/上游错误无自动重试** | 🟡 低 | `error sending request` 18 次、`网络错误` 15 次、`error decoding response body` 2 次、`模型回复超时` 2 次 | 偶发失败需用户手动重发 |
| 8 | 工具数接近注册上限 | 🟡 低 | 内置 **43** 个 + 已出现 **22** 种 MCP 工具；`MAX_NATIVE_TOOLS = 80` 且**静默截尾（MCP 在后）** | 超限时 MCP 工具会「凭空消失」，模型只能猜 |

**先说好的**：Phase 3 的工作流沉淀确实在跑 —— 19 次 workflow 运行、`全球经济日报` 连续 5 次**成功**生成 HTML 产物；`tool_audit` 说明原生工具调用链路整体是通的。问题集中在**度量口径、预算控制、日志治理、少量工具路由**。

---

## 二、逐项分析与修复建议

### 1. 🔴 消息 token 数口径错误（最像「有点问题」的那个）

**证据**（`messages` 表）：

| rowid | 正文字符 | 思考字符 | 记录 tokens | 时长 |
|---|---|---|---|---|
| 2 | 379 | 892 | **28,240** | 8.6s |
| 4 | 23,050 | 14,507 | 64,620 | 154.5s |
| 6 | 12,234 | 14,903 | 58,727 | 54.9s |
| 8 | 31,982 | 75,070 | 104,711 | 368.2s |
| 10 | 55,866 | 175,704 | 123,407 | 1435.3s |

379 字的回复记成 28240 tokens（≈74 token/字符）显然不可能。

**根因链**：
- `src-tauri/src/api.rs:190` — `let total = usage.total_tokens`；`:257` — `tokens: total` → SSE 里下发的 `tokens` 是**该轮请求的 prompt + completion 总和**。
- `src/stores/chat.ts:4463` — `if (d.tokens) assistantMsg.tokens = d.tokens;` → 直接当成「这条回复的 token 数」，且**多轮工具循环里每轮覆盖一次**，最终只剩**最后一轮**的值（那一轮的 prompt 因上下文膨胀而巨大）。

**影响**：
- 气泡上显示的 token 数不是「回复成本」，而是「最后一轮请求总量」——数值不可解释；
- `estimateCost(model, inputTokens, tokens)` 把 total 当作 **output** 计价（`src/stores/chat.ts:5117-5119`）→ 单条回复估算到 **¥1.26**，`usage_agg_daily` 累计同样虚高；
- 多轮里「哪一轮贵」完全不可见，无法优化。

**修复建议**：
1. `api.rs` 分别解析并上报 `prompt_tokens` / `completion_tokens` / `cached_tokens`；
2. 前端 `assistantMsg.tokens` 改为**多轮 completion 累加**（真实回复产出），另存 `totalTokens`（本轮总消耗）供展示；
3. 费用按 input（区分 cache hit/miss）× output 分别计价；
4. 加一条单测：给定两轮 usage 序列，断言累加口径正确。

### 2. 🔴 单轮无预算 + 大产物直接进对话

**证据**：单轮最长 **1435.3 秒（24 分钟）**；正文 55866 字、思考 175704 字；`max_context_messages = 50`。
模型把「全球经济日报」整篇报告写进**对话正文**（而不是写文件后给摘要），下一轮又把这几万字塞回上下文 → prompt 指数级膨胀。

**修复建议**：
1. 提示词强化：**长产物一律落盘**（`write_file`）+ 正文只给摘要与文件链接（现有提示已有类似条款，但只在 write_file 被截断时触发，需前置到常规路径）；
2. 正文超长（如 > 8000 字）时前端**折叠展示 + 自动落盘**，避免污染上下文；
3. 给单轮加**软预算**：工具轮次（现 `MAX_TOOL_ROUNDS = 48`）之外再加「总时长 / 总 token」上限，超限时主动收尾汇报；
4. 超出 `max_context_messages` 的历史做**摘要压缩**（记忆系统已有 `save_summary`，但 `memory_summaries` 表为空 → 该链路没真正启用）。

### 3. 🔴 日志热路径刷屏

**证据**：`daoshengyi.log` = 1,149,331 行 / 80MB，其中 `[sse] reasoning_len=…` **1,115,187 行 = 97%**；同一秒内出现 492 行。
**根因**：`src-tauri/src/lib.rs:902-908` 打印条件是 `rl > 0 || cl > 0 || ch > 0 || cm > 0`——注释说「usage 块也打印」，但 `rl/cl` 是**每个正文分片**的长度，于是**每个 chunk 都打一行**。
另外 `append_log`（`lib.rs:59`）每次调用都 `open → writeln → close`，且**无大小上限、无轮转**。

**修复建议**：
1. 条件收紧为「仅当收到 usage（`ch/cm/total` 有值）时打印」，或改为**每 5 秒聚合打一行**；
2. `append_log` 复用带缓冲的文件句柄；加 **8MB × 3 轮转**；
3. 提供「设置 → 健康 → 清空日志」入口（`HealthPanel` 已有基础）。

### 4. 🟠 工具失败率 10.9%，失败集中在四处

| 工具 | 失败/总 | 典型错误 | 疑似原因 |
|---|---|---|---|
| `puppeteer_evaluate` | 12/17 | `Cannot convert undefined or null to object` | 模型传 `expression` / `function`，**参数名不对**（该工具参数疑为 `script`）→ 服务端拿到 undefined |
| `fetch_page` | 3/3 | `MCP error -32602: Tool fetch_page not found` | **内置工具被路由到 MCP 服务器**（`resolveToolServer` 转发逻辑），应走内置 |
| `command` | 16 失败 | `命令执行超时（60s），已终止` | 无头浏览器渲染/长脚本超 60s；缺「长任务」提示或后台执行 |
| `write_file` | 2 失败 | `Invalid arguments … expected string, received undefined at path` | 模型漏传必填参数，缺参数级纠错回填 |

**修复建议**：
- 给高频 MCP 工具（puppeteer 系）在 `builtin-params.ts` 补**显式中文参数说明**（覆盖服务端 schema 的空缺/晦涩），失败时回填「正确参数名是 `script`」；
- 修 `resolveToolServer`：内置工具名优先命中内置，不再向 MCP 转发（`fetch_page` 案例）；
- `command` 超时错误信息里附「如需长任务请拆分或使用后台方式」的引导；
- 必填参数缺失时，在 tool 结果里回填 schema 要求的参数名（已有「未知工具」回填思路，可复用）。

### 5. 🟠 工作流「假成功」

**证据**：`workflow_runs` 中 `宏观局势分析报告生成器` 多条 `status=success`，但 `summary=[输出] [n1] （模型未返回内容）`。
即 **LLM 节点返回空内容，却被记为运行成功** → 用户看到「成功」但拿不到东西。

**修复建议**：LLM 节点输出为「（模型未返回内容）」/空串时标记为 `failed` 或自动重试一次；`workflow_runs.status` 增加 `partial` 语义。

### 6. 🟠 工作流重复执行 + 产物落在家目录根

**证据**：`全球经济日报` 在 23:57:33 / 23:58:22 / 23:59:38 / 00:00:43 / 00:01:32 **连续成功 5 次**（3 分钟内），产物为 `/Users/wanghuan/全球经济日报-2026-09-15.html`。

**修复建议**：
1. 工作流节点写文件时强制**输出目录**（如工作区下的 `reports/`），避免污染 `~`；
2. 同名工作流短时间内重复运行给出提示（或做「运行中不允许重复触发」）；
3. 定时任务（`scheduled_tasks` 当前为空）本就该承担「每日生成」职责，手工重复跑属于调试残留。

### 7. 🟡 网络/上游错误无自动重试

`error sending request` 18 次、`网络错误` 15 次、`流错误: error decoding response body` 2 次、`模型回复超时（120 秒）` 2 次。
现有只有「截断续写」的自动处理，**没有网络层重试**。建议：SSE 建连失败/中途断流时按指数退避重试 1~2 次（保留已生成内容），并把「重试中」状态透出到 UI 与托盘。

### 8. 🟡 工具数接近上限

内置 43 个 + MCP 已出现 22 种；`MAX_NATIVE_TOOLS = 80` 且 `tool-schema.ts:133` 是**静默截尾**（内置在前、MCP 在后）。
建议：接近上限时在 MCP 面板给出警告，或按「当前会话用得到的服务器」动态裁剪（而不是固定截尾）。

---

## 三、建议的修复顺序（按性价比）

| 顺序 | 事项 | 预估工作量 | 收益 |
|---|---|---|---|
| 1 | **日志热路径收紧 + 轮转** | 0.5 小时 | 立刻止血 80MB 日志与 I/O 开销 |
| 2 | **token 口径修正**（分 prompt/completion + 费用分别计价） | 1~2 小时 | 显示与费用恢复可信；为后续优化提供真实数据 |
| 3 | **fetch_page 路由修复** + puppeteer 参数名纠错回填 | 1 小时 | 直接降低工具失败率 |
| 4 | 工作流：空输出判失败 + 产物落到工作区目录 | 1 小时 | 消除「假成功」与家目录污染 |
| 5 | 超长产物折叠/落盘 + 单轮软预算 | 2~3 小时 | 抑制上下文与成本雪球 |
| 6 | SSE 断流重试 | 2 小时 | 韧性提升 |

---

## 四、复现与验证命令（供后续回归）

```bash
DB="$HOME/Library/Application Support/com.daoshengyi.app/daoshengyi.db"
# 消息 token 口径
sqlite3 "$DB" "select rowid, length(content) content_len, ifnull(length(reasoning_content),0) reasoning_len, ifnull(tokens,0) tokens from messages where role='assistant'"
# 工具失败分布
sqlite3 "$DB" "select tool_name, count(*), sum(is_error) from tool_audit group by tool_name order by sum(is_error) desc limit 10"
# 工作流运行
sqlite3 "$DB" "select wf_name, status, datetime(started_at/1000,'unixepoch','localtime'), substr(summary,1,60) from workflow_runs order by started_at desc limit 10"
# 日志占比
LOG="$HOME/Library/Application Support/com.daoshengyi.app/daoshengyi.log"
echo "$(wc -l < "$LOG") 行 / $(grep -c 'reasoning_len=' "$LOG") 行是 sse 诊断日志"
```
