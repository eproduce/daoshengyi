# 道生一 · 开发计划

> 本文件是**当前可执行的开发计划**（现状 + 积压 + 待办功能），配套《开发进度》`DEVELOPMENT_PROGRESS.md` 记录已完成工作，愿景方向见 `ROADMAP.md`。
>
> **最后更新：2026-08-17**

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

## 1. 已完成能力（截至 2026-08-17）

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

---

## 2. 进行中（当前积压，优先处理）

### 2.1 Puppeteer MCP env 支持（半成品，需收尾）
- **目的**：server-puppeteer 需 Chrome/Chromium；旧版 Chrome for Testing 在 macOS 26 被系统 SIGKILL（`spawn error -88`），改用本机 **Microsoft Edge**（`PUPPETEER_EXECUTABLE_PATH`）。
- **已改**：
  - `src-tauri/src/mcp.rs`：`McpServerConfig` 加 `env: HashMap<String,String>`；spawn 时 `cmd.envs`
  - `src-tauri/src/lib.rs`：`mcp_connect` 加 `env` 参数
  - `src/api/appSettings.ts`：`McpServerPersist` 加 `env?`
  - `src/stores/mcp.ts`：接口/`save`/`connect`/`connectByName` 透传 env；`applyPuppeteerEnv` 迁移自动补 Edge 路径
- **待改**：
  - `src/data/mcp-catalog.ts`：`McpCatalogItem` 加 `env?`；puppeteer 条目加 `env: { PUPPETEER_EXECUTABLE_PATH: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" }`
  - `src/components/McpSettings.vue`：编辑表单支持 env（文本 `KEY=VALUE` 多行），`openAdd/openEdit/save/installPlugin` 处理 env
- **待验证**：`cargo check` + `npx vite build` + `npm test` + 端到端 puppeteer 测试 + 推送 GitHub

### 2.2 日期幻觉 + 编造数据 bug（用户 2026-08-17 报告）
- 现象：模型日期幻觉；未调用工具时编造数据（如天气）
- 排查点：
  - `withCurrentDate`（chat.ts）天粒度注入是否在 `sendMessage` 与 `chat_once` 两条路径都生效（远程拉取后 550 行改动可能影响）
  - 精确时间是否放入"本次补充上下文"（最新用户消息）
  - 工具调用强制：涉及时效性/数据类问题时是否强制要求先调 `fetch_page`/`web_search`

---

## 3. 计划功能（借鉴 Hermes-CN-Desktop，按优先级）

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

## 4. 关键技术决策与坑（务必记住）

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
| listen 竞态 | 先 `await` 注册监听再 `invoke` |
| flex 弹窗滚动 | 用 `height:min(85vh,720px)` + `min-height:0`，勿用 `max-height` 导致 flex 失效 |

---

## 5. 常用命令

```bash
npm run tauri dev          # 开发模式（自动启动 Vite + cargo）
npx vite build            # 前端生产构建
npm test                  # 前端测试（30 项）
cargo check               # Rust 编译检查
cargo test settings       # Rust 加密/设置测试（4 项）
git push origin main      # 每次完成推送 GitHub
```
