//! MCP 服务器模式：`daoshengyi --mcp-server` 以 stdio 启动 MCP server，
//! 把道生一的能力（记忆检索/保存、联网搜索、对话历史搜索）暴露给 Claude Desktop 等 MCP 客户端。
//! 复用 mcp.rs 的 JSON-RPC 类型与 search.rs / db.rs 的既有能力。

use crate::db::{Database, FactRow};
use crate::mcp::{JsonRpcError, JsonRpcResponse};
use serde_json::{json, Value};
use std::path::PathBuf;

/// 与应用一致的数据目录（macOS：~/Library/Application Support/com.daoshengyi.app）
fn app_data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    #[cfg(target_os = "macos")]
    return PathBuf::from(home).join("Library/Application Support/com.daoshengyi.app");
    #[cfg(target_os = "windows")]
    return PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("com.daoshengyi.app");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return PathBuf::from(home).join(".local/share/com.daoshengyi.app");
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({"name": name, "description": description, "inputSchema": input_schema})
}

fn tools_list() -> Value {
    json!({ "tools": [
        tool(
            "memory_search",
            "检索道生一的长期记忆事实（关键词匹配），返回相关事实列表。参数：query 关键词、limit 条数（默认 5）。",
            json!({"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer"}},"required":["query"]}),
        ),
        tool(
            "memory_save",
            "保存一条记忆事实到道生一的长期记忆。参数：fact 事实内容、fact_type 类型（默认 info）、importance 重要度 1-10。",
            json!({"type":"object","properties":{"fact":{"type":"string"},"fact_type":{"type":"string"},"importance":{"type":"integer"}},"required":["fact"]}),
        ),
        tool(
            "web_search",
            "联网搜索（Brave→Bing→DuckDuckGo 多源回退），返回相关网页标题/链接/摘要。参数：query 搜索关键词。",
            json!({"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}),
        ),
        tool(
            "search_conversations",
            "在道生一的对话历史中搜索相关消息片段。参数：query 关键词、limit 条数（默认 10）。",
            json!({"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer"}},"required":["query"]}),
        ),
    ]})
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": "2024-11-05",
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "daoshengyi", "version": "0.1.0" }
    })
}

fn str_arg(args: &Value, key: &str) -> String {
    args.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn int_arg(args: &Value, key: &str, default: i64) -> i64 {
    args.get(key).and_then(|v| v.as_i64()).unwrap_or(default)
}

/// 处理 tools/call：分发到具体能力，返回 MCP 文本结果
async fn handle_call(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let args = params.get("arguments").cloned().unwrap_or(Value::Null);
    let err = |code: i64, msg: &str| JsonRpcError { code, message: msg.to_string() };
    let (text, is_err) = match name.as_str() {
        "memory_search" => {
            let query = str_arg(&args, "query");
            let limit = int_arg(&args, "limit", 5);
            match db.search_facts(&query, limit) {
                Ok(facts) if !facts.is_empty() => {
                    let lines: Vec<String> = facts.iter().enumerate().map(|(i, f)| {
                        format!("{}. [{}] {}（重要度 {}，访问 {} 次）", i + 1, f.fact_type, f.fact, f.importance, f.access_count)
                    }).collect();
                    (format!("找到 {} 条记忆：\n{}", facts.len(), lines.join("\n")), false)
                }
                Ok(_) => ("未找到相关记忆".to_string(), false),
                Err(e) => (format!("记忆检索失败: {}", e), true),
            }
        }
        "memory_save" => {
            let fact_text = str_arg(&args, "fact");
            if fact_text.trim().is_empty() {
                return Err(err(-32602, "memory_save 需要 fact 参数"));
            }
            let fact_type = str_arg(&args, "fact_type");
            let fact_type = if fact_type.is_empty() { "info".to_string() } else { fact_type };
            let importance = int_arg(&args, "importance", 5).clamp(1, 10);
            let row = FactRow {
                id: format!("fact_{}_{}", now_ms(), rand::random::<u32>()),
                conversation_id: None,
                fact: fact_text,
                fact_type,
                importance,
                access_count: 0,
                last_accessed: None,
                created_at: now_ms(),
            };
            match db.save_fact(&row) {
                Ok(_) => (format!("已保存记忆（类型 {}，重要度 {}）", row.fact_type, row.importance), false),
                Err(e) => (format!("保存失败: {}", e), true),
            }
        }
        "web_search" => {
            let query = str_arg(&args, "query");
            if query.trim().is_empty() {
                return Err(err(-32602, "web_search 需要 query 参数"));
            }
            match crate::search::search_web(&query, "").await {
                Ok(results) if !results.is_empty() => {
                    let lines: Vec<String> = results.iter().enumerate().map(|(i, r)| {
                        format!("{}. {} — {}\n   {}", i + 1, if r.title.is_empty() { r.url.clone() } else { r.title.clone() }, r.url, r.snippet)
                    }).collect();
                    (format!("搜索「{}」找到 {} 条：\n{}", query, results.len(), lines.join("\n")), false)
                }
                Ok(_) => (format!("搜索「{}」无结果", query), false),
                Err(e) => (format!("搜索失败: {}", e), true),
            }
        }
        "search_conversations" => {
            let query = str_arg(&args, "query");
            let limit = int_arg(&args, "limit", 10) as usize;
            match db.search(&query) {
                Ok(results) if !results.is_empty() => {
                    let lines: Vec<String> = results.iter().take(limit).enumerate().map(|(i, r)| {
                        format!("{}. [{}]（{}）{}", i + 1, r.conversation_title, r.role, r.snippet)
                    }).collect();
                    (format!("在对话历史中找到 {} 条相关：\n{}", results.len(), lines.join("\n")), false)
                }
                Ok(_) => ("未找到相关对话".to_string(), false),
                Err(e) => (format!("对话搜索失败: {}", e), true),
            }
        }
        _ => return Err(err(-32602, &format!("未知工具: {}", name))),
    };
    Ok(json!({ "content": [{ "type": "text", "text": text }], "isError": is_err }))
}

/// stdio MCP server 主循环：读取 stdin 的 JSON-RPC 行，处理后写回 stdout
pub async fn serve() -> i32 {
    let app_dir = app_data_dir();
    let db = match Database::new(app_dir.clone()) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[mcp-server] 数据库打开失败: {}", e);
            return 1;
        }
    };
    eprintln!("[mcp-server] 道生一 MCP 服务器已启动（数据目录: {}）", app_dir.display());

    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // 通知请求（无 id）直接忽略
        let Some(id) = v.get("id").and_then(|x| x.as_u64()) else { continue };
        let method = v.get("method").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let params = v.get("params").cloned().unwrap_or(Value::Null);
        let result = match method.as_str() {
            "initialize" => Ok(initialize_result()),
            "tools/list" => Ok(tools_list()),
            "tools/call" => handle_call(&db, &params).await,
            _ => Err(JsonRpcError { code: -32601, message: format!("方法不存在: {}", method) }),
        };
        let resp = match result {
            Ok(r) => JsonRpcResponse { jsonrpc: "2.0".into(), id: Some(id), result: Some(r), error: None },
            Err(e) => JsonRpcResponse { jsonrpc: "2.0".into(), id: Some(id), result: None, error: Some(e) },
        };
        let mut s = serde_json::to_string(&resp).unwrap_or_default();
        s.push('\n');
        if out.write_all(s.as_bytes()).await.is_err() {
            break;
        }
        if out.flush().await.is_err() {
            break;
        }
    }
    0
}
