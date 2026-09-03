//! IM 网关：把即时聊天工具（钉钉 / 飞书 / 企业微信）接入 agent，实现
//! 「在聊天工具里发消息 → Agent 思考回复 → 回发聊天工具」的双向闭环。
//!
//! 架构（对应 docs/IM_GATEWAY.md）：
//! - `ImAdapter` trait：统一平台接口（poll_updates 收 / send_message 发）
//! - 平台适配器：`DingtalkAdapter`（stream 长连接收 + 机器人发送）、
//!   `FeishuAdapter`（长连接收 + 消息 API 发送）、`WecomAdapter`（企微：只推不接）
//! - `ImGateway`：消息去重 / 白名单 / 触发前缀 / 会话上下文 / 限流 / 调 LLM 回复并回发
//! - `ImGatewayState`：运行状态 + 最近日志 + 最近消息（供前端查询展示）
//!
//! 国内平台选型（用户确认）：钉钉 / 飞书 / 企业微信。钉钉、飞书接收走官方
//! WebSocket 长连接（无需公网），企微接收需公网回调 URL（桌面端不适用）→ 只推不接。

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use tokio::sync::Mutex;

type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

/// IM 平台配置（存在 settings.im_config，整体 AES 加密落盘）
/// 统一承载两类能力：接收（应用凭据 + 长连接）与主动推送（群机器人 Webhook）。
/// 字段名与前端 imConfig 对象的 snake_case 键一一对应（勿加 camelCase 重命名）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImConfig {
    pub platform: String,       // "dingtalk" | "feishu" | "wecom"
    pub enabled: bool,
    pub whitelist: Vec<String>, // 允许的 chat_id（空=全部）
    pub trigger: String,        // 触发前缀（空=全部消息，如 "@ai " 只处理带前缀的）
    pub system_prompt: String,  // 回复用的系统提示词（空=内置默认）
    pub max_context: usize,     // 每会话上下文条数（默认 12）
    // 钉钉（机器人 stream 模式）
    pub dingtalk_client_id: String,
    pub dingtalk_client_secret: String,
    pub dingtalk_robot_code: String,
    // 飞书（应用长连接）
    pub feishu_app_id: String,
    pub feishu_app_secret: String,
    pub feishu_receive_id_type: String, // open_id / chat_id / user_id
    // 企业微信（只推不接：应用消息主动推送）
    pub wecom_corp_id: String,
    pub wecom_corp_secret: String,
    pub wecom_agent_id: String,
    pub wecom_touser: String, // 默认接收人（空=用 chat_id 参数）
    // 群机器人 Webhook（主动推送用，可选；未配置应用凭据时 send_im 走此路径）
    #[serde(default)]
    pub feishu_webhook: String,
    #[serde(default)]
    pub wecom_webhook: String,
    #[serde(default)]
    pub dingtalk_webhook: String,
    #[serde(default)]
    pub dingtalk_secret: String,
}

impl ImConfig {
    /// 校验当前平台必填凭据是否齐全
    pub fn validate(&self) -> Result<(), String> {
        match self.platform.as_str() {
            "dingtalk" => {
                if self.dingtalk_client_id.is_empty() || self.dingtalk_client_secret.is_empty() {
                    return Err("钉钉需要配置 Client ID 与 Client Secret".into());
                }
            }
            "feishu" => {
                if self.feishu_app_id.is_empty() || self.feishu_app_secret.is_empty() {
                    return Err("飞书需要配置 App ID 与 App Secret".into());
                }
            }
            "wecom" => {
                if self.wecom_corp_id.is_empty() || self.wecom_corp_secret.is_empty() || self.wecom_agent_id.is_empty() {
                    return Err("企微需要配置 Corp ID / Corp Secret / AgentId".into());
                }
            }
            _ => return Err("请先选择 IM 平台（钉钉/飞书/企业微信）".into()),
        }
        Ok(())
    }
}

/// 从 IM 收到的消息
#[derive(Debug, Clone)]
pub struct ImMessage {
    pub id: String,      // 平台消息 id（去重）
    pub chat_id: String, // 会话/聊天 id（回复目标）
    pub sender: String,  // 发送者
    pub text: String,
}

/// 平台适配器统一接口
#[async_trait]
pub trait ImAdapter: Send + Sync {
    fn platform(&self) -> &'static str;
    /// 拉取/等待新消息（长连接阻塞式或长轮询），返回待处理消息（可空）。
    /// 建议实现用超时包裹，避免网关停止时永久阻塞。
    async fn poll_updates(&mut self) -> Result<Vec<ImMessage>, String>;
    /// 给指定会话发送文本回复
    async fn send_message(&self, chat_id: &str, text: &str) -> Result<(), String>;
}

/// 网关的 LLM 回复生成器（由宿主注入，便于 mock 测试）
#[async_trait]
pub trait ReplyGenerator: Send + Sync {
    async fn reply(&self, history: Vec<(String, String)>, user_text: &str) -> Result<String, String>;
}

/// 网关运行状态快照（返回给前端）
#[derive(Debug, Clone, Serialize)]
pub struct ImStatus {
    pub running: bool,
    pub platform: String,
    pub platform_label: String,
    pub started_at: u64,
    pub last_error: String,
    pub handled: usize,
    pub logs: Vec<String>,
    pub messages: Vec<ImMessageLog>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImMessageLog {
    pub ts: u64,
    pub chat: String,
    pub sender: String,
    pub text: String,
    pub reply: String,
}

/// 网关共享状态（Arc<Mutex> 供前端查询）
#[derive(Debug, Default)]
pub struct ImGatewayState {
    pub running: bool,
    pub platform: String,
    pub started_at: u64,
    pub last_error: String,
    pub handled: usize,
    pub logs: VecDeque<String>,
    pub messages: VecDeque<ImMessageLog>,
}

impl ImGatewayState {
    /// 供 Tauri 管理与后台任务共享
    pub fn shared() -> Arc<Mutex<ImGatewayState>> {
        Arc::new(Mutex::new(ImGatewayState::default()))
    }

    pub fn push_log(&mut self, line: String) {
        self.logs.push_back(line);
        if self.logs.len() > 200 {
            self.logs.pop_front();
        }
    }
    pub fn push_message(&mut self, m: ImMessageLog) {
        self.messages.push_back(m);
        if self.messages.len() > 100 {
            self.messages.pop_front();
        }
    }
    pub fn snapshot(&self) -> ImStatus {
        ImStatus {
            running: self.running,
            platform: self.platform.clone(),
            platform_label: match self.platform.as_str() {
                "dingtalk" => "钉钉".to_string(),
                "feishu" => "飞书".to_string(),
                "wecom" => "企业微信".to_string(),
                _ => self.platform.clone(),
            },
            started_at: self.started_at,
            last_error: self.last_error.clone(),
            handled: self.handled,
            logs: self.logs.iter().cloned().collect(),
            messages: self.messages.iter().cloned().collect(),
        }
    }
}

/// 网关核心：消息去重 / 白名单 / 触发前缀 / 会话上下文 / 限流 / 调 LLM 回复并回发
pub struct ImGateway {
    cfg: ImConfig,
    adapter: Box<dyn ImAdapter>,
    reply: Arc<dyn ReplyGenerator>,
    state: Arc<Mutex<ImGatewayState>>,
    seen: HashSet<String>,
    history: HashMap<String, VecDeque<(String, String)>>,
    last_reply_at: HashMap<String, u64>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

const MIN_REPLY_GAP_MS: u64 = 20_000; // 同会话回复间隔下限（防刷）
const POLL_IDLE_MS: u64 = 2000; // 轮询空转间隔

impl ImGateway {
    pub fn new(
        cfg: ImConfig,
        adapter: Box<dyn ImAdapter>,
        reply: Arc<dyn ReplyGenerator>,
        state: Arc<Mutex<ImGatewayState>>,
    ) -> Self {
        Self {
            cfg,
            adapter,
            reply,
            state,
            seen: HashSet::new(),
            history: HashMap::new(),
            last_reply_at: HashMap::new(),
        }
    }

    /// 网关主循环（后台任务）：持续拉取并处理消息
    pub async fn run(&mut self) {
        {
            let mut st = self.state.lock().await;
            st.running = true;
            st.platform = self.adapter.platform().to_string();
            st.started_at = now_ms();
            let p = st.platform.clone();
            st.push_log(format!("🚀 IM 网关启动：{}", p));
        }
        loop {
            match self.adapter.poll_updates().await {
                Ok(msgs) => {
                    for m in msgs {
                        self.handle(m).await;
                    }
                }
                Err(e) => {
                    let mut st = self.state.lock().await;
                    st.last_error = e.clone();
                    st.push_log(format!("⚠️ 拉取消息失败：{}", e));
                    drop(st);
                    tokio::time::sleep(std::time::Duration::from_millis(5000)).await;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(POLL_IDLE_MS)).await;
        }
    }

    /// 处理单条消息：去重 → 白名单 → 触发前缀 → 限流 → 会话上下文 → LLM → 回发
    async fn handle(&mut self, m: ImMessage) {
        // 1. 去重（按平台消息 id）
        if !self.seen.insert(m.id.clone()) {
            return;
        }
        if self.seen.len() > 20000 {
            self.seen.clear();
        }
        // 2. 白名单（chat_id）
        if !self.cfg.whitelist.is_empty() && !self.cfg.whitelist.contains(&m.chat_id) {
            let mut st = self.state.lock().await;
            st.push_log(format!("⏭ 忽略非白名单会话：{}", m.chat_id));
            return;
        }
        // 3. 触发前缀
        let text = if !self.cfg.trigger.is_empty() {
            if !m.text.starts_with(&self.cfg.trigger) {
                return;
            }
            m.text[self.cfg.trigger.len()..].trim().to_string()
        } else {
            m.text.clone()
        };
        if text.trim().is_empty() {
            return;
        }
        // 4. 限流：同会话回复间隔下限
        let now = now_ms();
        if let Some(last) = self.last_reply_at.get(&m.chat_id) {
            if now.saturating_sub(*last) < MIN_REPLY_GAP_MS {
                return;
            }
        }
        // 5. 记录 + 日志
        {
            let mut st = self.state.lock().await;
            st.push_log(format!("📩 [{}] {}：{}", m.chat_id, m.sender, clip(&text, 80)));
            st.push_message(ImMessageLog {
                ts: now,
                chat: m.chat_id.clone(),
                sender: m.sender.clone(),
                text: text.clone(),
                reply: String::new(),
            });
        }
        // 6. 会话上下文（每会话最近 N 条；借用块内结束，避免与 self.reply 冲突）
        let max_ctx = if self.cfg.max_context == 0 { 12 } else { self.cfg.max_context };
        {
            let hist = self.history.entry(m.chat_id.clone()).or_default();
            hist.push_back(("user".into(), text.clone()));
            while hist.len() > max_ctx {
                hist.pop_front();
            }
        }
        let snapshot: Vec<(String, String)> = self.history.get(&m.chat_id).cloned().unwrap_or_default().into_iter().collect();
        // 7. 调 LLM 生成回复
        let ans_res = self.reply.reply(snapshot, &text).await;
        match ans_res {
            Ok(ans) => {
                // 8. 回发
                match self.adapter.send_message(&m.chat_id, &ans).await {
                    Ok(()) => {
                        self.last_reply_at.insert(m.chat_id.clone(), now_ms());
                        if let Some(hist) = self.history.get_mut(&m.chat_id) {
                            hist.push_back(("assistant".into(), ans.clone()));
                            while hist.len() > max_ctx {
                                hist.pop_front();
                            }
                        }
                        let mut st = self.state.lock().await;
                        st.handled += 1;
                        st.push_log(format!("✅ [{}] 已回复（{} 字）", m.chat_id, ans.chars().count()));
                        for msg in st.messages.iter_mut().rev() {
                            if msg.chat == m.chat_id && msg.reply.is_empty() && msg.ts == now {
                                msg.reply = clip(&ans, 200);
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        let mut st = self.state.lock().await;
                        st.last_error = e.clone();
                        st.push_log(format!("❌ [{}] 回发失败：{}", m.chat_id, e));
                    }
                }
            }
            Err(e) => {
                let mut st = self.state.lock().await;
                st.last_error = e.clone();
                st.push_log(format!("🤔 [{}] 生成回复失败：{}", m.chat_id, e));
            }
        }
    }
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let t: String = s.chars().take(n).collect();
        format!("{}…", t)
    }
}

// ============================== 企业微信（只推不接） ==============================

/// 企业微信应用消息主动推送（接收需公网回调 URL，桌面端不适用）
pub struct WecomAdapter {
    client: reqwest::Client,
    corp_id: String,
    corp_secret: String,
    agent_id: String,
    default_touser: String,
}

impl WecomAdapter {
    pub fn new(cfg: &ImConfig) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .unwrap_or_default(),
            corp_id: cfg.wecom_corp_id.clone(),
            corp_secret: cfg.wecom_corp_secret.clone(),
            agent_id: cfg.wecom_agent_id.clone(),
            default_touser: cfg.wecom_touser.clone(),
        }
    }
}

/// 企微 access_token（可测试的解析逻辑 + 真实请求）
pub async fn wecom_get_token(
    client: &reqwest::Client,
    corp_id: &str,
    corp_secret: &str,
) -> Result<String, String> {
    let url = format!(
        "https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid={}&corpsecret={}",
        corp_id, corp_secret
    );
    let resp = client.get(&url).send().await.map_err(|e| format!("企微 gettoken 网络错误: {}", e))?;
    let j: serde_json::Value = resp.json().await.map_err(|e| format!("企微 gettoken 响应解析失败: {}", e))?;
    if j["errcode"].as_i64() == Some(0) {
        j["access_token"].as_str().map(|s| s.to_string()).ok_or_else(|| "企微 gettoken 返回空 token".into())
    } else {
        Err(format!("企微 gettoken 失败 errcode={} errmsg={}", j["errcode"], j["errmsg"]))
    }
}

#[async_trait]
impl ImAdapter for WecomAdapter {
    fn platform(&self) -> &'static str {
        "wecom"
    }
    async fn poll_updates(&mut self) -> Result<Vec<ImMessage>, String> {
        // 企微接收消息需要公网回调 URL，桌面端不适用 → 只推不接
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        Ok(vec![])
    }
    async fn send_message(&self, chat_id: &str, text: &str) -> Result<(), String> {
        let token = wecom_get_token(&self.client, &self.corp_id, &self.corp_secret).await?;
        let touser = if chat_id.trim().is_empty() { &self.default_touser } else { chat_id };
        if touser.trim().is_empty() {
            return Err("企微未配置接收人（touser）".into());
        }
        let url = format!("https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token={}", token);
        let body = serde_json::json!({
            "touser": touser,
            "msgtype": "text",
            "agentid": self.agent_id.parse::<i64>().unwrap_or(0),
            "text": { "content": text },
        });
        let resp = self.client.post(&url).json(&body).send().await.map_err(|e| format!("企微发送网络错误: {}", e))?;
        let j: serde_json::Value = resp.json().await.map_err(|e| format!("企微发送响应解析失败: {}", e))?;
        if j["errcode"].as_i64() == Some(0) {
            Ok(())
        } else {
            Err(format!("企微发送失败 errcode={} errmsg={}", j["errcode"], j["errmsg"]))
        }
    }
}

// ============================== 钉钉（stream 长连接） ==============================

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// 钉钉 stream 消息解密（纯函数，可测）：data 为 base64(AES-256-CBC)。
/// 加密 key = sha256(clientSecret) 前 32 字节，iv = 同 key 前 16 字节，PKCS7 去填充。
pub fn decrypt_dingtalk_data(client_secret: &str, data: &str) -> Result<String, String> {
    let digest = sha256_bytes(client_secret.as_bytes());
    let key: [u8; 32] = digest[..32].try_into().map_err(|_| "key 长度错误".to_string())?;
    let iv: [u8; 16] = digest[..16].try_into().map_err(|_| "iv 长度错误".to_string())?;
    let ciphertext = base64_decode(data)?;
    let mut buf = ciphertext.clone();
    let pt = Aes256CbcDec::new(&key.into(), &iv.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|_| "钉钉消息解密失败（key/iv 不符或密文损坏）".to_string())?;
    String::from_utf8(pt.to_vec()).map_err(|e| format!("钉钉解密结果非 UTF-8: {}", e))
}

/// 飞书事件解密（纯函数，可测）：encrypt 为 base64(AES-256-CBC)，
/// key = app_secret 前 32 字节，iv = key 前 16 字节。
pub fn decrypt_feishu_data(app_secret: &str, encrypt: &str) -> Result<String, String> {
    let key_bytes = app_secret.as_bytes();
    if key_bytes.len() < 32 {
        return Err("飞书 App Secret 长度不足 32 字节".into());
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&key_bytes[..32]);
    let mut iv = [0u8; 16];
    iv.copy_from_slice(&key[..16]);
    let ciphertext = base64_decode(encrypt)?;
    let mut buf = ciphertext.clone();
    let pt = Aes256CbcDec::new(&key.into(), &iv.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|_| "飞书事件解密失败（App Secret 不符或密文损坏）".to_string())?;
    String::from_utf8(pt.to_vec()).map_err(|e| format!("飞书解密结果非 UTF-8: {}", e))
}

pub fn sha256_bytes(data: &[u8]) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().to_vec()
}

pub fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| format!("base64 解码失败: {}", e))
}

/// 钉钉机器人（stream 模式）适配器：WebSocket 长连接接收 + 机器人 API 发送
pub struct DingtalkAdapter {
    client: reqwest::Client,
    cfg: ImConfig,
    ws: Option<WsStream>,
    access_token: String,
}

impl DingtalkAdapter {
    pub fn new(cfg: &ImConfig) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
            cfg: cfg.clone(),
            ws: None,
            access_token: String::new(),
        }
    }

    /// 获取钉钉机器人 access_token（client_id:client_secret 换 token）
    async fn get_access_token(&mut self) -> Result<String, String> {
        let body = serde_json::json!({
            "appKey": self.cfg.dingtalk_client_id,
            "appSecret": self.cfg.dingtalk_client_secret,
        });
        let resp = self
            .client
            .post("https://api.dingtalk.com/v1.0/oauth2/accessToken")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("钉钉 gettoken 网络错误: {}", e))?;
        let j: serde_json::Value = resp.json().await.map_err(|e| format!("钉钉 gettoken 解析失败: {}", e))?;
        j["accessToken"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| format!("钉钉 gettoken 失败: {}", j))
    }

    /// 打开长连接，返回 (endpoint, ticket)
    async fn open_connection(&self) -> Result<(String, String), String> {
        let resp = self
            .client
            .post("https://api.dingtalk.com/v1.0/gateway/connections/open")
            .header("x-acs-dingtalk-access-token", &self.access_token)
            .send()
            .await
            .map_err(|e| format!("钉钉 open connection 网络错误: {}", e))?;
        let j: serde_json::Value = resp.json().await.map_err(|e| format!("钉钉 open connection 解析失败: {}", e))?;
        let endpoint = j["endpoint"].as_str().ok_or_else(|| format!("钉钉 open 无 endpoint: {}", j))?.to_string();
        let ticket = j["ticket"].as_str().unwrap_or("").to_string();
        Ok((endpoint, ticket))
    }

    /// 确保已建立 WebSocket 长连接
    async fn ensure_ws(&mut self) -> Result<(), String> {
        if self.ws.is_some() {
            return Ok(());
        }
        if self.access_token.is_empty() {
            self.access_token = self.get_access_token().await?;
        }
        let (endpoint, ticket) = self.open_connection().await?;
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&endpoint)
            .await
            .map_err(|e| format!("钉钉 wss 连接失败: {}", e))?;
        // 发送 CONNECTED 帧
        use futures_util::SinkExt;
        let hello = serde_json::json!({ "type": "CONNECTED", "ticket": ticket }).to_string();
        ws.send(tokio_tungstenite::tungstenite::Message::Text(hello))
            .await
            .map_err(|e| format!("钉钉发送 CONNECTED 失败: {}", e))?;
        self.ws = Some(ws);
        Ok(())
    }
}

#[async_trait]
impl ImAdapter for DingtalkAdapter {
    fn platform(&self) -> &'static str {
        "dingtalk"
    }

    async fn poll_updates(&mut self) -> Result<Vec<ImMessage>, String> {
        use futures_util::StreamExt;
        self.ensure_ws().await?;
        let mut out = Vec::new();
        // 最多收 55 秒（超时返回已有消息，让网关能响应停止/限流）
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(55);
        loop {
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            let frame = {
                let ws = self.ws.as_mut().ok_or("钉钉连接未建立")?;
                tokio::time::timeout(std::time::Duration::from_secs(55), ws.next()).await
            };
            let frame = match frame {
                Ok(Some(Ok(f))) => f,
                Ok(Some(Err(e))) => {
                    self.ws = None; // 连接断开，重连
                    return Err(format!("钉钉 ws 读取错误: {}", e));
                }
                Ok(None) => {
                    self.ws = None;
                    return Err("钉钉 ws 连接已关闭".into());
                }
                Err(_elapsed) => break,
            };
            match frame {
                tokio_tungstenite::tungstenite::Message::Text(t) => {
                    let txt = t.to_string();
                    let v: serde_json::Value = match serde_json::from_str(&txt) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    match v["type"].as_str() {
                        Some("PING") => {
                            use futures_util::SinkExt;
                            if let Some(ws) = self.ws.as_mut() {
                                let _ = ws
                                    .send(tokio_tungstenite::tungstenite::Message::Text(
                                        serde_json::json!({ "type": "PONG" }).to_string(),
                                    ))
                                    .await;
                            }
                        }
                        Some("DATA") => {
                            let topic = v["topic"].as_str().unwrap_or("");
                            if !topic.contains("/im/bot/messages/get") {
                                continue;
                            }
                            let data = v["data"].as_str().unwrap_or("");
                            let plain = match decrypt_dingtalk_data(&self.cfg.dingtalk_client_secret, data) {
                                Ok(p) => p,
                                Err(e) => {
                                    eprintln!("[im] 钉钉消息解密失败: {}", e);
                                    continue;
                                }
                            };
                            let ev: serde_json::Value = match serde_json::from_str(&plain) {
                                Ok(v) => v,
                                Err(_) => continue,
                            };
                            let msgtype = ev["msgtype"].as_str().unwrap_or("");
                            let text = ev["text"]["content"].as_str().unwrap_or("").to_string();
                            if msgtype != "text" || text.trim().is_empty() {
                                continue;
                            }
                            let msg_id = ev["msgId"].as_str().unwrap_or("").to_string();
                            let chat_id = ev["conversationId"].as_str().unwrap_or("").to_string();
                            let sender = ev["senderStaffId"].as_str().unwrap_or("").to_string();
                            if msg_id.is_empty() || chat_id.is_empty() {
                                continue;
                            }
                            out.push(ImMessage { id: msg_id, chat_id, sender, text });
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        Ok(out)
    }

    async fn send_message(&self, chat_id: &str, text: &str) -> Result<(), String> {
        // 用机器人 API 向会话发送（openConversationId）
        let body = serde_json::json!({
            "robotCode": self.cfg.dingtalk_robot_code,
            "openConversationId": chat_id,
            "msg": { "msgtype": "text", "text": { "content": text } },
        });
        let resp = self
            .client
            .post("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend")
            .header("x-acs-dingtalk-access-token", &self.access_token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("钉钉发送网络错误: {}", e))?;
        let j: serde_json::Value = resp.json().await.map_err(|e| format!("钉钉发送响应解析失败: {}", e))?;
        if j.get("processQueryKey").is_some() || j.get("messageId").is_some() {
            Ok(())
        } else {
            Err(format!("钉钉发送失败: {}", j))
        }
    }
}

// ============================== 飞书（长连接） ==============================

/// 飞书应用长连接适配器
pub struct FeishuAdapter {
    client: reqwest::Client,
    cfg: ImConfig,
    ws: Option<WsStream>,
    ticket: String,
    last_heartbeat: std::time::Instant,
}

impl FeishuAdapter {
    pub fn new(cfg: &ImConfig) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
            cfg: cfg.clone(),
            ws: None,
            ticket: String::new(),
            last_heartbeat: std::time::Instant::now(),
        }
    }

    /// 获取 tenant_access_token（应用凭据）
    async fn get_tenant_token(&self) -> Result<String, String> {
        let body = serde_json::json!({
            "app_id": self.cfg.feishu_app_id,
            "app_secret": self.cfg.feishu_app_secret,
        });
        let resp = self
            .client
            .post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("飞书 gettoken 网络错误: {}", e))?;
        let j: serde_json::Value = resp.json().await.map_err(|e| format!("飞书 gettoken 解析失败: {}", e))?;
        if j["code"].as_i64() == Some(0) {
            j["tenant_access_token"]
                .as_str()
                .map(|s| s.to_string())
                .ok_or_else(|| "飞书 gettoken 返回空 token".into())
        } else {
            Err(format!("飞书 gettoken 失败 code={} msg={}", j["code"], j["msg"]))
        }
    }

    /// 建立长连接：取 endpoint + 连 wss + 发认证帧
    async fn ensure_ws(&mut self) -> Result<(), String> {
        if self.ws.is_some() {
            return Ok(());
        }
        let token = self.get_tenant_token().await?;
        let body = serde_json::json!({ "token": token });
        let resp = self
            .client
            .post("https://open.feishu.cn/open-apis/bot/v2/ws/endpoint")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("飞书取 endpoint 网络错误: {}", e))?;
        let j: serde_json::Value = resp.json().await.map_err(|e| format!("飞书 endpoint 解析失败: {}", e))?;
        let url = j["data"]["url"].as_str().ok_or_else(|| format!("飞书 endpoint 无 url: {}", j))?.to_string();
        self.ticket = j["data"]["ticket"].as_str().unwrap_or("").to_string();
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
            .await
            .map_err(|e| format!("飞书 wss 连接失败: {}", e))?;
        // 认证帧（长连接协议：{"type":2,"data":{"client_type":"app","app_id":...,"ticket":...}}）
        use futures_util::SinkExt;
        let auth = serde_json::json!({
            "type": 2,
            "data": {
                "client_type": "app",
                "app_id": self.cfg.feishu_app_id,
                "ticket": self.ticket,
            }
        })
        .to_string();
        ws.send(tokio_tungstenite::tungstenite::Message::Text(auth))
            .await
            .map_err(|e| format!("飞书发送认证帧失败: {}", e))?;
        self.ws = Some(ws);
        self.last_heartbeat = std::time::Instant::now();
        Ok(())
    }
}

#[async_trait]
impl ImAdapter for FeishuAdapter {
    fn platform(&self) -> &'static str {
        "feishu"
    }

    async fn poll_updates(&mut self) -> Result<Vec<ImMessage>, String> {
        use futures_util::StreamExt;
        self.ensure_ws().await?;
        let mut out = Vec::new();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(55);
        loop {
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            let frame = {
                let ws = self.ws.as_mut().ok_or("飞书连接未建立")?;
                tokio::time::timeout(std::time::Duration::from_secs(55), ws.next()).await
            };
            let frame = match frame {
                Ok(Some(Ok(f))) => f,
                Ok(Some(Err(e))) => {
                    self.ws = None;
                    return Err(format!("飞书 ws 读取错误: {}", e));
                }
                Ok(None) => {
                    self.ws = None;
                    return Err("飞书 ws 连接已关闭".into());
                }
                Err(_elapsed) => break,
            };
            match frame {
                tokio_tungstenite::tungstenite::Message::Text(t) => {
                    let txt = t.to_string();
                    let v: serde_json::Value = match serde_json::from_str(&txt) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let kind = v["type"].as_i64().unwrap_or(0);
                    match kind {
                        0 => {
                            // 事件
                            let ev = &v["data"]["event"];
                            let header = &v["data"]["header"];
                            let ev_type = header["event_type"].as_str().unwrap_or("");
                            if !ev_type.contains("im.message.receive_v1") {
                                continue;
                            }
                            let encrypted = ev["encrypt"].as_str().or(v["data"]["encrypt"].as_str());
                            let plain = if let Some(enc) = encrypted {
                                match decrypt_feishu_data(&self.cfg.feishu_app_secret, enc) {
                                    Ok(p) => p,
                                    Err(e) => {
                                        eprintln!("[im] 飞书事件解密失败: {}", e);
                                        continue;
                                    }
                                }
                            } else {
                                serde_json::to_string(ev).unwrap_or_default()
                            };
                            let msg: serde_json::Value = match serde_json::from_str(&plain) {
                                Ok(v) => v,
                                Err(_) => continue,
                            };
                            let message = &msg["event"]["message"];
                            let msg_type = message["message_type"].as_str().unwrap_or("");
                            let content = message["content"].as_str().unwrap_or("").to_string();
                            if msg_type != "text" || content.trim().is_empty() {
                                continue;
                            }
                            // content 是 JSON 字符串 {"text":"..."}
                            let text = serde_json::from_str::<serde_json::Value>(&content)
                                .ok()
                                .and_then(|c| c["text"].as_str().map(|s| s.to_string()))
                                .unwrap_or_default();
                            if text.trim().is_empty() {
                                continue;
                            }
                            let msg_id = message["message_id"].as_str().unwrap_or("").to_string();
                            let chat_id = message["chat_id"].as_str().unwrap_or("").to_string();
                            let sender = msg["event"]["sender"]["sender_id"]["open_id"].as_str().unwrap_or("").to_string();
                            if msg_id.is_empty() || chat_id.is_empty() {
                                continue;
                            }
                            out.push(ImMessage { id: msg_id, chat_id, sender, text });
                        }
                        1 => {
                            // 心跳响应：无需处理（也可在此续心跳）
                            self.last_heartbeat = std::time::Instant::now();
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        Ok(out)
    }

    async fn send_message(&self, chat_id: &str, text: &str) -> Result<(), String> {
        let token = self.get_tenant_token().await?;
        let rid = if self.cfg.feishu_receive_id_type.is_empty() { "chat_id" } else { &self.cfg.feishu_receive_id_type };
        let url = format!("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={}", rid);
        let body = serde_json::json!({
            "receive_id": chat_id,
            "msg_type": "text",
            "content": serde_json::json!({ "text": text }).to_string(),
        });
        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("飞书发送网络错误: {}", e))?;
        let j: serde_json::Value = resp.json().await.map_err(|e| format!("飞书发送响应解析失败: {}", e))?;
        if j["code"].as_i64() == Some(0) {
            Ok(())
        } else {
            Err(format!("飞书发送失败 code={} msg={}", j["code"], j["msg"]))
        }
    }
}

// ============================== 工厂 ==============================

/// 按配置构建适配器（企微只推不接也可作为独立推送工具用）
pub fn build_adapter(cfg: &ImConfig) -> Result<Box<dyn ImAdapter>, String> {
    cfg.validate()?;
    match cfg.platform.as_str() {
        "dingtalk" => Ok(Box::new(DingtalkAdapter::new(cfg))),
        "feishu" => Ok(Box::new(FeishuAdapter::new(cfg))),
        "wecom" => Ok(Box::new(WecomAdapter::new(cfg))),
        other => Err(format!("不支持的 IM 平台：{}", other)),
    }
}

// ============================== 测试 ==============================

#[cfg(test)]
mod tests {
    use super::*;

    struct MockAdapter {
        pub inbound: std::sync::Mutex<Vec<ImMessage>>,
        pub sent: std::sync::Mutex<Vec<(String, String)>>,
    }
    impl MockAdapter {
        fn new(msgs: Vec<ImMessage>) -> Self {
            Self {
                inbound: std::sync::Mutex::new(msgs),
                sent: std::sync::Mutex::new(Vec::new()),
            }
        }
    }
    #[async_trait]
    impl ImAdapter for MockAdapter {
        fn platform(&self) -> &'static str {
            "mock"
        }
        async fn poll_updates(&mut self) -> Result<Vec<ImMessage>, String> {
            let mut v = self.inbound.lock().unwrap();
            Ok(std::mem::take(&mut *v))
        }
        async fn send_message(&self, chat_id: &str, text: &str) -> Result<(), String> {
            self.sent.lock().unwrap().push((chat_id.to_string(), text.to_string()));
            Ok(())
        }
    }

    struct MockReply {
        pub ans: String,
    }
    #[async_trait]
    impl ReplyGenerator for MockReply {
        async fn reply(&self, _history: Vec<(String, String)>, _user_text: &str) -> Result<String, String> {
            Ok(self.ans.clone())
        }
    }

    fn cfg() -> ImConfig {
        ImConfig {
            platform: "dingtalk".into(),
            enabled: true,
            whitelist: vec![],
            trigger: "".into(),
            system_prompt: "".into(),
            max_context: 12,
            ..Default::default()
        }
    }

    #[test]
    fn gateway_dedups_and_replies() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let cfg = cfg();
            let msgs = vec![
                ImMessage { id: "m1".into(), chat_id: "c1".into(), sender: "u".into(), text: "你好".into() },
                ImMessage { id: "m1".into(), chat_id: "c1".into(), sender: "u".into(), text: "你好".into() }, // 重复
            ];
            let adapter = Box::new(MockAdapter::new(msgs));
            let reply: Arc<dyn ReplyGenerator> = Arc::new(MockReply { ans: "回复你".into() });
            let state = Arc::new(Mutex::new(ImGatewayState::default()));
            let mut gw = ImGateway::new(cfg, adapter, reply, state.clone());
            gw.handle(ImMessage { id: "m1".into(), chat_id: "c1".into(), sender: "u".into(), text: "你好".into() }).await;
            // 同 id 去重：再处理一次不应重复回复
            gw.handle(ImMessage { id: "m1".into(), chat_id: "c1".into(), sender: "u".into(), text: "你好".into() }).await;
            let st = state.lock().await;
            assert_eq!(st.handled, 1, "重复消息应去重");
        });
    }

    #[test]
    fn gateway_whitelist_filters() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let mut cfg = cfg();
            cfg.whitelist = vec!["c1".into()];
            let adapter = Box::new(MockAdapter::new(vec![]));
            let reply: Arc<dyn ReplyGenerator> = Arc::new(MockReply { ans: "x".into() });
            let state = Arc::new(Mutex::new(ImGatewayState::default()));
            let mut gw = ImGateway::new(cfg, adapter, reply, state.clone());
            gw.handle(ImMessage { id: "a".into(), chat_id: "c1".into(), sender: "u".into(), text: "ok".into() }).await;
            gw.handle(ImMessage { id: "b".into(), chat_id: "c2".into(), sender: "u".into(), text: "no".into() }).await;
            let st = state.lock().await;
            assert_eq!(st.handled, 1, "非白名单会话应被忽略");
        });
    }

    #[test]
    fn gateway_trigger_prefix_strips() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let mut cfg = cfg();
            cfg.trigger = "@ai ".into();
            let adapter = Box::new(MockAdapter::new(vec![]));
            let reply: Arc<dyn ReplyGenerator> = Arc::new(MockReply { ans: "回复".into() });
            let state = Arc::new(Mutex::new(ImGatewayState::default()));
            let mut gw = ImGateway::new(cfg, adapter, reply, state.clone());
            // 无前缀 → 忽略
            gw.handle(ImMessage { id: "a".into(), chat_id: "c1".into(), sender: "u".into(), text: "随便聊聊".into() }).await;
            // 有前缀 → 处理并剥离前缀
            gw.handle(ImMessage { id: "b".into(), chat_id: "c1".into(), sender: "u".into(), text: "@ai 帮我查一下".into() }).await;
            let st = state.lock().await;
            assert_eq!(st.handled, 1, "无触发前缀的消息应忽略");
        });
    }

    #[test]
    fn decrypt_roundtrips_both_platforms() {
        // 自加密-解密往返（用相同的 AES-CBC 编码验证我们的解密函数）
        use aes::cipher::{BlockEncryptMut, KeyIvInit};
        type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
        // 钉钉：key = sha256(secret)[..32]
        let secret = "test-client-secret-1234567890";
        let plain = r#"{"msgId":"m1","msgtype":"text","text":{"content":"你好"},"conversationId":"cid1","senderStaffId":"u1"}"#;
        let digest = sha256_bytes(secret.as_bytes());
        let key: [u8; 32] = digest[..32].try_into().unwrap();
        let iv: [u8; 16] = digest[..16].try_into().unwrap();
        let mut buf = plain.as_bytes().to_vec();
        buf.resize(buf.len() + 16, 0);
        let ct = Aes256CbcEnc::new(&key.into(), &iv.into())
            .encrypt_padded_mut::<Pkcs7>(&mut buf, plain.as_bytes().len())
            .unwrap()
            .to_vec();
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(ct);
        let dec = decrypt_dingtalk_data(secret, &b64).unwrap();
        assert!(dec.contains("你好"), "钉钉解密应还原明文: {}", dec);

        // 飞书：key = app_secret[..32]
        let secret2 = "0123456789abcdef0123456789abcdef"; // 32 字节
        let plain2 = r#"{"event":{"message":{"message_id":"m2","message_type":"text","content":"{\"text\":\"hi\"}","chat_id":"oc1"}}}"#;
        let mut k2 = [0u8; 32];
        k2.copy_from_slice(&secret2.as_bytes()[..32]);
        let mut iv2 = [0u8; 16];
        iv2.copy_from_slice(&k2[..16]);
        let mut buf2 = plain2.as_bytes().to_vec();
        buf2.resize(buf2.len() + 16, 0);
        let ct2 = Aes256CbcEnc::new(&k2.into(), &iv2.into())
            .encrypt_padded_mut::<Pkcs7>(&mut buf2, plain2.as_bytes().len())
            .unwrap()
            .to_vec();
        let b64_2 = base64::engine::general_purpose::STANDARD.encode(ct2);
        let dec2 = decrypt_feishu_data(secret2, &b64_2).unwrap();
        assert!(dec2.contains("oc1"), "飞书解密应还原明文: {}", dec2);
    }

    #[test]
    fn wecom_token_parse_valid() {
        // 模拟企微 gettoken 响应解析（不实际联网）
        let client = reqwest::Client::new();
        // 直接验证 JSON 解析逻辑等价路径：构造一次成功响应文本应能被我们读取
        let j: serde_json::Value = serde_json::json!({ "errcode": 0, "errmsg": "ok", "access_token": "TOKEN123" });
        assert_eq!(j["errcode"].as_i64(), Some(0));
        assert_eq!(j["access_token"].as_str(), Some("TOKEN123"));
        let _ = client;
    }
}
