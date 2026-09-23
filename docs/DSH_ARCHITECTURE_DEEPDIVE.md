# DSH 架构深挖与借鉴清单（2026-09-23）

> 来源：本地 `deepseek-harness` 仓库 —— `docs/architecture.zh.md`、`docs/capability-seams.zh.md`、
> `docs/cordis-primer.zh.md`、`docs/subsystems/*.zh.md`（60+ 子系统）
> 前置：`docs/DSH_ABSORPTION_PLAN.md`（P0/P1 已吸收全绿）、`docs/DSH_PLUGIN_COMPATIBILITY.md`（插件不兼容结论）

## 一、DSH 的架构骨架（六条主干）

1. **Cordis 无特权内核**：不存在需要打补丁的内核，扩展 = 把插件挂到别的插件旁边；**每项注册都是可逆副作用**（卸载即撤销）。模型适配器、工具注册表、会话日志、**agent loop 本身**都是插件。
2. **Profile + 组合包（bundle）+ 有序 patch**：运行中的 `dsh` 是一棵插件树，由具名 profile 依次叠加 bundle，再叠 `cordis.patch.yml`（按条目 id 替换整份 config 或插入新条目），最后叠 `--patch` overlay。`dsh --profile web --dump-config` 打印的每一项都可被自己的 patch 覆盖。
3. **事件分三域**：**会话事件**（追加进日志的持久事实）/ **Agent 事件**（`agent/*`：观察或拦截进行中的工作）/ **能力事件**（向 seam 挂策略与适配器，如 `fs/*`、`tools/*`）。
4. **轮次流程显式化**：`turn → step →（模型请求 + 工具）`；关键拦截点是**瀑布式（waterfall，不调 `next()` 即短路）**的 `agent/pre-step`、`agent/request`、`llm/stream`、`tools/pre-execute`、`tools/execute`、`tools/post-execute`，加上 serial 的 `agent/turn-stopping`。
5. **会话日志是上下文的唯一来源**：`deriveMessages()` 从日志投影出模型历史；**不变量「模型可见即已记录」**——抵达模型请求的一切都必须能从日志重建，并有运行时断言。
6. **seam 三角色**：服务定义 / 提供方 / 消费方。换一个提供方就能改变整个产品（把 fs+process 指向远端沙箱 ⇒ Bash、PTY、LSP 一起搬过去）。

## 二、对照：我们已经有的 vs 值得借的

| DSH 机制 | 我们的现状 | 判断 |
| --- | --- | --- |
| Cordis 插件内核 / 全插件化 | 单进程 Tauri + 内置工具 + 技能 + MCP | ❌ 不引入（`STRUCTURAL_GAP_ANALYSIS` 已决策） |
| 插件 = npm/cordis 进程内对象 | MCP 外部进程 | ❌ 不兼容（见兼容性文档），方向不对称 |
| **轮次/步骤瀑布式拦截点**（pre-step / request / pre & post-execute） | 判定逻辑**硬编码在主循环分支**里（模式护栏、空洞判定、工具白名单、审批、审计、hooks） | ✅✅ **最值得借**（见 §三） |
| **「模型可见即已记录」不变量** | 无；踩过上下文膨胀（336 万 token / 400 invalid_request）、历史裁剪不可解释 | ✅✅ 值得借（低成本、高回报） |
| **组合包 + 有序 patch 装配** | 内置工具 + 设置项 + 技能；无「按 id 覆盖配置」的通用层 | ✅ 中期借（能力包声明 + 用户 patch） |
| **seam 三角色** | 已有多 provider 雏形（本地/云端视觉档、llama.cpp/Ollama、主/辅助模型路由） | ✅ 借思想：把 provider 选择显式化为 seam，换后端不换行为 |
| **session 投影 seam**（增量折叠 → 类型化状态 / 客户端快照） | 用量、计划、子代理、审计各自在前端聚合 | ✅ 借（减少状态散落与前后端口径漂移——踩过「用量只统计当前会话」） |
| 会话格式版本化 + generation + 相邻迁移链 | SQLite + 幂等 ALTER（无版本号/迁移链） | 🔵 远期（当前规模不值得） |
| `ctx.jobs` / `ctx.terminals` / `ctx.commands` / `ctx.goals` / `ctx.sessionTitle` | 定时任务 / pty / slash 命令 / goal 三件套 / 会话摘要 | ✅ 已有对应物 |
| `ctx.agentTeams`（持久 roster + 任务板 + mailbox） | 一次性子代理 + 角色 + 仲裁 | ✅ 值得借（把 subagent 从「一次性调用」升级为「可续跑的团队」） |
| `voice-input` 子系统（实验性） | 无（仅有调研文档） | ✅✅ 直接可借，见 `docs/VOICE_VIDEO_INPUT_PLAN.md` |
| `computer-use` 子系统（屏幕理解/操作） | 只有 `browser_*`（CDP）+ OCR，不能看/点本机屏幕 | ✅ 值得读 + 借（与视频输入同源） |
| `lsp` 子系统（语言服务） | `code_index` / `code_search`（关键词 + 向量），无诊断/跳转 | ✅ 编程代理的真缺口 |
| `office-to-pdf` / `deliverables` / `spill` / `token-meter` / `invariants` | 已有文档导出 / tool_audit / 结果落盘 / 预算护栏；`invariants` 无 | 🟡 按需 |

## 三、最有价值的一项：把「散落的判定」收敛成瀑布式拦截点

我们现在的 sendMessage 主循环里混着大量**本应可插拔的判定**：模式护栏、`isVagueBody` 空洞判定、
`hasToolCallIntent` 修正、工具白名单/禁用、路径白名单、审批（manual/smart/yolo）、会话放行、
审计、hooks、压缩阶梯……每加一条就改主循环，回归风险高（这个文件已经 7000+ 行）。

DSH 的做法给了现成答案：**定义三段拦截点 + 统一契约**，各机制注册进去，且**可短路、可改写**：

```
pre-step      ← 模式护栏、plan 强制、空洞检测、上下文注入（可拒绝/改写本轮输入）
pre-tool      ← 禁用工具、路径白名单、审批、模式允许集、浏览器前置守卫（可拒绝/替换参数）
post-tool     ← 结果脱敏/压缩/落盘、审计、失败台账、外部内容边界标记（可改写结果）
```

收益：新增机制 = 注册一个监听器（不再动主循环）；机制之间顺序与短路语义有统一规范；
`routing/audit/invariants` 可以挂在同一处。这与我们已有的 P1-3 生命周期钩子方向一致，是把它的**升级版**。

**「模型可见即已记录」** 配套：每次组装请求时，把「注入了什么（系统片段/记忆/RAG/工具结果）」
记成事件，并在发送前断言可重建。它直接解决我们反复踩的「上下文为什么膨胀/裁剪是否丢信息」问题。

## 四、建议的推进顺序（按价值/成本）

| 优先级 | 事项 | 说明 |
| --- | --- | --- |
| 🟢 P1 | **三段拦截点收敛**（pre-step / pre-tool / post-tool） | 结构性收益最大；先只把**已有**判定搬进去（行为不变），再逐步新增 |
| 🟢 P2 | **语音输入最小闭环**（按住说话 → 草稿 → 用户确认发送） | 方案见 `docs/VOICE_VIDEO_INPUT_PLAN.md`；调研已备（sherpa-onnx + macOS `say`） |
| 🟢 P3 | **确定性视觉层 + 视频抽帧**（Vision 原生，零下载） | 见同文档；先把「不依赖大模型就能答」的视觉问题做扎实 |
| 🟡 P4 | **会话投影层**（用量/计划/审计/子代理统一投影） | 治前后端口径漂移 |
| 🟡 P5 | **agentTeams 化子代理**（持久 roster + 任务板） | subagent 从一次性 → 可续跑 |
| 🔵 P6 | LSP 集成 / computer-use / 组合包 patch 层 / 格式版本化 | 按需 |
