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
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use std::path::PathBuf;

/// 由本应用启动的 Ollama 服务进程 PID（退出应用时自动停止；用户自启的服务不受影响）
static OLLAMA_SERVER_PID: AtomicU32 = AtomicU32::new(0);
/// 全局部署锁：防止并发重复执行 ollama_setup（如多次点击或页面重载后重复触发，避免多个 brew install 互相抢锁卡死）
static OLLAMA_SETUP_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

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

// --- 运行时诊断（系统健康 + 日志查看） ---

fn run_sys_cmd(cmd: &str, args: &[&str]) -> String {
    std::process::Command::new(cmd)
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

#[derive(serde::Serialize)]
struct SystemDiagnostics {
    os: String,
    arch: String,
    app_version: String,
    mem_total_mb: u64,
    mem_used_percent: u8,
    disk_total_gb: u64,
    disk_free_gb: u64,
    uptime: String,
    log_tail: String,
}

#[tauri::command]
fn system_diagnostics(app: tauri::AppHandle) -> Result<SystemDiagnostics, String> {
    // 系统版本
    let os_ver = run_sys_cmd("sw_vers", &["-productVersion"]);
    let os = if os_ver.is_empty() { "macOS (未知)".to_string() } else { format!("macOS {}", os_ver) };

    // 内存总量（字节）
    let mem_total_b: u64 = run_sys_cmd("sysctl", &["-n", "hw.memsize"]).parse().unwrap_or(0);

    // 内存使用（vm_stat 分页统计，近似）
    let mut mem_used_percent: u8 = 0;
    if mem_total_b > 0 {
        let page_size: u64 = run_sys_cmd("sysctl", &["-n", "hw.pagesize"]).parse().unwrap_or(4096);
        let vm = run_sys_cmd("vm_stat", &[]);
        let mut pages_free: u64 = 0;
        let mut pages_spec: u64 = 0;
        for line in vm.lines() {
            let l = line.trim();
            if let Some(v) = l.strip_prefix("Pages free:") {
                pages_free = v.trim().trim_end_matches('.').trim().parse().unwrap_or(0);
            } else if let Some(v) = l.strip_prefix("Pages speculative:") {
                pages_spec = v.trim().trim_end_matches('.').trim().parse().unwrap_or(0);
            }
        }
        let free_bytes = (pages_free + pages_spec) * page_size;
        let used = mem_total_b.saturating_sub(free_bytes);
        mem_used_percent = ((used as f64 / mem_total_b as f64) * 100.0) as u8;
    }

    // 磁盘（当前盘，df -k 单位 KB）
    let df = run_sys_cmd("df", &["-k", "/"]);
    let mut disk_total_kb: u64 = 0;
    let mut disk_free_kb: u64 = 0;
    for (i, line) in df.lines().enumerate() {
        if i == 0 { continue; }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() >= 4 {
            disk_total_kb = fields[1].parse().unwrap_or(0);
            disk_free_kb = fields[3].parse().unwrap_or(0);
        }
        break;
    }

    // 运行时长（截取 load averages 之前的部分）
    let uptime = run_sys_cmd("uptime", &[]);
    let uptime_short = uptime.split("load averages").next().unwrap_or(&uptime).trim().to_string();

    // 日志尾部（最后 150 行）
    let mut log_tail = String::new();
    if let Ok(dir) = app.path().app_data_dir() {
        if let Ok(content) = std::fs::read_to_string(dir.join("daoshengyi.log")) {
            let lines: Vec<&str> = content.lines().collect();
            let start = lines.len().saturating_sub(150);
            log_tail = lines[start..].join("\n");
        }
    }
    if log_tail.is_empty() { log_tail = "（暂无日志）".into(); }

    Ok(SystemDiagnostics {
        os,
        arch: std::env::consts::ARCH.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        mem_total_mb: mem_total_b / 1024 / 1024,
        mem_used_percent,
        disk_total_gb: disk_total_kb / 1024 / 1024,
        disk_free_gb: disk_free_kb / 1024 / 1024,
        uptime: uptime_short,
        log_tail,
    })
}

// --- 定时任务 ---

/// 计算任务下次执行时间（毫秒）。daily：每天 HH:MM（本地时间）；否则按间隔分钟。
fn compute_next_run(t: &db::ScheduledTaskRow, now_ms: i64) -> i64 {
    use chrono::TimeZone;
    if t.schedule_type == "daily" {
        let mut parts = t.daily_time.split(':');
        let h: u32 = parts.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        let m: u32 = parts.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        let now_local = chrono::Local::now();
        let mut next = now_local
            .date_naive()
            .and_hms_opt(h, m, 0)
            .and_then(|dt| chrono::Local.from_local_datetime(&dt).single())
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(now_ms);
        if next <= now_ms { next += 24 * 3600 * 1000; }
        next
    } else {
        let mins = if t.interval_minutes > 0 { t.interval_minutes } else { 60 };
        now_ms + mins * 60 * 1000
    }
}

#[tauri::command]
fn list_scheduled_tasks(db: State<Database>) -> Result<Vec<db::ScheduledTaskRow>, String> {
    db.list_scheduled_tasks()
}

#[tauri::command]
fn save_scheduled_task(db: State<Database>, task: db::ScheduledTaskRow) -> Result<(), String> {
    db.save_scheduled_task(&task)
}

#[tauri::command]
fn delete_scheduled_task(db: State<Database>, id: String) -> Result<(), String> {
    db.delete_scheduled_task(&id)
}

#[tauri::command]
fn toggle_scheduled_task(db: State<Database>, id: String, enabled: bool) -> Result<(), String> {
    db.set_scheduled_task_enabled(&id, enabled)
}

// --- 长任务防休眠（macOS caffeinate） ---

/// 防止系统休眠守卫：active=true 启动 caffeinate -dimsu，false 停止。
struct SleepGuard(std::sync::Mutex<Option<std::process::Child>>);

#[tauri::command]
fn set_prevent_sleep(guard: State<SleepGuard>, active: bool) -> Result<(), String> {
    let mut g = guard.0.lock().map_err(|e| e.to_string())?;
    if active {
        if g.is_none() {
            #[cfg(target_os = "macos")]
            {
                let child = std::process::Command::new("caffeinate")
                    .arg("-dimsu")
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|e| format!("启动 caffeinate 失败: {}", e))?;
                *g = Some(child);
            }
            #[cfg(not(target_os = "macos"))]
            { /* 非 macOS 无系统级防休眠能力，静默跳过 */ }
        }
    } else if let Some(mut child) = g.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

// --- 编码 Agent 委派（检测本机 Claude Code / Codex 并委托任务） ---

fn which_path(cmd: &str) -> String {
    run_sys_cmd("which", &[cmd])
}

#[derive(serde::Serialize)]
struct CodingAgentInfo {
    id: String,
    label: String,
    installed: bool,
    version: Option<String>,
    path: Option<String>,
    status: String,
}

fn check_coding_agent(
    id: &str, label: &str, cmd: &str,
    version_args: &[&str], version_fallback: &[&str],
) -> CodingAgentInfo {
    let path = which_path(cmd);
    if path.is_empty() {
        return CodingAgentInfo {
            id: id.into(), label: label.into(), installed: false,
            version: None, path: None, status: "未安装".into(),
        };
    }
    let mut version = run_sys_cmd(cmd, version_args);
    if version.is_empty() && !version_fallback.is_empty() {
        version = run_sys_cmd(cmd, version_fallback);
    }
    CodingAgentInfo {
        id: id.into(), label: label.into(), installed: true,
        version: if version.is_empty() { None } else { Some(version.lines().next().unwrap_or("").to_string()) },
        path: Some(path),
        status: "已安装".into(),
    }
}

#[tauri::command]
fn check_coding_agents() -> Vec<CodingAgentInfo> {
    vec![
        check_coding_agent("claude", "Claude Code", "claude", &["--version"], &["-v"]),
        check_coding_agent("codex", "Codex", "codex", &["--version"], &["-v"]),
    ]
}

#[tauri::command]
async fn delegate_coding_agent(
    agent_id: String,
    task: String,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    let (cmd, args): (&str, Vec<String>) = match agent_id.as_str() {
        "claude" => ("claude", vec!["-p".into(), task.clone()]),
        "codex" => ("codex", vec!["exec".into(), task.clone()]),
        _ => return Err("未知编码 Agent：仅支持 claude / codex".into()),
    };
    if which_path(cmd).is_empty() {
        return Err(format!("未检测到 `{}`，请先安装并登录后重试", cmd));
    }
    let timeout = std::time::Duration::from_secs(timeout_secs.unwrap_or(300));
    let mut command = tokio::process::Command::new(cmd);
    command.args(&args);
    if let Some(c) = cwd { if !c.trim().is_empty() { command.current_dir(c.trim()); } }
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| format!("执行超时（{} 秒）", timeout.as_secs()))?
        .map_err(|e| format!("执行失败: {}", e))?;
    let mut out = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !err.is_empty() {
        out = format!("{}{}{}", out, if out.is_empty() { "" } else { "\n" }, err);
    }
    if output.status.success() {
        Ok(if out.is_empty() { "(完成，无输出)".to_string() } else { out })
    } else {
        Err(format!("退出码 {}{}{}", output.status.code().unwrap_or(-1), if out.is_empty() { "" } else { "\n" }, out))
    }
}

/// 非流式单轮聊天（ReAct 工具循环用）：走 Rust reqwest，避免前端 fetch 跨域 CORS 失败
#[tauri::command]
async fn chat_once(
    app: tauri::AppHandle,
    config: api::ApiConfig,
    messages: Vec<api::ChatMessage>,
) -> Result<api::ChatOnceResult, String> {
    let log_msg = format!("[chat_once] model={} 消息数={}", config.model, messages.len());
    eprintln!("{}", log_msg);
    append_log(&app, &log_msg);
    let result = api::chat_once(config, messages).await;
    match &result {
        Ok(r) => {
            let m = format!("[chat_once] 完成 content={} 字符 reasoning={} 字符 cache_hit={} cache_miss={}", r.content.len(), r.reasoning_content.len(), r.cache_hit, r.cache_miss);
            eprintln!("{}", m);
            append_log(&app, &m);
        }
        Err(e) => {
            let m = format!("[chat_once] 失败: {}", e);
            eprintln!("{}", m);
            append_log(&app, &m);
        }
    }
    result
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
                        let ch = delta.cache_hit.unwrap_or(0);
                        let cm = delta.cache_miss.unwrap_or(0);
                        // usage 块（choices 为空、仅有缓存/总 token）也打印，便于排查缓存命中率
                        if rl > 0 || cl > 0 || ch > 0 || cm > 0 {
                            let sm = format!("[sse] reasoning_len={} content_len={} cache_hit={} cache_miss={}", rl, cl, ch, cm);
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
    /// 是否有安装进程正在后台进行（brew install ollama / 官方脚本）
    installing: bool,
    models: Vec<String>,
}

/// Homebrew 是否可用（决定一键部署走 brew 还是官方 zip 直装）
fn brew_available() -> bool {
    std::process::Command::new("which")
        .arg("brew")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 用户主目录
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// 无 Homebrew 时直装到用户目录的 Ollama 二进制路径
fn ollama_user_bin() -> PathBuf {
    home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("Applications/Ollama.app/Contents/Resources/ollama")
}

/// 返回可用的 ollama 可执行文件路径（含用户目录直装版），None 表示未安装
fn ollama_bin() -> Option<PathBuf> {
    let candidates = [
        PathBuf::from("/usr/local/bin/ollama"),
        PathBuf::from("/opt/homebrew/bin/ollama"),
        PathBuf::from("/usr/bin/ollama"),
        PathBuf::from("/usr/local/opt/ollama/bin/ollama"),
        PathBuf::from("/opt/homebrew/opt/ollama/bin/ollama"),
        ollama_user_bin(),
    ];
    if let Some(p) = candidates.iter().find(|p| p.exists()) {
        return Some(p.clone());
    }
    // PATH 兜底
    std::process::Command::new("which")
        .arg("ollama")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(PathBuf::from(s))
            }
        })
}

fn ollama_installed() -> bool {
    ollama_bin().is_some()
}

/// 检测是否有 Ollama 安装进程正在后台进行（避免重复触发安装导致互相抢锁卡死）
fn ollama_installing() -> bool {
    let patterns: [&[&str]; 5] = [
        &["-f", "brew.*install ollama"],
        &["-f", r"install\.sh.*ollama"],
        &["-f", "ollama.*install"],
        &["-f", "Ollama-darwin"],
        &["-f", "ollama-setup"],
    ];
    patterns.iter().any(|args| {
        std::process::Command::new("pgrep")
            .args(*args)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
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
    let installing = !installed && ollama_installing();
    let mut running = false;
    let mut models = Vec::new();
    if installed {
        running = ollama_running().await;
        if running {
            models = ollama_models().await.unwrap_or_default();
        }
    }
    Ok(OllamaStatus { installed, running, installing, models })
}

#[derive(serde::Serialize)]
struct HardwareInfo {
    cpu_cores: u32,
    cpu_brand: String,
    memory_gb: u32,
    gpu_name: String,
    gpu_memory_mb: u32,
    has_metal: bool,
    /// 综合评分 0-100（CPU 核数 + 内存 + 显卡）
    score: u32,
    /// recommended / warning / not_recommended
    verdict: String,
    /// 给用户的中文建议
    message: String,
}

async fn sh_output(cmd: &str, args: &[&str]) -> String {
    tokio::process::Command::new(cmd)
        .args(args)
        .output()
        .await
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// 检测硬件综合性能（CPU / 内存 / 显卡），判断是否适合本地部署视觉模型
#[tauri::command]
async fn check_hardware() -> HardwareInfo {
    let cpu_cores = sh_output("sysctl", &["-n", "hw.ncpu"]).await.parse::<u32>().unwrap_or(4);
    let cpu_brand = sh_output("sysctl", &["-n", "machdep.cpu.brand_string"]).await;
    let mem_bytes = sh_output("sysctl", &["-n", "hw.memsize"]).await.parse::<u64>().unwrap_or(0);
    let memory_gb = (mem_bytes / 1024 / 1024 / 1024) as u32;

    // GPU 信息（system_profiler 解析）
    let gpu_report = sh_output("system_profiler", &["SPDisplaysDataType"]).await;
    let mut gpu_name = String::new();
    let mut gpu_memory_mb: u32 = 0;
    let mut has_metal = false;
    for line in gpu_report.lines() {
        let t = line.trim();
        if let Some(v) = t.strip_prefix("Chipset Model:") {
            gpu_name = v.trim().to_string();
        } else if t.starts_with("VRAM") && t.contains(':') {
            // 兼容 "VRAM (Total): 8 GB" 与 "VRAM (Dynamic, Max): 1536 MB" 等格式
            let s = t.split_once(':').map(|(_, v)| v.trim().to_string()).unwrap_or_default();
            if let Some(num) = s.strip_suffix("GB") {
                if let Ok(n) = num.trim().parse::<u32>() {
                    gpu_memory_mb = n * 1024;
                }
            } else if let Some(num) = s.strip_suffix("MB") {
                if let Ok(n) = num.trim().parse::<u32>() {
                    gpu_memory_mb = n;
                }
            }
        } else if t.starts_with("Metal") {
            has_metal = true;
        }
    }

    // 综合评分：CPU 30 分 + 内存 40 分 + 显卡 25 分 = 95 上限
    let cpu_score = match cpu_cores {
        c if c >= 8 => 30,
        c if c >= 6 => 22,
        c if c >= 4 => 14,
        _ => 6,
    };
    let mem_score = match memory_gb {
        m if m >= 16 => 40,
        m if m >= 12 => 32,
        m if m >= 8 => 22,
        m if m >= 6 => 12,
        _ => 5,
    };
    let gpu_score = if gpu_memory_mb >= 4096 {
        25
    } else if has_metal || gpu_memory_mb >= 1024 {
        18
    } else {
        10
    };
    let score = cpu_score + mem_score + gpu_score;

    let (verdict, message) = if memory_gb < 8 || (memory_gb < 12 && cpu_cores < 4) {
        (
            "not_recommended".to_string(),
            format!(
                "你的硬件（{}核 CPU / {}GB 内存）运行本地视觉模型会比较吃力，可能拖慢其他应用、影响系统流畅度。建议改为配置线上视觉模型 API（支持图片的模型）。",
                cpu_cores, memory_gb
            ),
        )
    } else if score >= 70 {
        (
            "recommended".to_string(),
            format!(
                "你的硬件（{}核 CPU / {}GB 内存 / {}{}）足以流畅运行本地视觉模型 llava-phi3，推荐本地部署：免费、隐私安全、不依赖网络。",
                cpu_cores,
                memory_gb,
                if gpu_name.is_empty() { "核显".to_string() } else { gpu_name.clone() },
                if gpu_memory_mb > 0 { format!(" / {}MB 显存", gpu_memory_mb) } else { String::new() }
            ),
        )
    } else {
        (
            "warning".to_string(),
            format!(
                "你的硬件（{}核 CPU / {}GB 内存）可以运行本地视觉模型，但会占用较多内存，运行大型应用时可能变慢；也可选择配置线上视觉模型 API。",
                cpu_cores, memory_gb
            ),
        )
    };

    HardwareInfo {
        cpu_cores,
        cpu_brand,
        memory_gb,
        gpu_name,
        gpu_memory_mb,
        has_metal,
        score,
        verdict,
        message,
    }
}

/// 一键部署本地视觉模型：安装 Ollama → 启动服务 → 拉取 llava-phi3
/// 进度通过 "ollama-progress" 事件推送
#[tauri::command]
async fn ollama_setup(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    cipher: State<'_, settings::SecretCipher>,
) -> Result<String, String> {
    use tauri::Emitter;

    // 0. 全局部署锁：避免并发 brew install 互相抢锁卡死
    let lock = OLLAMA_SETUP_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _guard = match lock.try_lock() {
        Ok(g) => g,
        Err(_) => {
            let _ = app.emit("ollama-progress", "已有部署任务正在进行中，请稍候...");
            return Err("已有部署任务正在进行中，请稍候再试".into());
        }
    };

    // 1. 安装 Ollama（未安装时）
    if !ollama_installed() {
        // 若已有安装进程在跑，等待它完成，而不是再起一个 brew install
        if ollama_installing() {
            let _ = app.emit("ollama-progress", "检测到 Ollama 正在安装中，等待其完成...");
            for _ in 0..1200 {
                if ollama_installed() {
                    break;
                }
                if !ollama_installing() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }
        if ollama_installed() {
            let _ = app.emit("ollama-progress", "✅ Ollama 已安装");
        } else {
            // 部署策略：macOS 优先走官方 zip 直装——不依赖 Homebrew / GitHub，
            // 避免 brew 需拉取大量依赖、且部分网络无法访问 raw.githubusercontent.com 导致反复下载失败；
            // zip 直装失败时自动回退 Homebrew。
            let zip_ok = if cfg!(target_os = "macos") {
                match ollama_install_from_zip(&app).await {
                    Ok(()) => true,
                    Err(e) => {
                        let _ = app.emit("ollama-progress", format!("官方直装失败，尝试 Homebrew 安装…（{}）", e));
                        false
                    }
                }
            } else {
                false
            };
            if !zip_ok && brew_available() {
                let _ = app.emit("ollama-progress", "正在通过 Homebrew 安装（约几百 MB，10 分钟超时）...");
                let out = tokio::time::timeout(
                    std::time::Duration::from_secs(600),
                    tokio::process::Command::new("brew")
                        .args(["install", "ollama"])
                        .output(),
                )
                .await
                .map_err(|_| {
                    let _ = app.emit("ollama-progress", "❌ brew install 超时（10 分钟），请检查 Homebrew 网络后重试，或手动执行 `curl -fsSL https://ollama.com/install.sh | sh`");
                    "安装超时（10 分钟）".to_string()
                })?
                .map_err(|e| format!("无法执行 brew install ollama: {}", e))?;
                if !out.status.success() {
                    let err = String::from_utf8_lossy(&out.stderr).chars().take(300).collect::<String>();
                    let _ = app.emit("ollama-progress", format!("❌ Homebrew 安装也失败，请检查网络/代理后重试，或手动安装：`curl -fsSL https://ollama.com/install.sh | sh`\n{}", err));
                    return Err("Ollama 自动安装失败（官方直装与 Homebrew 均失败）".into());
                }
                let _ = app.emit("ollama-progress", "✅ Ollama 安装成功");
            } else if !zip_ok {
                // 非 macOS 且无 brew，或 macOS 上官方直装失败且无 brew 可回退
                let _ = app.emit("ollama-progress", "❌ Ollama 安装失败：官方直装与 Homebrew 均不可用，请手动执行 `curl -fsSL https://ollama.com/install.sh | sh`");
                return Err("Ollama 安装失败（官方直装与 Homebrew 均不可用）".into());
            }
        }
    } else {
        let _ = app.emit("ollama-progress", "✅ Ollama 已安装");
    }

    // 2. 启动服务（记录 PID，退出应用时自动停止）
    if !ollama_running().await {
        let _ = app.emit("ollama-progress", "正在启动 Ollama 服务...");
        let bin = ollama_bin().ok_or("未找到 ollama 可执行文件")?;
        let child = tokio::process::Command::new(&bin)
            .arg("serve")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("启动 ollama serve 失败: {}", e))?;
        if let Some(pid) = child.id() {
            OLLAMA_SERVER_PID.store(pid, Ordering::SeqCst);
        }
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
        let _ = app.emit("ollama-progress", serde_json::json!({
            "text": "正在下载视觉模型 llava-phi3（约 2GB，可后台下载，不影响使用）...",
            "percent": 0.0,
        }));
        ollama_pull_with_progress(&app, "llava-phi3").await.map_err(|e| {
            let _ = app.emit("ollama-progress", format!("❌ 模型拉取失败：{}", e));
            format!("模型 llava-phi3 拉取失败: {}", e)
        })?;
    } else {
        let _ = app.emit("ollama-progress", serde_json::json!({ "text": "✅ llava-phi3 已就绪", "percent": 100.0 }));
    }

    // 4. 自动配置应用内 API：添加/更新「本地 Ollama」配置并切换为当前模型，
    //    避免用户部署后还要手动去设置里填地址 / Key / 模型
    ensure_ollama_profile(db.inner(), cipher.inner()).await.map_err(|e| {
        let _ = app.emit("ollama-progress", format!("⚠️ 自动配置本地模型失败：{}", e));
        e
    })?;
    let _ = app.emit("ollama-progress", "🎉 本地视觉模型部署完成！图片将自动用本地 Ollama 识别，文本对话继续使用你当前的模型（如 DeepSeek）。直接发送图片即可识别。");
    let _ = app.emit("ollama-configured", ());
    Ok("ok".into())
}

/// 解析 macOS 系统 HTTP/HTTPS 代理（scutil --proxy），返回 curl -x 需要的地址。
/// 用户开启 Clash/Surge 等代理软件后（系统代理模式），自动走代理下载。
fn system_proxy() -> Option<String> {
    let out = std::process::Command::new("scutil")
        .arg("--proxy")
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut enabled = false;
    let mut host: Option<String> = None;
    let mut port: Option<String> = None;
    for line in text.lines() {
        let t = line.trim();
        if let Some(v) = t.strip_prefix("HTTPSEnable") {
            enabled = enabled || v.contains('1');
        } else if let Some(v) = t.strip_prefix("HTTPSProxy") {
            host = Some(v.trim().trim_start_matches(':').trim().to_string());
        } else if let Some(v) = t.strip_prefix("HTTPSPort") {
            port = Some(v.trim().trim_start_matches(':').trim().to_string());
        } else if let Some(v) = t.strip_prefix("HTTPEnable") {
            enabled = enabled || v.contains('1');
        } else if let Some(v) = t.strip_prefix("HTTPProxy") {
            if host.is_none() {
                host = Some(v.trim().trim_start_matches(':').trim().to_string());
            }
        } else if let Some(v) = t.strip_prefix("HTTPPort") {
            if port.is_none() {
                port = Some(v.trim().trim_start_matches(':').trim().to_string());
            }
        }
    }
    if enabled {
        if let (Some(h), Some(p)) = (host, port) {
            if !h.is_empty() && !p.is_empty() {
                return Some(format!("http://{}:{}", h, p));
            }
        }
    }
    None
}

/// 预检 URL 是否可访问（带可选代理），用于部署前快速判断下载源连通性，
/// 避免网络不通时反复触发大文件下载
async fn url_reachable(url: &str, proxy: Option<&str>) -> bool {
    let mut cmd = tokio::process::Command::new("curl");
    cmd.args(["-s", "-I", "--max-time", "8", "-o", "/dev/null", "-w", "%{http_code}"]);
    if let Some(p) = proxy {
        cmd.args(["-x", p]);
    }
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        cmd.arg(url).output(),
    )
    .await;
    match out {
        Ok(Ok(o)) => {
            let code = String::from_utf8_lossy(&o.stdout).trim().to_string();
            code.parse::<u16>().map(|c| (200..400).contains(&c)).unwrap_or(false)
        }
        _ => false,
    }
}

/// 一键部署（macOS 首选 / 无 Homebrew 时）：从 Ollama 官方下载 macOS 包直装到用户目录。
/// 等价于官方 install.sh 的 macOS 分支，但安装在 ~/Applications（无需 brew / sudo）。
/// 支持：下载源预检、自动使用系统代理、断点续传（中断后重试续传而非从头下载）。
async fn ollama_install_from_zip(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;

    // 目前仅 macOS 支持 zip 直装；其他平台提示用官方脚本
    if !cfg!(target_os = "macos") {
        let _ = app.emit("ollama-progress", "当前系统未安装 Homebrew，请手动执行官方脚本：`curl -fsSL https://ollama.com/install.sh | sh`");
        return Err("当前系统未安装 Homebrew，请手动执行官方安装脚本".into());
    }

    let home = home_dir().ok_or("无法定位用户主目录")?;
    let apps_dir = home.join("Applications");
    let app_bundle = apps_dir.join("Ollama.app");
    let bin = app_bundle.join("Contents/Resources/ollama");
    let url = "https://ollama.com/download/Ollama-darwin.zip";
    let proxy = system_proxy();

    // 0. 部署前预检：下载源不可达直接明确报错，避免无效的反复下载
    let _ = app.emit("ollama-progress", "正在检测下载源网络连通性...");
    if !url_reachable(url, proxy.as_deref()).await {
        let _ = app.emit(
            "ollama-progress",
            "❌ 无法连接下载源 ollama.com（网络被阻断或需要代理）。\n请配置代理后重试：\n  ① 打开你的代理软件（Clash/Surge 等）并开启系统代理；\n  ② 或重启应用时在启动终端设置：export https_proxy=http://127.0.0.1:端口\n  ③ 配置后再次点击「一键部署」即可自动走代理下载。\n也可在能访问外网的机器上手动执行 `curl -fsSL https://ollama.com/install.sh | sh`。",
        );
        return Err("无法连接 Ollama 下载源（需要网络或代理）".into());
    }

    let _ = app.emit("ollama-progress", "✅ 下载源连通，开始下载 Ollama 官方包（约几百 MB，已支持断点续传）...");

    // 临时目录（固定路径 ollama-setup：配合 curl -C - 断点续传，中断后重试续传而非从头下载）
    let tmp = std::env::temp_dir().join("ollama-setup");
    let _ = std::fs::create_dir_all(&tmp);
    let zip_path = tmp.join("Ollama-darwin.zip");

    // 1. 下载（macOS 自带 curl；-C - 断点续传；自动走系统代理；20 分钟超时）
    let mut cmd = tokio::process::Command::new("curl");
    cmd.args(["--fail", "--show-error", "--location", "--progress-bar", "-C", "-"])
        .arg("-o")
        .arg(&zip_path);
    if let Some(p) = proxy.as_deref() {
        cmd.args(["-x", p]);
    }
    cmd.arg(url);
    let dl = tokio::time::timeout(std::time::Duration::from_secs(1200), cmd.status())
        .await
        .map_err(|_| {
            let _ = app.emit("ollama-progress", "❌ 下载 Ollama 超时（20 分钟），请检查网络后重试（已支持断点续传）");
            "下载超时".to_string()
        })?
        .map_err(|e| format!("无法执行 curl 下载 Ollama: {}", e))?;
    if !dl.success() {
        // 保留已下载部分，下次自动续传，不重复下载
        let _ = app.emit("ollama-progress", "❌ 下载 Ollama 失败，请检查网络/代理后重试（已支持断点续传，不会重复下载已完成部分）");
        return Err("Ollama 官方包下载失败".into());
    }
    let _ = app.emit("ollama-progress", "✅ 下载完成，正在解压安装到用户目录...");

    // 2. 解压（macOS 原生 ditto，兼容性优于 unzip，无需额外依赖）
    let ux = tokio::process::Command::new("ditto")
        .args(["-x", "-k"])
        .arg(&zip_path)
        .arg(&tmp)
        .status()
        .await
        .map_err(|e| format!("无法执行 ditto 解压: {}", e))?;
    if !ux.success() {
        // 解压失败多半是包损坏，清掉缓存避免反复使用坏包
        let _ = std::fs::remove_dir_all(&tmp);
        return Err("Ollama 解压失败".into());
    }

    // 3. 安装到 ~/Applications/Ollama.app（无需 sudo）
    let _ = std::fs::create_dir_all(&apps_dir);
    if app_bundle.exists() {
        let _ = std::fs::remove_dir_all(&app_bundle);
    }
    std::fs::rename(tmp.join("Ollama.app"), &app_bundle)
        .map_err(|e| format!("移动 Ollama.app 失败: {}", e))?;

    if !bin.exists() {
        return Err("Ollama.app 结构异常，未找到 ollama 可执行文件".into());
    }
    let _ = app.emit("ollama-progress", "✅ Ollama 安装成功（用户目录，无需 Homebrew）");
    Ok(())
}

/// 部署成功后自动配置应用内 API：添加/更新「本地 Ollama」配置并切换为当前模型，
/// 让用户无需手动填写 baseUrl / Key / 模型即可直接使用本地视觉模型识别图片。
async fn ensure_ollama_profile(db: &Database, cipher: &settings::SecretCipher) -> Result<(), String> {
    // 1. 读取现有设置（解密）
    let mut settings: settings::AppSettings = match db.get_setting(SETTINGS_KEY)? {
        Some(v) => serde_json::from_str(&v).map_err(|e| format!("解析设置失败: {}", e))?,
        None => settings::AppSettings::default(),
    };
    cipher.decrypt_settings(&mut settings)?;

    // 2. 取实际部署的视觉模型名（带 tag），找不到则用默认
    let models = ollama_models().await.unwrap_or_default();
    let model = models
        .iter()
        .find(|m| m.contains("llava-phi3"))
        .cloned()
        .unwrap_or_else(|| "llava-phi3:3.8b".to_string());

    // 3. 添加或更新「本地 Ollama」配置
    let profile = settings::ApiProfileSettings {
        id: "ollama".into(),
        name: "本地 Ollama".into(),
        base_url: "http://localhost:11434/v1".into(),
        api_key: "ollama".into(), // 本地无需密钥，占位即可
        model,
        max_tokens: 2048,
        temperature: 0.7,
        thinking_enabled: false,
        reasoning_effort: "low".into(),
        system_prompt: "你是道生一，一个运行在用户本地设备的 AI 助手，使用本地视觉模型（Ollama），可识别用户发送的图片。请用简洁、准确的中文回答。".into(),
        enable_web_search: false,
        max_context_messages: 20,
        available_models: None,
    };
    match settings.profiles.iter_mut().find(|p| p.id == "ollama") {
        Some(existing) => *existing = profile,
        None => settings.profiles.push(profile),
    }
    // 注意：这里不切换 activeProfileId。保持用户当前的文本主模型（如 DeepSeek），
    // 图片识别由前端 describeImages 自动使用本「本地 Ollama」配置，文本继续走主模型。

    // 4. 加密写回
    cipher.encrypt_settings(&mut settings)?;
    let json = serde_json::to_string(&settings).map_err(|e| format!("序列化设置失败: {}", e))?;
    db.set_setting(SETTINGS_KEY, &json)
}

/// 用本地 Ollama 视觉模型识别图片，返回文字描述（供前端图片预处理调用）。
/// 走 Rust 后端 reqwest，避免 webview 直接 fetch localhost 受限导致识别失败；
/// 与 send_message 同链路（Rust → 本地 Ollama /v1/chat/completions）。
#[tauri::command]
async fn ollama_describe_image(images: Vec<String>) -> Result<String, String> {
    let models = ollama_models().await.unwrap_or_default();
    let model = models
        .iter()
        .find(|m| m.contains("llava-phi3"))
        .cloned()
        .unwrap_or_else(|| "llava-phi3:3.8b".to_string());

    let url = "http://localhost:11434/v1/chat/completions";
    let client = reqwest::Client::new();
    let mut parts: Vec<String> = Vec::new();

    for img in images {
        // 支持 data URI 或本地文件路径（file:// 前缀）输入
        let img = resolve_image_data_uri(&img)?;
        let content = serde_json::json!([
            { "type": "text", "text": "请简要描述这张图片的内容，如果图中有文字请转录。用中文，一两句话即可。" },
            { "type": "image_url", "image_url": { "url": img, "detail": "auto" } }
        ]);
        let body = serde_json::json!({
            "model": model,
            "messages": [{ "role": "user", "content": content }],
            "max_tokens": 200,
            "stream": false,
        });

        let resp = tokio::time::timeout(
            std::time::Duration::from_secs(120),
            client.post(url)
                .header("Content-Type", "application/json")
                .json(&body)
                .send(),
        )
        .await
        .map_err(|_| "本地 Ollama 识别图片超时（120 秒），请稍后重试".to_string())?
        .map_err(|e| format!("请求本地 Ollama 失败: {}", e))?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Ollama 图片识别失败 [{}]: {}", status, text.chars().take(300).collect::<String>()));
        }
        let json: serde_json::Value = resp.json().await.map_err(|e| format!("解析响应失败: {}", e))?;
        let desc = json
            .get("choices").and_then(|c| c.get(0))
            .and_then(|c| c.get("message")).and_then(|m| m.get("content"))
            .and_then(|c| c.as_str()).unwrap_or("").to_string();
        if !desc.is_empty() {
            parts.push(desc);
        }
    }
    Ok(parts.join("\n\n"))
}

/// 用 macOS 系统 Vision OCR 提取图片文字（准确、离线、快）。
/// 非 macOS 返回空字符串，由前端回退到视觉模型语义描述。
#[tauri::command]
async fn ocr_extract_image_text(app: tauri::AppHandle, images: Vec<String>) -> Result<String, String> {
    if !cfg!(target_os = "macos") {
        return Ok(String::new());
    }
    let tool = ocr_tool_path(&app).ok_or("未找到 OCR 工具 ocr_tool（需先编译 src-tauri/ocr_tool.swift）")?;
    let mut parts: Vec<String> = Vec::new();
    for (i, img) in images.iter().enumerate() {
        let Some(bytes) = decode_data_uri(img) else { continue };
        let path = std::env::temp_dir().join(format!("daoshengyi-ocr-{}-{}.img", std::process::id(), i));
        if std::fs::write(&path, &bytes).is_err() {
            continue;
        }
        let out = tokio::process::Command::new(&tool)
            .arg(&path)
            .output()
            .await
            .map_err(|e| format!("执行 OCR 失败: {}", e))?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let _ = std::fs::remove_file(&path);
        if !text.is_empty() {
            parts.push(text);
        }
    }
    Ok(parts.join("\n\n"))
}

/// 解析 data URI（data:image/...;base64,xxx）返回原始字节
fn decode_data_uri(data: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let b64 = data.split_once(',').map(|(_, b)| b).unwrap_or(data);
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

/// 解析图片输入为 data URI：data URI 直接用；file:// 或本地路径则读文件转换
fn resolve_image_data_uri(input: &str) -> Result<String, String> {
    if input.starts_with("data:") {
        return Ok(input.to_string());
    }
    let path = input.strip_prefix("file://").unwrap_or(input);
    let bytes = std::fs::read(path).map_err(|e| format!("读取图片失败: {}", e))?;
    let ext = std::path::Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    };
    use base64::Engine as _;
    Ok(format!("data:{};base64,{}", mime, base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

/// 把 base64 图片（data URI）保存到临时文件，返回路径。供浏览器截图落盘后给视觉/OCR 分析。
#[tauri::command]
fn save_temp_image(data: String) -> Result<String, String> {
    let bytes = decode_data_uri(&data).ok_or("图片数据格式无效")?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("daoshengyi-shot-{}-{}.png", std::process::id(), ts));
    std::fs::write(&path, &bytes).map_err(|e| format!("保存图片失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// 用本地 OCR（macOS Vision）提取本地图片文件中的文字。
#[tauri::command]
async fn ocr_image_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    if !cfg!(target_os = "macos") {
        return Ok(String::new());
    }
    let tool = ocr_tool_path(&app).ok_or("未找到 OCR 工具 ocr_tool（需先编译 src-tauri/ocr_tool.swift）")?;
    let out = tokio::process::Command::new(&tool)
        .arg(&path)
        .output()
        .await
        .map_err(|e| format!("执行 OCR 失败: {}", e))?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// 定位 ocr_tool 二进制（dev: <项目根>/src-tauri/ocr_tool；打包: resource 目录）
fn ocr_tool_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join("ocr_tool");
        if p.exists() {
            return Some(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let cand = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .map(|root| root.join("src-tauri/ocr_tool"));
        if let Some(p) = cand {
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

/// 通过 Ollama HTTP API 流式拉取模型，实时推送后台下载进度
async fn ollama_pull_with_progress(app: &tauri::AppHandle, model: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("http://localhost:11434/api/pull")
        .json(&serde_json::json!({ "name": model, "stream": true }))
        .send()
        .await
        .map_err(|e| format!("发起模型下载请求失败: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("模型下载请求失败: HTTP {}", resp.status()));
    }
    // 逐行解析 NDJSON 流（stream: true），解析 downloading 状态计算百分比
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取下载进度失败: {}", e))?;
        buf.extend_from_slice(&chunk);
        let mut consumed = 0;
        while let Some(pos) = buf[consumed..].iter().position(|&b| b == b'\n') {
            let line = &buf[consumed..consumed + pos];
            consumed += pos + 1;
            if line.is_empty() {
                continue;
            }
            let Ok(val) = serde_json::from_slice::<serde_json::Value>(line) else { continue };
            let status = val.get("status").and_then(|s| s.as_str()).unwrap_or("");
            // Ollama 各版本下载状态名不同：老版本 "downloading"，0.3x 为 "pulling <digest>"。
            // 只要事件携带 total/completed 数字字段就按下载进度处理，避免进度卡在 0%。
            let has_progress = val.get("total").and_then(|t| t.as_f64()).is_some()
                && val.get("completed").and_then(|c| c.as_f64()).is_some();
            if has_progress {
                let total = val.get("total").and_then(|t| t.as_f64()).unwrap_or(0.0);
                let completed = val.get("completed").and_then(|c| c.as_f64()).unwrap_or(0.0);
                let percent = if total > 0.0 { (completed / total * 100.0).min(99.0) } else { 0.0 };
                let _ = app.emit("ollama-progress", serde_json::json!({
                    "text": format!("正在下载 {}（{:.0}MB / {:.0}MB）...", model, completed / 1048576.0, total / 1048576.0),
                    "percent": percent,
                }));
            } else if status == "success" {
                let _ = app.emit("ollama-progress", serde_json::json!({
                    "text": format!("✅ {} 部署完成", model),
                    "percent": 100.0,
                }));
                break;
            } else if !status.is_empty() {
                let _ = app.emit("ollama-progress", serde_json::json!({ "text": status }));
            }
        }
        if consumed > 0 {
            buf.drain(..consumed);
        }
    }
    Ok(())
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
    app: tauri::AppHandle,
    manager: State<'_, McpManager>,
    name: String,
    command: String,
    args: Vec<String>,
    env: std::collections::HashMap<String, String>,
) -> Result<Vec<mcp::Tool>, String> {
    let log_msg = format!("[mcp_connect] 收到连接请求: name='{}' command='{}' args={:?}", name, command, args);
    eprintln!("{}", log_msg);
    append_log(&app, &log_msg);
    let config = mcp::McpServerConfig { name: name.clone(), command, args, enabled: true, env };
    let client = match mcp::McpClient::connect(&config).await {
        Ok(c) => {
            let m = format!("[mcp_connect] '{}' 连接成功, {} 个工具", name, c.tools.len());
            eprintln!("{}", m);
            append_log(&app, &m);
            c
        }
        Err(e) => {
            let m = format!("[mcp_connect] '{}' 连接失败: {}", name, e);
            eprintln!("{}", m);
            append_log(&app, &m);
            return Err(e);
        }
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
async fn mcp_disconnect(app: tauri::AppHandle, manager: State<'_, McpManager>, name: String) -> Result<bool, String> {
    let mut clients = manager.clients.lock().await;
    let removed = clients.remove(&name).is_some();
    let m = if removed {
        format!("[mcp_disconnect] 已断开 '{}'（服务器进程已终止）", name)
    } else {
        format!("[mcp_disconnect] '{}' 未在连接列表中", name)
    };
    eprintln!("{}", m);
    append_log(&app, &m);
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
    let app = tauri::Builder::default()
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
            app.manage(SleepGuard(std::sync::Mutex::new(None)));

            // 定时任务调度线程：每 30 秒检查一次到点任务并执行（/bin/sh -c，300 秒超时）。
            // 每次循环用独立数据库连接（SQLite WAL 支持多连接并发）。
            {
                let sched_dir = app_dir.clone();
                std::thread::spawn(move || loop {
                    if let Ok(db) = Database::new(sched_dir.clone()) {
                        let tasks = db.list_scheduled_tasks().unwrap_or_default();
                        let now = chrono::Utc::now().timestamp_millis();
                        for t in tasks {
                            if !t.enabled || t.next_run_at > now { continue; }
                            let started = chrono::Utc::now().timestamp_millis();
                            let output = std::process::Command::new("/bin/sh")
                                .arg("-c").arg(&t.command)
                                .output();
                            let result = match output {
                                Ok(o) => {
                                    let mut s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                                    let e = String::from_utf8_lossy(&o.stderr).trim().to_string();
                                    if !e.is_empty() {
                                        s = format!("{}{}{}", s, if s.is_empty() { "" } else { "\n" }, e);
                                    }
                                    if s.is_empty() {
                                        format!("(退出码 {})", o.status.code().unwrap_or(-1))
                                    } else { s }
                                }
                                Err(e) => format!("(启动失败: {})", e),
                            };
                            let clipped = if result.len() > 1000 {
                                format!("{}...(截断)", &result[..1000])
                            } else { result };
                            let mut updated = t.clone();
                            updated.next_run_at = compute_next_run(&t, now);
                            updated.last_run_at = Some(started);
                            updated.last_result = Some(clipped);
                            let _ = db.save_scheduled_task(&updated);
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_secs(30));
                });
            }

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
            chat_once,
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
            system_diagnostics,
            list_scheduled_tasks,
            save_scheduled_task,
            delete_scheduled_task,
            toggle_scheduled_task,
            set_prevent_sleep,
            check_coding_agents,
            delegate_coding_agent,
            execute_command,
            read_file,
            read_attachment,
            ollama_status,
            ollama_setup,
            ollama_describe_image,
            ocr_extract_image_text,
            save_temp_image,
            ocr_image_file,
            check_hardware,
            mcp_connect,
            mcp_disconnect,
            mcp_call_tool,
            mcp_list_tools,
            list_tool_audit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // 应用退出时，自动停止由本应用启动的 Ollama 服务，减少后台硬件消耗
    app.run(|_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let pid = OLLAMA_SERVER_PID.load(Ordering::SeqCst);
            if pid != 0 {
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }
        }
    });
}
