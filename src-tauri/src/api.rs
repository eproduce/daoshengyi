//! LLM API 请求层：与 OpenAI 兼容端点通信。
//!
//! - `stream_chat`：SSE 流式对话（分块解码 + 缓存命中统计）
//! - `chat_once`：非流式单轮请求（供子代理 / IM 回复 / 非交互 exec 等使用）
//! - `ApiConfig` / `ChatMessage` / `ChatOnceResult` 等共享类型

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ApiConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub max_tokens: u32,
    pub temperature: f32,
    pub thinking_enabled: bool,
    pub reasoning_effort: String,
    pub system_prompt: String,
    pub enable_web_search: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: serde_json::Value,
    /// 原生 function calling：assistant 消息携带的结构化工具调用（OpenAI 风格
    /// `[{id,type:"function",function:{name,arguments}}]`），续接对话时必须原样回传。
    /// 仅聊天请求走前端注入；缺失时序列化省略，不影响旧的纯文本请求。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<serde_json::Value>,
    /// 原生 function calling：`role:"tool"` 结果消息必须携带的 `tool_call_id`，
    /// 用于把结果关联回上一条 assistant 消息里的某个调用。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// 上一轮 assistant 的思维链。**官方明确要求：请求携带 `tools` 时，历史轮次的
    /// `reasoning_content` 应回传并被拼进上下文**（不带 tools 时传了也会被忽略）。
    /// 不回传的代价：多轮工具循环里模型「忘了自己刚才怎么想的」，容易原地打转；
    /// 回传后这些 token 还能命中 KV 缓存（它们是前缀的一部分）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

/// 是否 DeepSeek 官方端点。
///
/// 为什么要区分：`thinking` / `reasoning_effort` 是 **DeepSeek 扩展字段**。本地兜底
/// （llama.cpp / LM Studio / vLLM）与多数第三方 OpenAI 兼容网关并不认识它们，
/// 轻则忽略、重则 400（`unknown field`）。所以对非官方端点**只发标准 OpenAI 字段**。
pub fn is_deepseek_endpoint(base_url: &str) -> bool {
    let u = base_url.trim().to_ascii_lowercase();
    u.contains("deepseek.com") || u.contains("api.deepseek")
}

/// 思考强度规范化到官方值域 `none | low | high | max`。
///
/// 官方文档：出于兼容考虑 `minimal → low`、`medium/xhigh → high`（我们列表里可能还留着旧值）。
/// 未知值一律降到 `high`（官方默认），**绝不能**把未知字符串原样发出去当实验品。
pub fn normalize_reasoning_effort(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "none" | "disabled" => "none",
        "minimal" | "low" => "low",
        "high" | "medium" | "xhigh" | "" => "high",
        "max" | "ultra" => "max",
        _ => "high",
    }
}

/// 思考模式下 `max_tokens` 的下限。
///
/// 官方：未设置时非思考模式默认 8K、思考模式默认 64K。而我们按用户设置发 `max_tokens`
/// （常见 8192）——**思考模式下思维链会先把这 8K 吃光**，正文只剩半句，
/// 表现为 `finish_reason=length` 反复续写。所以思考模式给一个下限，低于它按它发。
pub const THINKING_MIN_OUTPUT_TOKENS: u32 = 16_384;

/// 构造一次 chat/completions 请求体（纯函数，便于逐条验证参数语义）。
///
/// 这里集中处理三件在文档里写得很明确、但很容易写错的事：
/// 1. **关闭思考必须显式发 `thinking: {type:"disabled"}`** —— 省略 `thinking` 与
///    `reasoning_effort` 时官方**默认开启思考**，所以「不传」根本关不掉；
/// 2. **思考模式下 `temperature` 不生效**（官方原文），照发只会让人以为调过温度，
///    所以思考模式干脆不发；
/// 3. 非 DeepSeek 端点不发 DeepSeek 扩展字段（本地兜底要能跑）。
pub fn build_chat_body(
    config: &ApiConfig,
    messages: serde_json::Value,
    tools: Option<serde_json::Value>,
    stream: bool,
) -> serde_json::Value {
    // 「思考模式」只在 DeepSeek 官方端点成立：本地兜底与第三方网关没有这个语义，
    // 把它们当思考模式处理（去掉 temperature、抬 max_tokens）只会让行为变得不可解释。
    let thinking = config.thinking_enabled && is_deepseek_endpoint(&config.base_url);
    let mut body = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "stream": stream,
    });
    // 非思考模式保留用户温度；思考模式下官方明确不生效 → 不发（避免"假生效"）
    if !thinking {
        body["temperature"] = serde_json::json!(config.temperature);
    }
    body["max_tokens"] = serde_json::json!(if thinking {
        config.max_tokens.max(THINKING_MIN_OUTPUT_TOKENS)
    } else {
        config.max_tokens
    });
    if let Some(tools) = tools {
        body["tools"] = tools;
        body["tool_choice"] = serde_json::json!("auto");
    }
    if is_deepseek_endpoint(&config.base_url) {
        body["thinking"] = serde_json::json!({
            "type": if thinking { "enabled" } else { "disabled" }
        });
        if thinking {
            body["reasoning_effort"] =
                serde_json::json!(normalize_reasoning_effort(&config.reasoning_effort));
        }
    }
    body
}

/// 发送 POST 请求到 OpenAI 兼容端点，连接阶段失败自动重试。
///
/// `error sending request for url` 这类网络错误几乎都发生在**连接建立阶段**
/// （DNS 解析 / 本地代理切换 / TLS 握手 / 连接重置）——瞬时抖动居多，一次失败就让
/// 整个 agent 会话中断，体验很差。HTTP 状态码错误（401/429/5xx）已进入响应阶段、
/// 不会走到这里，交由调用方处理。因此对 `.send()` 返回 Err 最多重试 3 次
/// （0.5s/1s 退避）：响应头尚未收到，重发请求不会产生重复生成内容。
async fn post_chat_with_retry(
    url: &str,
    api_key: &str,
    body: String,
    connect_timeout: std::time::Duration,
    total_timeout: Option<std::time::Duration>,
) -> Result<reqwest::Response, String> {
    const MAX_ATTEMPTS: u32 = 3;
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let mut builder = reqwest::Client::builder().connect_timeout(connect_timeout);
        if let Some(t) = total_timeout {
            builder = builder.timeout(t);
        }
        let client = builder
            .build()
            .map_err(|e| format!("客户端构建失败: {}", e))?;
        match client
            .post(url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", api_key))
            .body(body.clone())
            .send()
            .await
        {
            Ok(r) => return Ok(r),
            Err(e) if attempt < MAX_ATTEMPTS => {
                let backoff_ms = 500u64 * (1 << (attempt - 1));
                let warn = format!(
                    "[api] 连接失败（第 {}/{} 次）：{}，{}ms 后自动重试",
                    attempt, MAX_ATTEMPTS, e, backoff_ms
                );
                eprintln!("{}", warn);
                tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
            }
            Err(e) => return Err(format!("网络错误: {}", e)),
        }
    }
}

/// 发送流式聊天请求，返回 SSE 事件流。
/// `tools`：可选的 OpenAI 风格 function schema 数组；传入即启用「原生 function calling」，
/// 模型会以结构化 `delta.tool_calls` 返回工具调用（而非文本 <tool_call>），更稳、可规避思考模式吞调用。
pub async fn stream_chat(
    config: ApiConfig,
    messages: Vec<ChatMessage>,
    tools: Option<serde_json::Value>,
) -> Result<impl futures::Stream<Item = Result<String, String>>, String> {
    let base_url = config.base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base_url);

    let body = build_chat_body(
        &config,
        serde_json::to_value(&messages).unwrap_or(serde_json::Value::Null),
        tools,
        true,
    );

    // 连接阶段失败（DNS/代理/TLS 等瞬时抖动）由 post_chat_with_retry 自动重试；
    // 流式一旦建立，整体不做总超时（长思考/长输出可持续推流，空闲由前端兜底）。
    let response = post_chat_with_retry(
        &url,
        &config.api_key,
        body.to_string(),
        std::time::Duration::from_secs(10),
        None,
    )
    .await?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        return Err(format!(
            "[{}] {}",
            status,
            text.chars().take(300).collect::<String>()
        ));
    }

    use futures::StreamExt;
    // 累积缓冲：SSE chunk 可能在 UTF-8 多字节字符（如中文 3 字节）中间断开，
    // 直接用 from_utf8_lossy 会用 U+FFFD（�）替换未完成字节导致乱码。
    // 这里保留尾部未完成字节，等下一 chunk 补全后再解码。
    let mut pending: Vec<u8> = Vec::new();
    let stream = response.bytes_stream().map(move |chunk| {
        let mut out = String::new();
        match chunk {
            Ok(bytes) => {
                pending.extend_from_slice(&bytes);
                match std::str::from_utf8(&pending) {
                    Ok(s) => {
                        out.push_str(s);
                        pending.clear();
                    }
                    Err(e) => {
                        let valid = e.valid_up_to();
                        if valid > 0 {
                            // 输出已完整的 UTF-8 部分，保留尾部未完成字节
                            out.push_str(std::str::from_utf8(&pending[..valid]).unwrap());
                            pending.drain(..valid);
                        }
                        // 若存在确定的无效字节序列（error_len 非 None，即不是“不完整多字节”而是真无效），
                        // 必须丢弃它（至少 1 字节），否则 valid_up_to 永远为 0、pending 无限增长，
                        // 后续所有内容都不再输出 → 表现为流中断/内容丢失
                        if let Some(err_len) = e.error_len() {
                            let skip = err_len.max(1).min(pending.len());
                            pending.drain(..skip);
                        }
                        // 剩余尾部（不完整多字节，error_len=None）保留等待下一 chunk 补全
                    }
                }
            }
            Err(e) => return Err(format!("流错误: {}", e)),
        }
        Ok::<String, String>(out)
    });

    Ok(stream)
}

/// 解析 SSE 事件，提取 delta 内容
pub fn parse_sse_line(line: &str) -> Option<SSEDelta> {
    let data = line.trim().strip_prefix("data:")?;
    let data = data.trim();
    if data == "[DONE]" {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(data).ok()?;

    // 关键：DeepSeek 流式在最后一个 chunk 返回 usage，且此时 choices 为空数组。
    // 必须先把 usage 解析出来（不依赖 choices），否则用 choices 的 ? 链会提前 return，
    // usage 丢失 → 前端缓存命中率恒为 0%（看似费 token）。
    let usage = parsed.get("usage");
    let total = usage.and_then(|u| u.get("total_tokens").and_then(|v| v.as_u64()));
    // 计费口径：必须把「输入(prompt) / 输出(completion)」分开上报。
    // 过去只下发 total_tokens，前端把它当「回复 token」显示并**按输出单价**估算费用，
    // 导致 379 字的回复显示成 28240 tokens、单条费用虚高（详见 AGENT_DIAGNOSIS）。
    let prompt_tokens = usage.and_then(|u| u.get("prompt_tokens").and_then(|v| v.as_u64()));
    let completion_tokens = usage.and_then(|u| u.get("completion_tokens").and_then(|v| v.as_u64()));
    // 缓存命中/未命中 token：DeepSeek 用 prompt_cache_hit/miss_tokens；兼容其他厂商字段
    let cache_hit = usage.and_then(|u| {
        u.get("prompt_cache_hit_tokens")
            .or_else(|| u.get("cache_read_input_tokens"))
            .or_else(|| u.get("cached_tokens"))
            .and_then(|v| v.as_u64())
    });
    let cache_miss = usage.and_then(|u| {
        u.get("prompt_cache_miss_tokens")
            .or_else(|| u.get("cache_creation_input_tokens"))
            .or_else(|| u.get("uncached_tokens"))
            .and_then(|v| v.as_u64())
    });

    // choices 可能为空数组（usage 块），此时 delta 为 None，但 usage 仍需上报
    let delta = parsed
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("delta"));
    let reasoning = delta.and_then(|d| d.get("reasoning_content").and_then(|v| v.as_str()));
    let content = delta.and_then(|d| d.get("content").and_then(|v| v.as_str()));

    // 原生 function calling：DeepSeek/OpenAI 流式把工具调用放在 delta.tool_calls（按 index 分片）。
    // 需要单独解析并透传，绝不能因为 content/reasoning 为空就把携带 tool_calls 的 chunk 丢弃。
    let tool_calls = delta
        .and_then(|d| d.get("tool_calls").and_then(|v| v.as_array()))
        .map(|arr| {
            arr.iter()
                .filter_map(|it| {
                    let index = it.get("index").and_then(|v| v.as_u64())? as usize;
                    Some(StreamToolCallDelta {
                        index,
                        id: it.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()),
                        name: it
                            .get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        arguments: it
                            .get("function")
                            .and_then(|f| f.get("arguments"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                    })
                })
                .collect::<Vec<_>>()
        });

    // 结束原因：最后的 chunk 往往只有 finish_reason（delta 为空），不能因此丢弃
    let finish_reason = parsed
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("finish_reason"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if reasoning.is_none()
        && content.is_none()
        && total.is_none()
        && prompt_tokens.is_none()
        && completion_tokens.is_none()
        && tool_calls.is_none()
        && finish_reason.is_none()
    {
        return None;
    }

    Some(SSEDelta {
        reasoning_content: reasoning.map(|s| s.to_string()),
        content: content.map(|s| s.to_string()),
        tokens: total,
        prompt_tokens,
        completion_tokens,
        cache_hit,
        cache_miss,
        tool_calls,
        finish_reason,
    })
}

/// 原生工具调用的流式分片（对应 OpenAI `delta.tool_calls[i]`）。
/// `arguments` 可能被拆成多段文本，需要按 `index` 累积合并后再执行。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamToolCallDelta {
    pub index: usize,
    pub id: Option<String>,
    pub name: Option<String>,
    pub arguments: Option<String>,
}

/// 把流式返回的 tool_calls 分片按 index 合并为完整的函数调用列表。
/// 返回 OpenAI 风格 `[{id, type:"function", function:{name, arguments}}]`，
/// arguments 为完整 JSON 字符串（执行前再解析）。
pub fn resolve_tool_calls(deltas: &[StreamToolCallDelta]) -> Vec<serde_json::Value> {
    let mut order: Vec<usize> = Vec::new();
    let mut map: std::collections::HashMap<usize, (Option<String>, Option<String>, String)> =
        std::collections::HashMap::new();
    for d in deltas {
        let e = map
            .entry(d.index)
            .or_insert_with(|| (None, None, String::new()));
        if e.0.is_none() && d.id.is_some() {
            e.0 = d.id.clone();
        }
        if e.1.is_none() && d.name.is_some() {
            e.1 = d.name.clone();
        }
        if let Some(a) = &d.arguments {
            e.2.push_str(a);
        }
        if !order.contains(&d.index) {
            order.push(d.index);
        }
    }
    order
        .iter()
        .filter_map(|&idx| {
            let (id, name, args) = map.get(&idx)?;
            let name = name.clone().unwrap_or_default();
            if name.is_empty() {
                return None;
            }
            Some(serde_json::json!({
                "id": id.clone().unwrap_or_default(),
                "type": "function",
                "function": { "name": name, "arguments": args.clone() }
            }))
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct SSEDelta {
    pub reasoning_content: Option<String>,
    pub content: Option<String>,
    /// 该轮请求的总 token（prompt + completion；仅作诊断用，**不要**当回复产出）
    pub tokens: Option<u64>,
    /// 输入 token（该轮请求的 prompt 部分）
    pub prompt_tokens: Option<u64>,
    /// 输出 token（该轮模型真正生成的回复部分）
    pub completion_tokens: Option<u64>,
    pub cache_hit: Option<u64>,
    pub cache_miss: Option<u64>,
    /// 原生 function calling：本 chunk 携带的工具调用分片（有则处理，无则 None）
    pub tool_calls: Option<Vec<StreamToolCallDelta>>,
    /// 结束原因："stop" 正常结束 / "length" 达到 max_tokens 被截断 / "tool_calls" 等。
    /// 前端据此判断回复是否被截断（"length" 时必须续写，绝不能把半截话当最终答案）。
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatOnceResult {
    pub content: String,
    pub reasoning_content: String,
    pub cache_hit: u64,
    pub cache_miss: u64,
    /// 原生 function calling：非流式响应 `message.tool_calls`（OpenAI 风格
    /// `[{id,type:"function",function:{name,arguments}}]`），无工具调用时为 None。
    pub tool_calls: Option<Vec<serde_json::Value>>,
}

/// 纯函数：从非流式 /v1/chat/completions 响应中提取 `message.tool_calls`（已完整成组，
/// 无需分片合并）。无则 None。
fn extract_message_tool_calls(json: &serde_json::Value) -> Option<Vec<serde_json::Value>> {
    json["choices"][0]["message"]["tool_calls"]
        .as_array()
        .cloned()
        .filter(|a| !a.is_empty())
}

/// 非流式单轮聊天请求，返回完整回复（供子代理等后台 ReAct 工具循环使用）。
/// `tools`：可选 OpenAI 风格 function schema 数组；传入即启用「原生 function calling」，
/// 模型以结构化 `message.tool_calls` 返回工具调用（而非文本 <tool_call>），更稳。
pub async fn chat_once(
    config: ApiConfig,
    messages: Vec<ChatMessage>,
    tools: Option<serde_json::Value>,
) -> Result<ChatOnceResult, String> {
    let base_url = config.base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base_url);

    let body = build_chat_body(
        &config,
        serde_json::to_value(&messages).unwrap_or(serde_json::Value::Null),
        tools,
        false,
    );

    // 非流式单次请求超时（chat_once 供子代理 / 工作流 LLM 节点 / IM 回复使用）：
    // 固定 120s 整体 deadline 会间歇性误杀长输入/长输出（生成常超 120s，表现≈随机失败、
    // 长文截断）；连接阶段仍 10s 防卡，整体放宽到 600s——服务端只要持续响应就等它完成。
    // 连接阶段瞬时失败（DNS/代理/TLS）由 post_chat_with_retry 自动重试。
    let response = post_chat_with_retry(
        &url,
        &config.api_key,
        body.to_string(),
        std::time::Duration::from_secs(10),
        Some(std::time::Duration::from_secs(600)),
    )
    .await?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        return Err(format!(
            "[{}] {}",
            status,
            text.chars().take(300).collect::<String>()
        ));
    }

    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let reasoning_content = json["choices"][0]["message"]
        .get("reasoning_content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let usage = json.get("usage");
    let cache_hit = usage
        .and_then(|u| u.get("prompt_cache_hit_tokens").and_then(|v| v.as_u64()))
        .unwrap_or(0);
    let cache_miss = usage
        .and_then(|u| u.get("prompt_cache_miss_tokens").and_then(|v| v.as_u64()))
        .unwrap_or(0);
    let tool_calls = extract_message_tool_calls(&json);
    Ok(ChatOnceResult {
        content,
        reasoning_content,
        cache_hit,
        cache_miss,
        tool_calls,
    })
}

/// 探针：检测当前端点/模型是否支持「原生 function calling（tools）」。
/// 背景：思考模式下用“文本 <tool_call> 解析”很脆弱（DSML/截断/工具调用被 reasoning 吞掉），
/// 若端点支持原生 tools，agent 工具循环应优先用原生 function calling，文本解析降为兜底。
/// 只读探测，不触碰用户密钥。返回可读报告。
pub async fn probe_native_tools(config: ApiConfig) -> Result<String, String> {
    let base_url = config.base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base_url);

    let tools = serde_json::json!([{
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "查询指定城市的当前天气",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": { "type": "string", "description": "城市名，如 北京" }
                },
                "required": ["city"]
            }
        }
    }]);
    let messages = serde_json::json!([
        { "role": "system", "content": "你是一个支持工具调用的助手。当用户请求匹配某函数时，必须调用 tools 中的函数。" },
        { "role": "user", "content": "帮我查一下北京的天气。" }
    ]);

    let mut report = String::new();
    report.push_str(&format!("模型: {}\n端点: {}\n\n", config.model, base_url));

    // A=不带 thinking（原生 tools 是否可用）；B=带 thinking（当前实际配置，仅当开启 thinking 时）
    let mut variants: Vec<(String, bool)> = vec![("A. 不带 thinking".to_string(), false)];
    if config.thinking_enabled {
        variants.push(("B. 带 thinking（当前配置）".to_string(), true));
    } else {
        variants[0].0 = "A. 不带 thinking（当前配置）".to_string();
    }

    for (label, use_thinking) in variants {
        let mut probe_cfg = config.clone();
        probe_cfg.thinking_enabled = use_thinking;
        probe_cfg.max_tokens = 512;
        probe_cfg.temperature = 0.0;
        let body = build_chat_body(&probe_cfg, messages.clone(), Some(tools.clone()), false);

        report.push_str(&format!("== {} ==\n", label));
        // 探针也用带连接重试的发送（网络瞬时抖动不至于误判“不支持 tools”）
        let resp = post_chat_with_retry(
            &url,
            &config.api_key,
            body.to_string(),
            std::time::Duration::from_secs(10),
            Some(std::time::Duration::from_secs(60)),
        )
        .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            report.push_str(&format!(
                "  ❌ HTTP {status}（可能不支持 tools 参数，或端点报错）：\n  {}\n\n",
                text.chars().take(400).collect::<String>()
            ));
            continue;
        }

        let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let msg = &json["choices"][0]["message"];
        let finish = json["choices"][0]["finish_reason"].as_str().unwrap_or("");
        let content_len = msg["content"].as_str().map(|s| s.len()).unwrap_or(0);
        let reasoning_len = msg
            .get("reasoning_content")
            .and_then(|v| v.as_str())
            .map(|s| s.len())
            .unwrap_or(0);

        match msg.get("tool_calls") {
            Some(arr) if arr.as_array().map(|a| !a.is_empty()).unwrap_or(false) => {
                let tc = &arr[0];
                let name = tc["function"]["name"].as_str().unwrap_or("");
                let args = tc["function"]["arguments"].as_str().unwrap_or("");
                report.push_str(&format!(
                    "  ✅ 原生 tool_calls 生效！ finish={finish} reasoning={reasoning_len}字符 content={content_len}字符\n",
                ));
                report.push_str(&format!("     → {name}({args})\n"));
            }
            _ => {
                let content = msg["content"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take(160)
                    .collect::<String>();
                report.push_str(&format!(
                    "  ⚠️ 未返回原生 tool_calls。 finish={finish} reasoning={reasoning_len}字符 content={content_len}字符\n",
                ));
                if !content.is_empty() {
                    report.push_str(&format!("     content 开头: {content}\n"));
                }
                report.push_str(&format!(
                    "     原始 message 字段: {}\n",
                    serde_json::to_string(&json["choices"][0])
                        .unwrap_or_else(|_| "(序列化失败)".into())
                ));
            }
        }
        report.push('\n');
    }

    report.push_str(
        "结论建议：若任一档返回原生 tool_calls，则 agent 工具循环应改为优先用原生 function calling \
（结构化 tool_calls，无需手写/解析文本 JSON），文本 <tool_call> 解析降为兜底，可彻底规避\
思考模式吞工具调用 / DSML 变体 / 标签截断等问题。",
    );
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn delta_line(json_fragment: &str) -> String {
        format!("data: {}", json_fragment)
    }

    #[test]
    fn parse_sse_line_extracts_native_tool_calls() {
        let line = delta_line(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"北京\"}"}}]}}]}"#,
        );
        let d = parse_sse_line(&line).expect("应解析出 tool_calls");
        assert!(d.content.is_none(), "纯 tool_calls chunk 无 content");
        let calls = d.tool_calls.expect("应有 tool_calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].index, 0);
        assert_eq!(calls[0].id.as_deref(), Some("call_1"));
        assert_eq!(calls[0].name.as_deref(), Some("get_weather"));
        assert_eq!(calls[0].arguments.as_deref(), Some(r#"{"city":"北京"}"#));
    }

    #[test]
    fn parse_sse_line_not_dropped_when_only_tool_calls() {
        // reasoning/content 都为空、仅带 tool_calls 的 chunk 绝不能丢弃
        let line = delta_line(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"f"}}]}}]}"#,
        );
        let d = parse_sse_line(&line).expect("仅 tool_calls 也不应被丢弃");
        assert!(d.tool_calls.is_some());
    }

    #[test]
    fn parse_sse_line_extracts_finish_reason() {
        // 最后一个 chunk 往往**只有 finish_reason**（delta 为空）——绝不能因此丢弃：
        // 前端要靠它判断回复是否被 max_tokens 截断（length）并自动续写，
        // 否则半截回复会被当成最终答案（现象：正文断在半句、任务计划剩余步骤永远待办）。
        let line = delta_line(r#"{"choices":[{"delta":{},"finish_reason":"length"}]}"#);
        let d = parse_sse_line(&line).expect("仅含 finish_reason 的 chunk 不应被丢弃");
        assert_eq!(d.finish_reason.as_deref(), Some("length"));
        assert!(d.content.is_none());

        let stop = delta_line(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#);
        assert_eq!(
            parse_sse_line(&stop).unwrap().finish_reason.as_deref(),
            Some("stop")
        );
    }

    #[test]
    fn parse_sse_line_returns_none_for_empty_delta() {
        // 无 reasoning/content/tool_calls/usage/finish_reason → None（跳过）
        let line = delta_line(r#"{"choices":[{"delta":{}}]}"#);
        assert!(parse_sse_line(&line).is_none());
    }

    #[test]
    fn parse_sse_line_splits_prompt_and_completion_tokens() {
        // 计费口径回归：usage 必须把输入(prompt) / 输出(completion) 分开上报。
        // 曾经只透传 total_tokens，前端把它当「回复 token」显示并按输出单价计费，
        // 导致 379 字的回复显示成 28240 tokens、单条费用虚高（AGENT_DIAGNOSIS 问题 1）。
        let line = delta_line(
            r#"{"choices":[],"usage":{"prompt_tokens":26000,"completion_tokens":210,"total_tokens":26210}}"#,
        );
        let d = parse_sse_line(&line).expect("仅含 usage 的 chunk 不应被丢弃");
        assert_eq!(d.prompt_tokens, Some(26000));
        assert_eq!(d.completion_tokens, Some(210));
        assert_eq!(d.tokens, Some(26210));
        // 只有 prompt/completion（没有 total）时也不能被丢弃
        let no_total =
            delta_line(r#"{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3}}"#);
        let d2 = parse_sse_line(&no_total).expect("缺 total_tokens 的 usage 仍应上报");
        assert_eq!(d2.prompt_tokens, Some(10));
        assert_eq!(d2.completion_tokens, Some(3));
        assert!(d2.tokens.is_none());
    }

    #[test]
    fn resolve_tool_calls_merges_fragmented_arguments_by_index() {
        let frags = vec![
            StreamToolCallDelta {
                index: 0,
                id: Some("call_1".into()),
                name: Some("get_weather".into()),
                arguments: Some("{\"city\":\"北".into()),
            },
            StreamToolCallDelta {
                index: 0,
                id: None,
                name: None,
                arguments: Some("京\"}".into()),
            },
        ];
        let resolved = resolve_tool_calls(&frags);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0]["function"]["name"], "get_weather");
        assert_eq!(resolved[0]["function"]["arguments"], r#"{"city":"北京"}"#);
        assert_eq!(resolved[0]["id"], "call_1");
    }

    #[test]
    fn resolve_tool_calls_preserves_order_and_multiple_calls() {
        // 顺序 = 流式中“首次出现”的顺序（index 0 先出现，则排前）
        let frags = vec![
            StreamToolCallDelta {
                index: 0,
                id: Some("c1".into()),
                name: Some("tool_a".into()),
                arguments: Some("{}".into()),
            },
            StreamToolCallDelta {
                index: 1,
                id: Some("c2".into()),
                name: Some("tool_b".into()),
                arguments: None,
            },
            // index 1 的后续分片：同一调用的参数 JSON 被拆成多片，合并后应拼成完整 JSON
            StreamToolCallDelta {
                index: 1,
                id: None,
                name: None,
                arguments: Some("{\"e".into()),
            },
            StreamToolCallDelta {
                index: 1,
                id: None,
                name: None,
                arguments: Some("xtra\":1}".into()),
            },
        ];
        let resolved = resolve_tool_calls(&frags);
        assert_eq!(resolved.len(), 2);
        assert_eq!(resolved[0]["function"]["name"], "tool_a");
        assert_eq!(resolved[1]["function"]["name"], "tool_b");
        assert_eq!(resolved[1]["function"]["arguments"], r#"{"extra":1}"#);
    }

    #[test]
    fn resolve_tool_calls_skips_entries_without_name() {
        let frags = vec![StreamToolCallDelta {
            index: 0,
            id: Some("x".into()),
            name: None,
            arguments: Some("{}".into()),
        }];
        assert!(resolve_tool_calls(&frags).is_empty());
    }

    #[test]
    fn chat_message_serializes_tool_calls_passthrough() {
        // assistant 消息带 tool_calls → 序列化必须原样包含（续接对话需要回传）
        let tool_calls = serde_json::json!([
            {"id": "call_1", "type": "function", "function": {"name": "create_file", "arguments": "{\"path\":\"/tmp/a.txt\"}"}}
        ]);
        let msg = ChatMessage {
            role: "assistant".into(),
            content: serde_json::Value::String("".into()),
            tool_calls: Some(tool_calls.clone()),
            tool_call_id: None,
            reasoning_content: None,
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["role"], "assistant");
        assert_eq!(json["tool_calls"], tool_calls);
        assert!(json.get("tool_call_id").is_none(), "None 字段应省略");
    }

    #[test]
    fn chat_message_serializes_tool_call_id_passthrough() {
        // role:"tool" 结果消息 → 序列化必须带 tool_call_id 关联回调用
        let msg = ChatMessage {
            role: "tool".into(),
            content: serde_json::Value::String("文件已写入".into()),
            tool_calls: None,
            tool_call_id: Some("call_9".into()),
            reasoning_content: None,
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["tool_call_id"], "call_9");
        assert!(json.get("tool_calls").is_none(), "None 字段应省略");
    }

    #[test]
    fn chat_message_carries_reasoning_content_when_present() {
        // 官方要求：带 tools 的历史轮次必须回传 reasoning_content（会拼进上下文）。
        // 序列化时只有 Some 才出现（None 时省略，避免给不带思考的请求塞空字段）。
        let with = ChatMessage {
            role: "assistant".into(),
            content: serde_json::Value::String(String::new()),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: Some("先看构建脚本，再决定改哪里".into()),
        };
        let json = serde_json::to_value(&with).unwrap();
        assert_eq!(json["reasoning_content"], "先看构建脚本，再决定改哪里");

        let without = ChatMessage {
            reasoning_content: None,
            ..with
        };
        assert!(serde_json::to_value(&without)
            .unwrap()
            .get("reasoning_content")
            .is_none());
    }

    #[test]
    fn chat_message_deserializes_missing_native_fields() {
        // 旧的纯文本请求没有 tool_calls/tool_call_id → 反序列化不报错、字段为 None
        let json = r#"{"role":"user","content":"你好"}"#;
        let msg: ChatMessage = serde_json::from_str(json).unwrap();
        assert!(msg.tool_calls.is_none());
        assert!(msg.tool_call_id.is_none());
    }

    #[test]
    fn chat_message_roundtrips_native_conversation() {
        // 模拟一轮原生 function calling 的完整续接消息（assistant.tool_calls + tool 结果）
        let messages = serde_json::json!([
            {"role": "user", "content": "创建文件"},
            {"role": "assistant", "content": "", "tool_calls": [
                {"id": "call_1", "type": "function", "function": {"name": "create_file", "arguments": "{}"}}
            ]},
            {"role": "tool", "content": "ok", "tool_call_id": "call_1"}
        ]);
        let msgs: Vec<ChatMessage> = serde_json::from_value(messages).unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[1].tool_calls.as_ref().unwrap()[0]["id"], "call_1");
        assert_eq!(msgs[2].tool_call_id.as_deref(), Some("call_1"));
        // 再序列化回 JSON 必须仍包含原生字段
        let out = serde_json::to_value(&msgs).unwrap();
        assert_eq!(out[1]["tool_calls"][0]["function"]["name"], "create_file");
        assert_eq!(out[2]["tool_call_id"], "call_1");
    }

    #[test]
    fn chat_once_extracts_message_tool_calls() {
        // 非流式响应带 message.tool_calls → 完整提取（无需分片合并）
        let json = serde_json::json!({
            "choices": [{
                "message": {
                    "content": "",
                    "tool_calls": [
                        {"id": "call_1", "type": "function", "function": {"name": "list_dir", "arguments": "{\"path\":\"/tmp\"}"}},
                        {"id": "call_2", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}
                    ]
                }
            }]
        });
        let calls = extract_message_tool_calls(&json).expect("应有 tool_calls");
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["function"]["name"], "list_dir");
        assert_eq!(calls[1]["id"], "call_2");
    }

    #[test]
    fn chat_once_no_tool_calls_returns_none() {
        // 无 tool_calls（纯文本回复）→ None
        let json = serde_json::json!({
            "choices": [{"message": {"content": "最终答案", "tool_calls": []}}]
        });
        assert!(extract_message_tool_calls(&json).is_none());
        let json2 = serde_json::json!({ "choices": [{ "message": { "content": "无工具" } }] });
        assert!(extract_message_tool_calls(&json2).is_none());
    }

    #[test]
    fn chat_once_result_serializes_tool_calls() {
        let r = ChatOnceResult {
            content: "".into(),
            reasoning_content: "".into(),
            cache_hit: 0,
            cache_miss: 0,
            tool_calls: Some(vec![serde_json::json!({
                "id": "call_x",
                "type": "function",
                "function": {"name": "list_dir", "arguments": "{}"}
            })]),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["tool_calls"][0]["function"]["name"], "list_dir");
        let r2 = ChatOnceResult {
            tool_calls: None,
            ..r
        };
        let v2 = serde_json::to_value(&r2).unwrap();
        assert!(v2["tool_calls"].is_null() || v2.get("tool_calls").is_none());
    }

    fn cfg(base_url: &str, thinking: bool, effort: &str, max_tokens: u32) -> ApiConfig {
        ApiConfig {
            base_url: base_url.into(),
            api_key: "k".into(),
            model: "deepseek-flash".into(),
            max_tokens,
            temperature: 0.35,
            thinking_enabled: thinking,
            reasoning_effort: effort.into(),
            system_prompt: String::new(),
            enable_web_search: false,
        }
    }

    #[test]
    fn deepseek_endpoint_detection_keeps_local_fallback_clean() {
        assert!(is_deepseek_endpoint("https://api.deepseek.com"));
        assert!(is_deepseek_endpoint("https://API.DeepSeek.com/beta"));
        // 本地兜底与第三方网关：不得被当成官方端点
        assert!(!is_deepseek_endpoint("http://127.0.0.1:1234/v1"));
        assert!(!is_deepseek_endpoint("https://openrouter.ai/api/v1"));
        assert!(!is_deepseek_endpoint("https://api.openai.com"));
    }

    #[test]
    fn effort_normalizes_to_official_values_only() {
        // 官方值域 none/low/high/max；兼容映射按文档
        assert_eq!(normalize_reasoning_effort("none"), "none");
        assert_eq!(normalize_reasoning_effort("minimal"), "low");
        assert_eq!(normalize_reasoning_effort("low"), "low");
        assert_eq!(normalize_reasoning_effort("medium"), "high");
        assert_eq!(normalize_reasoning_effort("xhigh"), "high");
        assert_eq!(normalize_reasoning_effort("max"), "max");
        assert_eq!(normalize_reasoning_effort("ultra"), "max");
        // 空 / 未知：落到官方默认 high，绝不把未知字符串原样发出去
        assert_eq!(normalize_reasoning_effort(""), "high");
        assert_eq!(normalize_reasoning_effort("超高"), "high");
    }

    #[test]
    fn turning_thinking_off_must_be_explicit() {
        // 关键：省略 thinking 时官方**默认开启思考**，所以「关掉」必须显式发 disabled
        let body = build_chat_body(
            &cfg("https://api.deepseek.com", false, "high", 8192),
            serde_json::json!([]),
            None,
            true,
        );
        assert_eq!(body["thinking"]["type"], "disabled");
        assert!(
            body.get("reasoning_effort").is_none(),
            "关掉思考时不该发 effort"
        );
    }

    #[test]
    fn thinking_mode_omits_ineffective_temperature_and_lifts_max_tokens() {
        let body = build_chat_body(
            &cfg("https://api.deepseek.com", true, "max", 8192),
            serde_json::json!([]),
            None,
            true,
        );
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["reasoning_effort"], "max");
        // 思考模式下 temperature 官方不生效 → 不发，避免「以为调过温度」
        assert!(body.get("temperature").is_none());
        // 8K 会被思维链吃光 → 抬到下限
        assert_eq!(
            body["max_tokens"].as_u64().unwrap() as u32,
            THINKING_MIN_OUTPUT_TOKENS
        );
    }

    #[test]
    fn non_thinking_keeps_temperature_and_respects_max_tokens() {
        let body = build_chat_body(
            &cfg("https://api.deepseek.com", false, "low", 4096),
            serde_json::json!([]),
            None,
            false,
        );
        // f32→f64 有精度尾巴（0.3499999940395355），比较时放宽容差
        assert!((body["temperature"].as_f64().unwrap() - 0.35).abs() < 1e-5);
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["stream"], false);
    }

    #[test]
    fn local_endpoints_get_plain_openai_body() {
        // 本地兜底（LM Studio / llama.cpp / vLLM）不认识 thinking / reasoning_effort
        let body = build_chat_body(
            &cfg("http://127.0.0.1:1234/v1", true, "max", 8192),
            serde_json::json!([]),
            None,
            true,
        );
        assert!(body.get("thinking").is_none(), "本地端点不该收到 thinking");
        assert!(body.get("reasoning_effort").is_none());
        // f32→f64 有精度尾巴（0.3499999940395355），比较时放宽容差
        assert!((body["temperature"].as_f64().unwrap() - 0.35).abs() < 1e-5);
    }

    #[test]
    fn tools_are_forwarded_with_auto_choice() {
        let tools = serde_json::json!([{"type":"function","function":{"name":"f"}}]);
        let body = build_chat_body(
            &cfg("https://api.deepseek.com", true, "high", 8192),
            serde_json::json!([]),
            Some(tools),
            true,
        );
        assert_eq!(body["tools"][0]["function"]["name"], "f");
        assert_eq!(body["tool_choice"], "auto");
    }

    /// **真机验证（默认忽略）**：关掉思考模式后，响应里**不该有** reasoning_content。
    ///
    /// 这是「显式 disabled」这条修复的唯一硬证据：省略 `thinking` 时官方默认开启思考，
    /// 之前的表现是「用户点了关闭，模型照样在思考」。
    /// 跑法：`cargo test --lib api::tests::live_thinking_toggle -- --ignored --nocapture`
    /// （读本机已配置的 profile，需要已保存 Key 与网络）
    #[tokio::test]
    #[ignore]
    async fn live_thinking_toggle_respects_disabled() {
        let app_dir = dirs_app_data();
        let Some(app_dir) = app_dir else {
            eprintln!("跳过：找不到应用数据目录");
            return;
        };
        let db = crate::db::Database::new(app_dir.clone()).expect("打开数据库");
        let Some(raw) = db.get_setting("app_settings").ok().flatten() else {
            eprintln!("跳过：本机没有已保存的设置");
            return;
        };
        let mut settings: crate::settings::AppSettings =
            serde_json::from_str(&raw).expect("解析设置");
        let cipher = crate::settings::SecretCipher::new(&app_dir).expect("加载密钥");
        cipher.decrypt_settings(&mut settings).expect("解密设置");
        let Some(p) = settings.profiles.iter().find(|p| !p.api_key.is_empty()) else {
            eprintln!("跳过：没有可用 profile");
            return;
        };
        let base = ApiConfig {
            base_url: p.base_url.clone(),
            api_key: p.api_key.clone(),
            model: p.model.clone(),
            max_tokens: 1024,
            temperature: 0.2,
            thinking_enabled: false,
            reasoning_effort: "high".into(),
            system_prompt: String::new(),
            enable_web_search: false,
        };
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: serde_json::Value::String(
                "9.11 和 9.8 哪个大？先在心里比较，然后只输出较大的那个数字".into(),
            ),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        }];

        // 关掉思考：不应有思维链
        let off = chat_once(base.clone(), msgs.clone(), None)
            .await
            .expect("关闭思考的请求应成功");
        eprintln!(
            "[live] thinking=off content={:?} reasoning_len={} cache_hit={} cache_miss={}",
            off.content.chars().take(30).collect::<String>(),
            off.reasoning_content.chars().count(),
            off.cache_hit,
            off.cache_miss
        );
        assert!(!off.content.trim().is_empty(), "关闭思考时正文必须有内容");
        assert!(
            off.reasoning_content.trim().is_empty(),
            "thinking=disabled 时不该返回 reasoning_content（说明关闭没生效）：{}",
            off.reasoning_content.chars().take(80).collect::<String>()
        );

        // 打开思考：应有思维链（同时验证 effort 值域被接受）
        let mut on = base;
        on.thinking_enabled = true;
        on.reasoning_effort = "low".into();
        let on_res = chat_once(on, msgs, None)
            .await
            .expect("开启思考的请求应成功");
        eprintln!(
            "[live] thinking=on content_len={} reasoning_len={}",
            on_res.content.chars().count(),
            on_res.reasoning_content.chars().count()
        );
        assert!(
            !on_res.content.trim().is_empty(),
            "开启思考时正文也必须完整"
        );
        assert!(
            !on_res.reasoning_content.trim().is_empty(),
            "thinking=enabled 时应有 reasoning_content（否则说明开关没被识别）"
        );
    }

    fn dirs_app_data() -> Option<std::path::PathBuf> {
        let home = std::env::var("HOME").ok()?;
        let p = std::path::PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("com.daoshengyi.app");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
}
