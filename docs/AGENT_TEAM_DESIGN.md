# Agent Team 设计（roster + mailbox）· 2026-11-16

> 状态：**S0 / S1 / S2 / S3 均已实现**（2026-11-16 ~ 11-18，见 §2.4 与各段的「已落地」注记）。
> 三个待确认项的默认取值为：**先做 S0 / 按会话隔离 / 推荐预算（40 万 tokens、主会话 30%、并发 4）**。
>
> 实现时与本文的差异（都以代码为准）：
> - 工具面合并成**一个** `agent {action}`（spawn/ask/send/inbox/list/status/close）而不是四个独立工具
>   —— 内置工具已达 `MAX_NATIVE_TOOLS`(96)，拆开会把 MCP 的声明名额吃到 0。
> - mailbox 消费点直接复用 `flushHookInjections` 的位置（回合开头），未新造注入通道。
> - 成员预算用**估算** token 累计（`runSubagentLoop` 不回 usage）；记 0 会让预算闸形同虚设。
> 触发：DSH 复盘 P2 的第三项。前两项（回合统计作用域化、子代理轨迹落库+复盘界面）已完成。

---

## 0. 一页结论

**先修地基，再做编制。** 现在「后台子会话」根本**没有工具**（`queue_turn` 调
`api::chat_once(config, msgs, None)`，第三个参数是 tools，传的是 `None`），它只能聊、
不能读文件/跑命令。在这个地基上直接盖 roster + mailbox，等于给一个不能干活的人发工牌。

所以顺序改成：

| 阶段 | 内容 | 为什么必须先做 |
|---|---|---|
| **S0** | 把 `sendMessage` 主循环抽成 `utils/agent-loop.ts`，让**后台**回合也走同一个带工具的循环 | ①子会话没有工具=假 teammate ②主循环 7,900 行零行为测试 |
| **S1** | roster：`agents` 表 + `agent_spawn/agent_list/agent_status` | 让「成员」可被再次寻址 |
| **S2** | mailbox：`agent_messages` 表 + `agent_send/agent_inbox` | 让主/子代理能异步传话 |
| **S3** | 恢复与重放：重启后 running → interrupted，可 `agent_resume` | 现在重启即丢（`agentSessions` 是内存 Map） |

---

## 1. 现状（带代码位置，避免凭印象设计）

| 事实 | 位置 | 影响 |
|---|---|---|
| 子代理 = 一次性函数调用 `runSubagentLoop`，独立上下文、独立回合统计、有工具 | [chat.ts](../src/stores/chat.ts) `runSubagentLoop`（约 4402 行） | 能干活，但**跑完即消失**，不可寻址、不能追加任务 |
| 子代理轨迹已落库（`subagent_runs`），可用 `subagent_trace` / 面板「复盘」看 | `db.rs`、`utils/subagent-trace.ts`、`SubagentTraceDialog.vue` | 复盘有了，但那是一次性调用的遗物，不是成员状态 |
| `session_spawn` 建的是**真实子会话**（进左侧历史，能续聊），状态持久 | `toolSessionSpawn`（约 1872 行）+ `ensure_conversation_cmd` + `queue_turn` | 「持久成员」其实已经存在，缺的是**角色/归属/状态**这层元数据 |
| 后台回合**没有工具** | `lib.rs::queue_turn` → `api::chat_once(config, api_msgs, None)` | 子会话不能真正承担子任务，只能做纯推理/写作 |
| 子会话登记是内存 Map，重启即清 | `agentSessions: Map<string, …>` | 「持久」只到重启为止；中断状态无法恢复 |
| 主循环（`sendMessage`）1,700 行，零行为测试 | `chat.ts` | 任何 roster 改动都在**不可测**的核心上动刀 |

---

## 2. S0：先让后台回合真的能干活

### 2.1 问题本质

前端有完整的 agent 循环（流式 + 原生 tools + 内置工具分发 + 拦截链 + 预算裁剪），
Rust 侧的 `queue_turn` 只有一句 `chat_once(..., None)`。于是同一件事有两套实现，
而且弱的那套在后台跑。

### 2.2 方案（推荐 A）

**A. 前端跑后台循环（推荐）**
- 把 `sendMessage` 里的「回合编排」抽成 `utils/agent-loop.ts`：输入
  `{config, history, tools, gate, hooks, onDelta, onTool, stopSignal}`，
  输出 `{content, toolCards, usage}`，**不依赖 Pinia**（依赖以参数注入）。
- `session_spawn`/`queue_turn` 改为：由前端为子会话启动一个 `agentLoop` 实例，
  `onDelta/onTool` 写回该会话（沿用现有 `refreshConversation` 与消息落库）。
- `queue_turn` 的 Rust 实现保留为**降级路径**（前端不可用时仍能跑纯对话）。

代价：需要把 `chat.ts` 的状态依赖梳理干净（这是它的老问题，也是必须做的）。
收益：后台与前台**同一套循环**，行为一致；核心终于可测。

**B. 在 Rust 里实现第二套带工具的循环** —— 拒绝。两套实现必然分叉，
且 Rust 侧拿不到前端的内置工具（`callBuiltinTool` 在 TS 里）。

### 2.4 已落地的折中（2026-11-16）

完整抽 `agent-loop.ts` 会动 1,700 行主循环，风险高；而「后台不能干活」这件事有更小的解法：
**让后台回合直接复用已有的 `runSubagentLoop`**（它本来就带全套内置工具、独立回合统计、轨迹落库），
跑完把「任务 + 结论」写回子会话消息。

- `session_spawn`：主路径改为 `runSubagentLoop(cfg, sys, prompt, {allowTools: true, maxRounds: 24})`
  → `appendToChildSession`（`get_messages` + `save_conversation`，按 id upsert）→ `refreshConversation`；
  `queue_turn` 只保留为「没有可用模型配置」时的降级通道（行为与以前一致）。
- 契约测试钉住：主路径必须是带工具的循环，`invoke("queue_turn")` 在 spawn 体内**只允许出现一次**（降级用）。

**仍然没解决**：`sendMessage` 本身还是不可测；真正的抽离（前台与后台共用**同一个**循环对象）
仍要做，只是不再阻塞 roster 的推进。

### 2.3 验收标准（S0）

1. `agent-loop.ts` 有行为测试：给一段假 SSE 与假工具表，断言
   「原生 tool_calls → 执行 → 回填 → 继续」与「无工具调用 → 收尾」两条主路径。
2. 真机：`session_spawn` 一个「读某个文件并总结」的后台任务，**能真的读到文件**
   （当前会答「我无法访问文件」）。
3. `npm run ci:local` 8/8，且 `chat.ts` 行数明显下降（目标 −800 行以上）。

---

## 3. S1：roster（成员表）

### 3.1 数据模型

```sql
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,          -- 成员 id（= 子会话 id，复用会话表）
  conversation_id TEXT NOT NULL,             -- 归属会话（主会话）
  name            TEXT NOT NULL,             -- 成员名（用户可读，主代理用它寻址）
  role_id         TEXT,                      -- 角色（analyst/reviewer/…）
  brief           TEXT DEFAULT '',           -- 职责一句话（长期目标，不是单次任务）
  status          TEXT NOT NULL,             -- idle|running|waiting|done|failed|cancelled|interrupted
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_turn_at    INTEGER,
  turns           INTEGER DEFAULT 0,         -- 累计回合数（预算/成本分摊）
  tokens          INTEGER DEFAULT 0,
  cost            REAL DEFAULT 0,
  UNIQUE(conversation_id, name)              -- 同一会话内名字唯一（寻址不歧义）
);
```

**关键取舍：成员 id = 子会话 id。** 不新建第二套「成员会话」，否则「历史里能点开的会话」
与「代理眼里的成员」会分叉（用户点进去聊两句，成员却不知道）。

### 3.2 状态机（这是 S1 的核心，不是 UI）

```
        spawn                task               完成
  (none) ──▶ idle ──▶ running ──▶ idle（可再派活）
                       │  │
            等待输入 ◀─┘  └─▶ failed（工具/模型错误，保留轨迹）
                       │
              用户停止 ─┴─▶ cancelled
  进程重启时：running → interrupted（**不自动重跑**）
```

**恢复语义（明确写死，避免以后扯皮）**：
- `interrupted` **不自动继续**：重启后自动重跑一个写了一半的任务，比不跑危险得多。
- 用户/主代理可 `agent_resume`：把「上次做到哪」作为上下文（取该会话最后一条 assistant
  正文 + 未完成的任务原文）重新投递，**新一轮**而不是「接着写」。
- `failed` 在派新活时直接转 `running`（失败不粘）。

### 3.3 工具面（对模型）

| 工具 | 作用 | 备注 |
|---|---|---|
| `agent_spawn {name, role?, brief, task?}` | 建成员并（可选）立刻派首个任务 | 名字冲突时返回可读错误，建议换名 |
| `agent_list {status?}` | 列本会话成员（名字/角色/状态/累计回合） | 主代理「点名」前先看这个 |
| `agent_status {name}` | 单个成员的状态 + 最近结论摘要 | |
| `agent_close {name}` | 归档成员（不删会话历史） | |

与现有工具的关系：`subagent`（一次性、要结论）保留给「问一句就走」的场景；
`agent_spawn` 用于「需要长期协作、多次追加任务」的场景。**工具描述必须把这条边界写死**，
否则模型会在两者之间随机选。

### 3.4 验收标准（S1）

1. 同一会话内不能建同名成员；跨会话同名互不影响。
2. 成员状态在 UI 侧栏可见，且与数据库一致（刷新/重启后仍对）。
3. 重启后 `running` 一律显示为 `interrupted`，且不自动执行任何动作。
4. 单测：状态迁移表（合法/非法迁移都要断言）。

---

## 4. S2：mailbox（异步传话）

### 4.1 数据模型

```sql
CREATE TABLE IF NOT EXISTS agent_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  from_agent  TEXT NOT NULL,   -- 'main' 或成员名
  to_agent    TEXT NOT NULL,
  kind        TEXT NOT NULL,   -- task|question|answer|note|result
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER,         -- NULL = 未读
  turn_id     TEXT             -- 投递给哪一轮（回填到该轮开头）
);
```

### 4.2 投递语义（关键设计）

1. **信箱只在「回合开头」被消费**，注入方式与现有 `flushHookInjections` 完全一致
   （同一条路径、同一位置）。这样：①不改请求装配的不变量（前缀稳定）；
   ②消息出现的位置可预测，便于调试。
2. **未读消息不会丢失**：成员下一次被唤醒（`agent_resume` 或被派活）时先消费信箱。
3. **不打断在跑的回合**：正在 running 的成员收到消息 → 只入信箱，不抢占。
   （想立刻插话的场景用「停止 + 重新派活」，那是用户的显式动作。）
4. `read_at` 在读入上下文时写入；同一消息不会被消费两次。

### 4.3 工具面

| 工具 | 作用 |
|---|---|
| `agent_send {to, kind, content}` | 投递消息（不等待） |
| `agent_inbox {name?, unread_only?}` | 查看信箱（自己或某成员） |

### 4.4 验收标准（S2）

1. 主代理给成员发消息 → 成员下次回合的系统上下文里能看到（并标记来源 agent）。
2. 同一消息只被消费一次（`read_at` 生效）。
3. 投递不改变「前缀稳定」不变量：消息只追加在最后一条 user 之后。
4. 单测：消费顺序、重复消费、跨会话隔离。

---

## 5. 横切关注点（不能等出问题再补）

| 主题 | 设计 |
|---|---|
| **预算** | 每个成员累计 tokens/cost；超过阈值（默认单成员 40 万 tokens 或主会话的 30%）→ 拒绝新派活并提示用户。防「无限互相派活」把账单烧穿。 |
| **并发** | 同时 running 的成员上限（默认 4，沿用并行子代理的信号量）；超出的进 `waiting`。 |
| **防环** | 成员不得 `agent_spawn` 新成员（只有主代理可以），避免「代理生代理」的爆炸；成员之间只能经主代理转发。 |
| **隔离** | 成员沿用主会话的工作区与权限规则；**不因成员身份放宽任何权限**（尤其命令门禁）。 |
| **可观测** | 成员的每轮轨迹复用 `subagent_runs`（加 `agent_name` 列），复盘入口一致。 |
| **迁移** | 新表用 `CREATE TABLE IF NOT EXISTS`；老数据零影响。`session_spawn` 保持可用（= 匿名单次成员）。 |

---

## 6. 待你确认的三个决定

1. **S0 要不要先做**（我建议做）——不做的话，roster+mailbox 建在一个「不能干活的成员」上。
   代价：S0 是这四件里最重的一件（要动主循环）。
2. **成员是否跨会话共享**：现在是「每会话一个花名册」（同名互不干扰）。
   跨会话共享的好处是「一个长期助理」；坏处是隔离变复杂、成本归属模糊。我建议**先按会话隔离**。
3. **成员上限与预算**：默认 4 个并发 / 单成员 40 万 tokens。要不要更保守？

---

## 7. 如果确认，实施顺序与提交粒度

```
S0-1  抽 agent-loop.ts（纯编排，参数注入）+ 行为测试      ← 可独立提交，先不接线
S0-2  后台回合改走 agent-loop（queue_turn 留降级）         ← 真机验证「后台能读文件」
S1-1  agents 表 + 状态机纯函数 + 单测
S1-2  agent_* 工具 + 侧栏展示
S2-1  agent_messages 表 + 回合开头消费 + 单测
S2-2  agent_send/inbox 工具 + 模型侧描述与边界
S3    重启恢复：running → interrupted + resume 语义
```

每步都跑 `npm run ci:local`（8 门禁）+ 打包安装 + 推送 main。
