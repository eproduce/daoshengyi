# 道生一 (DaoShengYi) - AI Agent 桌面客户端

基于 **Tauri 2 + Vue 3** 构建的 AI Agent 桌面客户端，支持 DeepSeek 等国产大模型的流式对话。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | Vue 3 (Composition API + `<script setup>`) |
| 构建工具 | Vite 5 |
| 类型系统 | TypeScript |
| 状态管理 | Pinia |
| 桌面框架 | Tauri 2 (Rust) |
| Markdown | marked + highlight.js |

## 功能特性

- 🤖 **多轮对话** — 支持上下文连续对话
- 📝 **对话历史** — 保存/删除/切换历史会话
- 📄 **Markdown 渲染** — AI 回复支持 Markdown 格式
- ⚡ **流式输出** — AI 回复逐字流式显示
- 🎨 **代码高亮** — 回复中代码块自动语法高亮
- 🌗 **主题切换** — 亮色/暗色主题一键切换
- ⚙️ **灵活配置** — 支持任意兼容格式的 API 端点

## 快速开始

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

## 项目结构

```
daoshengyi/
├── src/                        # Vue 3 前端
│   ├── api/agent.ts            # API 请求层
│   ├── assets/styles/          # 全局样式
│   ├── components/             # Vue 组件
│   │   ├── ChatHistory.vue     # 对话历史侧边栏
│   │   ├── ChatInput.vue       # 消息输入框
│   │   ├── ChatMessage.vue     # 消息气泡（含 Markdown）
│   │   └── SettingsDialog.vue  # API 设置弹窗
│   ├── composables/            # 组合式函数
│   │   └── useTheme.ts         # 主题管理
│   ├── stores/                 # Pinia 状态管理
│   │   └── chat.ts             # 对话核心状态
│   ├── types/index.ts          # TypeScript 类型定义
│   ├── App.vue                 # 主布局
│   └── main.ts                 # 入口文件
├── src-tauri/                  # Tauri 2 后端
│   ├── src/
│   │   ├── main.rs             # Rust 入口
│   │   └── lib.rs              # Tauri 命令与插件注册
│   ├── Cargo.toml              # Rust 依赖
│   ├── tauri.conf.json         # Tauri 配置
│   └── capabilities/           # 权限配置
├── index.html
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## 配置说明

首次使用请在设置中配置：

- **API 地址** — API 基础地址（如 `https://api.deepseek.com`）
- **API Key** — 您的 API 密钥
- **模型** — 模型名称（如 `deepseek-v4-flash`）

配置自动保存在本地（API Key 经 AES-256-GCM 加密）。

## License

MIT
