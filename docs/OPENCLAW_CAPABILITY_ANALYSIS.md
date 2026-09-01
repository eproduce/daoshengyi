# OpenClaw 能力研究（2026-09-01）

> 对比对象：`openclaw/openclaw`（GitHub 388k star，MIT，OpenClaw Foundation 维护，Peter Steinberger 发起，1 分钟前仍在更新）
> 定位："Your own personal AI assistant. Any OS. Any Platform. The lobster way. 🦞" —— 个人/团队 AI 助手，Gateway 统一连接模型、工具、消息渠道与可选 Companion 应用。
> 技术栈：pnpm workspace，TypeScript 91% + Swift 4.6% + Kotlin 1.8%（Companion app），Node 运行时（macOS/Linux/Windows）。

## 一、OpenClaw 核心架构

- **Gateway** = 本地控制平面，统一管会话、工具、事件、渠道连接；Control UI / CLI / TUI 都连它；可个人部署或团队共享（配置唯一区别）。
- **Channels** = 渠道插件：WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage、微信/企微/钉钉/飞书（经生态插件）等。
- **Companion apps / Nodes** = 设备节点：voice 语音、Canvas、camera、screen、device-local actions。
- **模型 providers** = 宿主/本地 provider 均可，且 provider 本身是插件（可注册新 provider + auth wizard）。
- **扩展三件套** = Tools / Skills / **Plugins**（ClawHub 市场 + Plugin SDK）。
- **安全基调** = "trusted gateway, untrusted execution, deterministic policy"；入站消息视为不可信；DM 未知发送者默认配对（approve pairing）；工具执行可沙箱化。

## 二、道生一**不具备** / 明显落后的能力（重点）

### A. 架构级（最根本差距）

1. **插件化运行时（Plugin SDK + ClawHub 能力市场）** — 最大差距。
   - OpenClaw 几乎所有能力（渠道/模型 provider/工具/技能/命令/节点/hook）都是**可安装插件**：`openclaw/plugin-sdk/*` 类型化契约、`openclaw.plugin.json` manifest、npm/git/ClawHub/archive 多安装源、能力模型（capability/shape）、grants 授予、hooks、config 深度绑定、安装完整性校验（SSRI/sha256/git commit）。
   - 道生一 = 编译进二进制的内置工具 + 外部 MCP server，**没有自己的插件 SDK / 运行时扩展机制**，第三方无法为道生一开发热插拔插件。MCP catalog 只是"配置外部 server"，非应用自身插件。
2. **OS 级执行沙箱（untrusted execution）** — 安全模型差距。
   - OpenClaw：exec host 可选 `auto/sandbox/gateway/node`；Docker 沙箱（默认）/ SSH 远程沙箱；bind mount 校验（阻止 /etc /proc /sys + 凭证目录 .ssh/.aws/.npm/.gnupg/.config/.cargo）、网络模式校验、seccomp/AppArmor profile 校验、沙箱内浏览器（CDP bridge + noVNC）。
   - 道生一：命令在**宿主直接 sh -c 执行**，只有文件层白名单（allowed_paths）+ 主目录边界 + execpolicy 命令策略，**无容器/进程隔离**。

### B. 渠道与入口

3. **多渠道 IM 矩阵 + 配对审批**：OpenClaw 支持 12+ 渠道（WhatsApp/Telegram/Slack/Discord/Google Chat/Signal/iMessage/微信/企微/钉钉/飞书/QQ），DM 未知发送者默认配对审批；多实例可把不同账号/频道绑定到不同 Agent。
   - 道生一：仅飞书/企微/钉钉三平台（im.rs），且以主动推送为主，无配对审批、无微信/QQ/Telegram/Signal/iMessage。
4. **Companion apps / 设备节点（Node 网络）**：手机/设备 companion app、voice 语音、camera、screen、Canvas、device-local actions；PluginNodeHostCommand / nodes runtime。
   - 道生一：单机桌面，无多设备协同、无语音、无摄像头/屏幕感知节点。
5. **团队部署 / 共享网关 / 多用户**：同一 Gateway 可作个人助手或共享团队部署，operator scopes、远程访问、受信任成员模型。
   - 道生一：单用户本地应用。
6. **完整 CLI + TUI + Control UI + slash 命令体系**：三套前端入口 + 体系化 slash 命令。
   - 道生一：桌面 UI + 少量 slash（/run /read /clear）。

### C. 上下文与记忆

7. **智能上下文压缩（compaction）**：OpenClaw 有 server-side compaction（tsdown/tsdown.ai 配置、compaction gates），压缩历史保留关键信息。
   - 道生一：粗暴"裁剪最早非 system 消息到 120 万字符"，无智能压缩。
8. **会话管理工具集（sessions_*）+ Agent Harness**：agent 内部可 `sessions_spawn/yield/send/history/search/list`，甚至子代理可让位/续跑命名会话；plugin-sdk/agent-harness 可打包完整外部 agent 运行时（如 Codex 扩展）统一调度。
   - 道生一：有 subagent_delegate/subagent_parallel（一次性子任务）+ /run 队列 + 会话 fork，但**无"agent 可 spawn 命名会话并 resume/yield"的会话级工具**，也无第三方 agent harness 插件机制。

### D. 安全体系

9. **安全审计 + 威胁模型 + Doctor**：OpenClaw 有 `THREAT-MODEL-ATLAS.md`、100+ 安全审计检查（audit-checks：sandbox/exec/网络/插件信任/小模型风险…）、`openclaw doctor` 健康诊断、exposure runbook（暴露前安全清单）。
   - 道生一：有 HealthPanel 系统诊断 + 权限 tab + 审计面板（tool_audit），但**无"安全配置审计"级别的体系化检查**（无威胁模型文档、无 doctor 类自检）。
10. **SSRF 防护**：DNS pinning + IP 阻断 + hostname allowlist + private-network 策略（security-runtime：`resolvePinnedHostnameWithPolicy`、`isPrivateNetworkAllowedByPolicy`、`matchesHostnameAllowlist`）。
    - 道生一：内置 fetch_page / web_search 直接请求，**无 SSRF 防护**（无法阻止内网地址/SSRF 攻击面）。
11. **结构化"外部不可信内容"边界**：外部内容包裹/截断、prompt injection 防护 hook（`hooks.gmail.allowUnsafeExternalContent` 等开关）、channel metadata 标记不可信来源。
    - 道生一：提示词层有防注入引导，但无结构化"入站内容不可信"边界与开关。

### E. 媒体能力

12. **语音 / 图像生成 / 视频生成 / 媒体理解**：OpenClaw + LobsterAI 生态有 TTS/STT（speech、realtime-voice）、image-generation、media-understanding、Remotion 视频生成、Meeting 会议（浏览器会议插件、会议转录）。
    - 道生一：仅图片 OCR + 本地视觉描述，无语音、无图像/视频生成、无会议能力。

### F. 其他

13. **模型 provider 插件化**：新 provider 可作为插件注册（带 auth wizard），原生 pricing。
    - 道生一：通用 OpenAI 兼容 baseUrl + Ollama 本地，provider 未插件化。
14. **沙箱化浏览器**：sandbox 内浏览器（CDP bridge、noVNC、容器名 openclaw-sbx-browser）。
    - 道生一：外部 server-puppeteer（Edge 进程），无隔离。
15. **插件 grants / hooks / config 深度集成**：插件声明能力授予与 hook，operator 可审核插件信任。
    - 道生一：无。

## 三、道生一已领先 / 相当的（简要）

- **桌面原生体验**：Tauri 2 + Vue 3 单包原生应用（OpenClaw 是 Node 运行时 + 依赖 Web UI）。
- **记忆系统**：FTS5 + 语义向量 + 分层（facts/episodic/画像）+ 去重 + 衰减遗忘（OpenClaw 用 MEMORY.md/USER.md/SOUL.md 文件式，机制不同）。
- **知识库 RAG + 命名库**（kb_create/kb_add/kb_index/kb_search）。
- **可视化工作流编辑器**（VueFlow 节点画布）——OpenClaw 无此。
- **多 Agent 协作**（subagent_parallel + 角色 + 仲裁 synth）——OpenClaw 有 sessions/subagents 但无"角色/仲裁"产品化。
- **编程代理内置**（git/run_tests/analyze_project/code_index 语义检索）——OpenClaw 靠 Codex/Claude 等外部 agent harness 扩展。
- **本地 Ollama 部署**（一键拉模型/视觉/embedding）。
- **费用统计 / 审计面板 / 撤销回放 / PTY / exec CLI / execpolicy**。

## 四、可借鉴落地建议（按道生一四层体系归位，遵循"只吸收机制不复刻终端交互"）

- 🟢 **P1 上下文智能压缩**：实现 compaction——超长会话先 LLM 提炼要点再截断，替代粗暴裁剪。
- 🟢 **P2 SSRF 防护**：内置 fetch_page/web_search 加 hostname allowlist + 内网 IP 阻断（纯函数可测，仿 security-runtime）。
- 🟢 **P3 会话级工具集**：给 agent 提供 `session_spawn/resume/yield` 命名会话工具（复用既有 fork/queue）。
- 🟡 **P4 入站内容安全边界**：外部内容（网页/邮件/渠道消息）包裹标记 + 防注入开关。
- 🟡 **P5 配对审批**：IM 网关补"未知发送者→配对码审批"流程（复用 askConfirm）。
- 🟡 **P6 安全审计检查**：doctor 式自检（execpolicy/白名单/密钥加密/沙箱状态核查）并入 HealthPanel。
- 🔵 **P7 插件化 SDK（远期）**：定义最小插件契约（内置工具注册表 → 外部插件加载），是最重但最根本的架构差距。
- 🔵 **P8 OS 沙箱（远期）**：命令执行迁到可选沙箱（macOS 可用 `sandbox-exec` 轻量隔离起步）。

## 参考

- 仓库：https://github.com/openclaw/openclaw
- 文档：https://docs.openclaw.ai（gateway/security/sandboxing/plugins）
- 插件 SDK：docs/plugins/{architecture,sdk-overview,sdk-setup,sdk-runtime}
- 安全：docs/gateway/security/* 、docs/security/THREAT-MODEL-ATLAS.md
