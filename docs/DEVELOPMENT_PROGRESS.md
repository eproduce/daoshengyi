# 道生一 · 开发进度

> 按时间记录已完成功能、修复与验证结果，便于回溯与跨会话续接。配套《开发计划》`DEVELOPMENT_PLAN.md`。
>
> **最后更新：2026-08-17**

---

## 2026-08-17

### ✅ 修复：fetch MCP 插件不可用（`npx mcp-server-fetch` 报错）
- **现象**：启动 MCP 报 `mcp-server-fetch: line 1: /Applications: is a directory` / `syntax error`
- **根因**：npm 上 `mcp-server-fetch`（v0.0.2）是安全研究 **canary 占位包**，`npx` 拉取的是遥测脚本而非 MCP server
- **方案**：`src/stores/mcp.ts` 新增 `migrateConfig` 自动禁用此类配置（提示用内置 `fetch_page`）；`mcp-catalog.ts` 移除 fetch 插件条目；清理 `~/.npm/_npx` 污染缓存
- **验证**：30 项测试通过，无类型错误；应用热更新后「网络请求」不再连接
- **已推送**：`56e8fbe`

### ✅ 修复：Puppeteer MCP 不可用（`spawn Unknown system error -88`）
- **现象**：`puppeteer_navigate` 启动失败
- **根因**：
  1. `chrome-headless-shell` 缓存损坏（目录内缺可执行文件，只有 ABOUT/LICENSE）
  2. 完整版 Chrome for Testing（131，2024 年）在 macOS 26.5.2 上**启动即被系统 SIGKILL**（`zsh: killed`），故 `--version` 都失败
  3. 本机无 Google Chrome，仅有 Microsoft Edge
- **方案**（代码已改，待收尾）：
  - 重新安装 `chrome-headless-shell@131.0.6778.204`（修复缓存）
  - MCP 客户端加 **env 支持**（`mcp.rs`/`lib.rs`/`appSettings.ts`/`mcp.ts`），`PUPPETEER_EXECUTABLE_PATH` 指向本机 Edge
  - 待办：`mcp-catalog.ts` + `McpSettings.vue` + 编译验证 + 推送（见计划 §2.1）
- **验证**：puppeteer + Edge `launch` + `goto` 成功（百度天气页标题正常）

### ✅ 修复：日期幻觉 + 编造数据
- **现象**：模型日期幻觉；未调用工具时编造数据（如天气）
- **根因**：
  1. 工具提示为软性（"需要工具时..."），模型被问实时信息（天气/新闻等）时凭训练数据编造
  2. `volatileCtx` 的【当前时间】只有 HH:MM 无日期；系统提示日期措辞不够强硬
- **修复**（`src/stores/chat.ts`）：
  - `withCurrentDate`：强调"唯一可信日期来源，回答前先核对，严禁编造训练数据日期"
  - `volatileCtx`【当前时间】：补全完整日期（年月日 + 星期 + 时分）
  - `getMcpToolsPrompt`：新增「强制要求（实时/时效信息）」——实时数据**必须先调** `web_search`/`fetch_page`，拿不到明确说「无法获取」，**严禁编造**
- **验证**：`vite build` + `npm test`（30 项）通过

### ✅ 功能：YOLO/自动批准高危命令开关（🟢）
- `settings.rs`/`appSettings.ts`：`AppSettings` 加 `yolo_mode`（默认 false）
- `chat.ts runCommand`：危险命令确认前判断 `yoloMode`，开启则自动批准不弹窗
- `SettingsDialog.vue`：Agent 设置新增「⚠️ 高危操作(YOLO 模式)」开关
- 验证：`cargo check` + `cargo test settings`(4) + `vite build` + `npm test`(30) 通过

### ✅ 功能：用量统计图表页（🟢）
- 新增 `UsageStats.vue`：从 SQLite 对话记录聚合——总会话/消息/Token/费用/平均耗时卡片、缓存命中率条、每日 Token 柱状图、会话 Token 分布
- `SettingsDialog.vue`：新增「📊 用量统计」tab
- 纯 CSS 图表（无新依赖），只改前端（HMR 热更新，不重启 dev 客户端）

### ✅ 功能：会话归档/导出（🟢）
- 归档：`chat.ts` 加 `archivedIds`（localStorage 持久化）+ `archiveConversation`/`unarchiveConversation`/`deleteArchived`；主列表只显示未归档，归档视图可恢复/删除
- 导出：复用已有 `export_conversation` 后端（JSON/Markdown）+ 前端 `downloadExport`（Blob 下载）
- `ChatHistory.vue`：每个会话加「⤓ 导出」「🗂 归档」按钮，顶部「🗄」切换归档视图
- 只改前端不重启 dev 客户端

### ✅ 修复：发送图片回复空内容
- **根因**：`describeImages(images)` 在 `try` 块外，若本地视觉模型识别异常会绕过 catch/finally，`assistantMsg.content` 永不赋值 → 气泡停留为空内容
- **修复**：图片预处理调用包 try-catch，异常时走 `ocrFailed` 分支进入错误兜底
- 验证：`vite build` + `npm test`（30 项）通过

### 📌 调研：Hermes-CN-Desktop（`Eynzof/Hermes-CN-Desktop`）
- Tauri 2 + React 桌面客户端，1.6k stars，v0.8.0-rc7；许可 **PolyForm Noncommercial**（只借鉴思路不抄代码）
- 借鉴点已纳入《开发计划》§3（YOLO 开关 / 用量图表 / 会话归档 / 健康面板 / 定时任务 / 子代理委派等）
- 完整调研笔记在会话记忆 `hermes-cn-research.md`

### ✅ 基础设施
- `npm run tauri dev` 首次完整构建通过（1m 07s），文件系统 MCP 连接成功（14 工具）
- 拉取远程后验证：工作区配置、`/run` 终端卡片、`/read` 文件读取均保留；HEAD 与 origin/main 同步

---

## 2026-08-14 及之前（Phase 1 及演进，详见 ROADMAP.md）

- **Phase 1 完成**：流式对话、多模型切换、记忆系统、技能库、MCP 客户端、联网搜索、网页抓取、SQLite 持久化、API Key 加密、Token/费用统计、图片预处理、提示词模板
- **Agent 能力演进**：ReAct 自动工具调用、MCP 插件市场、API Key AES 加密迁移、动态获取模型、国产模型定位（仅 DeepSeek）、SSE 丢字修复、AI 头像品牌化、IM 气泡布局、DeepSeek Harness 集成（超时守卫/审计/危险命令/工作区/终端卡片/文件读取）、官方价格表计费、UI 滚动/配色修复
- 每次完成均推送 GitHub main

---

## 验证清单（改完必跑）

```bash
cargo check                     # Rust 编译
npx vite build                  # 前端构建
npm test                        # 前端测试（30 项：19 tokens + 11 模板/工具）
cargo test settings             # Rust 加密测试（4 项）
git push origin main            # 推送
```
