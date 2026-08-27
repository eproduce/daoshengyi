# 道生一 · 开发计划

> 本文件是**当前可执行的开发计划**（现状 + 积压 + 待办功能），配套《开发进度》`DEVELOPMENT_PROGRESS.md` 记录已完成工作，愿景方向见 `ROADMAP.md`。
>
> **最后更新：2026-08-27**（已与代码核对：P-A1~P-A9/P-A12、P-M1~P-M4 全部完成；§4 A~H 全部落地；§3 长期记忆补全；Phase 3 知识库 RAG + 语义向量、可视化工作流（含条件分支/代码节点）+ Phase 5 系统托盘落地）

---

## 0. 项目速览

| 项 | 值 |
|----|----|
| 技术栈 | Tauri 2 + Vue 3 + TypeScript + Pinia |
| Rust 后端 | reqwest / tokio / rusqlite(bundled) / aes-gcm / chrono / futures |
| 存储 | SQLite（conversations / messages / memory_* / app_settings / tool_audit） |
| 密钥 | AES-256-GCM，密钥文件 `secret.key`（0600）于 app_data_dir |
| 定位 | 本地优先 + 国产模型（DeepSeek）的 AI Agent 桌面客户端 |
| 远程 | `https://github.com/eproduce/daoshengyi` 分支 main |
| 测试 | `npm test`（前端 84 项）· `cargo test --lib`（Rust 40 项）· `vue-tsc --noEmit` |

---

## 1. 已完成能力（截至 2026-08-18）

| 模块 | 说明 |
|------|------|
| 流式对话 | Rust SSE + 行缓冲器（修复分块丢字） |
| ReAct 工具循环 | 自动工具调用 + 结果回注 |
| MCP 客户端 | stdio + JSON-RPC 2.0，插件市场，按需连接（浏览器类按需激活） |
| Skills 技能库 | 市场 + 导入导出 + 系统提示词注入（8 模板） |
| 记忆系统 | 摘要压缩 + 事实提取 + 关键词/语义检索（DeepSeek 无 embeddings 则跳过） |
| API Key 加密 | AES-256-GCM + 密钥文件（0600） |
| 动态模型获取 | 启动拉取厂商模型列表并持久化回填 |
| `/run` 终端命令 | 工作区 cwd 执行 + 超时守卫（kill_on_drop）+ 危险命令检测 |
| `/read` 文件读取 | Rust `read_file` 读取本地文件供 AI 分析 |
| 危险命令检测 | `DANGEROUS_PATTERNS`（rm -rf / sudo / mkfs / dd / fork bomb 等） |
| 审计日志 | `tool_audit` 表 + `list_tool_audit` |
| Token/费用统计 | DeepSeek 官方人民币价格表（输入命中/未命中/输出） |
| 内置工具 | `fetch_page`（网页→纯文本）、`web_search`、`describe_image`、`ocr_image` |
| Ollama 集成 | 一键部署 + 本地视觉/OCR |
| 缓存命中率 | 流式 SSE 末尾 usage 统计（cache_hit / cache_miss） |
| UI | IM 气泡布局 + AppLogo 品牌头像 + 主题变量 |
| 数学公式渲染 | KaTeX（自建 marked 扩展 `katex-marked.ts`），`$...$` / `$$...$$` / `\(...\)`，兼容中文紧贴 |
| 中文菜单栏 | 6 菜单（道生一/文件/编辑/视图/窗口/工具）+ `menu://action` 事件分发 + 关于弹窗 |
| 消息宽度 | 内容容器自适应（`min(100%-48px, 1400px)`），减少全屏空白 |
| 图标统一 | `AppLogo` 与 Dock 图标同源造型，颜色随明暗主题切换 |

---

## 2. 近期积压（✅ 已全部收尾）

### 2.1 Puppeteer MCP env 支持（✅ 已完成，2026-08-25 确认收尾）
- **目的**：server-puppeteer 需 Chrome/Chromium；旧版 Chrome for Testing 在 macOS 26 被系统 SIGKILL（`spawn error -88`），改用本机 **Microsoft Edge**（`PUPPETEER_EXECUTABLE_PATH`）。
- **完成项**（全链路已实现并推送，核心提交 `0930eda`）：
  - `src-tauri/src/mcp.rs`：`McpServerConfig` 加 `env: HashMap<String,String>`；spawn 时 `cmd.envs`
  - `src-tauri/src/lib.rs`：`mcp_connect` 加 `env` 参数
  - `src/api/appSettings.ts`：`McpServerPersist` 加 `env?`
  - `src/stores/mcp.ts`：接口/`save`/`connect`/`connectByName` 透传 env；`applyPuppeteerEnv` 迁移自动补 Edge 路径
  - `src/data/mcp-catalog.ts`：`McpCatalogItem` 加 `env?`；puppeteer 条目加 `env: { PUPPETEER_EXECUTABLE_PATH: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" }`
  - `src/components/McpSettings.vue`：编辑表单支持 env（文本 `KEY=VALUE` 多行），`openAdd/openEdit/save/installPlugin` 处理 env
- **验证**：`npm test`（35 项）+ `npx vite build` + `cargo check` 通过；已推送 GitHub

### 2.2 日期幻觉 + 编造数据 bug（用户 2026-08-17 报告，**已修复**，见进度文档 08-17）
- 现象：模型日期幻觉；未调用工具时编造数据（如天气）
- 修复要点：
  - `withCurrentDate`（chat.ts）强调"唯一可信日期来源，回答前先核对，严禁编造训练数据日期"
  - `volatileCtx`【当前时间】补全完整日期（年月日 + 星期 + 时分）
  - `getMcpToolsPrompt` 新增「强制要求（实时/时效信息）」——实时数据必须先调 `web_search`/`fetch_page`，拿不到明确说「无法获取」，严禁编造
- 验证：`vite build` + `npm test`（30 项）通过，已推送

---

## 3. 长期记忆功能开发计划（2026-08-25 新增；Phase 1/2/3 大部已完成，2026-08-26 核对）

> 目标：让 Agent **跨会话**记住用户偏好 / 事实 / 决策 / 待办，对话时自动检索注入；记忆可持续累积、可管理、可遗忘。基于现有 `memory_facts` / `memory_summaries` 基础设施增强，不引入重型外部依赖。

### 3.1 现状盘点（已有基础）

- **已实现**：事实提取（LLM 输出 JSON → `memory_facts`）、长对话摘要压缩（`memory_summaries`）、关键词检索（`LIKE`）、向量检索（embedding 存 BLOB + 余弦，DeepSeek 无 embeddings 端点则跳过）、偏好注入（`get_preferences`）、记忆 touch/遗忘命令（`touch_fact` / `prune_facts`）
- **短板**：
  1. **语义检索在 DeepSeek 下不可用**（无 embeddings 端点）→ 只剩关键词 `LIKE`，跨会话召回质量差（长期记忆最大短板）
  2. **无事实去重 / 合并** → 同义事实重复堆积，越积越多
  3. **遗忘不自动**：`prune_facts` 仅命令存在，未被调度
  4. **注入策略粗糙**：检索结果无权重排序、无 token 剪裁
  5. **无记忆管理 UI**：记忆不可见、不可编辑
  6. **用户画像弱**：`preference` 仅普通 fact，无跨会话沉淀

### 3.2 Phase 1 — 记忆内核增强（数据层，🟢）

> **状态：1.1 / 1.2 / 1.3 / 1.4 / 1.5 全部完成（2026-08-27 核对）**

| # | 任务 | 状态 | 说明 |
|---|------|------|------|
| 1.1 | 事实去重与合并 | ✅ | `save_fact` 前字符集 Jaccard 相似度（>0.62 + 长度比惩罚）检测近似重复 → 合并：累加 importance（上限 10）、文本取更长、复用原 id；`mcp_server` memory_save 与前端 extractFacts 均反馈合并状态 |
| 1.2 | 记忆衰减与遗忘调度 | ✅ | 新增 `maintain_facts`：>45 天未访问非 preference 的 importance 降 1（最低 1）；importance≤2 且 60 天未访问的删除；清理孤儿 FTS 行。lib.rs 后台线程启动即跑 + 每 6 小时检查；`prune_facts` 命令复用 |
| 1.3 | FTS5 全文索引 | ✅ | `memory_facts_fts` FTS5 虚拟表（rowid 关联）；中文 unigram 分词（`cjk_terms`）+ 英文小写词；`search_facts` 改为 FTS5 bm25 × importance × recency 加权 + LIKE 兜底；`Database::new` 对旧库幂等回填索引；save/delete 同步维护 |
| 1.4 | 记忆分层 | ✅ | episodic（会话摘要）+ semantic（事实）双库明确 + **跨会话主题汇总（episodic 聚合层）**：`memory_episodic` 表（title/summary/source_summary_ids）+ `aggregateEpisodic`（LLM 提炼跨会话反复出现的主题，已汇总摘要记入来源避免重复）+ MemoryPanel「跨会话汇总」按钮与主题列表 |
| 1.5 | 用户画像沉淀 | ✅ | `getUserProfile()` 聚合 preference+高重要度身份/环境信息，每次对话稳定注入；MemoryPanel 用户画像高亮区块 |

### 3.3 Phase 2 — 检索与注入（Agent 侧，🟡）

> **状态：2.1 ✅（含 Ollama 本地 embedding，P-A6）、2.4 ✅（2026-08-25）；2.2 ✅（2026-08-27 来源标注 + 条数/token 剪裁）；2.3 ✅（2026-08-27 触发门槛）**

| # | 任务 | 状态 | 说明 |
|---|------|------|------|
| 2.1 | 混合检索 | ✅ | FTS5 关键词（1.3）+ 意图关键词扩展（LLM 提取核心词，空结果时重试）+ **Ollama 本地 embedding 语义向量（P-A6：`ollama_embed` + `search_by_embedding` 余弦）** |
| 2.2 | 排序与剪裁 | ✅ | search_facts 按 bm25×importance×recency 加权 + **注入条数（memoryRecallLimit）/token 剪裁 + 来源标注（formatMemoriesBlock）** |
| 2.3 | 写入策略优化 | ✅ | 对话结束异步提取 + **重要性门槛（<3 不存）+ 触发门槛（shouldExtractMessages：对话过短/内容过少跳过提取）+ 失败静默** |
| 2.4 | 主动记忆工具 | ✅ | `memory_save` / `memory_recall` / `memory_forget` 内置工具（app）+ 提示词「长期记忆使用要点」区块；memory_save 自动走去重合并；memory_recall 走 FTS5 检索；memory_forget 按关键词删除 |

### 3.4 Phase 3 — 记忆 UI 与管理（🔵）

| # | 任务 | 说明 |
|---|------|------|
| 3.1 | 记忆管理面板 | ✅ | 已完成：查看/筛选/删除/编辑（update_fact）+ 用户画像区块 + 会话摘要 + 执行维护 + **全文搜索框（本地过滤）** + **智能复习（P-A9：LLM 合并过时/矛盾/重复事实）** |
| 3.2 | 记忆配置 | 开关（启用记忆）、检索条数、遗忘阈值（AppSettings + 设置 tab） |
| 3.3 | 记忆可视化 | 用户画像卡片、遗忘候选提示、记忆来源标注 |

### 3.5 Phase 4 — 增强（远期）

| # | 任务 | 状态 | 说明 |
|---|------|------|------|
| 4.1 | 本地语义检索 | ✅ | 已接入 Ollama 本地 embedding（`nomic-embed-text`，P-A6）：`ollama_embed` 命令 + `embed-provider` 判定 + 记忆向量余弦检索；未部署时静默回退 FTS5 |
| 4.2 | 记忆复习 | ✅ | 已实现（P-A9）：`reviewMemories` + 记忆面板「智能复习」按钮，LLM 合并过时/矛盾/重复事实 |
| 4.3 | 跨设备同步 | ⬜ | 远期（需云端账号/服务器） |

### 3.6 关键技术点 / 坑

- **DeepSeek 无 embeddings**：语义检索不依赖它——已接入本地 Ollama `nomic-embed-text`（P-A6）补齐；未部署时静默回退 FTS5；记忆检索已有 15s 超时兜底（`Promise.race`），不阻塞主对话
- **FTS5 中文分词**：SQLite 内置 `unicode61` 对中文按整串切词，需自定义 unigram tokenizer（建表时 `tokenize=...` 指定）
- **去重成本**：LLM 逐条去重贵 → 先文本相似度低阈值合并，LLM 复核仅用于高歧义
- **注入约束**：保持短（≤N 条 / ≤X token），避免污染上下文

---

## 3.7 编程代理能力路线（源自 ROADMAP，长期规划，2026-08-25 整合）

> 目标：把道生一从「聊天 + 工具代理」推进为「能理解代码库、编辑多文件、跑测试修复、操作 Git」的**编程 Agent**（对标 Codex）。以下均为 ROADMAP 中**尚未实现**的项，按优先级与前置依赖排序，逐步落地。

| # | 功能 | 状态 | 优先级 | 前置依赖 | 说明 / 实现要点 |
|---|------|------|--------|----------|------------------|
| P-A1 | **Git 集成** | ✅ | 🟢 | 无 | `git_operation` 命令（git CLI 子进程，零新依赖）+ 内置 `git` 工具；白名单子命令 + 拒绝危险参数（validate_git_operation 纯函数 + 测试）；status/diff/log/branch/add/commit/pull/push/checkout |
| P-A2 | **验证循环** | ✅ | 🟢 | `/run`（已有） | `run_tests` 命令（自动检测 package.json→npm test / Cargo.toml→cargo test / pyproject→pytest，可显式覆盖）+ 前端 `run_tests` 工具返回结构化结果（框架/命令/通过或失败/失败项摘要）；提示词「验证循环」门禁：改代码必跑测试、失败必修复直至通过 |
| P-A3 | **代码库索引/理解** | 🟡 | 🟢 | list_dir（已有） | ✅ 已做：`analyze_project` 命令（技术栈识别 Rust/TS/Python/Vue、manifest 包名+scripts、源码按扩展名统计、顶层结构跳过 node_modules/.git/target）+ 前端工具；⬜ 待做：语义索引/「自然语言找代码」/符号跳转 |
| P-A4 | **多文件编辑 + diff** | ✅ | 🟢 | P-A3 | `apply_edits` 命令（replace/insert/delete 三原语 + occurrence 定位 + 主目录安全边界 + **preview 参数：只算 diff 不写盘**）+ 行级 LCS **unified diff** 返回；前端内置工具 replace_string / insert_string / create_file / delete_file；**应用内 diff「确认后应用」UI（2026-08-27）**：设置「文件编辑需确认」开启后，编辑/删除类工具先调 apply_edits(preview=true) 拿 diff → `DiffConfirmDialog` 弹窗展示（diff 高亮 + 路径 + 应用/拒绝，点停止自动拒绝）→ 确认后才写盘；`create_file` 防误覆盖、`delete_file_agent` 仅删主目录文件 |
| P-A5 | **任务规划增强（Plan 模式）** | ✅ | 🟢 | 无 | 内置 `plan_task`（创建/替换计划：标题+有序子步骤）+ `plan_update`（逐步标记 doing/done/failed）；对话区顶部实时进度卡片（进度条+步骤状态徽标+完成计数，可手动关闭）；与工具循环结合 Plan→Act→Observe→修正（提示词「任务规划规范」引导复杂任务先分解、逐步更新、全部完成后再给最终答案）；新对话自动清空计划。简单任务不触发 |
| P-A6 | **本地语义 embedding** | ✅ | 🟡 | 记忆（已有） | 接入 Ollama 本地 embedding（`nomic-embed-text`）：Rust `ollama_embed` 命令（/api/embed，服务未运行/模型未装时快速失败不自动下载）；前端 `generateEmbedding` 对 DeepSeek（无 embeddings 端点）主模型改用本地 Ollama 补语义，向量存 `set_fact_embedding` + `search_by_embedding` 余弦检索；未部署 nomic-embed-text 时静默回退 FTS5 |
| P-A7 | **权限矩阵（工具级）** | ✅ | 🟡 | approval_mode（已有） | AppSettings 加 `disabledTools`/`allowedPaths`；前端 `isToolDisabled`/`isPathAllowed` 纯函数拦截（callMcpTool/callBuiltinTool 双入口）；设置「权限」tab 配置禁用工具 + 路径白名单（每行一个，@change 即时保存） |
| P-A8 | **沙箱** | ✅ | 🟡 | 无 | 文件层白名单沙箱：Rust `path_within_any`（组件级前缀匹配防误判）/`parse_allowed_paths`（~ 展开）纯函数 + `sandbox_allowed_paths`/`sandbox_file_path`；`read_file`/`write_file_agent` 加 `db: State` 应用白名单（未配置时 read 保持原行为、write 仍主目录边界）；命令层 `DANGEROUS_PATTERNS` 已有 + P-A7 前端门禁兜底 |
| P-A9 | **记忆复习** | ✅ | 🔵 | 记忆（已有） | `memory.ts reviewMemories`：LLM 回顾记忆库（list_facts → buildReviewPrompt → parseReviewActions），删除过时/矛盾/重复事实，merge 时目标重要度 +1；记忆面板「智能复习」按钮（手动触发，配 API 才可用）；纯函数 buildReviewPrompt/parseReviewActions 可测试 |
| P-A10 | **插件/技能生态** | ⬜ | 🔵 | 技能库/MCP（已有） | 第三方技能/工具上传、评分、分享；版本管理与自动更新 |
| P-A11 | **跨设备同步** | ⬜ | 🔵 | 无 | 记忆/技能/配置跨设备同步 |
| P-A12 | **多模型路由** | ✅ | 🔵 | Ollama（已有） | AppSettings 加 `modelRouting`（任务类型→Profile id）；`routeProfileId` 纯函数（routing[taskType]→辅助模型→主模型）；`getRoutedAuxConfig(taskType)`：子代理走 coding 路由、记忆摘要/提取/关键词/复习走 summarize 路由；设置「模型路由」配置（摘要/编程两个下拉） |

**推进状态（2026-08-26）**：P-A1 → P-A2 → P-A3 → P-A4 → P-A5 → P-A6 → P-M1~P-M4 → P-A7/P-A8 → P-A9 → P-A12 **全部完成 ✅**；剩余 P-A10（插件生态，需社区后端）、P-A11（跨设备同步，需云端）为远期。

---

## 3.8 多 agent 协作路线（2026-08-26 新增）

> 背景决策：道生一已具备内置编码能力（P-A1~P-A5），外部编码 Agent（Claude Code / Codex）委派**降级为隐藏兜底**（见 §4 计划功能 H 项与 ROADMAP §4.5 退役路线），研发重心转向**内置多 agent 协作**，终局为零外部编码依赖。

| # | 功能 | 状态 | 优先级 | 前置依赖 | 说明 / 实现要点 |
|---|------|------|--------|----------|------------------|
| P-M1 | **子代理带工具** | ✅ | 🟢 | subagent_delegate（已有） | 让子代理不仅能对话，还能调内置工具（git/编辑/测试/搜索/记忆）；子代理用完整工具循环（复用 sendMessage 的工具执行链路），独立上下文 + 独立工具结果，不再只是纯 chat_once |
| P-M2 | **并行子代理** | ✅ | 🟢 | P-M1 | 多个子代理并发执行（前端 `subagent_parallel` 工具，信号量并发池默认≤4）；主代理分发子任务后并行收集结果（结果按原顺序汇总）；可视化面板同时显示各子代理状态；共享状态竞争处理：浏览器操作 `withBrowserLock` 串行锁 + `refreshMcpTools` 单飞 |
| P-M3 | **角色分工** | ✅ | 🟡 | P-M2 | 面向任务的 agent 角色模板（规划者 planner / 执行者 executor / 验证者 verifier / 评审者 reviewer / 研究助手 researcher），各自系统提示词 + **工具集约束**（提示词只展示允许工具 + runSubagentLoop 执行层强制拦截不允许工具，双保险） |
| P-M4 | **主代理汇总仲裁** | ✅ | 🟡 | P-M3 | `subagent_parallel` 支持 `synth=true`：并行完成后用评审角色做**汇总仲裁**（冲突消解/交叉验证/统一呈现，失败回退普通汇总）；主代理系统提示加「多子代理结果仲裁规范」（冲突时明确冲突点/评估依据/给出判定/统一呈现） |

---

## 3.9 Phase 3/5 落地（2026-08-27）

| 项 | 状态 | 说明 |
|---|------|------|
| 知识库 RAG（Phase 3 部分） | ✅ | `kb_chunks` 表（含 `embedding BLOB`）+ `kb_chunks_fts`（FTS5 unigram）；Rust `kb_index`（扫描 md/txt/代码/PDF，`chunk_text` 分块 800 字符、P-A8 沙箱白名单、重建式；异步批量调用 `ollama_embed` 生成分块 embedding，Ollama 不可用时回退纯关键词）、`kb_search`（**混合检索 `kb_search_hybrid`：FTS5 关键词 bm25 在前 + 语义向量余弦补充召回**）、`kb_list`/`kb_delete`；前端内置工具 `kb_index`/`kb_search`/`kb_list` + 提示词 |
| 系统托盘（Phase 5 部分） | ✅ | Cargo 开 `tray-icon` feature；`TrayIconBuilder`（**macOS 模板图 `tray-icon.png` + `icon_as_template`** 自动适配深浅菜单栏；左键切换窗口、菜单新建对话/退出） |
| 可视化工作流编辑器（Phase 3） | ✅ | 依赖 `@vue-flow/core`；`workflow-engine.ts` 纯 DAG 引擎（topoSort 环检测 / renderTemplate `{{id}}` 占位 / executeWorkflow，runtime 注入可测）；节点类型 text/llm/tool/**condition（条件分支：安全布尔表达式求值器 `evalCondition`，支持 `{{id}}`/裸节点id/字符串/数字 + `== != > < >= <= contains startsWith endsWith && \|\| !`（及 and/or/not），条件出边带 true/false 标签做分支路由，未激活分支节点跳过不执行、跳过死端不计入终端输出）**/**code（代码节点 `runCodeNode`：JS 函数体注入 input/outputs，异常捕获为文案，对象 JSON 序列化）**/end；`WorkflowDialog.vue`（画布 + 节点面板 + 配置编辑 + 点选连线编辑分支标签 + 运行（LLM 走 chat_once / 工具走 callMcpTool）+ 日志/输出 + 导入导出 JSON）；**内置模板库 `workflow-templates.ts`（研究助手/文案润色/日报生成/Bug 分流，`materializeTemplate` 重新生成唯一 id 并同步替换 `{{id}}` 引用，可多次载入不冲突，模板合法性自测校验）**；入口=工具菜单「可视化工作流」。待做：云端工作流市场 |
| 全局快捷键（Phase 5） | ✅ | `tauri-plugin-global-shortcut` 依赖 + capability `global-shortcut:default`；setup 从设置读取并注册 `CommandOrControl+Shift+Space`（显示/隐藏主窗口，快速召唤）与 `CommandOrControl+Shift+K`（新建对话，复用 `menu://action` 通道）；`OnceLock<Mutex<Option<(Shortcut, Shortcut)>>>` 存当前注册句柄供 handler 比对（register 返回 `()`，需 `Shortcut::from_str` 解析句柄）；**设置页「快捷键」tab 可自定义两个快捷键**（AppSettings 加 `global_shortcut_toggle`/`global_shortcut_new_chat` 字段 + serde 默认 + 测试字面量同步；`apply_global_shortcuts` 命令注销旧注册并按新配置重注册，保存即生效；「恢复默认」按钮）；注册失败（被占用）仅日志不阻塞启动；「关于」对话框展示默认快捷键 |

## 3.10 近期开发方向（2026-08-27 规划）

> 按「本地可立即开发（自包含、价值高）」优先整理，推进顺序 ①→②→③…；🟡 中等（需设计，本地可做）、🔵 远期（需云端/社区后端）。

### 🟢 本地可立即开发（自包含、价值高，推荐优先）
| # | 方向 | 复用基础 | 实现要点 |
|---|------|---------|---------|
| 1 | **会话内「撤销最近操作」** | ✅ | `apply_edits`（preview）+ `tool_audit`（工具调用全记录） | **已完成（2026-08-27）**：`undo_history` 表（action/path/backup/existed）+ `record_undo`（apply_edits 写盘前 / write_file_agent / delete_file_agent 自动快照）+ `undo_by_id`（edit 恢复内容 / create 删除新建 / delete 恢复文件，回滚后删记录）+ `list_undo`；命令 `apply_edits`/`delete_file_agent` 重构为纯函数+命令层（compute_edits/delete_file_impl）；前端 `UndoBubble` 右下角悬浮气泡显示最近可撤销操作一键回滚（写/删工具成功后 dispatch undo-changed 刷新）；测试 Rust +4 / 前端全绿。待做：操作回放面板（可筛选/导出） |
| 2 | **项目语义索引 / 自然语言找代码**（P-A3 补全） | ✅ | `ollama_embed` + `kb_chunks` embedding 基建 | **已完成（2026-08-27）**：`code_chunks` 表（按 root 组织）+ `code_clear/code_add_chunk/code_search(余弦)/code_roots/code_stats`；命令 `code_index`（扫描代码文件→chunk_text 500 分块→Ollama 批量向量化，跳过 node_modules/.git/target 与大文件）/`code_search`（查询嵌入→余弦召回）/`code_roots`/`code_stats`/`code_delete`；前端内置工具 code_index/code_search/code_roots/code_stats/code_delete + BUILTIN_TOOLS/提示词描述；测试 Rust +1。待做：符号跳转（定义/引用） |
| 3 | **IM 网关（远程驱动 agent）** | `send_im`（已有只发不收）+ 设计方案 `docs/IM_GATEWAY.md` | **已完成（2026-08-28，用户确认国内平台：钉钉/飞书/企微）**：新增 `src-tauri/src/im.rs`——`ImAdapter` trait（poll_updates/send_message）+ `ImGateway`（去重 HashSet / 白名单 chat_id / 触发前缀 / 会话上下文 / 同会话 20s 限流 / 调 chat_once 生成回复并回发）+ `ImGatewayState`（运行状态/日志/最近消息，前端轮询展示）；适配器：企微（只推不接，gettoken+message/send）、钉钉（stream 长连接：accessToken→connections/open→wss CONNECTED/PING-PONG→DATA AES-CBC 解密→机器人 API 发送）、飞书（长连接：tenant_token→ws/endpoint→wss 认证帧→事件解密→im/v1/messages 发送）；`settings.im_config` 整体 AES 加密落盘；命令 `im_start`/`im_stop`/`im_status`；设置「即时聊天」Tab（平台/凭据/白名单/触发前缀/启停/日志/最近消息）。**踩坑**：reqwest 0.12 无 websocket feature → 用 `tokio-tungstenite`；cipher 0.4.4 `encrypt_padded_mut` 需传 msg_len。待做：真实凭据实连验证（协议细节按官方文档实现） |
| 4 | **知识库 RAG 自动注入** | `kb_search_hybrid` + 记忆注入通道 | **已完成（2026-08-27）**：`AppSettings.rag_enabled/rag_kb`；`sendMessage` 会话首轮自动 `kb_search` 默认知识库命中分块注入上下文（`ragInjectedConvs` 同会话只注入一次 + 5s 超时兜底，精细引用仍可手动 kb_search）；设置「知识库」Tab（开关 + 默认库下拉 + 库列表/分块数 + 刷新） |
| 5 | **工作流持久化 + 运行历史** | `workflow-engine` + 设置持久化 | **已完成（2026-08-27）**：`workflows` 表（name 唯一同名保存即更新）+ `workflow_runs` 表 + `wf_save/list/get/delete/run_add/runs`；命令 `workflow_*`；前端工具栏（名称保存 + 我的工作流下拉载入 + 删除当前 + 刷新）+ 运行成功/失败自动记录历史 + 底部「运行历史」列。**后续（同日）工作流 UI 优化**：接入 `WorkflowNodeView` 自定义节点（显式可拖拽 Handle 连接点，条件节点 T/F 双出点自动带分支标签）+ fit-view-on-init |

### 🟡 中等复杂度（需设计，本地可做）
- **会话级权限记忆（✅ 已完成 2026-08-28）**：文件编辑确认弹窗加「本会话内不再询问」勾选——用户在 DiffConfirmDialog 勾选后，`replace_string`/`insert_string`/`delete_file` 本会话内自动放行（chat.ts 模块级 `sessionPermits` reactive Set + `hasSessionPermit`/`rememberSessionPermit`/`clearSessionPermits`，仅本会话有效不落盘）
- 审计可视化面板（工具调用全记录 UI：筛选/回放/导出）
- 外部编码 Agent 阶段三：彻底移除 `delegate_coding_agent`，零外部依赖

### 🔵 远期（需云端/社区后端）
- P-A10 插件/技能生态、P-A11 / 4.3 跨设备同步、云端工作流市场、团队协作共享

---

## 3.11 Agent 多模式（2026-08-28 规划）

> **动机**：用户观察到当前是「通用对话」单模式 Agent；希望像自动化编码助手那样有多种运行模式
> （任务模式 / 办公模式 等），按场景自动采用不同的**规划-执行方式**，而不是每次都从零自由发挥。

### 核心概念

**模式（Mode）= 系统提示词 + 工具集约束 + 行为风格 + 界面入口** 的组合，与现有「角色(Persona)」
（personas-catalog）正交：角色回答「我是谁」，模式决定「我怎么做」。

| 模式 | 目的 | 工具侧重 | 行为风格 |
|------|------|---------|---------|
| 对话（默认） | 日常问答、闲聊 | 全量按需 | 轻量、响应快 |
| **任务模式** | 目标驱动长流程（自动规划→执行→自测→汇报） | 文件/命令/git/测试/子代理/浏览器 | **自动拆解计划** → 逐步执行 → 每步自测 → 汇总汇报（复用 task-plan） |
| **办公模式** | 文档/表格/邮件/纪要/日程 | 文件导出(CSV/HTML 表格)、知识库 RAG、记忆 | 结构化输出、格式规范、如实报告 |
| **研究模式** | 信息获取与整理 | 搜索、网页抓取、附件解析 | 检索优先、来源引用、交叉验证 |
| **编码模式** | 代码任务 | 项目语义索引、文件编辑、测试、git | 改代码→跑测试→提交，自动验证 |
| **速答模式** | 一句话快问快答 | 禁用工具、禁用思考（或低思考） | 极简、低延迟 |

### 实现要点（全部复用现有基建，本地可做）

1. **`src/data/modes-catalog.ts`**：模式定义（id/name/desc/icon/systemPrompt 片段/内置工具白名单/
   行为约束），类比现有 `personas-catalog.ts` / `skills-catalog.ts`。
2. **提示词注入**：主提示词按模式追加 systemPrompt 片段（复用现有 persona/skill 注入通道）。
3. **工具集约束**：模式内置工具白名单 → 映射到现有 `disabledTools` 权限矩阵（或工具调用前的
   mode 白名单判断），避免任务模式误用浏览器、速答模式不调工具。
4. **任务模式**：复用现有 taskPlan（「规划 → 执行 → 验证 → 汇报」自动循环 + `TaskPlanCard` 展示）；
   任务模式下发送即进入自动推进（不再等用户逐条确认），关键操作仍走 diff/命令审批。
5. **办公模式**：复用「文件导出规范」提示词（CSV/HTML 表格、如实报告文件数）+ 知识库 RAG 自动注入
   + 记忆系统，输出可直接交付的文档。
6. **界面**：输入框上方模式切换（类比现有「思考/联网」按钮），会话级持久化（会话元数据记录模式，
   会话恢复时沿用）。
7. **与 IM 网关联动**：IM 网关回复也可按模式（任务模式自动跑长流程，办公模式出文档）。

### 分阶段

- **Phase A（✅ 已完成 2026-08-28）**：`src/data/modes-catalog.ts`（6 模式：对话/任务/办公/研究/
  编码/速答，每模式含行为提示词 prompt + 工具白名单 allowedTools）+ 主提示词按模式注入
  （sendMessage「【当前模式：X】+ prompt」，与 persona 互补）+ `callMcpTool` 模式工具白名单拦截
  （速答模式禁用全部工具）+ 输入框「模式」pill 下拉切换（ChatInput，会话级 localStorage 持久化）+
  任务模式复用 plan_task/plan_update（自动拆解→执行→汇报）、办公模式复用文档导出规范 + 知识库 RAG。
  测试 npm +17。
- **Phase B**：研究模式（检索优先）、编码模式深化（语义索引 + 自动测试循环）、模式记忆（记住用户
  常用模式）、模式图标高亮与快捷切换。
- **Phase C（远期）**：自定义模式（用户可写自己的 mode）/ 模式市场 / 云端同步。

---

## 4. 计划功能（借鉴 Hermes-CN-Desktop，按优先级）

> 参考项目：`https://github.com/Eynzof/Hermes-CN-Desktop`（许可 PolyForm Noncommercial，**只借鉴思路，不抄代码**）。调研详见会话记忆 `hermes-cn-research.md`。

### 🟢 高价值 · 易落地（✅ 已全部落地）
| # | 功能 | 状态 | 基础 |
|---|------|------|------|
| A | **YOLO/自动批准高危命令开关** | ✅ | `DANGEROUS_PATTERNS` + `tool_audit` + 设置「危险命令审批模式」（manual/smart/yolo） |
| B | **用量统计图表页** | ✅ | token/费用/cache 命中率可视化 + 历史累计（usage_agg） |
| C | **会话归档/导出** | ✅ | SQLite 会话表 + 归档（archivedIds）+ 导出 MD/JSON |

### 🟡 中价值（✅ 已全部落地）
| # | 功能 | 状态 | 说明 |
|---|------|------|------|
| D | 运行时健康/日志面板 | ✅ | 系统健康 + 运行时诊断 + 日志查看（HealthPanel） |
| E | 定时任务 | ✅ | 定时任务表 + 调度线程（ScheduledTasks） |
| F | 长任务防休眠 | ✅ | SleepGuard + caffeinate，图片识别/命令执行时自动 |

### 🔵 长期
| # | 功能 | 状态 | 说明 |
|---|------|------|------|
| G | 子代理委派 | ✅ | 已升级为**内置多 agent 协作全链路**（P-M1 子代理带工具 → P-M2 并行 → P-M3 角色分工 → P-M4 汇总仲裁），见 §3.8 |
| H | 编码 Agent 委派 | 🟡 | 外部委派已**降级为隐藏兜底**（2026-08-26）：UI 移出设置面板，保留 `delegate_coding_agent` 内置工具按需调用；内置多 agent 成熟后彻底移除（退役路线见 ROADMAP §4.5） |

---

## 5. 关键技术决策与坑（务必记住）

| 坑/决策 | 结论 |
|---------|------|
| npm `mcp-server-fetch` | 安全研究 canary 占位包，**不可用**；官方 fetch 仅 Python（PyPI，需 uvx）。道生一用内置 `fetch_page` 覆盖，外部 fetch MCP 一律自动禁用 |
| `@modelcontextprotocol/server-fetch` | npm 上 **404 不存在** |
| Puppeteer + macOS 26 | 旧 Chrome for Testing（如 131）启动即被 SIGKILL（`spawn Unknown system error -88`）；需用本机新版 Edge（`PUPPETEER_EXECUTABLE_PATH`） |
| chrome-headless-shell | 下载可能解压不完整（缺可执行文件），需 `npx puppeteer browsers install chrome-headless-shell@<版本>` 重装 |
| SSE 分块丢字 | 必须行缓冲（buf + drain 处理不完整行） |
| datalist 下拉 | WKWebView 不显示，改自定义下拉组件 |
| 身份注入 | `sanitizeAI`/`sanitize_delta` 已删，身份注入保留在 `preprocess_messages` |
| Token 统计 | `assistantMsg` 用 `reactive<ChatMessage>` 创建保证累加 |
| Vue 模板 setTimeout | 会报 `_ctx.setTimeout is not a function`，回调移入 `<script setup>` |
| DeepSeek embeddings | 无 embeddings 端点，`generateEmbedding` 对 deepseek 直接跳过 |
| marked 自定义 text renderer | 必须处理 `token.tokens`（有则先 `parseInline` 渲染嵌套 strong/em/katex），否则加粗/公式以字面量显示 |
| marked-katex-extension | 类型入口是裸 TS 源码，`strict + noUnusedParameters` 报 TS6133 → 自建 `katex-marked.ts` |
| 前端菜单事件 | `@tauri-apps/api` 旧版无 `getCurrentWindow().onMenuEvent`（新版本才有）→ 用 Rust `on_menu_event` + emit + 前端 listen |
| listen 竞态 | 先 `await` 注册监听再 `invoke` |
| flex 弹窗滚动 | 用 `height:min(85vh,720px)` + `min-height:0`，勿用 `max-height` 导致 flex 失效 |

---

## 6. 常用命令

```bash
npm run tauri dev          # 开发模式（自动启动 Vite + cargo）
npx vite build            # 前端生产构建（不跑类型检查）
npx vue-tsc --noEmit      # 前端严格类型检查（建议每轮自测加它）
npm test                  # 前端测试（84 项）
cargo check               # Rust 编译检查
cargo test --lib          # Rust 单元测试（40 项，7 项 live 忽略）
git push origin main      # 每次完成推送 GitHub
```
