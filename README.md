# 道生一 (DaoShengYi) — AI Agent 桌面客户端

> 「道生一，一生二，二生三，三生万物。」—— 从一句话开始，让 AI 帮你完成更多。
>
> 一个**本地优先**的 AI Agent 桌面客户端，基于 **Tauri 2 + Vue 3 + Rust** 构建。深度绑定 **DeepSeek** 等国产大模型，同时支持本地 **Ollama** 视觉模型与 macOS 系统 **OCR**，让对话不只是聊天，更能自主调用工具、操作浏览器、读写文件、执行命令。

## ✨ 功能特性

### 🤖 智能对话
- **流式输出** — Rust SSE 流式渲染，分块不丢字，逐字显示
- **深度思考展示** — 展开/折叠模型的推理过程（reasoning_content）
- **多模型 Profile** — DeepSeek 默认，可配置任意 OpenAI 兼容端点；本地 Ollama 一键接入
- **日期防幻觉** — 自动注入当天日期，回答"今天/今年"类问题不胡诌
- **缓存命中率统计** — 解析模型 `usage.prompt_cache_hit/miss_tokens`，顶栏实时显示 `缓存 xx%`

### 🛠 Agent 工具调用（ReAct 循环）
- **LLM 自主决策** — 由大模型根据任务自行选择工具，无需手动触发
- **内置工具**：
  - `fetch_page` 网页抓取（HTML → 文本，快且稳）
  - `web_search` 网络搜索
  - `describe_image` 本地视觉模型描述图片
  - `ocr_image` 本地 OCR 提取图片文字
- **MCP 服务器扩展**：
  - 🌍 浏览器自动化（Puppeteer：打开/点击/输入/截图/抓动态页）
  - 🧠 记忆（语义检索历史事实）
  - 📁 文件系统（读写本地文件）
  - **按需连接** — 对话开始按需连接、任务完成自动断开；浏览器等重服务器**不日常弹窗**，仅模型明确需要时经 `__connect__` 懒激活
- **过程透明** — 工具调用卡片实时展示（参数折叠、结果摘要），思考过程可见

### 🖼 本地视觉 & OCR
- **一键部署 Ollama** — 无需 Homebrew：官方 zip 直装（`~/Applications/Ollama.app`）+ 断点续传 + 连通性预检 + 自动配置 API Profile
- **分层识别** — macOS Vision **OCR**（精确提取文字）+ Ollama `llava-phi3` 语义描述，合并注入主模型
- **截图链路** — 浏览器截图 → 保存临时文件 → `describe_image` / `ocr_image` 分析

### 💾 本地记忆与知识
- **记忆系统** — 事实提取 + 关键词/语义检索 + 自动摘要旧消息
- **技能库** — 内置技能市场 + 导入导出 + 系统提示词注入
- **提示词模板** — 8 个角色模板一键应用

### 🖥 生产力能力
- **`/run <命令>`** — 直接执行终端命令，返回输出与退出码（含超时处理）
- **`/read <路径>`** — 读取本地文件内容供 AI 分析
- **对话历史** — SQLite 持久化、切换/删除、导出 Markdown、失败重试
- **Token/费用统计** — 本地估算 + 价格表，顶部实时显示

### 🔒 安全与体验
- **API Key 加密落盘** — AES-256-GCM，密钥文件权限 0600
- **本地优先** — 数据、密钥、记忆全部存储在本机
- **Markdown + 代码高亮**、亮/暗主题一键切换

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | Vue 3（Composition API + `<script setup>`） |
| 构建工具 | Vite 5 |
| 类型系统 | TypeScript |
| 状态管理 | Pinia |
| 桌面框架 | Tauri 2（Rust） |
| 后端能力 | reqwest、SQLite（rusqlite）、AES-256-GCM |
| Markdown | marked + highlight.js |
| 本地视觉 | Ollama（llava-phi3） |
| 本地 OCR | macOS Vision（`ocr_tool.swift`） |

## 🚀 快速开始

### 环境要求

- **Node.js** >= 18
- **Rust** >= 1.70
- **macOS / Windows / Linux**

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run tauri dev
```

### 生产构建

```bash
npm run tauri build
```

> 💡 macOS 上首次构建会自动编译 OCR 工具（`swiftc -O ocr_tool.swift`，增量编译）。

## 📖 使用指南

### 1. 配置 API

「设置 → API 配置」中填写：
- **API 地址** — 如 `https://api.deepseek.com`
- **API Key** — 你的密钥（AES-256-GCM 加密保存）
- **模型** — 如 `deepseek-v4-flash`、`deepseek-reasoner`

### 2. 一键部署本地 Ollama（可选）

「设置 → Ollama」点击一键部署即可（无需 Homebrew）：
1. 官方 zip 直装到 `~/Applications/Ollama.app`，断点续传、失败可重试
2. 自动拉取视觉模型（如 `llava-phi3:3.8b`）并显示进度
3. 自动添加 `ollama` API Profile，用于图片识别

### 3. 启用 MCP 服务器 / 技能 / 记忆

- **MCP** —「设置 → MCP」从内置市场添加（浏览器自动化/记忆/文件系统），勾选启用后对话中按需自动连接
- **技能** —「设置 → 技能」启用技能或导入导出
- **记忆** — 对话中自动提取关键事实并检索注入

### 4. 图片识别

直接发送图片即可：主模型非视觉时自动用本地 Ollama + OCR 识别成文字描述后交给模型；支持图片的模型则直接多模态输入。

### 5. 终端命令与文件

- 输入框输入 `/run ls -la` 执行命令
- 输入框输入 `/read src/App.vue` 读取文件

## 📁 项目结构

```
daoshengyi/
├── src/                        # Vue 3 前端
│   ├── api/                    # API 请求层（agent / appSettings / search）
│   ├── assets/styles/          # 全局样式
│   ├── components/             # 组件
│   │   ├── ChatHistory.vue     # 对话历史侧边栏
│   │   ├── ChatInput.vue       # 消息输入框
│   │   ├── ChatMessage.vue     # 消息气泡（流式 + Markdown + 深度思考）
│   │   ├── McpSettings.vue     # MCP 服务器设置
│   │   ├── QuickBar.vue        # 快捷指令栏
│   │   ├── SettingsDialog.vue  # API/模型设置
│   │   └── SkillManager.vue    # 技能管理
│   ├── composables/useTheme.ts # 主题管理
│   ├── data/                   # 静态数据（MCP 市场 / 提示词模板 / 技能库）
│   ├── stores/                 # Pinia 状态（chat / mcp / memory / ollama / skill）
│   ├── types/index.ts          # TypeScript 类型定义
│   ├── utils/                  # 工具（hljs / tokens / tool-call）
│   ├── App.vue                 # 主布局
│   └── main.ts                 # 入口（含事件监听）
├── src-tauri/                  # Tauri 2 后端
│   ├── src/
│   │   ├── main.rs             # Rust 入口
│   │   ├── lib.rs              # Tauri 命令与 Ollama 部署 / OCR / 日志
│   │   ├── api.rs              # SSE 流式 / 非流式请求 / 缓存命中解析
│   │   ├── db.rs               # SQLite 持久化
│   │   ├── mcp.rs              # MCP stdio 连接与工具调用
│   │   ├── middleware.rs       # 系统消息注入
│   │   ├── search.rs           # 网络搜索
│   │   └── settings.rs         # 配置 + AES-256-GCM 加密
│   ├── ocr_tool.swift          # macOS Vision OCR 源码
│   ├── build.rs                # 自动编译 OCR 工具（增量）
│   ├── Cargo.toml
│   ├── tauri.conf.json         # Tauri 配置（含 OCR 资源打包）
│   └── capabilities/           # 权限配置
├── docs/ROADMAP.md             # 开发路线图
├── scripts/                    # 测试脚本（tokens / 模板 / 工具）
├── index.html
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## 🧪 测试

```bash
npm test
```

## 🔍 日志与排障

运行时日志写入 `~/Library/Application Support/com.daoshengyi.app/daoshengyi.log`（包含模型请求、MCP 连接/断开、SSE 流式等诊断信息），可在终端用 `tail -f` 查看。

## 📄 License

MIT
