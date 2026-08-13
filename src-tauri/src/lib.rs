mod api;
mod middleware;
mod db;
mod search;
mod mcp;
mod settings;

use tauri::{Emitter, Manager, State};
use futures::StreamExt;
use db::Database;
use tokio::sync::Mutex;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("你好, {}! 欢迎使用道生一。", name)
}

#[tauri::command]
async fn send_message(
    app: tauri::AppHandle,
    config: api::ApiConfig,
    mut messages: Vec<api::ChatMessage>,
) -> Result<(), String> {
    middleware::preprocess_messages(&mut messages);
    let mut stream = api::stream_chat(config, messages).await?;

    // 行缓冲器：SSE 数据块可能在任意字节边界断开，
    // 必须把不完整的行累积到缓冲区，直到遇到换行符才解析，否则会丢字。
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(text) => {
                buf.push_str(&text);
                while let Some(pos) = buf.find('\n') {
                    let line: String = buf.drain(..=pos).collect();
                    if let Some(delta) = api::parse_sse_line(line.trim()) {
                        let _ = app.emit("sse-delta", &delta);
                    }
                }
            }
            Err(e) => {
                let _ = app.emit("sse-error", &e);
                return Err(e);
            }
        }
    }
    // 处理最后可能残留的不完整行
    if let Some(delta) = api::parse_sse_line(buf.trim()) {
        let _ = app.emit("sse-delta", &delta);
    }
    let _ = app.emit("sse-done", ());
    Ok(())
}

// --- 终端命令执行 ---

#[derive(serde::Serialize)]
struct CommandOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
    timed_out: bool,
}

/// 执行终端命令（一次性返回输出，默认 60 秒超时）
#[tauri::command]
async fn execute_command(
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<CommandOutput, String> {
    use tokio::io::AsyncReadExt;

    let mut cmd = tokio::process::Command::new(&command);
    cmd.args(&args);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(&dir);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动命令失败: {}", e))?;
    let mut stdout_pipe = child.stdout.take().ok_or("无法获取 stdout")?;
    let mut stderr_pipe = child.stderr.take().ok_or("无法获取 stderr")?;

    let timeout = std::time::Duration::from_secs(timeout_secs.unwrap_or(60));

    // 并发读取输出 + 等待进程退出（带超时）
    let result = tokio::time::timeout(timeout, async {
        let mut out_buf = Vec::new();
        let mut err_buf = Vec::new();
        let (stdout_res, stderr_res, status_res) = tokio::join!(
            stdout_pipe.read_to_end(&mut out_buf),
            stderr_pipe.read_to_end(&mut err_buf),
            child.wait(),
        );
        (stdout_res, stderr_res, status_res, out_buf, err_buf)
    })
    .await;

    match result {
        Ok((_, _, status_res, out_buf, err_buf)) => {
            let status = status_res.map_err(|e| format!("等待命令失败: {}", e))?;
            Ok(CommandOutput {
                stdout: String::from_utf8_lossy(&out_buf).to_string(),
                stderr: String::from_utf8_lossy(&err_buf).to_string(),
                exit_code: status.code().unwrap_or(-1),
                timed_out: false,
            })
        }
        Err(_) => {
            // 超时：child 因 kill_on_drop 被自动终止
            Ok(CommandOutput {
                stdout: String::new(),
                stderr: format!("命令执行超时（{}s），已终止", timeout_secs.unwrap_or(60)),
                exit_code: -1,
                timed_out: true,
            })
        }
    }
}

// --- 对话持久化命令 ---

#[tauri::command]
fn load_conversations(db: State<Database>) -> Result<Vec<db::ConvRow>, String> {
    db.list_conversations()
}

#[tauri::command]
fn get_messages(db: State<Database>, conversation_id: String) -> Result<Vec<db::MsgRow>, String> {
    db.get_messages(&conversation_id)
}

#[tauri::command]
fn save_conversation(
    db: State<Database>,
    conv: db::ConvRow,
    messages: Vec<db::MsgRow>,
) -> Result<(), String> {
    db.save_conversation(&conv, &messages)
}

#[tauri::command]
fn delete_conversation_cmd(db: State<Database>, id: String) -> Result<(), String> {
    db.delete_conversation(&id)
}

#[tauri::command]
fn search_conversations_cmd(db: State<Database>, query: String) -> Result<Vec<db::SearchResult>, String> {
    db.search(&query)
}

#[tauri::command]
fn export_conversation_cmd(db: State<Database>, id: String, format: String) -> Result<String, String> {
    db.export_conversation(&id, &format)
}

// --- 记忆命令 ---

#[tauri::command]
fn save_summary(db: State<Database>, id: String, conv_id: String, summary: String, range_start: i64, range_end: i64) -> Result<(), String> {
    db.save_summary(&id, &conv_id, &summary, range_start, range_end)
}

#[tauri::command]
fn get_summaries(db: State<Database>, conv_id: String) -> Result<Vec<db::SummaryRow>, String> {
    db.get_summaries(&conv_id)
}

#[tauri::command]
fn save_fact(db: State<Database>, fact: db::FactRow) -> Result<(), String> {
    db.save_fact(&fact)
}

#[tauri::command]
fn search_facts(db: State<Database>, query: String, limit: i64) -> Result<Vec<db::FactRow>, String> {
    db.search_facts(&query, limit)
}

#[tauri::command]
fn get_preferences(db: State<Database>) -> Result<Vec<db::FactRow>, String> {
    db.get_facts_by_type("preference", 20)
}

// --- 应用设置存取（配置 + 加密 API Key） ---

const SETTINGS_KEY: &str = "app_settings";

#[tauri::command]
fn save_app_settings(
    db: State<Database>,
    cipher: State<settings::SecretCipher>,
    mut settings: settings::AppSettings,
) -> Result<(), String> {
    cipher.encrypt_settings(&mut settings)?;
    let json = serde_json::to_string(&settings).map_err(|e| format!("序列化设置失败: {}", e))?;
    db.set_setting(SETTINGS_KEY, &json)
}

#[tauri::command]
fn load_app_settings(
    db: State<Database>,
    cipher: State<settings::SecretCipher>,
) -> Result<settings::AppSettings, String> {
    let json = match db.get_setting(SETTINGS_KEY)? {
        Some(v) => v,
        None => return Ok(settings::AppSettings::default()),
    };
    let mut settings: settings::AppSettings =
        serde_json::from_str(&json).map_err(|e| format!("解析设置失败: {}", e))?;
    // 解密 apiKey；解密失败（旧数据为明文）时保留原文
    cipher.decrypt_settings(&mut settings)?;
    Ok(settings)
}

/// 获取厂商所有可用模型（兼容 /models 端点）
#[tauri::command]
async fn list_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    let base = base_url.trim_end_matches('/');
    let url = format!("{}/models", base);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("构建请求失败: {}", e))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("请求模型列表失败: {}", e))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), body));
    }

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {}", e))?;
    let mut models: Vec<String> = Vec::new();
    if let Some(data) = json.get("data").and_then(|d| d.as_array()) {
        for item in data {
            if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
                models.push(id.to_string());
            }
        }
    }
    models.sort();
    models.dedup();
    Ok(models)
}

#[tauri::command]
fn touch_fact(db: State<Database>, id: String) -> Result<(), String> {
    db.touch_fact(&id)
}

#[tauri::command]
fn delete_fact_cmd(db: State<Database>, id: String) -> Result<(), String> {
    db.delete_fact(&id)
}

#[tauri::command]
fn prune_facts(db: State<Database>) -> Result<(), String> {
    db.prune_facts(3, 60)
}

#[tauri::command]
fn set_fact_embedding(db: State<Database>, id: String, embedding: Vec<f32>) -> Result<(), String> {
    db.set_fact_embedding(&id, &embedding)
}

#[tauri::command]
fn search_by_embedding(db: State<Database>, embedding: Vec<f32>, limit: i64) -> Result<Vec<(db::FactRow, f32)>, String> {
    db.search_by_embedding(&embedding, limit)
}

#[tauri::command]
async fn web_search(query: String, brave_key: String) -> Result<Vec<search::SearchResult>, String> {
    search::search_web(&query, &brave_key).await
}

#[derive(serde::Serialize, Clone)]
struct PageContent {
    title: String,
    text: String,
    url: String,
}

#[tauri::command]
async fn fetch_page(url: String) -> Result<PageContent, String> {
    eprintln!("[fetch_page] 请求: {}", url);
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .timeout(std::time::Duration::from_secs(15))
        .build().map_err(|e| format!("err:{}", e))?;

    let resp = client.get(&url).send().await.map_err(|e| format!("err:{}", e))?;
    let final_url = resp.url().to_string();
    let html = resp.text().await.map_err(|e| format!("err:{}", e))?;
    eprintln!("[fetch_page] HTML: {} bytes", html.len());

    let title = extract_title(&html);
    let text = html_to_text(&html);
    eprintln!("[fetch_page] 标题: {}, 文本: {} chars", title, text.len());

    Ok(PageContent { title, text, url: final_url })
}

// --- MCP 管理器 ---

struct McpManager {
    clients: Mutex<std::collections::HashMap<String, mcp::McpClient>>,
}

#[tauri::command]
async fn mcp_connect(
    manager: State<'_, McpManager>,
    name: String,
    command: String,
    args: Vec<String>,
) -> Result<Vec<mcp::Tool>, String> {
    let config = mcp::McpServerConfig { name: name.clone(), command, args, enabled: true };
    let client = mcp::McpClient::connect(&config).await?;
    let tools = client.tools.clone();
    manager.clients.lock().await.insert(name, client);
    Ok(tools)
}

#[tauri::command]
async fn mcp_call_tool(
    manager: State<'_, McpManager>,
    server: String,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<mcp::CallToolResult, String> {
    let mut clients = manager.clients.lock().await;
    let client = clients.get_mut(&server).ok_or("MCP Server 未连接")?;
    client.call_tool(&tool_name, arguments).await
}

#[tauri::command]
async fn mcp_list_tools(manager: State<'_, McpManager>) -> Result<Vec<(String, Vec<mcp::Tool>)>, String> {
    let clients = manager.clients.lock().await;
    Ok(clients.iter().map(|(name, c)| (name.clone(), c.tools.clone())).collect())
}

fn extract_title(html: &str) -> String {
    let start = html.find("<title").unwrap_or(0);
    let end = html[start..].find("</title>").map(|i| start + i).unwrap_or(0);
    if start < end {
        let t = &html[start..end];
        let t = &t[t.find('>').map(|i| i + 1).unwrap_or(0)..];
        t.trim().to_string()
    } else {
        String::new()
    }
}

fn html_to_text(html: &str) -> String {
    // 1. 去除 script/style 标签及其内容
    let mut s = html.to_string();
    s = remove_tags(&s, "script");
    s = remove_tags(&s, "style");
    s = remove_tags(&s, "noscript");

    // 2. 去除所有 HTML 标签
    let mut result = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        if c == '<' { in_tag = true; continue; }
        if c == '>' { in_tag = false; continue; }
        if !in_tag { result.push(c); }
    }

    // 3. 解码实体
    result = result
        .replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
        .replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
        .replace("&apos;", "'");

    // 4. 压缩空白
    let mut out = String::new();
    let mut space = false;
    for c in result.chars() {
        if c.is_whitespace() {
            if !space { out.push(' '); space = true; }
        } else {
            out.push(c); space = false;
        }
    }
    out.trim().chars().take(8000).collect()
}

fn remove_tags(html: &str, tag: &str) -> String {
    let mut result = String::new();
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let mut pos = 0;
    let lower = html.to_lowercase();
    loop {
        match lower[pos..].find(&open) {
            Some(i) => {
                result.push_str(&html[pos..pos + i]);
                match lower[pos + i..].find(&close) {
                    Some(j) => pos = pos + i + j + close.len(),
                    None => { result.push_str(&html[pos..]); break; }
                }
            }
            None => { result.push_str(&html[pos..]); break; }
        }
    }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let app_dir = app.path().app_data_dir().expect("无法获取数据目录");
            let database = Database::new(app_dir.clone()).expect("数据库初始化失败");
            let cipher = settings::SecretCipher::new(&app_dir).expect("加密密钥初始化失败");
            app.manage(database);
            app.manage(cipher);
            app.manage(McpManager {
                clients: Mutex::new(std::collections::HashMap::new()),
            });

            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            send_message,
            load_conversations,
            get_messages,
            save_conversation,
            delete_conversation_cmd,
            search_conversations_cmd,
            export_conversation_cmd,
            save_summary,
            get_summaries,
            save_fact,
            search_facts,
            get_preferences,
            save_app_settings,
            load_app_settings,
            list_models,
            touch_fact,
            delete_fact_cmd,
            prune_facts,
            set_fact_embedding,
            search_by_embedding,
            web_search,
            fetch_page,
            execute_command,
            mcp_connect,
            mcp_call_tool,
            mcp_list_tools,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
