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
}

/// 发送流式聊天请求，返回 SSE 事件流
pub async fn stream_chat(
    config: ApiConfig,
    messages: Vec<ChatMessage>,
) -> Result<impl futures::Stream<Item = Result<String, String>>, String> {
    let base_url = config.base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base_url);

    let mut body = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "stream": true,
        "max_tokens": config.max_tokens,
        "temperature": config.temperature,
    });

    if config.thinking_enabled {
        body["thinking"] = serde_json::json!({"type": "enabled"});
        body["reasoning_effort"] = serde_json::json!(config.reasoning_effort);
    }

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", config.api_key))
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("网络错误: {}", e))?;

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

    if reasoning.is_none() && content.is_none() && total.is_none() {
        return None;
    }

    Some(SSEDelta {
        reasoning_content: reasoning.map(|s| s.to_string()),
        content: content.map(|s| s.to_string()),
        tokens: total,
        cache_hit,
        cache_miss,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct SSEDelta {
    pub reasoning_content: Option<String>,
    pub content: Option<String>,
    pub tokens: Option<u64>,
    pub cache_hit: Option<u64>,
    pub cache_miss: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatOnceResult {
    pub content: String,
    pub reasoning_content: String,
    pub cache_hit: u64,
    pub cache_miss: u64,
}

/// 非流式单轮聊天请求，返回完整回复（供 ReAct 工具循环使用）。
/// 通过 Rust 端 reqwest 发送，避免前端 fetch 跨域被 CORS 拦截导致工具循环失败。
pub async fn chat_once(
    config: ApiConfig,
    messages: Vec<ChatMessage>,
) -> Result<ChatOnceResult, String> {
    let base_url = config.base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base_url);

    let mut body = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "stream": false,
        "max_tokens": config.max_tokens,
        "temperature": config.temperature,
    });
    if config.thinking_enabled {
        body["thinking"] = serde_json::json!({"type": "enabled"});
        body["reasoning_effort"] = serde_json::json!(config.reasoning_effort);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("客户端构建失败: {}", e))?;
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", config.api_key))
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("网络错误: {}", e))?;

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
    Ok(ChatOnceResult {
        content,
        reasoning_content,
        cache_hit,
        cache_miss,
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
        let mut body = serde_json::json!({
            "model": config.model,
            "messages": messages,
            "stream": false,
            "max_tokens": 512,
            "temperature": 0.0,
            "tools": tools,
            "tool_choice": "auto",
        });
        if use_thinking {
            body["thinking"] = serde_json::json!({"type": "enabled"});
            body["reasoning_effort"] = serde_json::json!(config.reasoning_effort);
        }

        report.push_str(&format!("== {} ==\n", label));
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| format!("客户端构建失败: {}", e))?;
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", config.api_key))
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| format!("网络错误: {}", e))?;

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
        let finish = json["choices"][0]["finish_reason"]
            .as_str()
            .unwrap_or("");
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
