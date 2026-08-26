# 道生一 · 开发计划

> 本文件是**当前可执行的开发计划**（现状 + 积压 + 待办功能），配套《开发进度》`DEVELOPMENT_PROGRESS.md` 记录已完成工作，愿景方向见 `ROADMAP.md`。
>
> **最后更新：2026-08-25**

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
| 测试 | `npm test`（前端 30 项）· `cargo test settings`（Rust 4 项） |

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

## 3. 长期记忆功能开发计划（2026-08-25 新增，待启动）

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

> **状态：1.1 / 1.2 / 1.3 已完成（2026-08-25），1.4 / 1.5 待做**

| # | 任务 | 状态 | 说明 |
|---|------|------|------|
| 1.1 | 事实去重与合并 | ✅ | `save_fact` 前字符集 Jaccard 相似度（>0.62 + 长度比惩罚）检测近似重复 → 合并：累加 importance（上限 10）、文本取更长、复用原 id；`mcp_server` memory_save 与前端 extractFacts 均反馈合并状态 |
| 1.2 | 记忆衰减与遗忘调度 | ✅ | 新增 `maintain_facts`：>45 天未访问非 preference 的 importance 降 1（最低 1）；importance≤2 且 60 天未访问的删除；清理孤儿 FTS 行。lib.rs 后台线程启动即跑 + 每 6 小时检查；`prune_facts` 命令复用 |
| 1.3 | FTS5 全文索引 | ✅ | `memory_facts_fts` FTS5 虚拟表（rowid 关联）；中文 unigram 分词（`cjk_terms`）+ 英文小写词；`search_facts` 改为 FTS5 bm25 × importance × recency 加权 + LIKE 兜底；`Database::new` 对旧库幂等回填索引；save/delete 同步维护 |
| 1.4 | 记忆分层 | ⬜ | episodic（会话摘要）+ semantic（事实）双库明确；跨会话摘要汇总 |
| 1.5 | 用户画像沉淀 | ✅ | `getUserProfile()` 聚合 preference+高重要度身份/环境信息，每次对话稳定注入；MemoryPanel 用户画像高亮区块 |

### 3.3 Phase 2 — 检索与注入（Agent 侧，🟡）

> **状态：2.1 部分（FTS5 混合检索）、2.2 部分（加权排序）、2.4 已完成（2026-08-25）；2.3 待做**

| # | 任务 | 状态 | 说明 |
|---|------|------|------|
| 2.1 | 混合检索 | ✅ | FTS5 关键词（1.3）+ 意图关键词扩展（LLM 提取核心词，空结果时重试）；Ollama 本地 embedding 待做 |
| 2.2 | 排序与剪裁 | 🟡 | search_facts 已按 bm25×importance×recency 加权（Phase 1）；注入条数/token 剪裁、来源标注待做 |
| 2.3 | 写入策略优化 | ⬜ | 对话结束异步提取（已有）；触发优化：重要性门槛、失败静默、避免低价值事实堆积 |
| 2.4 | 主动记忆工具 | ✅ | `memory_save` / `memory_recall` / `memory_forget` 内置工具（app）+ 提示词「长期记忆使用要点」区块；memory_save 自动走去重合并；memory_recall 走 FTS5 检索；memory_forget 按关键词删除 |

### 3.4 Phase 3 — 记忆 UI 与管理（🔵）

| # | 任务 | 说明 |
|---|------|------|
| 3.1 | 记忆管理面板 | 🟡 | 已完成：查看/筛选/删除/编辑（update_fact）+ 用户画像区块 + 会话摘要 + 执行维护；待做：全文搜索框 |
| 3.2 | 记忆配置 | 开关（启用记忆）、检索条数、遗忘阈值（AppSettings + 设置 tab） |
| 3.3 | 记忆可视化 | 用户画像卡片、遗忘候选提示、记忆来源标注 |

### 3.5 Phase 4 — 增强（远期）

| # | 任务 | 说明 |
|---|------|------|
| 4.1 | 本地语义检索 | 接入 Ollama 本地 embedding（`nomic-embed-text`）或内置轻量 BM25；可行则启用真向量 |
| 4.2 | 记忆复习 | 定期 LLM 回顾记忆仓库，合并过时 / 矛盾事实 |
| 4.3 | 跨设备同步 | 远期 |

### 3.6 关键技术点 / 坑

- **DeepSeek 无 embeddings**：语义检索不依赖它；用关键词增强 + 可选 Ollama 本地 embedding；记忆检索已有 15s 超时兜底（`Promise.race`），不阻塞主对话
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
| P-A4 | **多文件编辑 + diff** | ✅ | 🟢 | P-A3 | `apply_edits` 命令（replace/insert/delete 三原语 + occurrence 定位 + 主目录安全边界）+ 行级 LCS **unified diff** 返回（@@ 头 + 3 行上下文）；前端内置工具 replace_string / insert_string / create_file / delete_file（精确编辑、避免整文件覆盖误伤，`create_file` 防误覆盖、`delete_file_agent` 仅删主目录文件）；diff 在工具结果卡片展示、提示词要求编辑后回复说明改动；跨文件重构 = 对多文件连续精确编辑。待做：应用内 diff「确认后应用」UI（并入 P-A7 权限矩阵审批） |
| P-A5 | **任务规划增强（Plan 模式）** | ✅ | 🟢 | 无 | 内置 `plan_task`（创建/替换计划：标题+有序子步骤）+ `plan_update`（逐步标记 doing/done/failed）；对话区顶部实时进度卡片（进度条+步骤状态徽标+完成计数，可手动关闭）；与工具循环结合 Plan→Act→Observe→修正（提示词「任务规划规范」引导复杂任务先分解、逐步更新、全部完成后再给最终答案）；新对话自动清空计划。简单任务不触发 |
| P-A6 | **本地语义 embedding** | ✅ | 🟡 | 记忆（已有） | 接入 Ollama 本地 embedding（`nomic-embed-text`）：Rust `ollama_embed` 命令（/api/embed，服务未运行/模型未装时快速失败不自动下载）；前端 `generateEmbedding` 对 DeepSeek（无 embeddings 端点）主模型改用本地 Ollama 补语义，向量存 `set_fact_embedding` + `search_by_embedding` 余弦检索；未部署 nomic-embed-text 时静默回退 FTS5 |
| P-A7 | **权限矩阵（工具级）** | ✅ | 🟡 | approval_mode（已有） | AppSettings 加 `disabledTools`/`allowedPaths`；前端 `isToolDisabled`/`isPathAllowed` 纯函数拦截（callMcpTool/callBuiltinTool 双入口）；设置「权限」tab 配置禁用工具 + 路径白名单（每行一个，@change 即时保存） |
| P-A8 | **沙箱** | ✅ | 🟡 | 无 | 文件层白名单沙箱：Rust `path_within_any`（组件级前缀匹配防误判）/`parse_allowed_paths`（~ 展开）纯函数 + `sandbox_allowed_paths`/`sandbox_file_path`；`read_file`/`write_file_agent` 加 `db: State` 应用白名单（未配置时 read 保持原行为、write 仍主目录边界）；命令层 `DANGEROUS_PATTERNS` 已有 + P-A7 前端门禁兜底 |
| P-A9 | **记忆复习** | ✅ | 🔵 | 记忆（已有） | `memory.ts reviewMemories`：LLM 回顾记忆库（list_facts → buildReviewPrompt → parseReviewActions），删除过时/矛盾/重复事实，merge 时目标重要度 +1；记忆面板「智能复习」按钮（手动触发，配 API 才可用）；纯函数 buildReviewPrompt/parseReviewActions 可测试 |
| P-A10 | **插件/技能生态** | ⬜ | 🔵 | 技能库/MCP（已有） | 第三方技能/工具上传、评分、分享；版本管理与自动更新 |
| P-A11 | **跨设备同步** | ⬜ | 🔵 | 无 | 记忆/技能/配置跨设备同步 |
| P-A12 | **多模型路由** | ⬜ | 🔵 | Ollama（已有） | 按任务类型自动选模型（对话/编程/摘要），本地模型作离线回退 |

**建议推进顺序**：P-A1（Git）→ P-A2（验证循环）→ P-A3（代码库索引）→ P-A4（多文件编辑 diff）→ P-A5（Plan）→ P-A6（本地 embedding）→ P-M1~P-M4（多 agent 协作）→ P-A7/P-A8（权限沙箱）→ 其余远期。

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

## 4. 计划功能（借鉴 Hermes-CN-Desktop，按优先级）

> 参考项目：`https://github.com/Eynzof/Hermes-CN-Desktop`（许可 PolyForm Noncommercial，**只借鉴思路，不抄代码**）。调研详见会话记忆 `hermes-cn-research.md`。

### 🟢 高价值 · 易落地
| # | 功能 | 基础 |
|---|------|------|
| A | **YOLO/自动批准高危命令开关** | 已有 `DANGEROUS_PATTERNS` + `tool_audit`，加设置开关「自动批准」即闭环 |
| B | **用量统计图表页** | 已有 token/费用/cache 命中率数据，加可视化 |
| C | **会话归档/导出** | 基于 SQLite 会话表加归档/导出 |

### 🟡 中价值
| # | 功能 | 说明 |
|---|------|------|
| D | 运行时健康/日志面板 | 系统健康 + 运行时诊断 + 日志查看 |
| E | 定时任务 | `/run` 已能执行命令，配 cron 表可实现 |
| F | 长任务防休眠 | prevent-sleep 类能力 |

### 🔵 长期
| # | 功能 | 说明 |
|---|------|------|
| G | 子代理委派 | ReAct 单循环 → orchestrator-subagent 树 + 监视面板（**已初步：subagent_delegate 轻量单层；升级方向见 §3.8 P-M1~P-M4**） |
| H | 编码 Agent 委派 | 检测/委派本机 Claude Code、Codex（**2026-08-26 降级为隐藏兜底**：UI 移出设置面板，保留 `delegate_coding_agent` 内置工具按需调用；内置多 agent 成熟后彻底移除，见 ROADMAP §4.5 退役路线） |

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
npx vite build            # 前端生产构建
npm test                  # 前端测试（30 项）
cargo check               # Rust 编译检查
cargo test settings       # Rust 加密/设置测试（4 项）
git push origin main      # 每次完成推送 GitHub
```
