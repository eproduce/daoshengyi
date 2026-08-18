# 道生一 × 即时聊天工具（IM 网关）对接设计

> 目标：让「道生一」这个 AI Agent 桌面客户端能对接即时聊天工具（Telegram / 企业微信 / 钉钉 / 飞书 / Slack 等），
> 实现「**别人在聊天工具里发消息 → Agent 自动思考并回复**」的双向即时闭环。
>
> 状态：**设计稿**（2026-08-19）。尚未实现，等确认目标平台后按 Phase 实施。

---

## 1. 核心难点

道生一当前是「**用户主动提问 → Agent 回复**」的**单向**链路。即时聊天是**双向 + 事件驱动**：

- **发送消息**：调 IM 平台的 Bot API（出站 HTTP）→ 现有 `reqwest` 就能做。
- **接收消息（真正的难点）**：别人随时发消息，需要「平台主动通知 / Agent 定时拉取」。
  - 道生一是**桌面应用**：无公网 IP、无入站 HTTP 服务器。
  - 结论：**首选「长轮询（Long Polling）」**，不需要公网、不需要新依赖。

## 2. 现有可复用能力（已确认）

| 能力 | 现状 |
|---|---|
| 出站 HTTP（调 IM API 发消息） | ✅ `reqwest`（rustls） |
| 后台常驻任务 | ✅ tokio 运行时 + `scheduled_tasks` 线程（`lib.rs:2342`） |
| 生成回复链路 | ✅ `chat_once`（非流式，IM 回复首选）/ `send_message`（流式） |
| MCP 插件接入 | ✅ 插件市场 + stdio 客户端 |
| 入站 HTTP（webhook） | ❌ 无（无 axum/tiny_http） |

## 3. 总体架构（推荐）

```
┌──────────────────────── 道生一桌面应用 ────────────────────────┐
│                                                                │
│  Rust 端新增 im.rs（IM 网关层）                                 │
│  ┌────────────────────────────────────────────┐               │
│  │  ImGateway（tokio::spawn 常驻任务）          │               │
│  │  ┌─────────┐  poll_updates()   ┌─────────┐  │               │
│  │  │ Telegram│◄──────────────────│ 适配器    │  │               │
│  │  │ 企业微信 │◄──── 统一 Trait ──│ (trait)  │  │               │
│  │  │ 钉钉/飞书│  send_message()  │ 多实现    │  │               │
│  │  └─────────┘                   └─────────┘  │               │
│  │        │ 新消息（去重/白名单/触发词）          │               │
│  │        ▼                                    │               │
│  │  ┌─────────────┐  chat_once()   ┌────────┐  │               │
│  │  │ 消息处理循环  │───────────────►│ 现有 AI │  │               │
│  │  │(会话上下文/限流)│◄──────────────│ 聊天链路│  │               │
│  │  └─────────────┘   回复文本      └────────┘  │               │
│  └────────────────────────────────────────────┘               │
│                                                                │
│  前端：设置新增「即时聊天」Tab（开关/平台/token/白名单/日志）      │
└────────────────────────────────────────────────────────────────┘
```

### 3.1 平台适配器抽象（`src-tauri/src/im.rs`）

```rust
/// 统一 IM 平台接口：每种平台实现一个适配器
pub trait ImAdapter: Send + Sync {
    /// 平台标识：telegram / wecom / dingtalk / lark / slack
    fn platform(&self) -> &'static str;
    /// 拉取新消息（长轮询或增量拉取），返回待处理消息
    async fn poll_updates(&self) -> Result<Vec<ImMessage>, String>;
    /// 给指定会话发送回复
    async fn send_message(&self, chat_id: &str, text: &str) -> Result<(), String>;
}

pub struct ImMessage {
    /// 平台内部消息 id（用于去重，如 Telegram update_id / 企业微信 msgid）
    pub id: String,
    pub chat_id: String,
    pub sender: String,
    pub text: String,
}
```

### 3.2 网关核心（`ImGateway`）

- `tokio::spawn` 常驻后台任务，按平台 `poll_updates` 间隔轮询。
- **去重**：内存 `HashSet<msg_id>`（上限裁剪），持久化可选。
- **白名单/触发词**：只处理允许的 `chat_id`（设置里配置）；可选前缀（如 `/ai`）避免全量接管群聊。
- **会话上下文**：按 `chat_id` 维护最近 N 条（复用 `messages` 表思路，或独立内存 LRU）。
- **限流**：同一会话并发 1 个请求，回复间隔下限。
- **回复**：调 `chat_once` 生成（非流式，IM 不需要逐字），思考过长可提示「正在思考…」。

## 4. 各平台可行性 & 对接要点

| 平台 | 接收方式 | 发送方式 | 国内直连 | 备注 |
|---|---|---|---|---|
| **Telegram** | `getUpdates` 长轮询（免费、无需公网） | `sendMessage` | ❌ 需代理 | **首选参考实现**，API 最简单 |
| **Slack** | Socket Mode（WebSocket，无需公网） | `chat.postMessage` | ❌ | 需配 Socket Token |
| **钉钉** | 机器人 WebSocket（`stream` 模式，无需公网，较新） | 机器人消息 API | ✅ | 国内可落地 |
| **飞书** | 长连接 WebSocket SDK | 消息 API | ✅ | 国内可落地 |
| **企业微信** | 应用「接收消息」需回调 URL（公网）→ 桌面端难 | 应用消息 API（`corpid+secret+agentid`） | ✅ | **接收消息是坎**；只推不接则可行 |
| **微信个人号** | — | — | — | **封号风险，不建议** |

> 结论：**境外可访问 → Telegram 起步最顺；国内 → 钉钉 / 飞书（WebSocket）优先，企业微信只做主动推送较稳。**

## 5. 与现有系统的接入点

1. **设置存储**：`AppSettings` 新增 `im_enabled: bool` + `im_platform: String` + `im_config: serde_json::Value`（token/白名单等，敏感字段走现有 AES-256-GCM 加密，参考 `brave_api_key` 的做法）。
2. **设置 UI**：`SettingsDialog.vue` 新增「💬 即时聊天」Tab（或并入「插件」Tab）：开关、平台选择、Token 输入、白名单 chat_id、连接状态、最近消息日志。
3. **回复复用**：网关内直接调 `chat_once`（已在 `chat.ts` 封装过 Rust 命令，IM 网关在 Rust 端可调用内部 `api::chat_once` 或复用 `chat_once` 命令逻辑）。
4. **生命周期**：应用启动时若启用则 spawn 网关任务；退出/切换平台时 abort。参考 `scheduled_tasks` 的后台线程模式。

## 6. 分阶段实施计划

### Phase 1 — MCP 插件先行（近渴，零代码）
- 在「插件市场」装现成 Telegram/Slack 等 MCP 服务器，Agent 可**主动**发消息、查消息。
- 缺点：非自动（需用户问它才动）。适合先满足「能发能查」。

### Phase 2 — 通用 IM 网关框架（核心）
1. 新增 `src-tauri/src/im.rs`：`ImAdapter` trait + `ImGateway`（去重/白名单/限流/会话）。
2. 新增 `AppSettings.im_*` 字段（加密）+ 设置 UI「即时聊天」Tab。
3. 实现 **Telegram 适配器**作为首个参考实现，打通双向闭环。
4. 前端显示连接状态与消息日志。
5. `cargo check` + 手动实测（发消息 → 回复）。

### Phase 3 — 国内平台适配
- 钉钉（WebSocket）/ 飞书（长连接）适配器；企业微信主动推送。
- 复用同一 `ImAdapter` trait，每个平台只写一个适配器。

## 7. 待确认决策点

- [ ] **目标平台**：Telegram（境外）还是 钉钉/飞书/企业微信（国内）？
- [ ] **场景**：自动回复 / 消息入口（当 app 用）/ 主动推送提醒 / 群助手？
- [ ] **是否需要公网/代理**：决定长轮询 vs WebSocket vs webhook+穿透。
- [ ] **安全**：是否限制只回复指定 chat_id；群聊是否需触发词前缀。

> 确认后即可按 Phase 2 开始实现（推荐先做 Telegram 参考实现，跑通架构再扩展国内平台）。
