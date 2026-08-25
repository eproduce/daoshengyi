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

| # | 任务 | 说明 |
|---|------|------|
| 1.1 | 事实去重与合并 | `save_fact` 前检测近似重复：编辑距离 / 最长公共子串相似度 > 阈值则合并（累加 importance、保留新 fact）；LLM 复核可选，控制成本 |
| 1.2 | 记忆衰减与遗忘调度 | 启动 / 每日后台自动执行 `prune_facts`；importance 随 access 上调、随时间衰减；`preference` 永久保护 |
| 1.3 | FTS5 全文索引 | `memory_facts` 建 FTS5 虚拟表替代 `LIKE` 全表扫；中文 unigram 分词提升召回 |
| 1.4 | 记忆分层 | episodic（会话摘要）+ semantic（事实）双库明确；跨会话摘要汇总 |
| 1.5 | 用户画像沉淀 | `preference` 型 fact 独立加权，跨会话维护「用户档案」（姓名/职业/偏好/环境） |

### 3.3 Phase 2 — 检索与注入（Agent 侧，🟡）

| # | 任务 | 说明 |
|---|------|------|
| 2.1 | 混合检索 | FTS5 关键词 + 意图关键词扩展（LLM 生成检索词）+ 向量（若 Ollama 本地 embedding 可用则启用） |
| 2.2 | 排序与剪裁 | 按 relevance × importance × recency 加权排序；限制注入条数 / token；标注来源与可信度 |
| 2.3 | 写入策略优化 | 对话结束异步提取（已有）；触发优化：非重复、重要性门槛、失败静默 |
| 2.4 | 主动记忆工具 | 内置 `memory_save` / `memory_recall` / `memory_forget` 工具，Agent 主动读写记忆 |

### 3.4 Phase 3 — 记忆 UI 与管理（🔵）

| # | 任务 | 说明 |
|---|------|------|
| 3.1 | 记忆管理面板 | 查看 / 搜索 / 编辑 / 删除事实与摘要；按类型 / 重要性 / 最近访问排序（设置新 tab 或独立面板） |
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
| G | 子代理委派 | ReAct 单循环 → orchestrator-subagent 树 + 监视面板 |
| H | 编码 Agent 委派 | 检测/委派本机 Claude Code、Codex |

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
