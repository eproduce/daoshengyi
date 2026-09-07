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

    let mut body = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "stream": true,
        "max_tokens": config.max_tokens,
        "temperature": config.temperature,
    });

    if let Some(tools) = tools {
        body["tools"] = tools;
        body["tool_choice"] = serde_json::json!("auto");
    }

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

    // 原生 function calling：DeepSeek/OpenAI 流式把工具调用放在 delta.tool_calls（按 index 分片）。
    // 需要单独解析并透传，绝不能因为 content/reasoning 为空就把携带 tool_calls 的 chunk 丢弃。
    let tool_calls = delta.and_then(|d| d.get("tool_calls").and_then(|v| v.as_array())).map(|arr| {
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

    if reasoning.is_none() && content.is_none() && total.is_none() && tool_calls.is_none() {
        return None;
    }

    Some(SSEDelta {
        reasoning_content: reasoning.map(|s| s.to_string()),
        content: content.map(|s| s.to_string()),
        tokens: total,
        cache_hit,
        cache_miss,
        tool_calls,
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
    pub tokens: Option<u64>,
    pub cache_hit: Option<u64>,
    pub cache_miss: Option<u64>,
    /// 原生 function calling：本 chunk 携带的工具调用分片（有则处理，无则 None）
    pub tool_calls: Option<Vec<StreamToolCallDelta>>,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn delta_line(json_fragment: &str) -> String {
        format!("data: {}", json_fragment)
    }

    #[test]
    fn parse_sse_line_extracts_native_tool_calls() {
        let line = delta_line(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"北京\"}"}}]}}]}"#);
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
        let line = delta_line(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"f"}}]}}]}"#);
        let d = parse_sse_line(&line).expect("仅 tool_calls 也不应被丢弃");
        assert!(d.tool_calls.is_some());
    }

    #[test]
    fn parse_sse_line_returns_none_for_empty_delta() {
        // 无 reasoning/content/tool_calls/usage → None（跳过）
        let line = delta_line(r#"{"choices":[{"delta":{}}]}"#);
        assert!(parse_sse_line(&line).is_none());
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
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["tool_call_id"], "call_9");
        assert!(json.get("tool_calls").is_none(), "None 字段应省略");
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
}
