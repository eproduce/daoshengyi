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

/// 追加诊断日志到应用数据目录（用户看不到终端时，可从这里排查）
fn append_log(app: &tauri::AppHandle, msg: &str) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    use std::io::Write;
    let _ = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("daoshengyi.log"))
        .and_then(|mut f| writeln!(f, "[{}] {}", chrono::Local::now().format("%H:%M:%S"), msg));
}

#[tauri::command]
async fn send_message(
    app: tauri::AppHandle,
    config: api::ApiConfig,
    mut messages: Vec<api::ChatMessage>,
) -> Result<(), String> {
    middleware::preprocess_messages(&mut messages);
    let has_image = messages.iter().any(|m| m.content.is_array());
    let log_msg = format!("[send_message] model={} 消息数={} 含图片={}", config.model, messages.len(), has_image);
    eprintln!("{}", log_msg);
    append_log(&app, &log_msg);
    let mut stream = match api::stream_chat(config, messages).await {
        Ok(s) => s,
        Err(e) => {
            let em = format!("[send_message] stream_chat 失败: {}", e);
            eprintln!("{}", em);
            append_log(&app, &em);
            return Err(e);
        }
    };

    // 行缓冲器：SSE 数据块可能在任意字节边界断开，
    // 必须把不完整的行累积到缓冲区，直到遇到换行符才解析，否则会丢字。
    let mut buf = String::new();
    let mut delta_count = 0usize;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(text) => {
                buf.push_str(&text);
                while let Some(pos) = buf.find('\n') {
                    let line: String = buf.drain(..=pos).collect();
                    if let Some(delta) = api::parse_sse_line(line.trim()) {
                        delta_count += 1;
                        let rl = delta.reasoning_content.as_ref().map(|s| s.len()).unwrap_or(0);
                        let cl = delta.content.as_ref().map(|s| s.len()).unwrap_or(0);
                        if rl > 0 || cl > 0 {
                            let sm = format!("[sse] reasoning_len={} content_len={}", rl, cl);
                            eprintln!("{}", sm);
                            append_log(&app, &sm);
                        }
                        let _ = app.emit("sse-delta", &delta);
                    }
                }
            }
            Err(e) => {
                let em = format!("[sse] 流错误: {}", e);
                eprintln!("{}", em);
                append_log(&app, &em);
                let _ = app.emit("sse-error", &e);
                return Err(e);
            }
        }
    }
    // 处理最后可能残留的不完整行
    if let Some(delta) = api::parse_sse_line(buf.trim()) {
        delta_count += 1;
        let _ = app.emit("sse-delta", &delta);
    }
    let done_msg = format!("[sse] 完成, 共 {} 个 delta", delta_count);
    eprintln!("{}", done_msg);
    append_log(&app, &done_msg);
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

/// 读取文本文件（借鉴 DeepSeek Harness 的文件能力）
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))
}

/// 附件读取结果
#[derive(serde::Serialize)]
struct AttachmentContent {
    kind: String, // "image" | "text"
    mime: String,
    content: String,
}

/// 读取附件内容（统一入口）：图片转 base64，PDF 提取文本，其余按文本读取
#[tauri::command]
fn read_attachment(path: String) -> Result<AttachmentContent, String> {
    let p = std::path::Path::new(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let image_exts = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tiff", "heic", "ico"];
    if image_exts.contains(&ext.as_str()) {
        let bytes = std::fs::read(&path).map_err(|e| format!("读取图片失败: {}", e))?;
        let mime = match ext.as_str() {
            "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif",
            "webp" => "image/webp", "bmp" => "image/bmp", "svg" => "image/svg+xml",
            "tiff" => "image/tiff", "heic" => "image/heic", _ => "image/*",
        };
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(AttachmentContent { kind: "image".into(), mime: mime.into(), content: b64 });
    }
    if ext == "pdf" {
        let text = pdf_extract::extract_text(&path)
            .map_err(|e| format!("PDF 文本提取失败: {}", e))?;
        return Ok(AttachmentContent { kind: "text".into(), mime: "application/pdf".into(), content: text });
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(AttachmentContent { kind: "text".into(), mime: "text/plain".into(), content: text })
}

// --- Ollama 本地视觉模型管理（自动部署 llava-phi3） ---

#[derive(serde::Serialize)]
struct OllamaStatus {
    installed: bool,
    running: bool,
    models: Vec<String>,
}

fn ollama_installed() -> bool {
    let candidates = ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama", "/usr/bin/ollama"];
    if candidates.iter().any(|p| std::path::Path::new(p).exists()) {
        return true;
    }
    std::process::Command::new("which")
        .arg("ollama")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

async fn ollama_running() -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .get("http://localhost:11434/api/version")
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

async fn ollama_models() -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get("http://localhost:11434/api/tags")
        .send()
        .await
        .map_err(|e| format!("查询模型失败: {}", e))?;
    if !resp.status().is_success() {
        return Ok(vec![]);
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut models = Vec::new();
    if let Some(arr) = json.get("models").and_then(|m| m.as_array()) {
        for m in arr {
            if let Some(n) = m.get("name").and_then(|n| n.as_str()) {
                models.push(n.to_string());
            }
        }
    }
    Ok(models)
}

/// 检测 Ollama 安装状态、服务状态与已部署模型
#[tauri::command]
async fn ollama_status() -> Result<OllamaStatus, String> {
    let installed = ollama_installed();
    let mut running = false;
    let mut models = Vec::new();
    if installed {
        running = ollama_running().await;
        if running {
            models = ollama_models().await.unwrap_or_default();
        }
    }
    Ok(OllamaStatus { installed, running, models })
}

/// 一键部署本地视觉模型：安装 Ollama → 启动服务 → 拉取 llava-phi3
/// 进度通过 "ollama-progress" 事件推送
#[tauri::command]
async fn ollama_setup(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;

    // 1. 安装 Ollama（未安装时）
    if !ollama_installed() {
        let _ = app.emit("ollama-progress", "未检测到 Ollama，正在通过 Homebrew 安装（约几百 MB，请耐心等待）...");
        let out = tokio::process::Command::new("brew")
            .args(["install", "ollama"])
            .output()
            .await
            .map_err(|e| format!("无法执行 brew install ollama: {}", e))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).chars().take(300).collect::<String>();
            let _ = app.emit("ollama-progress", format!("❌ 自动安装失败，请手动安装：`brew install ollama`\n{}", err));
            return Err("Ollama 自动安装失败（需要 Homebrew）".into());
        }
        let _ = app.emit("ollama-progress", "✅ Ollama 安装成功");
    } else {
        let _ = app.emit("ollama-progress", "✅ Ollama 已安装");
    }

    // 2. 启动服务
    if !ollama_running().await {
        let _ = app.emit("ollama-progress", "正在启动 Ollama 服务...");
        let _child = tokio::process::Command::new("ollama")
            .arg("serve")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("启动 ollama serve 失败: {}", e))?;
        // 等待服务就绪（最多 30 秒）
        for _ in 0..60 {
            if ollama_running().await {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        if !ollama_running().await {
            return Err("Ollama 服务启动超时".into());
        }
        let _ = app.emit("ollama-progress", "✅ Ollama 服务已启动");
    } else {
        let _ = app.emit("ollama-progress", "✅ Ollama 服务运行中");
    }

    // 3. 检查并拉取视觉模型
    let models = ollama_models().await.unwrap_or_default();
    if !models.iter().any(|m| m.contains("llava-phi3")) {
        let _ = app.emit("ollama-progress", "正在下载视觉模型 llava-phi3（约 2GB，耗时较长）...");
        let out = tokio::process::Command::new("ollama")
            .args(["pull", "llava-phi3"])
            .output()
            .await
            .map_err(|e| format!("执行 ollama pull 失败: {}", e))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).chars().take(300).collect::<String>();
            let _ = app.emit("ollama-progress", format!("❌ 模型拉取失败：{}", err));
            return Err(format!("模型 llava-phi3 拉取失败: {}", err));
        }
        let _ = app.emit("ollama-progress", "✅ llava-phi3 部署完成");
    } else {
        let _ = app.emit("ollama-progress", "✅ llava-phi3 已就绪");
    }

    let _ = app.emit("ollama-progress", "🎉 本地视觉模型部署完成！在设置中添加配置即可用于图片识别。");
    Ok("ok".into())
}

/// 执行终端命令（一次性返回输出，默认 60 秒超时）
#[tauri::command]
async fn execute_command(
    db: State<'_, Database>,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<CommandOutput, String> {
    use tokio::io::AsyncReadExt;

    let start = std::time::Instant::now();
    let audit_args = format!("{} {}", command, args.join(" "));

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

    let duration = start.elapsed().as_millis() as i64;

    match result {
        Ok((_, _, status_res, out_buf, err_buf)) => {
            let status = status_res.map_err(|e| format!("等待命令失败: {}", e))?;
            let stdout = String::from_utf8_lossy(&out_buf).to_string();
            let stderr = String::from_utf8_lossy(&err_buf).to_string();
            let exit_code = status.code().unwrap_or(-1);
            let _ = db.log_tool_call(
                "command",
                &audit_args,
                &format!("exit={} out={} err={}", exit_code, stdout, stderr),
                exit_code != 0,
                duration,
            );
            Ok(CommandOutput {
                stdout,
                stderr,
                exit_code,
                timed_out: false,
            })
        }
        Err(_) => {
            // 超时：child 因 kill_on_drop 被自动终止
            let msg = format!("命令执行超时（{}s），已终止", timeout_secs.unwrap_or(60));
            let _ = db.log_tool_call("command", &audit_args, &msg, true, duration);
            Ok(CommandOutput {
                stdout: String::new(),
                stderr: msg,
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
    eprintln!("[mcp_connect] 收到连接请求: name='{}' command='{}' args={:?}", name, command, args);
    let config = mcp::McpServerConfig { name: name.clone(), command, args, enabled: true };
    let client = match mcp::McpClient::connect(&config).await {
        Ok(c) => { eprintln!("[mcp_connect] '{}' 连接成功, {} 个工具", name, c.tools.len()); c }
        Err(e) => { eprintln!("[mcp_connect] '{}' 连接失败: {}", name, e); return Err(e); }
    };
    let tools = client.tools.clone();
    manager.clients.lock().await.insert(name.clone(), client);
    Ok(tools)
}

#[tauri::command]
async fn mcp_call_tool(
    manager: State<'_, McpManager>,
    db: State<'_, Database>,
    server: String,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<mcp::CallToolResult, String> {
    let start = std::time::Instant::now();
    let args_str = arguments.to_string();
    let audit_name = format!("{}:{}", server, tool_name);

    // 守卫：工具调用超时（借鉴 DeepSeek Harness 的 guard 理念）
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        async {
            let mut clients = manager.clients.lock().await;
            // LLM 输出的 server 名可能与配置名不一致（省略、大小写、多余空白等），
            // 做宽松匹配：精确 → 去空白 → 大小写不敏感 → 唯一客户端兜底
            let key = resolve_mcp_server(&clients, &server).ok_or("MCP Server 未连接")?;
            if key != server {
                eprintln!("[mcp_call_tool] server '{}' 映射为 '{}'", server, key);
            }
            let client = clients.get_mut(&key).ok_or("MCP Server 未连接")?;
            client.call_tool(&tool_name, arguments).await
        },
    )
    .await;

    let duration = start.elapsed().as_millis() as i64;
    match result {
        Ok(Ok(res)) => {
            let result_text = res
                .content
                .iter()
                .map(|c| c.text.clone().unwrap_or_default())
                .collect::<String>();
            let is_err = res.is_error.unwrap_or(false);
            let _ = db.log_tool_call(&audit_name, &args_str, &result_text, is_err, duration);
            Ok(res)
        }
        Ok(Err(e)) => {
            let _ = db.log_tool_call(&audit_name, &args_str, &e, true, duration);
            Err(e)
        }
        Err(_) => {
            let msg = "工具调用超时（30 秒）".to_string();
            let _ = db.log_tool_call(&audit_name, &args_str, &msg, true, duration);
            Err(msg)
        }
    }
}

#[tauri::command]
async fn mcp_list_tools(manager: State<'_, McpManager>) -> Result<Vec<(String, Vec<mcp::Tool>)>, String> {
    let clients = manager.clients.lock().await;
    Ok(clients.iter().map(|(name, c)| (name.clone(), c.tools.clone())).collect())
}

/// 断开 MCP 服务器连接：从管理器移除客户端，进程随 drop 被 kill（kill_on_drop），
/// 浏览器类服务器（如 server-puppeteer）的浏览器窗口随之关闭，形成使用闭环。
#[tauri::command]
async fn mcp_disconnect(manager: State<'_, McpManager>, name: String) -> Result<bool, String> {
    let mut clients = manager.clients.lock().await;
    let removed = clients.remove(&name).is_some();
    if removed {
        eprintln!("[mcp_disconnect] 已断开 '{}'（服务器进程已终止）", name);
    } else {
        eprintln!("[mcp_disconnect] '{}' 未在连接列表中", name);
    }
    Ok(removed)
}

/// 在已连接客户端中解析 server 名（宽松匹配，容忍 LLM 输出偏差）
fn resolve_mcp_server(
    clients: &std::collections::HashMap<String, mcp::McpClient>,
    server: &str,
) -> Option<String> {
    let s = server.trim();
    // 1. 精确匹配
    if let Some(k) = clients.keys().find(|k| *k == s) {
        return Some(k.clone());
    }
    // 2. 去空白后匹配
    if let Some(k) = clients.keys().find(|k| k.trim() == s) {
        return Some(k.clone());
    }
    // 3. 大小写不敏感匹配
    if let Some(k) = clients.keys().find(|k| k.trim().eq_ignore_ascii_case(s)) {
        return Some(k.clone());
    }
    // 4. 唯一客户端兜底
    if clients.len() == 1 {
        return clients.keys().next().cloned();
    }
    None
}

/// 查询工具调用审计日志（最近 N 条）
#[tauri::command]
fn list_tool_audit(db: State<Database>, limit: i64) -> Result<Vec<db::ToolAuditRow>, String> {
    db.list_tool_audit(limit)
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
        .plugin(tauri_plugin_dialog::init())
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
            read_file,
            read_attachment,
            ollama_status,
            ollama_setup,
            mcp_connect,
            mcp_disconnect,
            mcp_call_tool,
            mcp_list_tools,
            list_tool_audit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
