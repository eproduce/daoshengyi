# 结构性机制差距分析

> 对象：`daoshengyi`（Tauri + Vue 3 + TypeScript + Rust，v1.0.0-alpha.3）
> 方法：只读通读源码，所有结论附 `路径:行号` 与逐字引文。
> 相关文档：`DSH_ABSORPTION_PLAN.md` 吸收的是**社区插件能力**（确定性工具集、压缩、脱敏、预算护栏），不是本文的范围。

## 与 `DSH_ABSORPTION_PLAN.md` 的关系

那份计划的结论是「架构层面已吸收」，依据是**功能对照**：有工具渐进披露、有自动压缩、有子代理、有沙箱。这些都对。

但「有对应功能」不等于「有对应保证」。那份对照表里没有一格在问：**模型请求是从哪派生出来的？旧数据读不动时会怎样？我改了提示词谁来告诉我坏了？** 本篇只谈这类**结构不变式**，不重复功能清单。

## 结论摘要

| # | 机制 | 现状 | 差距 | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | UI 呈现与模型可见内容分离 | ❌ 卡片文本写进 `content`，`content` 直接发给模型 | 模型模仿出自己的伪卡片（**已在你们日志中发生**）+ token 重复 | **P0** |
| 2 | 会话状态的可追加日志 | ❌ Pinia 可变数组 + 整表覆盖写 | 崩溃丢数据、压缩状态不落库、无法回放 | **P0** |
| 3 | 未知数据默认拒绝 + 版本号 | ❌ 无版本号；解析失败丢整批会话 | 一次坏数据 = 整库会话从界面消失 | **P0** |
| 4 | 模型可见行为的回归测试 | ❌ 38 个测试文件无一 import `chat.ts` | 改提示词/工具格式零保护 | **P1** |
| 5 | 工具注册的单一真相 | ⚠️ 静态数组 + 参数表 + `switch` 三处分散 | 加工具要改三处，容易漏 | **P1** |
| 6 | 子代理轨迹可重建 | ❌ 进程内调用，轨迹不落会话 | 主会话看不到子代理做了什么 | **P2** |
| 7 | 定时任务「日志是真相、运行时是投影」 | ❌ DB 行是真相 | 无法重放、无法审计变更史 | **P2** |

---

## P0-1 工具卡片既污染了模型上下文，又没能持久化

同一根因的两个症状，是本次分析里最值得先做的一条。

### 症状 A：UI 卡片文本进了发给模型的 `content`

轮末构造助手消息正文（`src/stores/chat.ts:6910-6915`）：

```ts
const finalText = stripToolJson(streamingContent.value);
assistantMsg.content =
  toolChain.length > 0
    ? finalText
      ? toolChain.join("\n\n") + "\n\n" + finalText
      : toolChain.join("\n\n")
    : finalText;
```

而 `toolChain` 里的卡片是给人看的 UI 文本（`src/stores/chat.ts:6357-6362`）：

```ts
const card =
  `### 🔧 调用工具：\`${tool}\`\n\n` +
  `<details><summary>参数</summary>\n\n\`\`\`json\n${argsStr.slice(0, 400)}\n\`\`\`\n\n</details>` +
  `\n<details><summary>✅ 工具结果</summary>\n\n\`\`\`\n${clipped}\n\`\`\`\n\n</details>`;
toolChain.push(card);
```

下一轮把这些历史原样发给模型（`src/stores/chat.ts:5969`）：

```ts
rustMsgs.push({ role: m.role, content: m.content });
```

**后果已经被你们观测到并记录在案**（`src/stores/chat.ts:794-795`）：

> 工具调用唯一格式：模型误把历史消息里的 UI 卡片（`### 🔧 调用工具` / `<details>参数</details>`）当成调用格式写在正文里，导致工具不执行、回复中断（日志：有闭合标记但解析失败/伪卡片）。

也就是说：模型在历史里看到「助手自己」写过 `### 🔧 调用工具`，就把它当成一种合法写法来模仿。

### 症状 B：结构化卡片没持久化，重启后界面不再显示

`assistantMsg.tools = toolCards`（`src/stores/chat.ts:6916`）只存在内存；SQLite `messages` 表**没有 tools 列**（`src-tauri/src/db.rs:205-221` 的 `MsgRow` 共 11 个字段，无 tools；落库载荷 `src/stores/chat.ts:4289-4295` 也不含）。而显示层无条件剥离正文里的卡片（`src/components/ChatMessage.vue:200-204`）：

```ts
function md(s: string) {
  const body = stripToolCards(s || "");
  return body ? (marked.parse(normalizeMath(body)) as string) : "";
}
```

载入历史时不恢复 `tools`（`src/stores/chat.ts:4232-4247`）。**推论**：重启后 `message.tools` 为空 → 折叠分组不渲染，而 `md()` 又把正文里的卡片剥掉了 → **工具调用过程在界面上消失**，只剩最终回答。

> 证据限度：本地 `daoshengyi.db` 当前 0 条消息，无法用真实数据复核症状 B，此条由代码推得，建议实测确认一次（重启后打开任一含工具调用的历史会话）。症状 A 有你们自己的注释作为观测证据。

### 为什么会变成这样

卡片进正文是**为导出/复制保留完整过程**（`src/utils/tool-summary.ts:1-7` 的文件头自述）。这个目标合理，但实现方向错了：**把 UI 文本塞进了模型可见字段**，于是同一个字段同时承担了「导出用文本」「显示用文本」「模型上下文」三个互斥的职责。

### 建议

把三者拆开，让 `content` 只保留模型该看到的东西：

1. `content` 只放最终答案（不含卡片）。
2. 给 `messages` 表加 `tools` 列（结构化 JSON），落库 `toolCards`。这是既有数据的自然扩展，已有 6 条列迁移先例（`src-tauri/src/db.rs:281-295`）。
3. 导出/复制需要的卡片文本，**由 `tools` 数据现场派生**——`summarizeTools`（`src/utils/tool-summary.ts:29`）已经是无 import 的纯函数，正好复用，不必再存一份文本。
4. 顺带清理：`stripToolCards` 及其"只剥开头"的保守逻辑（`src/utils/tool-summary.ts:63-95`）可以退役；提示词里那 5 处以上反复禁止卡片的话（`chat.ts:794-806`、`941-945`、`3890-3892`、`3953`、`6511`）也可以删掉——**根因消失后，靠提示词压制症状的部分就是纯 token 成本**。

### 收益

- 消除「模型模仿 UI 卡片 → 伪卡片 → 回复中断」这类故障（**不再依赖模型服从提示词**）
- 每轮省下卡片文本的重复 token（工具结果目前既以 `role:"tool"` 回填、又在正文里再出现一次）
- 重启后工具调用记录不再丢失
- 提示词变短

### 验收

- 新会话跑一次含 2 个工具调用的回合，断言落库 `content` 不含 `### 🔧`、`tools` 列有 2 条记录
- 重启应用，打开该会话，断言折叠分组仍显示且条数一致
- 单测：`content` → 导出文本的派生函数（纯函数）

---

## P0-2 会话状态是可变数组，模型请求在发送时才临时拼装

**现状**：不存在「可追加日志作为唯一真相」的结构。

- 真相是 Pinia 内存数组 `const conversations = ref<Conversation[]>([])`（`src/stores/chat.ts:4309`），`Conversation.messages` 是可变数组（`src/types/index.ts:84-97`）
- 修改方式是直接 `push`：用户消息 `src/stores/chat.ts:4897-4900`，助手占位 `:5528-5531`
- 模型请求在 `sendMessage` 内内联拼装，无独立函数（`src/stores/chat.ts:5930-5934` 构造 `rustMsgs`，`:6254-6258` 发出）
- 持久化是**整表覆盖**：`save_conversation` 先 `DELETE FROM messages WHERE conversation_id=?1` 再全量插入（`src-tauri/src/db.rs:379-390`）

**三个具体后果**：

1. **崩溃丢数据**：整表覆盖写意味着每次保存都重写该会话的全部消息。中途失败就是丢整段历史，而不是丢最后一条。
2. **压缩状态不落库**：`compactBefore` / `compactSummary` 只在内存（`src/stores/chat.ts:1906-1914` 写入，`save_conversation` 载荷里没有这两个字段，`conversations` 表也没有对应列）。重启后压缩状态丢失 → 同一段历史会被**重新压缩一次，多花一次 token**。
3. **无法回放**：没有日志就没有「重放这次请求」的可能，也就没有 P1 的测试基础。

**顺带确认**：压缩本身设计是**可逆**的（原始消息完整保留，只把「发给模型的历史」跳过被摘要覆盖的区间，`src/stores/chat.ts:5943-5953`），这一点做得对——压缩不改数据，只改投影。

**建议（渐进，不必照搬 Cordis）**：

不要现在去引入事件溯源架构。分两步走：

1. **先去掉破坏性的覆盖写**：`save_conversation` 改为增量（按 message id upsert + 删除已不存在的 id），或直接复用已有的 `append_message`（`src-tauri/src/db.rs:402-411`，注释写明"追加一条消息到会话末尾（不清空原消息）"——**这条路径已经存在，只是主流程没用它**）。
2. **再把压缩状态落库**：给 `conversations` 表加 `compact_before` / `compact_summary` 两列。这一步很便宜，直接收回「重启后重复压缩」的成本。

真正的日志化留到 P1 的测试基建需要它时再做——那时有了明确收益（能回放）再付结构成本。

**验收**：模拟保存中途失败，断言旧消息仍在；重启后断言不再触发重复压缩。

---

## P0-3 数据库没有版本号，一次坏数据丢掉整批会话

**现状**：

- 库只设了 `journal_mode` / `foreign_keys`（`src-tauri/src/db.rs:272-280`），**全仓未找到** `user_version`、`schema_version` 或 migration 表
- 「迁移」是启动时无条件执行的 `ALTER TABLE`，而且**错误被显式丢弃**（`src-tauri/src/db.rs:281-295`）：

```rust
let _ = conn.execute("ALTER TABLE messages ADD COLUMN cost REAL", []);
let _ = conn.execute("ALTER TABLE messages ADD COLUMN attachments TEXT", []);
```

`let _ =` 让「列已存在」和「真的失败了」无法区分。新装的库每次启动都在跑这些失败语句。

- 会话行内 JSON 是**裸解析，无 try**（`src/stores/chat.ts:4237-4240`）：

```ts
images: m.images ? (JSON.parse(m.images) as ImageAttachment[]) : undefined,
attachments: m.attachments ? (JSON.parse(m.attachments) as FileAttachment[]) : undefined,
```

异常冒到外层 catch（`src/stores/chat.ts:4262-4264`），结果是**整个库的会话都不再载入，界面退化为空数据**，只留一行 `console.warn`。

**这是本次分析里风险最高的一条**：它不是理论问题——一条 corruption 就足以让用户看到"我的会话全没了"。而且没有版本号，未来任何格式变更都无法区分"旧数据"和"坏数据"。

**建议**（对齐 DSH 机制 2/3，但按你的规模裁剪）：

1. **用 `PRAGMA user_version` 存 schema 版本**（SQLite 自带，无需建表）。启动时读它，决定跑哪些迁移，跑完写回。
2. **迁移错误不再丢弃**：`let _ =` 换成带白名单的匹配——只忽略「duplicate column」，其余上报。
3. **单行解析加容错边界**：`JSON.parse` 包 try，失败时该字段退化为 `undefined` 并记一条日志，**不要让它冒到外层**。原则是 DSH 那句话的裁剪版：**坏一条就坏一条，不要坏一整批**。
4. （可选）给 `app_settings` 的解析加上"解析失败保留原文"的处理——现在 `load_app_settings` 解析失败直接抛错（`src-tauri/src/lib.rs:5526-5538`），前端吞掉后静默用默认值（`src/api/appSettings.ts:173-186`），用户会以为设置被重置了。

**验收**：单测注入一条 `images` 为非法 JSON 的消息，断言其余会话正常载入；断言 `PRAGMA user_version` 在迁移后被更新。

---

## P1-1 模型可见行为零测试覆盖

**现状**：38 个测试文件（`tests/test-*.test.ts`），全部是纯函数单测，覆盖 `src/utils/*` 与 `src/data/*`。**没有一个文件 import `src/stores/chat.ts`**，也就是说：

- 系统提示拼装（`getMcpToolsPrompt()`、`sp` / `volatileCtx` 装配）
- 工具结果回填格式（`foldToolResult` / `truncateToolResult` / `markExternalToolResult`）
- 压缩后的上下文装配

**全部无测试**。测试配置也极简（`vitest.config.ts` 11 行：`include: ["tests/**/*.test.ts"]`、`environment: "node"`，**无 coverage 段**），无 fixture、无快照、无回放。

**为什么这条现在就要动**：你们的功能里，改提示词和工具格式是**最高频**的改动（`DSH_ABSORPTION_PLAN.md` 的 P0/P1 有一半是工具与提示词变更），而它们恰好是零保护的区域——改坏了只有上线后靠用户发现。

**建议**（按投入产出排序，不必一次做完）：

1. **先把提示词变成可快照的**：把 `chat.ts` 里那些巨大字符串拼接（`outputRule`、`toolCallRule`、`fileRule`、`NATIVE_TOOLS_NOTE` 等）抽成纯函数，输入 config → 输出字符串；用 vitest 快照锁住。这一步不引入新基建，就能让"提示词改动"进入 review diff。
2. **再给工具结果格式加快照**：`foldToolResult` 等输入固定、输出字符串，天然适合快照。
3. **最后才是录制回放**：把一次真实回合的「发出的请求 + 收到的响应」存成 fixture，回放时免 key 重跑。这一步能覆盖"拼装出的 `messages` 到底长什么样"，也就是 P0-1 那类问题的回归网。

第 3 步是 DSH 机制 9 的裁剪版，价值最高但要基建，放在 1、2 之后。

**验收**：`npm test` 能在改坏系统提示时失败。

---

## P1-2 工具定义散在三处，没有单一真相

**现状**：

- 名字与描述：`src/data/builtin-tools.ts:12` 的 `BUILTIN_TOOLS` 数组
- 参数 schema：另一张表 `src/data/builtin-params.ts` 的 `BUILTIN_PARAMETERS`
- 执行分支：`src/stores/chat.ts:1974` 的 `switch (tool)`

`DSH_ABSORPTION_PLAN.md` 的"执行纪律"里已经写明这个约束：「工具类改动必须同步 `data/builtin-tools.ts`（描述）+ `data/builtin-params.ts`（参数 schema）+ `chat.ts`（执行分支）**三处**」——已用纪律弥补结构，但这正是"用约定补数据设计"的典型。

另外**没有任何注销/dispose 路径**：`tool-schema.ts` 导出 10 个符号，无 `unregister` / `remove` / `dispose`；MCP 断开只改标记（`src/stores/mcp.ts:326-340`），工具缓存靠 `refreshMcpTools()` 整体重建。

**建议**：把三处合一——一个 `defineTool({ name, desc, params, run })` 形状的表，`BUILTIN_TOOLS` / `BUILTIN_PARAMETERS` / `switch` 都从它派生。这是**一次重构，长期省事**：加工具变成改一处。

注销可以先不做。因为 `nativeRegistry` 本来就每轮重建（`src/stores/chat.ts:5641`），跨会话泄漏的风险很低——这点比许多同类项目干净。

**验收**：新增一个工具只需改一个文件；`test-tool-schema.test.ts` 的数量配额断言仍通过。

---

## P2-1 子代理的轨迹不可重建

**现状**：`subagent_delegate` 是**进程内函数调用**（`src/stores/chat.ts:2966` 起，`:2990-2996` 调用 `runSubagentLoop`），结果只作为工具返回值（`【子代理结论】…`）回到主会话。子代理登记表 `const subagents = ref<SubagentRecord[]>([])`（`src/stores/chat.ts:4569`）**不持久化**。

另一条路径 `session_spawn` 才建真会话并投给 Rust 后台队列（`src/stores/chat.ts:1713` 的 `queue_turn`），那条会作为普通会话出现在历史里。

**后果**：主会话只看得到子代理的结论，看不到它调用了哪些工具、失败过几次。对排查"子代理为什么给出这个答案"是空白。

**建议（P2，按需）**：不必把子代理做成完整会话。最小改动是**把子代理的工具调用摘要存进主会话该条工具结果的元数据里**（正好搭 P0-1 的 `tools` 列顺风车），至少可审计。要做到完整轨迹才需要真会话。

---

## P2-2 定时任务：DB 行是真相，没有变更史

**现状**：调度状态直接存在 `scheduled_tasks` 行里（`src-tauri/src/db.rs:166-179`），字段含 `next_run_at` / `last_run_at` / `last_result` / `last_exit_code`。

对照 DSH 的做法（`packages/schedule/schedule/README.md:80`）：

> **The Session log owns the state.** Version-1 `schedule/change` events are the only durable authority; timers, tool values, and follow-ups are disposable projections rebuilt from the fold.

方向正好相反：DSH 让日志当真相、定时器当投影；你们让行当真相。

**后果**：能回答"下次什么时候跑"，不能回答"谁在什么时候把间隔从 1 小时改成 5 分钟"。任务被静默改坏时没有线索——而你们 `v1.0.0-alpha.3` 恰好修过一个「定时任务静默停摆」的 bug。

**建议（P2）**：不改存储模型，只加一张 `scheduled_task_changes` 追加表（id / task_id / 时间 / 变更前后 JSON / 来源）。改动小，但把"静默停摆"这类问题的排查从猜变成查。

---

## 不建议做的

对齐 `DSH_ABSORPTION_PLAN.md` 的"执行纪律"，以下三条我建议明确排除：

- **不引入 Cordis 或通用插件内核**。你们是单进程 Tauri 应用，工具集是封闭的；引入插件内核是为了换来"第三方可扩展"，而你们没有这个需求。P1-2 的单一表重构就够。
- **不追求逐文件 100% 覆盖率**。DSH 是 200+ 包的库式仓库，你们是 276 个文件的应用。值得抄的是它的**态度**（看到未覆盖行先怀疑是死代码），不是阈值。
- **不引入 YAML 补丁层组合**。那解决的是"多份部署组合"问题，你们只有一种部署。

## 建议的执行顺序

| 批次 | 内容 | 为什么这个顺序 |
| --- | --- | --- |
| 1 | P0-1（卡片出 content、`tools` 落库） | 修掉一个**已发生**的故障模式，并让提示词瘦身；改动局部，收益立刻可见 |
| 2 | P0-3（`user_version` + 解析容错） | 风险最高的一条，且改动小；应在用户数据出事之前做 |
| 3 | P0-2 第 1、2 步（去覆盖写、压缩状态落库） | 直接收回"重复压缩"的 token 成本 |
| 4 | P1-1 第 1、2 步（提示词与工具格式快照） | 为后面所有提示词改动建保护网 |
| 5 | P1-2（工具表合一） | 纯重构，但之后每次加工具的收益都在累积 |
| 6 | P1-1 第 3 步（录制回放） | 需要前 5 步积累的可回放性 |
| 7 | P2 三条 | 按需 |

每批沿用现有门禁：`bash scripts/ci-local.sh` 八步（vitest / eslint / prettier / vue-tsc+build / tsc tests / rustfmt / clippy -D warnings / cargo test）。

## 证据限度

- 全部结论来自对 `daoshengyi` 工作区（HEAD `e0a0a44`，工作区干净）的静态阅读，未修改任何文件。
- 本地 `~/Library/Application Support/com.daoshengyi.app/daoshengyi.db` 当前 **0 条消息**，因此所有"持久化后的实际形态"结论均由代码推得，未经真实数据复核。P0-1 症状 B（重启后卡片不可见）建议实测确认一次。
- P0-1 症状 A（模型模仿 UI 卡片）有你们自己的代码注释作为观测证据（`src/stores/chat.ts:794-795`）。
