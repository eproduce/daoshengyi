# Codex 开源能力研究与技能整合分析

> 研究对象：`github.com/openai/codex`（Codex CLI，Rust 工作区，研究日期 2026-08-31）
> 对照对象：道生一（Tauri 2 + Vue 3 + DeepSeek 本地优先 Agent 桌面客户端）
> 目的：分析 Codex 有哪些能力是道生一没有的，与现有能力整合，归纳为可落地的「技能」。

---

## 0. 结论速览

Codex 的核心不是某一个工具，而是一套 **「引擎 + 协议 + 策略」** 的架构。道生一在**对话体验、记忆、多 agent、知识库、可视化工作流**上已经反超 Codex，但在以下 **7 类能力**上存在明显差距，均可在不引入重型外部依赖的前提下整合为技能：

| # | 技能 | 差距本质 | 价值 | 落地难度 |
|---|------|---------|------|---------|
| S1 | 命令执行策略引擎（execpolicy） | 审批从「正则黑名单」→「规则文件引擎」 | 高 | 中 |
| S2 | 项目指令发现（AGENTS.md） | 从「全局技能」→「项目级自动发现」 | 高 | 低 |
| S3 | 技能包结构化（渐进式披露） | 从「单 prompt」→「SKILL.md + references/scripts」 | 高 | 中 |
| S4 | 会话深度操作（fork/resume/queue） | 从「归档/导出」→「分支/续聊/异步投递」 | 中 | 中 |
| S5 | 对外引擎协议（app-server 化 MCP） | 从「单进程内用」→「多客户端可调」 | 中 | 中 |
| S6 | 非交互执行（exec + JSONL） | 从「内部 chatOnce」→「对外 CLI/脚本」 | 中 | 低 |
| S7 | 交互式 PTY 进程 | 从「一次性命令」→「长驻交互进程」 | 中 | 中 |

另有 3 项「软差距」（策略化程度），见 §4.4：网络域名策略、自动代码审查、轨迹回放。

---

## 1. Codex 能力全景（基于源码）

Codex CLI 是 `codex-rs/` Rust 工作区，围绕一个核心引擎构建了多层能力。按源码组织归纳如下：

### 1.1 引擎层（codex-core）

- **Session / Turn / Step 模型**：`Session`（配置+状态）、`Turn`（一次用户输入的执行循环）、`Step`（单次工具调用）。这是「任务怎么跑」的核心抽象，支持 steer（转向）/ interrupt（打断）。
- **审批流（AskForApproval）**：所有敏感操作（命令执行、网络访问、文件写入）走统一审批协议；**审批可附带「策略修订」**（ApproveExecpolicyAmendment / NetworkPolicyAmendment），即「本次允许 + 自动写入规则文件，下次不再询问」。
- **Plan 工具**：`plan_task` / `plan_update` 式任务规划（道生一已有同类实现）。
- **AGENTS.md 发现**：`agents_md` 模块递归发现仓库内任意层级的 `AGENTS.md`（含 `AGENTS.override.md` 优先级、fallback 文件名、`project_doc_max_bytes` 剪裁），作为项目级指令注入。
- **Skills 组装**：`build_skills_and_plugins` 在每轮按「技能被显式提及（$skill 名）」加载技能指令，支持 `skills/list`、`skills/changed` 通知、额外技能根。
- **Compaction / Recap**：上下文压缩（/compact）与会话总结（/recap）——道生一已有记忆摘要，但 Codex 是「会话内」压缩。

### 1.2 执行与安全层

| 组件 | 作用 |
|------|------|
| **execpolicy** | **命令执行策略引擎**。Starlark 语法规则文件（`default.rules`），三类规则：`prefix_rule(pattern=[...], decision="allow"/"deny"/"prompt", match/not_match=示例)`、`network_rule(host, protocol, decision)`、`host_executable(name, paths)`。支持示例校验（match/not_match 反例测试）、审批后 `blocking_append_allow_prefix_rule` 持久化追加规则。 |
| **network-proxy** | 网络策略代理。按域名 allow/deny 决策、`NetworkPolicyDecider` 钩子（命令已批准则自动放行其网络）、审计。 |
| **linux-sandbox** | Linux 沙箱（bwrap + landlock 文件系统权限）。 |
| **exec-server + utils-pty** | 子进程 spawn/控制服务 + **PTY 伪终端**（交互式 REPL / dev server）。 |
| **code-exec** | 非交互无人值守执行，`--json` JSONL 事件流输出。 |
| **approval protocol** | 命令/网络审批协议化（`ExecApprovalRequest` / `NetworkPolicyRequest`）。 |

### 1.3 服务层（app-server / daemon）

- **codex-app-server**：后台引擎服务，暴露 JSON-RPC 协议（`thread/start`、`thread/resume`、`thread/fork`、`turn/start`、`turn/steer`、`turn/interrupt`、`config/read`、`account/*`、`model/list`、`skills/list`、`approvals`），**多客户端并发**（VS Code 扩展 / TUI / exec 共用同一引擎）。
- **codex-app-server-daemon**：常驻守护进程 + `enable-remote-control` 远程控制。
- **codex-mcp-server**：以 stdio 把引擎能力暴露为 MCP server（`codex mcp-server`，已标记 deprecated 转向 app-server 协议）。

### 1.4 生态层

- **plugins**：插件系统（能力注入、marketplace、`plugin/list`）。
- **skills 规范**：技能 = 文件夹（`SKILL.md` 含 YAML frontmatter name/description + 正文 + `agents/openai.yaml` UI 元数据 + `scripts/` + `references/` + `assets/`），**渐进式披露**（先只暴露 name+description 做路由，命中后才加载正文，references 按需读）。
- **models-manager**：内置模型清单响应（model/specialty、multiAgent、speed tiers、retirement 信息）。
- **auth/login**：登录认证（含 workload identity、SSO、rate limits）。
- **otel**：OpenTelemetry 遥测（logs/traces/metrics + 会话级业务事件）。
- **doctor**：`codex doctor` 诊断命令（config/auth/feature flags/磁盘/网络逐项检查 + JSON 报告）。
- **features**：特征标志（`features enable/disable`）。
- **rollout trace**：轨迹回放/调试（`debug trace reduce`）。
- **CLI 子命令**：`exec`、`review`（非交互代码审查）、`resume/fork/archive/delete/queue`（会话管理）、`login/logout`、`mcp`、`plugin`、`app`、`sandbox`、`completion`、`update`、`doctor`。

---

## 2. 道生一现状（2026-08-31 核对）

### 2.1 已具备（与 Codex 对标）

| 能力域 | 道生一实现 |
|--------|-----------|
| 流式对话 + 工具循环 | ✅ Rust SSE（request_id 防串扰）+ 方案B流式中检测 `<tool_call>`，MAX_TOOL_ROUNDS=20，空洞回复重试 |
| 终端命令执行 | ✅ `execute_command`（`/bin/sh -c` + 进程组超时杀）+ `DANGEROUS_PATTERNS` 危险命令确认 + YOLO 开关 |
| 文件系统 | ✅ read/write/list/create/delete + `apply_edits`（replace/insert/delete 三原语）+ **unified diff** + 应用内 diff 确认 |
| 验证循环 | ✅ `run_tests`（框架自动检测）+ 提示词门禁 |
| Git | ✅ `git_operation`（白名单子命令 + 拒绝破坏性参数） |
| 代码库理解 | ✅ `analyze_project` + `code_index/code_search`（Ollama 语义向量） |
| 任务规划 | ✅ `plan_task/plan_update` + TaskPlanCard 进度卡片 |
| 多 agent | ✅ `subagent_delegate/parallel` + 5 角色分工 + 汇总仲裁 + `withBrowserLock` 串行化 |
| 记忆系统 | ✅✅ **超 Codex**：FTS5 中文分词 + Ollama 向量 + 分层（episodic/semantic）+ 用户画像 + 主动记忆工具（save/recall/forget）+ 复习 + 衰减遗忘 |
| 知识库 RAG | ✅ `kb_index/kb_search`（FTS5 + 向量混合检索）+ 自动注入 |
| 技能库 | ✅ 市场 + 导入导出 + 系统提示词注入（单 prompt 形态） |
| 模式 / 人格 / 角色 | ✅ modes（6）/ personas / roles（5） |
| MCP 客户端 | ✅ stdio + 按需连接 + 插件市场 + 工具路由容错 |
| MCP 服务器 | ✅ `mcp_server.rs`（`--mcp-server` 暴露 memory/web_search 工具） |
| 权限矩阵 | ✅ `disabled_tools` / `allowed_paths`（文件路径白名单）+ 会话级权限记忆 + diff 确认 |
| 审计 + 撤销 | ✅ `tool_audit` + AuditPanel + `undo_history` + UndoBubble |
| 浏览器自动化 | ✅ Puppeteer MCP（Edge 内核、视口自动补齐、navigate 前置守卫） |
| 联网搜索 | ✅ 百度/必应/360/搜狗多源并行 + 反爬静默降级 + 相关性过滤 + 自动抓正文 |
| 可视化工作流 | ✅✅ **超 Codex**：VueFlow DAG + 条件分支 + 代码节点 + 模板 + 持久化 |
| IM 网关 | ✅✅ **超 Codex**：钉钉/飞书/企微长连接收发 |
| 全局快捷键 / 系统托盘 | ✅ |
| 用量统计 / 会话归档导出 | ✅ |

### 2.2 已有但弱于 Codex（「软差距」）

| 项 | 道生一 | Codex |
|----|--------|-------|
| 命令审批 | `DANGEROUS_PATTERNS` 正则黑名单 + 每次确认，**无持久化规则** | execpolicy 规则文件引擎，审批后自动写 allow 规则 |
| 技能形态 | 单 prompt 字符串，全量注入 | SKILL.md + references 渐进式披露，按需加载 |
| 项目指令 | 全局技能库，无项目级发现 | AGENTS.md 递归发现 + 层级优先级 |
| 会话管理 | 归档 / 导出 | fork / resume / queue（异步投递）/ archive |
| 引擎对外 | 单进程内用 + 简化 MCP server | app-server JSON-RPC + daemon + 多客户端 |
| 非交互 | 内部 `chatOnce`（子代理用） | 对外 `codex exec --jsonl` |
| 进程模型 | 一次性命令 | PTY 交互式长驻进程 |
| 网络策略 | 无域名级策略 | network-proxy 域名 allow/deny |
| 代码审查 | `code-review` prompt 技能 | `codex review` 自动 diff 审查 |
| 诊断 | 前端 debug_log | `codex doctor` 结构化诊断 |
| 遥测 | 无 | OpenTelemetry |
| 回放 | 无 | rollout trace |

---

## 3. 差距矩阵（Codex 有、道生一没有 → 技能化）

> 完整技能定义卡见 §5。此处给出差距 → 技能 → 整合基座 的映射。

| Codex 能力 | 道生一缺口 | 归纳技能 | 现有可复用基座 |
|-----------|-----------|---------|---------------|
| execpolicy 规则引擎 | 无持久化命令/网络策略 | **S1 命令执行策略引擎** | `execute_command`、`DANGEROUS_PATTERNS`、`tool_audit` |
| AGENTS.md 项目指令 | 无项目级指令发现 | **S2 项目指令发现** | 技能库注入点、`analyze_project`、`withCurrentDate` 注入机制 |
| Skills 渐进式披露 | 技能是单 prompt | **S3 技能包结构化** | SKILL_CATALOG、SkillManager、getMcpToolsPrompt |
| thread fork/resume/queue | 无分支/续聊/异步投递 | **S4 会话深度操作** | conversations/messages 表、ChatHistory、归档导出 |
| app-server 协议 | 对外接口简单 | **S5 引擎协议外化** | mcp_server.rs、chat store 的 sendMessage |
| exec --jsonl | 无对外非交互 CLI | **S6 非交互执行** | chatOnce、runSubagentLoop |
| PTY | 命令无交互 | **S7 交互式 PTY** | execute_command、run_shell_command |
| network-proxy 域名策略 | 无网络域名白名单 | S8 网络域名策略（可选） | search.rs、fetch_page、permissions.ts |
| review 自动审查 | 无 diff 审查工具 | S9 自动代码审查（可选） | git diff、run_tests、roles verifier |
| rollout trace | 无轨迹回放 | S10 会话轨迹回放（可选） | tool_audit、undo_history |
| doctor | 诊断分散 | S11 结构化诊断（可选） | HealthPanel、system_diagnostics |

---

## 4. 整合思路（总原则）

1. **不重造轮子**：Codex 是「终端 + 单模型 + 单工作区」定位；道生一是「桌面 + 多模型 + 记忆/知识库/工作流」定位。只吸收**机制**（策略引擎、项目指令、渐进披露、协议外化），不复刻终端交互。
2. **贴合现有分层**：道生一已有清晰的「内置工具（BUILTIN_TOOLS）+ 技能（SKILL_CATALOG）+ 模式（MODES）+ 角色（ROLES）」四层技能体系，新能力按层归位：
   - 需要**后端能力**的 → 新增 Rust 命令 + 内置工具（S1/S4/S5/S6/S7/S8/S9）
   - 需要**内容/知识**的 → 新增技能/指令（S2/S3）
   - 需要**界面**的 → 新增设置 Tab / 面板（S1/S4/S10/S11）
3. **安全优先**：S1/S8 是安全强化，落地时保持「默认保守、审批可写规则」。
4. **国产/本地优先**：全部不依赖国外服务，不新增重型依赖（PTY 用 portable-pty，规则引擎用自研轻量解析）。

---

## 5. 技能归纳（核心交付）

> 每个技能按道生一的「技能体系」定义：目标 / 触发场景 / 依赖能力 / 整合实现 / 优先级。
> 优先级：🟢 立即（1-2 周）· 🟡 近期（2-4 周）· 🔵 远期。

### S1 🟢 命令执行策略引擎（execpolicy 技能）

- **目标**：把命令审批从「正则黑名单 + 每次确认」升级为「规则文件引擎 + 持久化学习」。
- **触发**：agent 请求执行命令时；用户希望「这个命令以后不用再问」时。
- **依赖**：现有 `execute_command`、`DANGEROUS_PATTERNS`、`tool_audit`。
- **整合实现**：
  1. Rust 新建 `execpolicy` 模块 + 规则文件（`app_data/execpolicy.rules`），规则格式简化自 Codex（不引 Starlark，用自研轻量解析器，避免重型依赖）：
     ```
     allow  git status        # prefix 匹配，allow
     deny   rm -rf            # 任何 rm -rf 拒绝
     prompt sudo              # 需用户确认
     network allow github.com # 域名白名单（供 S8 复用）
     ```
  2. `execute_command` 执行前走 `evaluate_command(cmd)` → 决策 allow/deny/prompt。
  3. **审批后自动追加规则**：用户在某次确认时勾选「本次会话内不再询问」→ 可选「持久化允许此命令前缀」→ 追加 `allow <prefix>` 到规则文件（复用 undo 思路，规则文件也可从 AuditPanel 回滚）。
  4. 设置新增「命令策略」Tab：查看/编辑规则文件、测试某条命令的决策、导入导出。
  5. 规则引擎提取纯函数 + 单测（allow/deny/prompt 决策、前缀匹配、示例反例）。
- **与现有整合点**：替换 `judgeCommandSafety` 的黑名单逻辑；`tool_audit` 记录「命中的规则」；YOLO 模式 = 全部按 allow 处理。

### S2 🟢 项目指令发现（AGENTS.md 技能）

- **目标**：让 agent 自动读取当前项目/工作区的「项目指令文件」，获得编码约定、测试命令、目录说明。
- **触发**：会话切换到某项目目录（workspace/cwd）时；用户要求「按这个项目的规范来」时。
- **依赖**：现有技能注入点（`withCurrentDate` / volatileCtx 注入机制）、`analyze_project`。
- **整合实现**：
  1. 约定文件名：`AGENTS.md` 与 `道生一.md`（二者取一，`AGENTS.md` 优先），支持在项目任意层级（从 cwd 向上找，就近优先）。
  2. 前端 utils `agents-md.ts`：`discoverProjectInstructions(cwd)` 纯函数（向上递归找 + 读取 + 大小剪裁 ≤8KB）→ 注入到 volatileCtx（每次会话注入一次）。
  3. 与技能库联动：项目指令可声明 `skills:` 清单（指定要用哪些技能），注入时附带。
  4. 提示词说明「项目指令优先于通用约定」。
  5. 新增「项目指令」面板/设置项：查看当前项目命中的指令、手动指定指令文件。
- **价值**：把「技能库是全局的」补上「项目级」维度，这是 Codex AGENTS.md 的核心价值。

### S3 🟡 技能包结构化（渐进式披露技能）

- **目标**：把技能从「单 prompt 字符串」升级为「技能包（SKILL.md + references + 可选 scripts）」，按需加载、渐进式披露。
- **触发**：技能体系整体升级；新增需要附带参考资料/脚本的复杂技能时。
- **依赖**：SKILL_CATALOG、SkillManager、getMcpToolsPrompt。
- **整合实现**：
  1. `SkillCatalogItem` 扩展：`frontmatter: { name, description, when_to_use }`、`references?: { id, title, content }[]`、`scripts?: { name, path }[]`。
  2. 注入机制改为 Codex 式**渐进披露**：主提示词只列技能「名称+一句话描述+何时用」（路由信息）；模型在回复中显式提及 `$技能名` 或判断适用时，才把该技能正文 + 相关 references 加载进上下文。
  3. `chat.ts` 新增 `loadSkillDetail(id, refIds?)`：命中后注入正文与指定 references（控制 token）。
  4. SkillManager 支持「技能包」导入导出（目录结构 ZIP/JSON）。
  5. 迁移现有 SKILL_CATALOG 条目为技能包形态（prompt 变正文，长内容拆 references）。
- **价值**：解决「技能一多，全量注入挤爆上下文」的问题；参考 Codex `SkillInstructions`/`SKILL.md` 规范。

### S4 🟡 会话深度操作（fork / resume / queue 技能）

> **进度：fork ✅ 已完成（2026-08-31）**——db.rs `fork_conversation`（全量复制 / 指定消息截断分支）+ `fork_conversation_cmd` + store `forkConversation` + ChatHistory「分支」按钮 + ChatMessage 用户消息「从此分支」按钮（Rust 测试 68 全绿）。resume / queue 待做。

- **目标**：补上会话级深度操作——分支（fork）、续聊（resume）、异步投递（queue）。
- **触发**：用户想「从这条消息另起一个分支」；「上次那个会话继续」；「把这条任务投给某个会话后台跑」。
- **依赖**：conversations/messages 表、ChatHistory、会话归档导出。
- **整合实现**：
  1. **fork**：`fork_conversation(id, atMessageId)` Rust 命令——复制会话与消息，在指定消息处截断，生成新会话。
  2. **resume**：`resume_conversation(id)` 加载历史并重设上下文（现有 sendMessage 已支持历史续聊，补一键入口）。
  3. **queue（异步投递）**：`queue_turn(conversationId, text)`——把一条消息投给后台会话执行（复用 subagent 后台执行模型），结果回到会话并通知；类似 Codex `codex queue`。
  4. ChatHistory 增加「fork」「投递」按钮；会话上下文菜单。
- **价值**：把「聊天历史」升级为「可编排的会话工作区」；queue 与 IM 网关联动可实现「微信里给某个会话发任务」。

### S5 🟡 引擎协议外化（app-server 化 MCP 技能）

- **目标**：把道生一的引擎能力以**完整协议**暴露给外部客户端（命令行、脚本、其他应用），而非仅简化工具列表。
- **触发**：外部程序想调用道生一能力（如 VS Code 扩展、CI 脚本、Claude Desktop）时。
- **依赖**：mcp_server.rs、chat store 的 sendMessage/stopStreaming。
- **整合实现**：
  1. 升级 `mcp_server.rs`：在现有 tools 之外，增加 Codex app-server 式 RPC（复用 JSON-RPC 基建）：
     - `thread/start`、`thread/resume`、`thread/fork`（对应 S4 会话操作）
     - `turn/start`、`turn/interrupt`（复用 sendMessage / cancel_stream）
     - `config/read`（读 active profile）、`skills/list`
     - `approvals`（外部审批请求回调，供自动化场景）
  2. 支持 `daoshengyi --app-server` 常驻模式（stdio），供外部客户端连接。
  3. 文档化协议（参考 `docs/IM_GATEWAY.md` 风格写 `docs/APP_SERVER_PROTOCOL.md`）。
- **价值**：把「单窗口应用」变成「可被编排的引擎」，是 Codex app-server/daemon 的精华。

### S6 🟡 非交互执行（exec 技能）

- **目标**：提供 `daoshengyi exec "prompt" [--jsonl]` 类对外非交互入口，供脚本/自动化复用引擎能力。
- **触发**：脚本/CI/自动化调用道生一；用户想「不打开窗口跑一个任务」。
- **依赖**：chatOnce、runSubagentLoop。
- **整合实现**：
  1. main.rs 加 `exec` 子命令（复用现有 `--mcp-server` 的入口模式）。
  2. 复用 `chatOnce` 非流式执行，输出最终消息；`--jsonl` 输出事件流（turn 开始/工具调用/完成）。
  3. 组合 S5：`exec` 可后台连常驻引擎（app-server），也可独立进程。
- **价值**：把引擎从「UI 独占」解放为「可脚本化」，配合 cron / 定时任务使用。

### S7 🟡 交互式 PTY 进程

- **目标**：让 `execute_command` 支持**交互式长驻进程**（dev server、REPL、watch、数据库 CLI），而非仅一次性命令。
- **触发**：agent 需要启动 dev server、进入 REPL、或与长驻进程交互时。
- **依赖**：execute_command、run_shell_command。
- **整合实现**：
  1. Rust 引入 `portable-pty`（轻量、跨平台），新增 `spawn_pty(command, cwd)` + `pty_write(id, input)` + `pty_read(id)` 命令。
  2. 前端新增「终端面板」视图（叠加在对话区或独立 Tab）：流式回显、可输入。
  3. 与现有「长任务防休眠」（caffeinate）联动。
- **价值**：补齐 Codex exec-server + PTY 能力，让 agent 能真正「养一个服务」并观察输出。

### S8 🔵 网络域名策略（可选，安全强化）

- **目标**：为 `fetch_page` / `web_search` / 浏览器 / 主动推送等出站请求加域名级 allow/deny 策略。
- **触发**：安全敏感场景；用户想限制 agent 能访问的域名。
- **整合实现**：`permissions.ts` 扩展域名白名单 + search.rs/api.rs 请求前域名校验 + 设置「网络策略」Tab（可复用 S1 的 network 规则）。
- **价值**：补 Codex network-proxy 的决策能力（不引代理，只做请求前拦截，够用）。

### S9 🔵 自动代码审查（review 技能）

- **目标**：内置 `run_review` 工具——git diff → LLM 审查 → 结构化发现列表（严重度/位置/建议），配合验证循环。
- **整合实现**：复用 `git_operation(diff)` + chatOnce（review 路由模型）+ 格式化输出；与 roles `reviewer` 角色复用。
- **价值**：把「code-review」从被动技能变主动工具。

### S10 🔵 会话轨迹回放（trace 技能）

- **目标**：把 `tool_audit` 升级为「可回放」的轨迹（按会话时间线重放每步工具调用 + 结果 + 决策）。
- **整合实现**：AuditPanel 加「按会话时间线回放」视图；复用 undo_history 数据。
- **价值**：补 Codex rollout trace 的调试价值。

### S11 🔵 结构化诊断（doctor 技能）

- **目标**：`codex doctor` 式一键诊断——把 HealthPanel/system_diagnostics 升级为「结构化诊断报告 + 导出 JSON」。
- **整合实现**：聚合现有 system_diagnostics / 记忆维护状态 / MCP 连接 / 配置健康检查。

---

## 6. 道生一的差异化优势（反哺方向）

这些是 Codex **没有**、道生一独有的能力，应作为产品差异化重点保持：

1. **长期记忆系统**：FTS5 中文分词 + Ollama 向量混合检索 + 分层（episodic/semantic）+ 用户画像 + 主动记忆工具 + 复习/衰减——Codex 无跨会话事实记忆。
2. **可视化工作流**：VueFlow DAG 编辑器 + 条件分支/代码节点/模板/持久化/运行历史——Codex 无图形化编排。
3. **IM 网关**：钉钉/飞书/企微长连接双向收发 + 主动推送——Codex 无任何 IM 集成。
4. **多源国产搜索**：百度/必应/360/搜狗并行 + 反爬静默降级 + 自动抓正文。
5. **多 agent 协作**：并行子代理 + 5 角色分工 + 仲裁 + 浏览器锁——Codex 的子代理受控更严。
6. **多模式 / 人格 / 角色三层正交体系**：模式（怎么做）× 人格（我是谁）× 角色（子代理）——Codex 无。
7. **撤销操作 + 会话级权限记忆**：任意文件操作可回滚，审批可「本会话记住」。
8. **本地优先 + 国产模型**：DeepSeek、无国外依赖。

---

## 7. 建议落地顺序

```
第一批（🟢，独立、高价值、低风险）
  S1 命令执行策略引擎  →  替换现有 DANGEROUS_PATTERNS 审批
  S2 项目指令发现      →  新增 AGENTS.md/道生一.md 注入

第二批（🟡，需要一些 UI 与协议工作）
  S4 会话深度操作      →  fork/resume/queue
  S6 非交互执行        →  exec 子命令
  S7 交互式 PTY        →  portable-pty + 终端面板

第三批（🟡~🔵，重一点）
  S3 技能包结构化      →  技能系统整体升级（渐进式披露）
  S5 引擎协议外化      →  app-server 化 MCP 协议
  S8~S11（可选）       →  网络策略 / 自动审查 / 回放 / 诊断
```

**配套文档**：落地时参考本文件 §5 的技能定义卡；`DEVELOPMENT_PLAN.md` 的编程代理路线（P-A*/P-M*）可直接承接 S1/S2/S4/S6/S7。

---

## 附：研究方法与依据

- 调研源：`github.com/openai/codex`（`codex-rs/` 工作区）关键源码与 README：
  - `core/src/exec_policy.rs`、`execpolicy/src/{parser,policy,amend}.rs`（S1 依据）
  - `core/src/agents_md_tests.rs`、`protocol/src/prompts/base_instructions/default.md`（S2 依据）
  - `ext/skills/src/{loader,host_prompt,fragments}.rs`、`skills/src/assets/samples/skill-creator/SKILL.md`、`app-server/README.md`（S3/S5 依据）
  - `cli/src/main.rs`（子命令全景）、`app-server/README.md`、`app-server-daemon/README.md`（S4/S5/S6 依据）
  - `exec/src/lib.rs`（JSONL 输出）、`exec-server/README.md`、`network-proxy/README.md`（S6/S7/S8 依据）
- 道生一现状核对：`docs/DEVELOPMENT_PROGRESS.md`、`docs/ROADMAP.md`、`src/data/builtin-tools.ts`、`src-tauri/src/lib.rs`、`src-tauri/src/mcp_server.rs`。
- 本文件由 2026-08-31 会话生成，已与代码核对。
