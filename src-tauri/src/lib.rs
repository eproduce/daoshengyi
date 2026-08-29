mod api;
mod middleware;
mod db;
mod search;
mod mcp;
mod mcp_server;
mod settings;
mod im;

use tauri::{Emitter, Manager, State};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
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

/// MCP 服务器模式入口：`daoshengyi --mcp-server` 启动 stdio MCP server，
/// 把记忆检索/保存、联网搜索、对话历史搜索暴露给 Claude Desktop 等 MCP 客户端。
pub fn run_mcp_server() -> i32 {
    let rt = tokio::runtime::Runtime::new().expect("无法创建 tokio runtime");
    rt.block_on(mcp_server::serve())
}

/// 追加诊断日志到应用数据目录（用户看不到终端时，可从这里排查）
fn append_log(app: &tauri::AppHandle, msg: &str) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    use std::io::Write;
    let _ = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("daoshengyi.log"))
        .and_then(|mut f| writeln!(f, "[{}] {}", chrono::Local::now().format("%H:%M:%S"), msg));
}

/// 供前端写诊断日志（排查前端工具循环等看不到终端的问题）
#[tauri::command]
fn debug_log(app: tauri::AppHandle, msg: String) {
    append_log(&app, &format!("[frontend] {}", msg));
    eprintln!("[frontend] {}", msg);
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

/// 写文本文件（仅允许常见导出扩展名，避免任意写文件）。
/// 会话导出在 WKWebView 下不支持 <a download>，由前端配合原生保存对话框调用本命令落盘。
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    let allowed = ["md", "json", "txt", "markdown"];
    let lower = path.to_lowercase();
    let ok = allowed.iter().any(|ext| lower.ends_with(&format!(".{}", ext)));
    if !ok {
        return Err("仅支持导出为 .md / .json / .txt / .markdown 文件".into());
    }
    std::fs::write(&path, content).map_err(|e| format!("写入文件失败: {}", e))
}

/// 展开用户路径（~/ → $HOME/），要求绝对路径或 ~/ 开头，不校验主目录边界。
fn expand_user_path(path: &str) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "无法获取用户主目录".to_string())?;
    if let Some(rest) = path.strip_prefix("~/") {
        Ok(format!("{}/{}", home, rest))
    } else if path.starts_with('/') {
        Ok(path.to_string())
    } else {
        Err("文件路径必须是绝对路径或以 ~/ 开头".into())
    }
}

/// 展开用户路径并校验必须在用户主目录内。
/// 供内置文件工具（write_file_agent / apply_edits / delete_file_agent）复用安全边界。
fn sanitize_home_path(path: &str) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "无法获取用户主目录".to_string())?;
    let expanded = expand_user_path(path)?;
    // 仅允许操作主目录内，避免越权写系统目录
    if !expanded.starts_with(&format!("{}/", home)) {
        return Err(format!("仅允许操作用户主目录（{}）内的文件", home));
    }
    Ok(expanded)
}

// --- P-A8 沙箱：文件路径白名单（三层沙箱之「文件层」） ---
/// 路径是否位于任一白名单目录内（纯函数，可测试）。
/// 用组件级匹配（Path::starts_with），避免字符串前缀把 /a/op2 误判进 /a/op。
fn path_within_any(path: &std::path::Path, dirs: &[std::path::PathBuf]) -> bool {
    dirs.iter().any(|d| path == d || path.starts_with(d))
}

/// 解析配置的路径白名单：去空、展开 ~ 前缀为绝对路径（纯函数，可测试）。
fn parse_allowed_paths(list: &[String]) -> Vec<std::path::PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    list.iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(|p| {
            if let Some(rest) = p.strip_prefix("~/") {
                std::path::PathBuf::from(format!("{}/{}", home, rest))
            } else {
                std::path::PathBuf::from(p)
            }
        })
        .collect()
}

/// 从设置读取路径白名单（P-A7/P-A8 共用配置）；未配置返回空 = 不限制。
fn sandbox_allowed_paths(db: &Database) -> Vec<std::path::PathBuf> {
    let raw: Vec<String> = db
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str::<settings::AppSettings>(&v).ok())
        .map(|s| s.allowed_paths)
        .unwrap_or_default();
    parse_allowed_paths(&raw)
}

/// 文件路径沙箱校验：展开 ~ 后，若配置了白名单则必须位于白名单内。
/// 未配置白名单时回退主目录边界（与 sanitize_home_path 一致）。
fn sandbox_file_path(db: &Database, path: &str) -> Result<String, String> {
    let allowed = sandbox_allowed_paths(db);
    if allowed.is_empty() {
        return sanitize_home_path(path);
    }
    let expanded = expand_user_path(path)?;
    let p = std::path::Path::new(&expanded);
    if !path_within_any(p, &allowed) {
        return Err(format!(
            "路径不在沙箱白名单内（允许：{:?}），拒绝访问",
            allowed
        ));
    }
    Ok(expanded)
}

/// 内置可信文件写入工具（供 agent 使用）：写入文本文件并**校验文件真实存在**后返回真实绝对路径。
/// 目的：由应用自身写盘，确保文件真实落盘；并把唯一真实路径返回给模型，要求其**原样引用**
/// （防止模型在最终回复中改写/编造文件路径，导致前端文件链接点击后打不开）。
/// 安全边界：仅允许写入当前用户主目录（$HOME）下的文件。
#[tauri::command]
fn write_file_agent(db: State<Database>, path: String, content: String) -> Result<String, String> {
    // P-A8 沙箱：主目录边界 + 路径白名单（配置时收紧）
    let expanded = sandbox_file_path(db.inner(), &path)?;
    // 撤销快照：操作前状态（是否已存在 + 原内容）
    let existed = std::path::Path::new(&expanded).exists();
    let backup = if existed { std::fs::read_to_string(&expanded).unwrap_or_default() } else { String::new() };
    // 创建父目录（如 ~/Desktop、~/Documents 等）
    if let Some(parent) = std::path::Path::new(&expanded).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&expanded, content).map_err(|e| format!("写入文件失败: {}", e))?;
    // 写盘成功后记录撤销快照（编辑覆盖或新建）
    let _ = db.record_undo(if existed { "edit" } else { "create" }, &expanded, &backup, existed);
    // 写入后校验文件真实存在，杜绝"谎报成功"
    if !std::path::Path::new(&expanded).exists() {
        return Err("写入校验失败：文件未生成，请重试".into());
    }
    let size = std::fs::metadata(&expanded).map(|m| m.len()).unwrap_or(0);
    Ok(format!(
        "已成功写入文件：{}\n（共 {} 字节，真实路径如上，回复用户时请原样引用该路径，禁止改写文件名或目录）",
        expanded, size
    ))
}

/// 行级 diff：LCS 计算两段文本的行差异，返回操作序列（' '=相同 / '-'=删除 / '+'=新增）。
fn diff_lines(old: &str, new: &str) -> Vec<(char, String)> {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();
    let (n, m) = (old_lines.len(), new_lines.len());
    // dp[i][j] = old[i..] 与 new[j..] 的 LCS 长度
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if old_lines[i] == new_lines[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    let mut ops: Vec<(char, String)> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if old_lines[i] == new_lines[j] {
            ops.push((' ', old_lines[i].to_string()));
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            ops.push(('-', old_lines[i].to_string()));
            i += 1;
        } else {
            ops.push(('+', new_lines[j].to_string()));
            j += 1;
        }
    }
    while i < n {
        ops.push(('-', old_lines[i].to_string()));
        i += 1;
    }
    while j < m {
        ops.push(('+', new_lines[j].to_string()));
        j += 1;
    }
    ops
}

/// 把行级 diff 渲染成带行号的 unified diff 文本（3 行上下文、@@ hunk 头）。
/// 仅包含有改动的区块，供模型与应用内查看改动。
fn format_unified_diff(old: &str, new: &str) -> String {
    let ops = diff_lines(old, new);
    let mut rows: Vec<(char, String, Option<usize>, Option<usize>)> = Vec::new(); // (kind, text, old_ln, new_ln)
    let (mut o, mut nn) = (1usize, 1usize);
    for (kind, text) in ops {
        match kind {
            ' ' => {
                rows.push((kind, text, Some(o), Some(nn)));
                o += 1;
                nn += 1;
            }
            '-' => {
                rows.push((kind, text, Some(o), None));
                o += 1;
            }
            _ => {
                rows.push((kind, text, None, Some(nn)));
                nn += 1;
            }
        }
    }
    let ctx = 3;
    let len = rows.len();
    let mut marked = vec![false; len];
    let mut any_change = false;
    for (i, r) in rows.iter().enumerate() {
        if r.0 != ' ' {
            any_change = true;
            let lo = i.saturating_sub(ctx);
            let hi = (i + ctx).min(len.saturating_sub(1));
            for k in lo..=hi {
                marked[k] = true;
            }
        }
    }
    if !any_change {
        return "（无改动）".to_string();
    }
    // 切出 marked 连续块
    let mut blocks: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < len {
        if marked[i] {
            let mut j = i;
            while j + 1 < len && marked[j + 1] {
                j += 1;
            }
            blocks.push((i, j));
            i = j + 1;
        } else {
            i += 1;
        }
    }
    // 间隔 ≤ 2*ctx 的相邻块合并成一个 hunk
    let mut hunks: Vec<(usize, usize)> = Vec::new();
    for b in blocks {
        if let Some(last) = hunks.last_mut() {
            let gap = b.0.saturating_sub(last.1 + 1);
            if gap <= 2 * ctx {
                last.1 = b.1;
            } else {
                hunks.push(b);
            }
        } else {
            hunks.push(b);
        }
    }
    let mut out = String::new();
    for (s, e) in hunks {
        let old_start = rows[s..=e].iter().find_map(|r| r.2).unwrap_or_else(|| {
            if s == 0 { 1 } else { rows[s - 1].2.map(|v| v + 1).unwrap_or(1) }
        });
        let new_start = rows[s..=e].iter().find_map(|r| r.3).unwrap_or_else(|| {
            if s == 0 { 1 } else { rows[s - 1].3.map(|v| v + 1).unwrap_or(1) }
        });
        let old_count = rows[s..=e].iter().filter(|r| r.2.is_some()).count();
        let new_count = rows[s..=e].iter().filter(|r| r.3.is_some()).count();
        out.push_str(&format!("@@ -{},{} +{},{} @@\n", old_start, old_count, new_start, new_count));
        for r in &rows[s..=e] {
            // unified diff：context 行前导一个空格，删除行 '-text'，新增行 '+text'
            out.push(r.0);
            out.push_str(&r.1);
            out.push('\n');
        }
    }
    out
}

/// 在 hay 中找 needle 的第 occurrence 次出现（1-based），返回字节偏移。
fn nth_occurrence(hay: &str, needle: &str, occurrence: usize) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let mut idx = 0usize;
    let mut found = 0usize;
    while idx <= hay.len() {
        if let Some(pos) = hay[idx..].find(needle) {
            found += 1;
            if found == occurrence {
                return Some(idx + pos);
            }
            idx += pos + needle.len();
        } else {
            break;
        }
    }
    None
}

/// 截断显示超长文本（错误信息/预览用）。
fn truncate_disp(s: &str) -> String {
    if s.chars().count() > 40 {
        format!("{}…", s.chars().take(40).collect::<String>())
    } else {
        s.to_string()
    }
}

/// 单文件精确编辑操作（P-A4 多文件编辑原语）。
/// - replace: 精确替换一段文本（occurrence 指定第几次出现，默认 1）
/// - insert:  在 anchor 文本前（before，默认）或后（after）插入 text
/// - delete:  精确删除一段文本（occurrence 指定第几次出现，默认 1）
#[derive(serde::Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum EditOp {
    Replace { old: String, new: String, occurrence: Option<usize> },
    Insert { anchor: String, position: String, text: String },
    Delete { old: String, occurrence: Option<usize> },
}

#[derive(serde::Serialize)]
struct EditResult {
    path: String,
    diff: String,
    new_len: usize,
    summary: String,
}

/// 对一个文件应用一系列精确编辑操作（replace/insert/delete），返回 unified diff（纯函数，不写盘）。
/// 安全边界：与 write_file_agent 一致，仅允许操作用户主目录内文件。
/// preview=true 只计算 diff 不写盘（供 diff 确认 UI）；命令层 apply_edits 负责写盘前记录撤销快照。
fn compute_edits(path: String, edits: Vec<EditOp>, preview: bool) -> Result<EditResult, String> {
    let expanded = sanitize_home_path(&path)?;
    let original = std::fs::read_to_string(&expanded)
        .map_err(|e| format!("读取文件失败（{}）: {}", expanded, e))?;
    let mut content = original.clone();
    for (i, edit) in edits.iter().enumerate() {
        match edit {
            EditOp::Replace { old, new, occurrence } => {
                if old.is_empty() {
                    return Err(format!("第 {} 个操作 replace 的 old 不能为空", i + 1));
                }
                let occ = occurrence.unwrap_or(1).max(1);
                let pos = nth_occurrence(&content, old, occ).ok_or_else(|| {
                    format!("replace 未找到文本（第 {} 次出现）：{:?}", occ, truncate_disp(old))
                })?;
                content = format!("{}{}{}", &content[..pos], new, &content[pos + old.len()..]);
            }
            EditOp::Insert { anchor, position, text } => {
                if anchor.is_empty() {
                    return Err(format!("第 {} 个操作 insert 的 anchor 不能为空", i + 1));
                }
                let pos = content.find(anchor).ok_or_else(|| {
                    format!("insert 未找到锚点文本：{:?}", truncate_disp(anchor))
                })?;
                let insert_at = if position.as_str() == "after" {
                    pos + anchor.len()
                } else {
                    pos // before（默认）
                };
                content = format!("{}{}{}", &content[..insert_at], text, &content[insert_at..]);
            }
            EditOp::Delete { old, occurrence } => {
                if old.is_empty() {
                    return Err(format!("第 {} 个操作 delete 的 old 不能为空", i + 1));
                }
                let occ = occurrence.unwrap_or(1).max(1);
                let pos = nth_occurrence(&content, old, occ).ok_or_else(|| {
                    format!("delete 未找到文本（第 {} 次出现）：{:?}", occ, truncate_disp(old))
                })?;
                content = format!("{}{}", &content[..pos], &content[pos + old.len()..]);
            }
        }
    }
    if content == original {
        return Err("编辑未产生任何改动（请检查要替换/删除的文本是否与文件内容匹配）".into());
    }
    // P-A4 应用内 diff 确认：preview=true 只计算并返回 diff，不写盘（供前端展示确认）。
    if !preview {
        // 写盘 + 校验
        if let Some(parent) = std::path::Path::new(&expanded).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&expanded, &content).map_err(|e| format!("写入文件失败: {}", e))?;
    }
    let new_len = content.len();
    let diff = format_unified_diff(&original, &content);
    let summary = if preview {
        format!(
            "【预览】将对文件 {} 应用 {} 个编辑操作（{} 字节 → {} 字节，未写盘）：\n```diff\n{}```",
            expanded, edits.len(), original.len(), new_len, diff
        )
    } else {
        format!(
            "已对文件 {} 应用 {} 个编辑操作（{} 字节 → {} 字节）：\n```diff\n{}```",
            expanded, edits.len(), original.len(), new_len, diff
        )
    };
    Ok(EditResult { path: expanded, diff, new_len, summary })
}

/// 应用编辑（命令层）：调用 compute_edits；真正写盘（非 preview）前读取原内容记录撤销快照。
#[tauri::command]
fn apply_edits(db: State<Database>, path: String, edits: Vec<EditOp>, preview: bool) -> Result<EditResult, String> {
    let original = if preview {
        String::new()
    } else {
        match sanitize_home_path(&path) {
            Ok(p) => std::fs::read_to_string(&p).unwrap_or_default(),
            Err(_) => String::new(),
        }
    };
    let res = compute_edits(path.clone(), edits, preview)?;
    if !preview {
        let _ = db.record_undo("edit", &res.path, &original, true);
    }
    Ok(res)
}

/// 删除文件（纯函数，仅允许删除用户主目录内的文件，不删除目录）。供 delete_file_agent 命令调用。
fn delete_file_impl(path: String) -> Result<String, String> {
    let expanded = sanitize_home_path(&path)?;
    let p = std::path::Path::new(&expanded);
    if !p.exists() {
        return Err(format!("文件不存在: {}", expanded));
    }
    if p.is_dir() {
        return Err("仅允许删除文件，不删除目录（删除目录请用 git 或终端）".into());
    }
    std::fs::remove_file(&expanded).map_err(|e| format!("删除文件失败: {}", e))?;
    Ok(format!("已删除文件：{}", expanded))
}

/// 删除文件（命令层）：删除前备份原内容记录撤销快照，再调用 delete_file_impl。
#[tauri::command]
fn delete_file_agent(db: State<Database>, path: String) -> Result<String, String> {
    let (backup_path, backup) = match sanitize_home_path(&path) {
        Ok(p) => (p.clone(), std::fs::read_to_string(&p).unwrap_or_default()),
        Err(_) => (String::new(), String::new()),
    };
    let res = delete_file_impl(path.clone())?;
    let _ = db.record_undo("delete", &backup_path, &backup, true);
    Ok(res)
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

/// 已被前端「停止」取消的流式 request_id 集合：send_message 每收到一个 chunk 前检查，
/// 命中则立即停止拉流/emit（否则前端虽移除了监听，Rust 仍在生成并消耗 token）。
static CANCELLED_STREAMS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> = std::sync::OnceLock::new();

/// 取消指定 request_id 的流式生成（前端点「停止」时调用，实现立刻停止）。
#[tauri::command]
fn cancel_stream(request_id: String) {
    CANCELLED_STREAMS
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
        .lock()
        .unwrap()
        .insert(request_id);
}

#[tauri::command]
async fn send_message(
    app: tauri::AppHandle,
    config: api::ApiConfig,
    mut messages: Vec<api::ChatMessage>,
    request_id: String,
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
        // 用户点「停止」：前端 cancel_stream 把 request_id 加入取消集合 → 下一个 chunk 到达即停
        if CANCELLED_STREAMS
            .get()
            .map(|m| m.lock().unwrap().contains(&request_id))
            .unwrap_or(false)
        {
            let cm = format!("[sse] request_id={} 已被用户取消，停止生成", request_id);
            eprintln!("{}", cm);
            append_log(&app, &cm);
            let _ = app.emit("sse-done", &request_id);
            return Ok(());
        }
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
                        // 临时诊断：检测流中是否出现 U+FFFD 乱码，定位乱码来源（Rust 解码 or 上游）
                        if let Some(c) = &delta.content {
                            if c.contains('\u{FFFD}') {
                                let warn = format!("[sse] ⚠️ content 含乱码 U+FFFD，片段: {}", c.chars().take(160).collect::<String>());
                                eprintln!("{}", warn);
                                append_log(&app, &warn);
                            }
                        }
                        if let Some(r) = &delta.reasoning_content {
                            if r.contains('\u{FFFD}') {
                                let warn = format!("[sse] ⚠️ reasoning 含乱码 U+FFFD，片段: {}", r.chars().take(160).collect::<String>());
                                eprintln!("{}", warn);
                                append_log(&app, &warn);
                            }
                        }
                        // usage 块（choices 为空、仅有缓存/总 token）也打印，便于排查缓存命中率
                        if rl > 0 || cl > 0 || ch > 0 || cm > 0 {
                            let sm = format!("[sse] reasoning_len={} content_len={} cache_hit={} cache_miss={}", rl, cl, ch, cm);
                            eprintln!("{}", sm);
                            append_log(&app, &sm);
                        }
                        let _ = app.emit("sse-delta", &serde_json::json!({
                            "request_id": request_id,
                            "reasoning_content": delta.reasoning_content,
                            "content": delta.content,
                            "tokens": delta.tokens,
                            "cache_hit": delta.cache_hit,
                            "cache_miss": delta.cache_miss,
                        }));
                    }
                }
            }
            Err(e) => {
                let em = format!("[sse] 流错误: {}", e);
                eprintln!("{}", em);
                append_log(&app, &em);
                let _ = app.emit("sse-error", &serde_json::json!({"request_id": request_id, "error": e}));
                return Err(e);
            }
        }
    }
    // 处理最后可能残留的不完整行
    if let Some(delta) = api::parse_sse_line(buf.trim()) {
        delta_count += 1;
        let _ = app.emit("sse-delta", &serde_json::json!({
            "request_id": request_id,
            "reasoning_content": delta.reasoning_content,
            "content": delta.content,
            "tokens": delta.tokens,
            "cache_hit": delta.cache_hit,
            "cache_miss": delta.cache_miss,
        }));
    }
    let done_msg = format!("[sse] 完成, 共 {} 个 delta", delta_count);
    eprintln!("{}", done_msg);
    append_log(&app, &done_msg);
    let _ = app.emit("sse-done", &request_id);
    Ok(())
}

// --- 终端命令执行 ---

#[derive(serde::Serialize)]
struct CommandOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
    timed_out: bool,
    /// 命令重定向生成的文件绝对路径（如 `ls > l.txt` → ["/…/l.txt"]），供前端渲染可点击链接
    #[serde(default)]
    created_files: Vec<String>,
}

/// 读取文本文件（借鉴 DeepSeek Harness 的文件能力）；传入目录时返回内容列表（ls 风格）
#[tauri::command]
fn read_file(db: State<Database>, path: String) -> Result<String, String> {
    // P-A8 沙箱：配置了路径白名单时，读取仅限白名单内目录（未配置则保持原行为，可读任意绝对路径）
    let allowed = sandbox_allowed_paths(db.inner());
    if !allowed.is_empty() {
        let expanded = expand_user_path(&path)?;
        if !path_within_any(std::path::Path::new(&expanded), &allowed) {
            return Err(format!("路径不在沙箱白名单内，拒绝读取：{}", path));
        }
    }
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        let mut entries: Vec<(String, bool, u64)> = Vec::new();
        for entry in std::fs::read_dir(p).map_err(|e| format!("读取目录失败: {}", e))? {
            if let Ok(ent) = entry {
                let name = ent.file_name().to_string_lossy().to_string();
                let is_dir = ent.file_type().map(|t| t.is_dir()).unwrap_or(false);
                let size = ent.metadata().map(|m| m.len()).unwrap_or(0);
                entries.push((name, is_dir, size));
            }
        }
        // 目录优先，再按名称排序
        entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        if entries.is_empty() {
            return Ok("（空目录）".to_string());
        }
        let lines: Vec<String> = entries
            .iter()
            .map(|(name, is_dir, size)| {
                if *is_dir { format!("📁 {}/", name) } else { format!("📄 {}  ({})", name, fmt_size(*size)) }
            })
            .collect();
        return Ok(format!("【目录】{}\n\n{}", path, lines.join("\n")));
    }
    if p.is_file() {
        let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;
        return read_text_bytes(&bytes);
    }
    Err(format!("路径不存在: {}", path))
}

fn fmt_size(b: u64) -> String {
    if b >= 1024 * 1024 {
        format!("{:.1} MB", b as f64 / (1024.0 * 1024.0))
    } else if b >= 1024 {
        format!("{:.1} KB", b as f64 / 1024.0)
    } else {
        format!("{} B", b)
    }
}

/// 检查本地文件是否真实存在（前端渲染文件链接前调用，只把真实存在的文件渲染为可点击链接，
/// 防止 agent 在回复文本中编造不存在的文件路径，导致点击后打开失败）
#[tauri::command]
fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// 用系统默认应用打开文件（macOS open / Windows start / Linux xdg-open）。
/// 传 line 时优先尝试 VSCode CLI `code --goto path:line` 定位到行（符号跳转），失败回退系统打开。
#[tauri::command]
fn open_file(path: String, line: Option<i64>) -> Result<(), String> {
    // 有行号：尝试 VSCode CLI 跳行（code 未安装时 status() 返回 Err → 回退系统打开）
    if let Some(l) = line {
        let goto = format!("{}:{}", path, l);
        let code_ok = std::process::Command::new("code")
            .arg("--goto")
            .arg(&goto)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if code_ok {
            return Ok(());
        }
    }
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(&path).status();
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("cmd").args(["/c", "start", "", &path]).status();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let status = std::process::Command::new("xdg-open").arg(&path).status();
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(_) => Err(format!("打开失败（退出码非零）: {}", path)),
        Err(e) => Err(format!("打开失败: {}", e)),
    }
}

/// 附件读取结果
#[derive(serde::Serialize)]
struct AttachmentContent {
    kind: String, // "image" | "text"
    mime: String,
    content: String,
}

/// 读取附件内容（统一入口）：图片转 base64，PDF/Excel 提取文本，其余按文本读取。
/// 用「扩展名 + magic bytes」双判断分流，扩展名缺失时也能正确识别 PDF/图片；
/// 文本读取带 GBK 回退，非 UTF-8 中文文件也能读。
#[tauri::command]
fn read_attachment(path: String) -> Result<AttachmentContent, String> {
    let p = std::path::Path::new(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;

    // 图片：扩展名 + magic
    let image_exts = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tiff", "heic", "ico"];
    if image_exts.contains(&ext.as_str()) || detect_image_magic(&bytes) {
        let mime = match ext.as_str() {
            "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif",
            "webp" => "image/webp", "bmp" => "image/bmp", "svg" => "image/svg+xml",
            "tiff" => "image/tiff", "heic" => "image/heic", _ => "image/*",
        };
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(AttachmentContent { kind: "image".into(), mime: mime.into(), content: b64 });
    }

    // PDF：扩展名 + %PDF magic（拖拽时扩展名可能丢失）
    if ext == "pdf" || bytes.starts_with(b"%PDF") {
        let text = pdf_extract::extract_text_from_mem(&bytes)
            .map_err(|e| format!("PDF 文本提取失败: {}", e))?;
        return Ok(AttachmentContent { kind: "text".into(), mime: "application/pdf".into(), content: text });
    }

    // Excel：xls/xlsx/xlsm/xlsb 用 calamine 解析单元格内容
    if matches!(ext.as_str(), "xls" | "xlsx" | "xlsm" | "xlsb") {
        let text = read_excel_content(&path)?;
        return Ok(AttachmentContent { kind: "text".into(), mime: "application/vnd.ms-excel".into(), content: text });
    }

    // Apple Numbers 表格：调用系统 Numbers.app 导出为 CSV 后读取
    if ext == "numbers" {
        let text = read_numbers_content(&path)?;
        return Ok(AttachmentContent { kind: "text".into(), mime: "text/plain".into(), content: text });
    }

    // 其余按文本：二进制检测（含 NUL 字节判定）+ GBK 回退
    if bytes.contains(&0u8) {
        return Err("该附件是二进制格式，暂不支持作为文本读取；请另存为 CSV/TXT，或转为 PDF/Excel 后再上传".into());
    }
    let text = read_text_bytes(&bytes)?;
    Ok(AttachmentContent { kind: "text".into(), mime: "text/plain".into(), content: text })
}

/// 图片 magic bytes 检测（扩展名缺失时兜底识别）
fn detect_image_magic(b: &[u8]) -> bool {
    b.starts_with(b"\x89PNG\r\n\x1a\n")
        || b.starts_with(b"\xFF\xD8\xFF")
        || b.starts_with(b"GIF8")
        || (b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP")
        || b.starts_with(b"BM")
        || (b.len() > 8 && &b[4..8] == b"ftyp")
}

/// 健壮文本读取：优先 UTF-8（去掉 BOM），失败回退 GB18030/GBK（覆盖中文 Excel 导出等编码）
fn read_text_bytes(bytes: &[u8]) -> Result<String, String> {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return Ok(s.trim_start_matches('\u{feff}').to_string());
    }
    let (decoded, _, _) = encoding_rs::GB18030.decode(bytes);
    Ok(decoded.into_owned())
}

/// 把 Excel 工作表追加为 CSV 风格文本
fn append_excel_range(out: &mut String, sheet: &str, range: &calamine::Range<calamine::Data>) {
    out.push_str(&format!("\n【工作表 {}】\n", sheet));
    for row in range.rows() {
        let cells: Vec<String> = row.iter().map(|c| match c {
            calamine::Data::String(s) => s.clone(),
            calamine::Data::Float(f) => f.to_string(),
            calamine::Data::Int(i) => i.to_string(),
            calamine::Data::Bool(b) => b.to_string(),
            calamine::Data::DateTime(dt) => dt.to_string(),
            calamine::Data::DateTimeIso(s) | calamine::Data::DurationIso(s) => s.clone(),
            _ => String::new(),
        }).collect();
        out.push_str(&cells.join(","));
        out.push('\n');
    }
}

/// 用 calamine 解析 Excel（.xls/.xlsx/.xlsm/.xlsb），按工作表输出单元格（CSV 风格）
fn read_excel_content(path: &str) -> Result<String, String> {
    use calamine::{Reader, Xls, Xlsx};
    let mut out = String::new();
    let lower = path.to_lowercase();
    if lower.ends_with(".xls") {
        let file = std::fs::File::open(path).map_err(|e| format!("打开 Excel 失败: {}", e))?;
        let mut wb = Xls::new(file).map_err(|e| format!("读取 Excel(.xls) 失败: {}", e))?;
        let sheets = wb.sheet_names().to_vec();
        for s in sheets {
            if let Ok(range) = wb.worksheet_range(&s) { append_excel_range(&mut out, &s, &range); }
        }
    } else {
        let file = std::fs::File::open(path).map_err(|e| format!("打开 Excel 失败: {}", e))?;
        let mut wb = Xlsx::new(file).map_err(|e| format!("读取 Excel(.xlsx) 失败: {}", e))?;
        let sheets = wb.sheet_names().to_vec();
        for s in sheets {
            if let Ok(range) = wb.worksheet_range(&s) { append_excel_range(&mut out, &s, &range); }
        }
    }
    if out.trim().is_empty() { return Err("Excel 中未读取到内容".into()); }
    Ok(out)
}

/// 读取 Apple Numbers 表格。优先用系统 Numbers.app 导出 CSV（最完整）；
/// 未安装 Numbers / 未授权时，回退为把 .numbers 当 zip 解压并提取内部可读文本
/// （小表格通常是未压缩 protobuf，单元格文本可直接提取，供 agent 分析）。
fn read_numbers_content(path: &str) -> Result<String, String> {
    // 1) 系统 Numbers.app 导出（若有）
    if let Ok(text) = export_numbers_via_app(path) {
        return Ok(text);
    }
    // 2) 纯 Rust 兜底：zip 解压 + 文本提取
    extract_numbers_text(path)
}

/// 调用系统 Numbers.app 把 .numbers 导出为 CSV 后读取。
/// 首次使用会请求「控制 Numbers」自动化授权；未安装或未授权时返回 Err。
fn export_numbers_via_app(path: &str) -> Result<String, String> {
    let out_csv = std::env::temp_dir().join(format!("numbers_export_{}.csv", std::process::id()));
    let out_str = out_csv.to_string_lossy().replace('"', "\\\"");
    let path_str = path.replace('"', "\\\"");
    let script = format!(
        "with timeout of 30 seconds\n\
         tell application \"Numbers\"\n\
         \tset theDoc to open POSIX file \"{path}\"\n\
         \tdelay 1\n\
         \texport theDoc to POSIX file \"{out}\" as CSV\n\
         \tclose theDoc saving no\n\
         end tell\n\
         end timeout",
        path = path_str, out = out_str
    );
    let status = std::process::Command::new("osascript")
        .arg("-e").arg(&script)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("调用 Numbers 失败: {}", e))?;
    if !status.success() {
        return Err("Numbers.app 导出失败（可能未安装或未授权）".into());
    }
    let bytes = std::fs::read(&out_csv).map_err(|e| format!("读取导出的 CSV 失败: {}", e))?;
    let _ = std::fs::remove_file(&out_csv);
    if bytes.is_empty() { return Err("Numbers 导出内容为空".into()); }
    read_text_bytes(&bytes)
}

/// 把 .numbers 当 zip 解压，从 IWA/JSON/表格内部文件提取可读文本（尽力而为）
fn extract_numbers_text(path: &str) -> Result<String, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| format!("打开 Numbers 文件失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Numbers 文件无法解压: {}", e))?;
    let mut collected = String::new();
    let mut seen = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取 Numbers 内部失败: {}", e))?;
        let name = entry.name().to_string();
        // 只看 IWA / JSON / 表格相关的内部文件
        let is_target = name.ends_with(".iwa")
            || name.ends_with(".json")
            || name.contains("Sheet")
            || name.contains("Table")
            || name.contains("Document");
        if !is_target { continue; }
        let mut buf = Vec::new();
        if entry.read_to_end(&mut buf).is_err() { continue; }
        // IWA 数据可能整体 snappy 压缩，尝试解压；失败则用原始字节
        let decompressed = if name.ends_with(".iwa") {
            snap::raw::Decoder::new().decompress_vec(&buf).unwrap_or_else(|_| buf.clone())
        } else { buf.clone() };
        let text = extract_readable_text(&decompressed);
        if !text.trim().is_empty() {
            collected.push_str(&format!("\n【{}】\n{}\n", name, text));
            seen += 1;
        }
        if seen >= 20 { break; }
    }
    if collected.trim().is_empty() {
        Err("未能从 Numbers 文件中提取到可读内容。请在 Numbers / WPS / LibreOffice 中另存为 CSV 或 Excel 后再上传".into())
    } else {
        Ok(collected)
    }
}

/// 从二进制中提取连续可读的 UTF-8 文本片段（过滤控制字符与单字符碎片）
fn extract_readable_text(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let flush = |out: &mut Vec<String>, cur: &mut String| {
        let t = cur.trim();
        let printable: usize = t.chars().filter(|c| !c.is_ascii_control()).count();
        if printable >= 3 { out.push(t.to_string()); }
        cur.clear();
    };
    for c in s.chars() {
        if c.is_ascii_control() {
            if !matches!(c, '\t' | '\n' | '\r') { flush(&mut out, &mut cur); continue; }
            cur.push(c);
        } else {
            cur.push(c);
        }
    }
    flush(&mut out, &mut cur);
    // 去重相邻重复（protobuf 里同一字符串常出现多次）
    let mut result: Vec<String> = Vec::new();
    for line in out {
        if result.last().map(|l| l == &line).unwrap_or(false) { continue; }
        if result.iter().any(|l| l.contains(&line) && l.len() > line.len() * 2) { continue; }
        result.push(line);
    }
    result.join("\n")
}

/// 从 base64 的 PDF 内容提取文本（拖拽/粘贴 PDF 用，避免前端 readAsText 读到二进制乱码）
#[tauri::command]
fn extract_pdf_text(data: String) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("PDF base64 解码失败: {}", e))?;
    pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|e| format!("PDF 文本提取失败: {}", e))
}

/// 分段读取 PDF：提取全文后返回 [offset, offset+length) 的字符区间（按 char 切，避免 UTF-8 边界问题）
#[tauri::command]
fn read_pdf_part(path: String, offset: i64, length: i64) -> Result<String, String> {
    let text = pdf_extract::extract_text(&path)
        .map_err(|e| format!("PDF 文本提取失败: {}", e))?;
    let chars: Vec<char> = text.chars().collect();
    let start = (offset.max(0) as usize).min(chars.len());
    let len = (length.max(0) as usize).min(chars.len() - start);
    Ok(chars[start..start + len].iter().collect())
}

// --- Phase 3 知识库 RAG：本地文件索引 + FTS5 关键词检索 ---

/// 把长文本切成约 size 字符的分块（尽量在换行处断开；超长行按 char 级切，避免 UTF-8 边界；纯函数可测试）
fn chunk_text(text: &str, size: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut cur_len = 0usize;
    for line in text.split('\n') {
        if line.chars().count() > size {
            if !current.trim().is_empty() {
                out.push(current.trim().to_string());
                current = String::new();
                cur_len = 0;
            }
            let mut buf = String::new();
            let mut n = 0usize;
            for c in line.chars() {
                buf.push(c);
                n += 1;
                if n >= size {
                    let t = buf.trim().to_string();
                    if !t.is_empty() {
                        out.push(t);
                    }
                    buf = String::new();
                    n = 0;
                }
            }
            if !buf.trim().is_empty() {
                current = buf;
                cur_len = current.chars().count();
            }
            continue;
        }
        if cur_len > 0 && cur_len + 1 + line.chars().count() > size {
            if !current.trim().is_empty() {
                out.push(current.trim().to_string());
            }
            current = String::new();
            cur_len = 0;
        }
        if cur_len > 0 {
            current.push('\n');
            cur_len += 1;
        }
        current.push_str(line);
        cur_len += line.chars().count();
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

/// 知识库索引：扫描目录（md/txt/代码/PDF），分块写入并建 FTS 索引（重建式：先清空同名知识库）。
/// 支持 P-A8 沙箱：配置了路径白名单时只能索引白名单内目录。
#[tauri::command]
async fn kb_index(db: State<'_, Database>, kb_name: String, path: String) -> Result<String, String> {
    use base64::Engine as _;
    let allowed = sandbox_allowed_paths(db.inner());
    let expanded = expand_user_path(&path)?;
    if !allowed.is_empty() && !path_within_any(std::path::Path::new(&expanded), &allowed) {
        return Err(format!("路径不在沙箱白名单内，拒绝索引：{}", path));
    }
    let root = std::path::PathBuf::from(&expanded);
    if !root.is_dir() {
        return Err(format!("不是目录: {}", path));
    }
    let skip: [&str; 9] = ["node_modules", ".git", "target", "dist", "build", ".next", "__pycache__", "vendor", ".idea"];
    let is_ok_ext = |ext: &str| {
        matches!(ext, "md" | "txt" | "markdown" | "json" | "py" | "ts" | "js" | "rs" | "vue" | "html" | "css" | "c" | "cpp" | "h" | "java" | "go" | "toml" | "yml" | "yaml" | "sh" | "csv" | "pdf")
    };

    db.kb_clear(&kb_name)?;
    let mut files = 0usize;
    let mut collected: Vec<(String, String, i64)> = Vec::new(); // (rel, chunk, chunk_idx)
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(|e| format!("读取目录失败 {}: {}", dir.display(), e))?;
        for ent in entries.flatten() {
            let p = ent.path();
            if p.is_dir() {
                let name = ent.file_name().to_string_lossy().to_string();
                if skip.contains(&name.as_str()) {
                    continue;
                }
                stack.push(p);
            } else if p.is_file() {
                let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
                if !is_ok_ext(&ext) {
                    continue;
                }
                files += 1;
                let text = if ext == "pdf" {
                    std::fs::read(&p)
                        .ok()
                        .map(|b| base64::engine::general_purpose::STANDARD.encode(b))
                        .and_then(|b64| extract_pdf_text(b64).ok())
                        .unwrap_or_default()
                } else {
                    std::fs::read_to_string(&p).unwrap_or_default()
                };
                let rel = p.strip_prefix(&root).unwrap_or(&p).to_string_lossy().to_string();
                for (i, chunk) in chunk_text(&text, 800).into_iter().enumerate() {
                    if chunk.trim().is_empty() {
                        continue;
                    }
                    collected.push((rel.clone(), chunk, i as i64));
                }
            }
        }
    }

    // 语义向量：探测一次 Ollama embedding 是否可用；可用则批量嵌入（每批 20）存储，否则回退纯关键词
    let mut semantic = false;
    let mut sem_note = String::new();
    if !collected.is_empty() {
        match ollama_embed_impl(vec![collected[0].1.clone()]).await {
            Ok(_) => semantic = true,
            Err(e) => sem_note = format!("，语义向量未启用：{}", e),
        }
    }
    let mut chunks = 0usize;
    if semantic {
        let mut batch: Vec<String> = Vec::new();
        let mut meta: Vec<&(String, String, i64)> = Vec::new();
        for item in &collected {
            batch.push(item.1.clone());
            meta.push(item);
            if batch.len() >= 20 {
                match ollama_embed_impl(batch.clone()).await {
                    Ok(vecs) => {
                        for (m, v) in meta.iter().zip(vecs.into_iter()) {
                            db.kb_add_chunk(&kb_name, &m.0, &m.1, m.2, Some(&v))?;
                            chunks += 1;
                        }
                    }
                    Err(_) => {
                        for m in meta.iter() {
                            db.kb_add_chunk(&kb_name, &m.0, &m.1, m.2, None)?;
                            chunks += 1;
                        }
                    }
                }
                batch.clear();
                meta.clear();
            }
        }
        if !batch.is_empty() {
            if let Ok(vecs) = ollama_embed_impl(batch.clone()).await {
                for (m, v) in meta.iter().zip(vecs.into_iter()) {
                    db.kb_add_chunk(&kb_name, &m.0, &m.1, m.2, Some(&v))?;
                    chunks += 1;
                }
            } else {
                for m in meta.iter() {
                    db.kb_add_chunk(&kb_name, &m.0, &m.1, m.2, None)?;
                    chunks += 1;
                }
            }
        }
    } else {
        for (rel, chunk, idx) in &collected {
            db.kb_add_chunk(&kb_name, rel, chunk, *idx, None)?;
            chunks += 1;
        }
    }

    Ok(format!(
        "知识库「{}」索引完成：{} 个文件 → {} 个分块（{}）{}",
        kb_name,
        files,
        chunks,
        root.display(),
        if semantic { "，语义向量已启用 ✅" } else { &sem_note }
    ))
}

/// 知识库检索（混合：FTS5 关键词 + 语义向量，Ollama embedding 可用时）
#[tauri::command]
async fn kb_search(db: State<'_, Database>, kb_name: String, query: String, limit: Option<i64>) -> Result<Vec<db::KbChunk>, String> {
    let lim = limit.unwrap_or(6).clamp(1, 20);
    // 尝试语义：Ollama 在跑且模型已装时给查询生成向量 → 混合检索；否则纯 FTS5
    let qvec = ollama_embed_impl(vec![query.clone()]).await.ok().and_then(|v| v.into_iter().next());
    db.kb_search_hybrid(&kb_name, &query, qvec.as_deref(), lim)
}

/// 列出所有知识库及分块数
#[tauri::command]
fn kb_list(db: State<Database>) -> Result<Vec<db::KbInfo>, String> {
    db.kb_list()
}

/// 删除整个知识库
#[tauri::command]
fn kb_delete(db: State<Database>, kb_name: String) -> Result<String, String> {
    db.kb_delete(&kb_name)?;
    Ok(format!("知识库「{}」已删除", kb_name))
}

// --- 可视化工作流持久化 + 运行历史（Phase 3） ---

/// 保存工作流（同名更新，返回 id）
#[tauri::command]
fn workflow_save(db: State<Database>, name: String, graph: String) -> Result<i64, String> {
    let n = name.trim().to_string();
    if n.is_empty() { return Err("工作流名称不能为空".into()); }
    db.wf_save(&n, &graph)
}

/// 工作流列表
#[tauri::command]
fn workflow_list(db: State<Database>) -> Result<Vec<db::WorkflowRow>, String> {
    db.wf_list()
}

/// 读取单个工作流
#[tauri::command]
fn workflow_get(db: State<Database>, id: i64) -> Result<Option<db::WorkflowRow>, String> {
    db.wf_get(id)
}

/// 删除工作流
#[tauri::command]
fn workflow_delete(db: State<Database>, id: i64) -> Result<(), String> {
    db.wf_delete(id)
}

/// 记录一次工作流运行
#[tauri::command]
fn workflow_run_add(
    db: State<Database>,
    wf_id: Option<i64>,
    wf_name: String,
    status: String,
    started_at: i64,
    finished_at: i64,
    summary: String,
) -> Result<i64, String> {
    db.wf_run_add(wf_id, &wf_name, &status, started_at, finished_at, &summary)
}

/// 工作流运行历史
#[tauri::command]
fn workflow_runs(db: State<Database>, limit: Option<i64>) -> Result<Vec<db::WorkflowRunRow>, String> {
    db.wf_runs(limit.unwrap_or(10).clamp(1, 100))
}

// --- IM 网关（钉钉/飞书/企微，docs/IM_GATEWAY.md，2026-08-28 落地） ---

/// IM 网关后台任务句柄（供停止）
static IM_GATEWAY_HANDLE: std::sync::OnceLock<std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>> =
    std::sync::OnceLock::new();

/// IM 回复生成器：读当前活跃模型配置，调 chat_once 生成回复
struct LlmReplyGen {
    app_dir: std::path::PathBuf,
}

#[async_trait::async_trait]
impl im::ReplyGenerator for LlmReplyGen {
    async fn reply(&self, history: Vec<(String, String)>, _user_text: &str) -> Result<String, String> {
        let db = db::Database::new(self.app_dir.clone()).map_err(|e| e.to_string())?;
        let cipher = settings::SecretCipher::new(&self.app_dir)?;
        let json = db.get_setting(SETTINGS_KEY)?.ok_or("未找到设置")?;
        let mut st: settings::AppSettings =
            serde_json::from_str(&json).map_err(|e| format!("解析设置失败: {}", e))?;
        cipher.decrypt_settings(&mut st)?;
        let profile = st
            .profiles
            .iter()
            .find(|p| p.id == st.active_profile_id)
            .or_else(|| st.profiles.first())
            .ok_or("未配置模型（请先在设置中配置 API）")?;
        let config = api::ApiConfig {
            base_url: profile.base_url.clone(),
            api_key: profile.api_key.clone(),
            model: profile.model.clone(),
            max_tokens: profile.max_tokens,
            temperature: profile.temperature,
            thinking_enabled: profile.thinking_enabled,
            reasoning_effort: profile.reasoning_effort.clone(),
            system_prompt: String::new(),
            enable_web_search: false,
        };
        let sys = "你是「道生一」AI 助手，正在通过 IM（钉钉/飞书/企业微信）回答用户。\
回答简洁、友好、直接给出结论；需要长内容时给要点；不要输出复杂排版。";
        let mut msgs = vec![api::ChatMessage {
            role: "system".into(),
            content: serde_json::Value::String(sys.into()),
        }];
        for (role, text) in history {
            let r = if role == "user" { "user" } else { "assistant" };
            msgs.push(api::ChatMessage { role: r.into(), content: serde_json::Value::String(text) });
        }
        let r = api::chat_once(config, msgs).await?;
        let content = r.content.trim().to_string();
        if content.is_empty() {
            Err("模型返回空回复".into())
        } else {
            Ok(content)
        }
    }
}

/// 启动 IM 网关：读设置 im_config → 构建平台适配器 → 后台常驻轮询/长连接
#[tauri::command]
async fn im_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Arc<tokio::sync::Mutex<im::ImGatewayState>>>,
) -> Result<im::ImStatus, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db = db::Database::new(app_dir.clone()).map_err(|e| e.to_string())?;
    let cipher = settings::SecretCipher::new(&app_dir)?;
    let json = db.get_setting(SETTINGS_KEY)?.ok_or("未找到设置")?;
    let mut st: settings::AppSettings =
        serde_json::from_str(&json).map_err(|e| format!("解析设置失败: {}", e))?;
    cipher.decrypt_settings(&mut st)?;
    let cfg: im::ImConfig = serde_json::from_value(st.im_config.clone()).unwrap_or_default();
    if !cfg.enabled {
        return Err("IM 网关未启用：请在设置「即时聊天」中启用并保存".into());
    }
    cfg.validate()?;
    let gw_state = state.inner().clone();
    {
        let g = gw_state.lock().await;
        if g.running {
            return Ok(g.snapshot());
        }
    }
    let adapter = im::build_adapter(&cfg)?;
    let reply: std::sync::Arc<dyn im::ReplyGenerator> = std::sync::Arc::new(LlmReplyGen { app_dir });
    let mut gateway = im::ImGateway::new(cfg, adapter, reply, gw_state.clone());
    let handle = tauri::async_runtime::spawn(async move { gateway.run().await });
    *IM_GATEWAY_HANDLE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap() = Some(handle);
    let st = gw_state.lock().await.snapshot();
    Ok(st)
}

/// 停止 IM 网关（abort 后台任务）
#[tauri::command]
async fn im_stop(
    state: tauri::State<'_, std::sync::Arc<tokio::sync::Mutex<im::ImGatewayState>>>,
) -> Result<im::ImStatus, String> {
    if let Some(h) = IM_GATEWAY_HANDLE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap()
        .take()
    {
        h.abort();
    }
    let mut g = state.inner().lock().await;
    g.running = false;
    g.push_log("🛑 IM 网关已停止".into());
    Ok(g.snapshot())
}

/// IM 网关状态（运行中 / 日志 / 最近消息）
#[tauri::command]
async fn im_status(
    state: tauri::State<'_, std::sync::Arc<tokio::sync::Mutex<im::ImGatewayState>>>,
) -> Result<im::ImStatus, String> {
    Ok(state.inner().lock().await.snapshot())
}

// --- 项目语义索引（P-A3 补全：自然语言找代码） ---

/// 项目语义索引：扫描项目代码文件分块 + Ollama embedding 向量化（自然语言找代码用）。
/// 需要本地 Ollama 且已装 nomic-embed-text（语义检索无向量无法工作，直接报错引导部署）。
#[tauri::command]
async fn code_index(db: State<'_, Database>, root_path: String) -> Result<String, String> {
    let allowed = sandbox_allowed_paths(db.inner());
    let expanded = expand_user_path(&root_path)?;
    if !allowed.is_empty() && !path_within_any(std::path::Path::new(&expanded), &allowed) {
        return Err(format!("路径不在沙箱白名单内，拒绝索引：{}", root_path));
    }
    let root = std::path::PathBuf::from(&expanded);
    if !root.is_dir() {
        return Err(format!("不是目录: {}", root_path));
    }
    let skip: [&str; 9] = ["node_modules", ".git", "target", "dist", "build", ".next", "__pycache__", "vendor", ".idea"];
    let is_code_ext = |ext: &str| {
        matches!(ext, "py"|"ts"|"js"|"jsx"|"tsx"|"rs"|"go"|"java"|"c"|"cpp"|"h"|"hpp"|"vue"|"rb"|"php"|"swift"|"kt"|"scala"|"sh"|"toml"|"yml"|"yaml"|"json"|"html"|"css"|"sql")
    };

    let mut collected: Vec<(String, String, i64)> = Vec::new();
    let mut files = 0usize;
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for ent in std::fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {}", e))?.flatten() {
            let p = ent.path();
            if p.is_dir() {
                let name = ent.file_name().to_string_lossy().to_string();
                if skip.contains(&name.as_str()) { continue; }
                stack.push(p);
            } else if p.is_file() {
                let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
                if !is_code_ext(&ext) { continue; }
                // 跳过过大文件（可能是生成物/压缩产物）
                if !p.metadata().map(|m| m.len() < 512 * 1024).unwrap_or(false) { continue; }
                files += 1;
                let text = std::fs::read_to_string(&p).unwrap_or_default();
                let rel = p.strip_prefix(&root).unwrap_or(&p).to_string_lossy().to_string();
                for (i, chunk) in chunk_text(&text, 500).into_iter().enumerate() {
                    if chunk.trim().is_empty() { continue; }
                    collected.push((rel.clone(), chunk, i as i64));
                }
            }
        }
    }
    if collected.is_empty() {
        return Ok(format!("未扫描到代码文件：{}", root.display()));
    }
    // 语义向量必须可用（否则索引无意义）
    ollama_embed_impl(vec![collected[0].1.clone()]).await
        .map_err(|e| format!("语义向量不可用（需要本地 Ollama 已运行且安装 nomic-embed-text）：{}", e))?;

    db.code_clear(&expanded)?;
    let mut chunks = 0usize;
    let mut batch: Vec<String> = Vec::new();
    let mut meta: Vec<&(String, String, i64)> = Vec::new();
    for item in &collected {
        batch.push(item.1.clone());
        meta.push(item);
        if batch.len() >= 20 {
            let vecs = ollama_embed_impl(batch.clone()).await.map_err(|e| format!("生成向量失败: {}", e))?;
            for (m, v) in meta.iter().zip(vecs.into_iter()) {
                db.code_add_chunk(&expanded, &m.0, &m.1, m.2, Some(&v))?;
                chunks += 1;
            }
            batch.clear();
            meta.clear();
        }
    }
    if !batch.is_empty() {
        let vecs = ollama_embed_impl(batch.clone()).await.map_err(|e| format!("生成向量失败: {}", e))?;
        for (m, v) in meta.iter().zip(vecs.into_iter()) {
            db.code_add_chunk(&expanded, &m.0, &m.1, m.2, Some(&v))?;
            chunks += 1;
        }
    }
    Ok(format!(
        "项目语义索引完成：{} 个代码文件 → {} 个分块（{}）",
        files, chunks, root.display()
    ))
}

/// 自然语言找代码：查询嵌入 → 余弦召回相关代码分块
#[tauri::command]
async fn code_search(db: State<'_, Database>, root_path: String, query: String, limit: Option<i64>) -> Result<Vec<db::CodeChunkRow>, String> {
    let lim = limit.unwrap_or(6).clamp(1, 20);
    let expanded = expand_user_path(&root_path)?;
    let qvec = ollama_embed_impl(vec![query]).await
        .map_err(|e| format!("语义向量不可用（需要本地 Ollama + nomic-embed-text）：{}", e))?;
    let v = qvec.into_iter().next().ok_or("查询向量为空")?;
    db.code_search(&expanded, &v, lim)
}

/// 已索引的项目根目录
#[tauri::command]
fn code_roots(db: State<Database>) -> Result<Vec<String>, String> {
    db.code_roots()
}

/// 某项目的语义索引统计（文件数, 分块数）
#[tauri::command]
fn code_stats(db: State<Database>, root_path: String) -> Result<(i64, i64), String> {
    let expanded = expand_user_path(&root_path)?;
    db.code_stats(&expanded)
}

/// 删除某项目的语义索引
#[tauri::command]
fn code_delete(db: State<Database>, root_path: String) -> Result<String, String> {
    let expanded = expand_user_path(&root_path)?;
    db.code_clear(&expanded)?;
    Ok(format!("已删除项目语义索引：{}", expanded))
}

/// 把 base64 附件写入临时目录并返回路径（拖拽/粘贴无磁盘路径的文件，先落盘再走 read_attachment 统一处理）
#[tauri::command]
fn save_temp_attachment(data: String, name: String) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("base64 解码失败: {}", e))?;
    let safe_name: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    let dir = std::env::temp_dir().join("daoshengyi_attachments");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
    let path = dir.join(format!("{}_{}", chrono::Utc::now().timestamp_millis(), safe_name));
    std::fs::write(&path, &bytes).map_err(|e| format!("写入临时文件失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
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
        // 官方 Ollama.app 安装器默认装在系统 /Applications（非 ~/Applications）
        PathBuf::from("/Applications/Ollama.app/Contents/Resources/ollama"),
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

// --- 浏览器检测（Puppeteer 多内核适配：按已安装浏览器 + 系统默认浏览器选择） ---

#[derive(serde::Serialize)]
struct BrowserInfo {
    id: String,       // "chrome" | "edge" | "chromium" | "brave" | "arc"
    name: String,     // 展示名
    path: String,     // 可执行文件绝对路径
    is_default: bool, // 是否是系统默认浏览器
}

/// 各平台浏览器候选路径（返回 id/name/绝对路径）。路径不存在的不返回。
fn browser_candidates() -> Vec<BrowserInfo> {
    let mut out: Vec<BrowserInfo> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        let mac_browsers: &[(&str, &str, &str)] = &[
            ("chrome", "Google Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            ("edge", "Microsoft Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
            ("chromium", "Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"),
            ("brave", "Brave Browser", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
            ("arc", "Arc", "/Applications/Arc.app/Contents/MacOS/Arc"),
        ];
        for (id, name, p) in mac_browsers {
            if std::path::Path::new(p).exists() {
                out.push(BrowserInfo { id: id.to_string(), name: name.to_string(), path: p.to_string(), is_default: false });
            }
        }
        // 用户目录直装（~/Applications）
        let home_apps: &[(&str, &str, &str)] = &[
            ("chrome", "Google Chrome", "Google Chrome.app/Contents/MacOS/Google Chrome"),
            ("edge", "Microsoft Edge", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
            ("chromium", "Chromium", "Chromium.app/Contents/MacOS/Chromium"),
            ("brave", "Brave Browser", "Brave Browser.app/Contents/MacOS/Brave Browser"),
        ];
        if let Some(home) = home_dir() {
            for (id, name, rel) in home_apps {
                let p = home.join("Applications").join(rel);
                if p.exists() && !out.iter().any(|b| b.id == *id) {
                    out.push(BrowserInfo { id: id.to_string(), name: name.to_string(), path: p.to_string_lossy().to_string(), is_default: false });
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        let win_browsers: &[(&str, &str, &str)] = &[
            ("chrome", "Google Chrome", r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            ("chrome", "Google Chrome", r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
            ("edge", "Microsoft Edge", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
            ("chromium", "Chromium", r"C:\Program Files\Chromium\Application\chromium.exe"),
            ("brave", "Brave Browser", r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"),
        ];
        for (id, name, p) in win_browsers {
            if std::path::Path::new(p).exists() && !out.iter().any(|b| b.id == *id) {
                out.push(BrowserInfo { id: id.to_string(), name: name.to_string(), path: p.to_string(), is_default: false });
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        let linux_cmds: &[(&str, &str, &str)] = &[
            ("chrome", "Google Chrome", "google-chrome"),
            ("chrome", "Google Chrome", "google-chrome-stable"),
            ("chromium", "Chromium", "chromium"),
            ("chromium", "Chromium", "chromium-browser"),
            ("edge", "Microsoft Edge", "microsoft-edge"),
            ("brave", "Brave Browser", "brave-browser"),
        ];
        for (id, name, cmd) in linux_cmds {
            if !out.iter().any(|b| b.id == *id) {
                let p = run_sys_cmd("which", &[cmd]);
                if !p.is_empty() {
                    out.push(BrowserInfo { id: id.to_string(), name: name.to_string(), path: p, is_default: false });
                }
            }
        }
    }
    out
}

/// 判定系统默认浏览器 id（macOS 读 https 协议默认 handler / Linux xdg / Windows 注册表）。
/// 探测失败返回 None（不影响主流程，前端回退按推荐序）。
fn system_default_browser() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        // LSCopyDefaultApplicationURLForURL：读 https:// 的默认处理程序
        let script = "osascript -e 'set u to URL \"https://\"\n tell application \"System Events\" to get name of first application process whose unix id is 0' 2>/dev/null; true";
        let _ = script;
        // 用 swift 内联：LSCopyDefaultApplicationURLForURL 返回 bundle 路径，再映射到已知浏览器
        let swift = r#"
import Foundation
import CoreServices
if let url = CFURLCreateWithString(kCFAllocatorDefault, "https://" as CFString, nil) {
  if let app = LSCopyDefaultApplicationURLForURL(url, .all, nil)?.takeRetainedValue() {
    let path = (app as URL).path
    let lower = path.lowercased()
    if lower.contains("google chrome") { print("chrome"); exit(0) }
    if lower.contains("microsoft edge") { print("edge"); exit(0) }
    if lower.contains("chromium") { print("chromium"); exit(0) }
    if lower.contains("brave") { print("brave"); exit(0) }
    if lower.contains("arc.app") { print("arc"); exit(0) }
  }
}
exit(1)
"#;
        let tmp = std::env::temp_dir().join("dsy_default_browser.swift");
        let exe = std::env::temp_dir().join("dsy_default_browser");
        // 编译产物缓存到 temp 固定路径：swiftc -O 很慢（1~5s），只在 exe 缺失时编译一次，
        // 后续检测直接运行已编译二进制（毫秒级），避免每次打开设置面板都卡顿。
        if !exe.exists() {
            if std::fs::write(&tmp, swift).is_ok() {
                let compile = std::process::Command::new("swiftc")
                    .args(["-O", tmp.to_str().unwrap_or(""), "-o", exe.to_str().unwrap_or("")])
                    .output();
                let _ = std::fs::remove_file(&tmp);
                if let Ok(o) = compile {
                    if !o.status.success() { let _ = std::fs::remove_file(&exe); }
                }
            }
        }
        if exe.exists() {
            let run = std::process::Command::new(&exe).output();
            if let Ok(r) = run {
                if r.status.success() {
                    let id = String::from_utf8_lossy(&r.stdout).trim().to_string();
                    if !id.is_empty() { return Some(id); }
                }
            }
        }
        // 兜底：读 LaunchServices 注册表（无需编译）
        let plist = run_sys_cmd("defaults", &["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"]);
        if !plist.is_empty() {
            let lower = plist.to_lowercase();
            if lower.contains("google chrome") { return Some("chrome".into()); }
            if lower.contains("microsoft edge") { return Some("edge".into()); }
            if lower.contains("chromium") { return Some("chromium".into()); }
            if lower.contains("brave") { return Some("brave".into()); }
            if lower.contains("arc") { return Some("arc".into()); }
        }
        None
    }
    #[cfg(target_os = "linux")]
    {
        let x = run_sys_cmd("xdg-settings", &["get", "default-web-browser"]);
        let l = x.to_lowercase();
        if l.contains("chrome") { return Some("chrome".into()); }
        if l.contains("chromium") { return Some("chromium".into()); }
        if l.contains("edge") { return Some("edge".into()); }
        if l.contains("brave") { return Some("brave".into()); }
        None
    }
    #[cfg(target_os = "windows")]
    {
        let reg = run_sys_cmd("reg", &["query", r"HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice", "/v", "Progid"]);
        let l = reg.to_lowercase();
        if l.contains("chrome") { return Some("chrome".into()); }
        if l.contains("edge") { return Some("edge".into()); }
        if l.contains("chromium") { return Some("chromium".into()); }
        if l.contains("brave") { return Some("brave".into()); }
        None
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    { None }
}

/// 检测已安装浏览器 + 系统默认浏览器（Puppeteer 多内核适配）。
#[tauri::command]
fn detect_browsers() -> Vec<BrowserInfo> {
    let mut list = browser_candidates();
    if let Some(def) = system_default_browser() {
        for b in list.iter_mut() {
            if b.id == def { b.is_default = true; }
        }
    }
    list
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

// --- P-A6 本地语义 embedding（Ollama nomic-embed-text，补 DeepSeek 无 embeddings 端点的短板） ---
/// 本地语义检索使用的 embedding 模型
const EMBED_MODEL: &str = "nomic-embed-text";

/// 模型列表中是否已安装本地 embedding 模型（纯函数，可测试）
fn embed_model_installed(models: &[String]) -> bool {
    models.iter().any(|m| m.starts_with(EMBED_MODEL))
}

/// 解析 Ollama /api/embed 响应（`{"embeddings": [[..], ..]}`）为向量列表（纯函数，可测试）。
/// 元素为空向量视为格式异常，返回错误。
fn parse_embed_response(json: &serde_json::Value) -> Result<Vec<Vec<f32>>, String> {
    let embeddings = json
        .get("embeddings")
        .and_then(|v| v.as_array())
        .ok_or("embedding 响应缺少 embeddings 字段")?;
    let mut out = Vec::with_capacity(embeddings.len());
    for e in embeddings {
        let arr = e.as_array().ok_or("embedding 元素格式异常")?;
        let vec: Vec<f32> = arr.iter().filter_map(|x| x.as_f64().map(|v| v as f32)).collect();
        if vec.is_empty() {
            return Err("embedding 为空向量".into());
        }
        out.push(vec);
    }
    Ok(out)
}

/// 本地语义 embedding 核心（P-A6）：用 Ollama 的 nomic-embed-text 生成向量，补 DeepSeek
/// 无 embeddings 端点的语义检索短板（记忆向量检索 + 知识库分块向量共用）。
/// 设计要点：**不自动拉模型**（避免静默下载大文件）——服务未运行或模型未安装时
/// 返回明确错误，调用方静默回退（语义检索暂不可用，FTS5 关键词检索不受影响）。
async fn ollama_embed_impl(texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
    // 服务不可用（未运行）→ 快速失败（ollama_running 内部 2s 超时）
    if !ollama_running().await {
        return Err("Ollama 服务未运行".into());
    }
    // 模型未安装 → 明确提示，不自动拉取
    let models = ollama_models().await.unwrap_or_default();
    if !embed_model_installed(&models) {
        return Err(format!(
            "本地 embedding 模型 {} 未安装，可执行 `ollama pull {}` 后启用语义检索",
            EMBED_MODEL, EMBED_MODEL
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {}", e))?;
    let resp = client
        .post("http://localhost:11434/api/embed")
        .json(&serde_json::json!({ "model": EMBED_MODEL, "input": texts }))
        .send()
        .await
        .map_err(|e| format!("请求 embedding 失败: {}", e))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "embedding 请求失败: HTTP {} {}",
            code,
            body.chars().take(200).collect::<String>()
        ));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    parse_embed_response(&json)
}

/// 本地语义 embedding（P-A6）：tauri 命令入口，复用 ollama_embed_impl。
#[tauri::command]
async fn ollama_embed(texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
    ollama_embed_impl(texts).await
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
/// 保存截图/图片。用户显式指定了保存路径则以用户为准（支持 ~ 展开，自动建父目录）；
/// 否则保存到用户可见的持久目录 ~/Pictures/道生一截图/（避免临时目录被系统清理、
/// 也让用户方便打开查看）。返回真实绝对路径。
fn save_temp_image(data: String, path: Option<String>) -> Result<String, String> {
    let bytes = decode_data_uri(&data).ok_or("图片数据格式无效")?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let home = std::env::var("HOME").unwrap_or_default();
    let target: std::path::PathBuf = match path {
        Some(p) if !p.trim().is_empty() => {
            let p = p.trim();
            if p == "~" || p.starts_with("~/") {
                if home.is_empty() { std::path::PathBuf::from(p) }
                else { std::path::Path::new(&home).join(p.trim_start_matches("~/")) }
            } else {
                std::path::PathBuf::from(p)
            }
        }
        _ => {
            let dir = if home.is_empty() {
                std::env::temp_dir()
            } else {
                std::path::Path::new(&home).join("Pictures").join("道生一截图")
            };
            std::fs::create_dir_all(&dir).map_err(|e| format!("创建截图目录失败: {}", e))?;
            dir.join(format!("daoshengyi-shot-{}.png", ts))
        }
    };
    // 用户指定路径时确保父目录存在
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    std::fs::write(&target, &bytes).map_err(|e| format!("保存图片失败: {}", e))?;
    Ok(target.to_string_lossy().to_string())
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

/// 执行终端命令（一次性返回输出，默认 60 秒超时）。
/// 通过 /bin/sh -c 执行**整条命令**：支持管道/重定向/~ 展开/&& 等 shell 语法（此前
/// 直接 Command::new 执行第一个词，`~` 不展开、管道不生效、非可执行文件报启动错误）。
/// 用进程组（process_group(0)）便于超时/取消时连同子进程一起终止，避免 sleep 等残留。
#[tauri::command]
async fn execute_command(
    db: State<'_, Database>,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<CommandOutput, String> {
    let start = std::time::Instant::now();
    // command 视为整条命令行（前端 /run 传整条、args 为空）；兼容旧调用（args 非空则追加）
    let full_cmd = if args.is_empty() {
        command.clone()
    } else {
        format!("{} {}", command, args.join(" "))
    };
    let audit_args = full_cmd.clone();
    let mut out = run_shell_command(&full_cmd, cwd.as_deref(), timeout_secs).await;
    let duration = start.elapsed().as_millis() as i64;
    match &out {
        Ok(CommandOutput { exit_code, stdout, stderr, timed_out: _, .. }) => {
            let _ = db.log_tool_call(
                "command",
                &audit_args,
                &format!("exit={} out={} err={}", exit_code, stdout, stderr),
                *exit_code != 0,
                duration,
            );
        }
        Err(e) => {
            let _ = db.log_tool_call("command", &audit_args, &format!("启动失败: {}", e), true, duration);
        }
    }
    // 解析命令重定向生成的文件（绝对路径），供前端展示为可点击链接
    if let Ok(co) = &mut out {
        co.created_files = extract_redirected_files(&full_cmd, cwd.as_deref());
    }
    out
}

/// 从 shell 命令中提取「重定向生成的文件」（如 `> l.txt`、`2> err.log`、`&> out.txt`），
/// 结合工作目录转绝对路径并校验真实存在，供前端渲染为可点击文件链接。
/// 引号感知（`echo "a > b"` 不误判）；排除 /dev/null、&1、$ 变量等特殊目标；实用优先不求完美。
fn extract_redirected_files(cmd: &str, cwd: Option<&str>) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    let chars: Vec<char> = cmd.chars().collect();
    let n = chars.len();
    let mut i = 0;
    let mut in_squote = false;
    let mut in_dquote = false;
    while i < n {
        let c = chars[i];
        match c {
            '\'' if !in_dquote => in_squote = !in_squote,
            '"' if !in_squote => in_dquote = !in_dquote,
            _ if !in_squote && !in_dquote && c == '>' => {
                let mut j = i;
                while j < n && chars[j] == '>' {
                    j += 1;
                }
                while j < n && chars[j].is_whitespace() {
                    j += 1;
                }
                let mut tok = String::new();
                if j < n && chars[j] == '"' {
                    j += 1;
                    while j < n && chars[j] != '"' {
                        tok.push(chars[j]);
                        j += 1;
                    }
                } else if j < n && chars[j] == '\'' {
                    j += 1;
                    while j < n && chars[j] != '\'' {
                        tok.push(chars[j]);
                        j += 1;
                    }
                } else {
                    while j < n && !chars[j].is_whitespace() && chars[j] != '<' {
                        tok.push(chars[j]);
                        j += 1;
                    }
                }
                let tok = tok.trim();
                if !tok.is_empty() && tok != "/dev/null" && tok != "&1" && !tok.starts_with('$') {
                    let abs = if tok.starts_with('/') {
                        tok.to_string()
                    } else if let Some(rest) = tok.strip_prefix("~/") {
                        let home = std::env::var("HOME").unwrap_or_default();
                        if home.is_empty() {
                            tok.to_string()
                        } else {
                            format!("{}/{}", home, rest)
                        }
                    } else if let Some(c) = cwd {
                        format!("{}/{}", c.trim_end_matches('/'), tok)
                    } else {
                        // 无显式 cwd：用进程当前目录作基准，保证相对路径能转成可点击的绝对路径
                        let pwd = std::env::current_dir()
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_default();
                        if pwd.is_empty() {
                            tok.to_string()
                        } else {
                            format!("{}/{}", pwd.trim_end_matches('/'), tok)
                        }
                    };
                    files.push(abs);
                }
                i = j;
            }
            _ => {}
        }
        i += 1;
    }
    // 去重 + 校验真实存在
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    files.retain(|f| {
        let canon = f.replace("//", "/");
        if seen.contains(&canon) {
            return false;
        }
        seen.insert(canon.clone());
        std::path::Path::new(&canon).exists()
    });
    files
}

/// 通过 /bin/sh -c 执行整条 shell 命令，返回结构化输出。
/// 独立成函数便于单元测试（不依赖 Tauri State）；进程组保证超时能杀干净子进程。
async fn run_shell_command(
    full_cmd: &str,
    cwd: Option<&str>,
    timeout_secs: Option<u64>,
) -> Result<CommandOutput, String> {
    use tokio::io::AsyncReadExt;

    let mut cmd = tokio::process::Command::new("/bin/sh");
    cmd.arg("-c").arg(full_cmd);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);
    // 新进程组：超时/drop 时能 kill 整个进程组（含 sh 派生的子进程）
    #[cfg(unix)]
    cmd.process_group(0);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动命令失败: {}", e))?;
    let pid = child.id().unwrap_or(0) as i32; // process_group(0) 后 pgid == pid，可 kill(-pid) 杀整个组
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
                created_files: Vec::new(),
            })
        }
        Err(_) => {
            // 超时：kill 整个进程组（sh 及其子进程）；kill_on_drop 只杀 sh 会残留 sleep 等子进程
            #[cfg(unix)]
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
            Ok(CommandOutput {
                stdout: String::new(),
                stderr: format!("命令执行超时（{}s），已终止", timeout_secs.unwrap_or(60)),
                exit_code: -1,
                timed_out: true,
                created_files: Vec::new(),
            })
        }
    }
}

/// Git 操作（编程 Agent：提交/推送/拉取/diff/状态/日志等）。
/// 用 git CLI 子进程执行（cwd 指定仓库目录），带超时 + 审计；禁止危险参数逃逸。
/// 参数 action：status/diff/log/commit/push/pull/add/branch/其他（透传 git args）
#[tauri::command]
async fn git_operation(
    db: State<'_, Database>,
    cwd: String,
    action: String,
    args: Vec<String>,
    timeout_secs: Option<u64>,
) -> Result<CommandOutput, String> {
    use tokio::io::AsyncReadExt;

    let start = std::time::Instant::now();
    let audit_args = format!("git {} {}", action, args.join(" "));
    validate_git_operation(&action, &args)?;

    let mut cmd = tokio::process::Command::new("git");
    cmd.arg(&action).args(&args);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);
    if !cwd.trim().is_empty() {
        cmd.current_dir(&cwd);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动 git 失败: {}", e))?;
    let mut stdout_pipe = child.stdout.take().ok_or("无法获取 stdout")?;
    let mut stderr_pipe = child.stderr.take().ok_or("无法获取 stderr")?;
    let timeout = std::time::Duration::from_secs(timeout_secs.unwrap_or(60));

    let result = tokio::time::timeout(timeout, async {
        let mut out_buf = Vec::new();
        let mut err_buf = Vec::new();
        let (_, _, status_res) = tokio::join!(
            stdout_pipe.read_to_end(&mut out_buf),
            stderr_pipe.read_to_end(&mut err_buf),
            child.wait(),
        );
        (status_res, out_buf, err_buf)
    })
    .await;

    let duration = start.elapsed().as_millis() as i64;

    match result {
        Ok((status_res, out_buf, err_buf)) => {
            let status = status_res.map_err(|e| format!("等待 git 失败: {}", e))?;
            let stdout = String::from_utf8_lossy(&out_buf).to_string();
            let stderr = String::from_utf8_lossy(&err_buf).to_string();
            let exit_code = status.code().unwrap_or(-1);
            let _ = db.log_tool_call("git", &audit_args, &format!("exit={} out={} err={}", exit_code, stdout, stderr), exit_code != 0, duration);
            Ok(CommandOutput { stdout, stderr, exit_code, timed_out: false, created_files: Vec::new() })
        }
        Err(_) => {
            let msg = format!("git 操作超时（{}s），已终止", timeout_secs.unwrap_or(60));
            let _ = db.log_tool_call("git", &audit_args, &msg, true, duration);
            Ok(CommandOutput { stdout: String::new(), stderr: msg, exit_code: -1, timed_out: true, created_files: Vec::new() })
        }
    }
}

/// 测试输出（编程 Agent 验证循环用）
#[derive(serde::Serialize)]
struct TestOutput {
    /// 检测到的测试框架：cargo / npm / pytest / custom / unknown
    framework: String,
    /// 实际执行的命令（如 "cargo test"）
    command: String,
    stdout: String,
    stderr: String,
    exit_code: i32,
    timed_out: bool,
}

/// 自动运行测试（编程 Agent 验证循环）：
/// 在指定项目目录自动检测测试框架并运行——package.json→npm test，Cargo.toml→cargo test，
/// pyproject/requirements→pytest，均不存在则用显式 command 覆盖。
/// 返回结构化结果，前端/Agent 据此判断失败项并迭代修复。
#[tauri::command]
async fn run_tests(
    db: State<'_, Database>,
    cwd: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    timeout_secs: Option<u64>,
) -> Result<TestOutput, String> {
    use tokio::io::AsyncReadExt;

    // 1) 检测项目测试框架
    let (mut framework, mut cmd_parts): (String, Vec<String>) = detect_test_framework(&cwd);

    // 2) 显式覆盖（agent 指定了具体命令时）
    if let Some(c) = command {
        if !c.trim().is_empty() {
            framework = "custom".to_string();
            let mut parts = c.split_whitespace().map(|s| s.to_string()).collect::<Vec<_>>();
            if let Some(a) = args { parts.extend(a); }
            cmd_parts = parts;
        }
    }
    if cmd_parts.is_empty() {
        return Err(format!("无法在 {} 检测到测试框架（无 package.json / Cargo.toml / pyproject.toml / requirements.txt），请用 command 参数显式指定测试命令", cwd));
    }

    let display_cmd = cmd_parts.join(" ");
    let start = std::time::Instant::now();
    let audit_args = display_cmd.clone();

    let mut child = {
        let mut cmd = tokio::process::Command::new(&cmd_parts[0]);
        cmd.args(&cmd_parts[1..]);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.kill_on_drop(true);
        if !cwd.trim().is_empty() { cmd.current_dir(&cwd); }
        cmd.spawn().map_err(|e| format!("启动测试命令失败（{}）: {}", display_cmd, e))?
    };

    let mut stdout_pipe = child.stdout.take().ok_or("无法获取 stdout")?;
    let mut stderr_pipe = child.stderr.take().ok_or("无法获取 stderr")?;
    let timeout = std::time::Duration::from_secs(timeout_secs.unwrap_or(300));

    let result = tokio::time::timeout(timeout, async {
        let mut out_buf = Vec::new();
        let mut err_buf = Vec::new();
        let (_, _, status_res) = tokio::join!(
            stdout_pipe.read_to_end(&mut out_buf),
            stderr_pipe.read_to_end(&mut err_buf),
            child.wait(),
        );
        (status_res, out_buf, err_buf)
    }).await;

    let duration = start.elapsed().as_millis() as i64;

    match result {
        Ok((status_res, out_buf, err_buf)) => {
            let status = status_res.map_err(|e| format!("等待测试失败: {}", e))?;
            let stdout = String::from_utf8_lossy(&out_buf).to_string();
            let stderr = String::from_utf8_lossy(&err_buf).to_string();
            let exit_code = status.code().unwrap_or(-1);
            let _ = db.log_tool_call("test", &audit_args, &format!("exit={} out={} err={}", exit_code, stdout, stderr), exit_code != 0, duration);
            Ok(TestOutput { framework, command: display_cmd, stdout, stderr, exit_code, timed_out: false })
        }
        Err(_) => {
            let msg = format!("测试执行超时（{}s），已终止", timeout_secs.unwrap_or(300));
            let _ = db.log_tool_call("test", &audit_args, &msg, true, duration);
            Ok(TestOutput { framework, command: display_cmd, stdout: String::new(), stderr: msg, exit_code: -1, timed_out: true })
        }
    }
}

/// 检测项目测试框架（纯逻辑，可测试）：返回 (框架名, 命令 parts)
fn detect_test_framework(cwd: &str) -> (String, Vec<String>) {
    use std::path::Path;
    let dir = Path::new(cwd);
    if dir.join("package.json").exists() {
        return ("npm".into(), vec!["npm".into(), "test".into()]);
    }
    if dir.join("Cargo.toml").exists() {
        return ("cargo".into(), vec!["cargo".into(), "test".into()]);
    }
    if dir.join("pyproject.toml").exists() || dir.join("requirements.txt").exists() || dir.join("pytest.ini").exists() {
        return ("pytest".into(), vec!["python3".into(), "-m".into(), "pytest".into(), "-q".into()]);
    }
    ("unknown".into(), Vec::new())
}

/// 项目结构分析输出（编程 Agent 代码库理解）
#[derive(serde::Serialize)]
struct ProjectAnalysis {
    /// 项目根路径
    root: String,
    /// 识别的技术栈（如 Rust / TypeScript+Vue / Python）
    stack: String,
    /// 清单文件（package.json/Cargo.toml 等）里可用的脚本/元信息摘要
    manifest_hint: String,
    /// 顶层结构（目录+文件，跳过常见大目录）
    top_level: Vec<String>,
    /// 源码文件按扩展名计数（仅主要语言，跳过 node_modules/target 等）
    by_ext: Vec<String>,
    /// 总源码文件数
    source_files: usize,
}

/// 分析项目结构（编程 Agent 代码库理解，P-A3）：
/// 识别技术栈、列出顶层结构、按扩展名统计源码文件，帮 Agent 快速建立项目认知。
/// 轻量扫描：跳过 node_modules/.git/target/dist/build 等大目录，限制扫描深度。
#[tauri::command]
fn analyze_project(root: String) -> Result<ProjectAnalysis, String> {
    let dir = std::path::Path::new(&root);
    if !dir.is_dir() {
        return Err(format!("不是目录: {}", root));
    }

    let mut stack_parts: Vec<String> = Vec::new();
    let mut manifest_hint = String::new();

    // 识别技术栈（优先级：多清单时组合）
    if dir.join("Cargo.toml").exists() {
        stack_parts.push("Rust".into());
        if let Ok(content) = std::fs::read_to_string(dir.join("Cargo.toml")) {
            if let Some(line) = content.lines().find(|l| l.trim().starts_with("name")) {
                manifest_hint = format!("Cargo 包: {}", line.trim().trim_start_matches("name").trim().trim_matches(|c| c == '=' || c == '"' || c == ' '));
            }
        }
    }
    if dir.join("package.json").exists() {
        let mut is_ts = false;
        if let Ok(content) = std::fs::read_to_string(dir.join("package.json")) {
            if content.contains("\"typescript\"") || content.contains("\"tsc\"") { is_ts = true; }
            if let Some(l) = content.lines().find(|l| l.contains("\"name\"")) {
                let hint = l.trim().trim_start_matches("\"name\"").trim().trim_matches(|c| c == ':' || c == ',' || c == '"' || c == ' ');
                manifest_hint = if manifest_hint.is_empty() { format!("npm 包: {}", hint) } else { format!("{}; npm 包: {}", manifest_hint, hint) };
            }
            let scripts: Vec<String> = content.split("\"scripts\"").nth(1).map(|s| {
                s.split(',').take(5).map(|x| {
                    x.trim().trim_start_matches('{').trim().trim_matches('}').trim().to_string()
                }).filter(|x| !x.is_empty() && x.contains(':')).collect()
            }).unwrap_or_default();
            if !scripts.is_empty() {
                manifest_hint = format!("{}; scripts: {}", manifest_hint, scripts.join(", "));
            }
        }
        stack_parts.push(if is_ts { "TypeScript".into() } else { "JavaScript".into() });
    }
    if dir.join("pyproject.toml").exists() || dir.join("requirements.txt").exists() {
        stack_parts.push("Python".into());
    }
    if dir.join("go.mod").exists() { stack_parts.push("Go".into()); }
    if dir.join("pom.xml").exists() { stack_parts.push("Java".into()); }
    if dir.join("vue.config.js").exists() || dir.join("vite.config.ts").exists() || dir.join("vite.config.js").exists() { stack_parts.push("Vue".into()); }
    if dir.join("src").join("App.vue").exists() { stack_parts.push("Vue".into()); }
    let stack = if stack_parts.is_empty() { "未知".to_string() } else { stack_parts.join(" + ") };

    // 顶层结构 + 按扩展名统计（跳过常见大目录）
    const SKIP_DIRS: &[&str] = &["node_modules", ".git", "target", "dist", "build", "vendor", ".next", "__pycache__", ".idea", ".vscode"];
    const SRC_EXTS: &[&str] = &["rs", "ts", "tsx", "js", "jsx", "vue", "py", "go", "java", "c", "cpp", "h", "hpp", "cs", "rb", "php", "swift", "kt", "sh", "sql", "toml", "json", "yaml", "yml", "css", "html"];
    let mut top_level: Vec<String> = Vec::new();
    let mut by_ext: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut source_files = 0usize;

    if let Ok(entries) = std::fs::read_dir(dir) {
        for ent in entries.flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            let is_dir = ent.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if SKIP_DIRS.contains(&name.as_str()) { continue; }
                top_level.push(format!("📁 {}/", name));
            } else {
                top_level.push(format!("📄 {}", name));
                if let Some(ext) = name.rsplit('.').next() {
                    if SRC_EXTS.contains(&ext) {
                        *by_ext.entry(ext.to_string()).or_insert(0) += 1;
                        source_files += 1;
                    }
                }
            }
        }
    }
    top_level.sort();
    let mut ext_lines: Vec<String> = by_ext.iter().map(|(k, v)| format!("{}: {}", k, v)).collect();
    ext_lines.sort();

    Ok(ProjectAnalysis {
        root,
        stack,
        manifest_hint,
        top_level: top_level.into_iter().take(60).collect(),
        by_ext: ext_lines.into_iter().take(20).collect(),
        source_files,
    })
}

/// Git 操作安全校验：白名单子命令 + 拒绝危险参数（可独立测试的纯逻辑）
fn validate_git_operation(action: &str, args: &[String]) -> Result<(), String> {
    const SAFE_RO: &[&str] = &["status", "diff", "log", "branch", "remote", "show", "ls-files", "rev-parse"];
    const SAFE_RW: &[&str] = &["add", "commit", "pull", "push", "checkout", "init", "clone"];
    if !SAFE_RO.contains(&action) && !SAFE_RW.contains(&action) {
        return Err(format!(
            "git_operation 不支持该子命令: {}（仅限 {}）",
            action,
            SAFE_RO.iter().chain(SAFE_RW).cloned().collect::<Vec<_>>().join("/")
        ));
    }
    // 禁止破坏性/危险参数（防止 agent 误操作或注入）
    let dangerous = ["--force", "--hard", "reset", "rm", "clean", "--delete"];
    if args.iter().any(|a| dangerous.iter().any(|d| a.contains(d))) {
        return Err(format!("git_operation 拒绝危险参数: {:?}", args));
    }
    Ok(())
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

/// 用量历史累计：每次 LLM 回复生成后调用一次（token/费用/耗时按天累计，删除会话不清零）
#[tauri::command]
fn accumulate_usage(db: State<Database>, tokens: i64, cost: f64, duration: f64, timestamp: i64) -> Result<(), String> {
    db.accumulate_usage(tokens, cost, duration, timestamp)
}

/// 读取用量历史累计（总量 + 按天）
#[tauri::command]
fn get_usage_agg(db: State<Database>) -> Result<serde_json::Value, String> {
    let total = db.get_usage_total()?;
    let daily = db.get_usage_daily()?;
    Ok(serde_json::json!({ "total": total, "daily": daily }))
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
fn save_fact(db: State<Database>, fact: db::FactRow) -> Result<String, String> {
    let (is_new, id) = db.save_fact(&fact)?;
    Ok(if is_new { format!("saved:{}", id) } else { format!("merged:{}", id) })
}

/// 记忆维护（启动/每日后台调度用）：重要度衰减 + 遗忘 + FTS 清理
#[tauri::command]
fn maintain_facts(db: State<Database>) -> Result<String, String> {
    db.maintain_facts()
}

#[tauri::command]
fn search_facts(db: State<Database>, query: String, limit: i64) -> Result<Vec<db::FactRow>, String> {
    db.search_facts(&query, limit)
}

#[tauri::command]
fn get_preferences(db: State<Database>) -> Result<Vec<db::FactRow>, String> {
    db.get_facts_by_type("preference", 20)
}

/// 列出全部事实（记忆管理面板用）：fact_type 空=全部；按 重要度/最近访问 排序
#[tauri::command]
fn list_facts(db: State<Database>, fact_type: String, limit: i64) -> Result<Vec<db::FactRow>, String> {
    db.list_facts(&fact_type, limit)
}

/// 列出全部会话摘要（记忆管理面板用）
#[tauri::command]
fn list_all_summaries(db: State<Database>, limit: i64) -> Result<Vec<db::SummaryRow>, String> {
    db.list_all_summaries(limit)
}

// --- 记忆分层 1.4：episodic 聚合层（跨会话主题汇总）命令 ---

/// 列出跨会话主题条目（记忆管理面板展示）
#[tauri::command]
fn list_episodic(db: State<Database>, limit: i64) -> Result<Vec<db::EpisodicRow>, String> {
    db.list_episodic(limit)
}

#[tauri::command]
fn save_episodic_cmd(
    db: State<Database>,
    id: String,
    title: String,
    summary: String,
    source_summary_ids: String,
) -> Result<(), String> {
    db.save_episodic(&id, &title, &summary, &source_summary_ids)
}

#[tauri::command]
fn delete_episodic_cmd(db: State<Database>, id: String) -> Result<(), String> {
    db.delete_episodic(&id)
}

/// 已参与跨会话汇总的会话摘要 id 列表（前端过滤未汇总的新摘要，避免重复汇总）
#[tauri::command]
fn episodic_covered(db: State<Database>) -> Result<Vec<String>, String> {
    db.episodic_covered()
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

/// 编辑事实（记忆管理面板用）：更新文本/类型/重要度
#[tauri::command]
fn update_fact_cmd(db: State<Database>, id: String, fact: String, fact_type: String, importance: i64) -> Result<(), String> {
    db.update_fact(&id, &fact, &fact_type, importance)
}

#[tauri::command]
fn prune_facts(db: State<Database>) -> Result<String, String> {
    db.maintain_facts()
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
async fn web_search(query: String) -> Result<Vec<search::SearchResult>, String> {
    search::search_web(&query).await
}

/// 主动推送消息到 IM 群机器人（飞书 / 企业微信）。只发不收，无需公网、无代理。
/// 飞书：POST {webhook} body {"msg_type":"text","content":{"text":..}}
/// 企业微信：POST {webhook} body {"msgtype":"text","text":{"content":..}}
/// 校验 HTTP 状态 + 平台业务错误码（errcode / code 非 0 视为失败）。
#[tauri::command]
async fn send_im_message(platform: String, text: String, webhook: String, secret: String) -> Result<String, String> {
    if webhook.trim().is_empty() {
        return Err("未配置 Webhook 地址".into());
    }
    // 钉钉支持加签：timestamp + HMAC-SHA256(secret) 签名追加到 URL（飞书/企业微信无此机制）
    let mut url = webhook;
    if platform == "dingtalk" && !secret.trim().is_empty() {
        use base64::Engine as _;
        use hmac::{Hmac, Mac};
        use sha2::Sha256;
        let ts = chrono::Utc::now().timestamp_millis();
        let string_to_sign = format!("{}\n{}", ts, secret.trim());
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.trim().as_bytes())
            .map_err(|e| format!("签名失败: {}", e))?;
        mac.update(string_to_sign.as_bytes());
        let sign = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
        let sep = if url.contains('?') { '&' } else { '?' };
        url = format!("{}{}timestamp={}&sign={}", url, sep, ts, urlencode(&sign));
    }
    let body = match platform.as_str() {
        "feishu" => serde_json::json!({
            "msg_type": "text",
            "content": { "text": text },
        }),
        _ => serde_json::json!({ // wecom / dingtalk 结构一致
            "msgtype": "text",
            "text": { "content": text },
        }),
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build().map_err(|e| format!("客户端构建失败: {}", e))?;
    let resp = client.post(&url)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send().await.map_err(|e| format!("网络错误: {}", e))?;
    let status = resp.status();
    let text_body = resp.text().await.unwrap_or_default();
    // 飞书/企业微信/钉钉即使 HTTP 200 也可能返回业务错误码，需再校验
    let json: serde_json::Value = serde_json::from_str(&text_body).unwrap_or(serde_json::Value::Null);
    let errcode = json.get("errcode").and_then(|v| v.as_i64());
    let code = json.get("code").and_then(|v| v.as_i64());
    let biz_ok = match (errcode, code) {
        (Some(e), _) => e == 0,
        (_, Some(c)) => c == 0,
        _ => true,
    };
    if status.is_success() && biz_ok {
        Ok(format!("✅ 已通过 {} 推送成功", platform))
    } else {
        Err(format!("推送失败 [{}]: {}", status, text_body.chars().take(200).collect::<String>()))
    }
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

// --- 社区插件市场（Smithery） ---

#[derive(serde::Serialize, Clone)]
struct CommunityPlugin {
    id: String,          // 唯一标识（如 gmail）
    name: String,        // 显示名
    description: String,
    source: String,      // "smithery"
    verified: bool,
    use_count: i64,
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 拉取社区插件列表（当前来源：Smithery registry，开放无鉴权）
#[tauri::command]
async fn fetch_community_plugins(query: Option<String>) -> Result<Vec<CommunityPlugin>, String> {
    let q = query.unwrap_or_default();
    let url = format!("https://registry.smithery.ai/servers?q={}", urlencode(&q));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {}", e))?;
    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("请求插件市场失败: {}", e))?;
    let text = resp.text().await.map_err(|e| format!("读取插件市场响应: {}", e))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析插件市场响应: {}", e))?;
    let servers = v
        .get("servers")
        .and_then(|x| x.as_array())
        .ok_or("插件市场响应缺少 servers 字段")?;
    let mut out = Vec::new();
    for s in servers {
        let id = s.get("qualifiedName").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let name = s.get("displayName").and_then(|x| x.as_str()).unwrap_or(&id).to_string();
        let description = s.get("description").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let verified = s.get("verified").and_then(|x| x.as_bool()).unwrap_or(false);
        let use_count = s.get("useCount").and_then(|x| x.as_i64()).unwrap_or(0);
        out.push(CommunityPlugin {
            id: id.clone(),
            name,
            description,
            source: "smithery".into(),
            verified,
            use_count,
        });
    }
    Ok(out)
}

/// 查询插件详情，返回远程 HTTP MCP 端点（deploymentUrl）
#[tauri::command]
async fn fetch_remote_plugin_endpoint(id: String) -> Result<String, String> {
    let clean = id.trim_start_matches("smithery:").trim().to_string();
    if clean.is_empty() {
        return Err("插件 ID 为空".into());
    }
    let url = format!("https://registry.smithery.ai/servers/{}", urlencode(&clean));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {}", e))?;
    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("查询插件详情失败: {}", e))?;
    let text = resp.text().await.map_err(|e| format!("读取插件详情: {}", e))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析插件详情: {}", e))?;
    if let Some(u) = v.get("deploymentUrl").and_then(|x| x.as_str()) {
        if !u.is_empty() {
            return Ok(u.to_string());
        }
    }
    if let Some(conns) = v.get("connections").and_then(|x| x.as_array()) {
        for c in conns {
            if let Some(u) = c.get("deploymentUrl").and_then(|x| x.as_str()) {
                if !u.is_empty() {
                    return Ok(u.to_string());
                }
            }
        }
    }
    Err(format!("插件 '{}' 没有可用的远程端点", clean))
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

/// 清空工具审计日志
#[tauri::command]
fn clear_tool_audit(db: State<Database>) -> Result<(), String> {
    db.clear_tool_audit()
}

/// 列出可撤销的文件操作（最近优先）
#[tauri::command]
fn list_undo(db: State<Database>, limit: i64) -> Result<Vec<db::UndoRow>, String> {
    db.list_undo(limit)
}

/// 撤销指定文件操作（按快照回滚文件系统状态）
#[tauri::command]
fn undo_by_id(db: State<Database>, id: i64) -> Result<String, String> {
    db.undo_by_id(id)
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
/// 返回应用版本（供「关于道生一」弹窗显示，避免前端硬编码版本号）
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// --- 系统菜单栏 ---

/// 构建中文系统菜单栏，替换 Tauri 默认英文菜单。
/// 自定义菜单项点击后统一转发为 `menu://action` 事件（payload 为动作 id），
/// 前端在 main.ts 中 listen 并分发到对应功能。预定义项（隐藏/退出/编辑/窗口）由系统原生处理。
fn build_app_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<Menu<R>> {
    // 道生一（macOS 首个菜单标题会被系统替换为应用名）
    let app_menu = Submenu::with_id_and_items(app, "app", "道生一", true, &[
        &MenuItem::with_id(app, "about", "关于道生一", true, None::<&str>)?,
        &MenuItem::with_id(app, "settings", "设置…", true, Some("CmdOrCtrl+,"))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::hide(app, Some("隐藏道生一"))?,
        &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
        &PredefinedMenuItem::show_all(app, Some("全部显示"))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::quit(app, Some("退出道生一"))?,
    ])?;

    // 文件
    let file_menu = Submenu::with_id_and_items(app, "file", "文件", true, &[
        &MenuItem::with_id(app, "new-chat", "新建对话", true, Some("CmdOrCtrl+N"))?,
        &MenuItem::with_id(app, "export-md", "导出对话为 Markdown…", true, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::close_window(app, Some("关闭窗口"))?,
    ])?;

    // 编辑（撤销/重做/剪切/复制/粘贴/全选：系统原生动作）
    let edit_menu = Submenu::with_id_and_items(app, "edit", "编辑", true, &[
        &PredefinedMenuItem::undo(app, Some("撤销"))?,
        &PredefinedMenuItem::redo(app, Some("重做"))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::cut(app, Some("剪切"))?,
        &PredefinedMenuItem::copy(app, Some("复制"))?,
        &PredefinedMenuItem::paste(app, Some("粘贴"))?,
        &PredefinedMenuItem::select_all(app, Some("全选"))?,
    ])?;

    // 视图
    let view_menu = Submenu::with_id_and_items(app, "view", "视图", true, &[
        &MenuItem::with_id(app, "toggle-sidebar", "切换侧边栏", true, Some("CmdOrCtrl+B"))?,
        &MenuItem::with_id(app, "toggle-theme", "切换主题", true, Some("CmdOrCtrl+Shift+L"))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::fullscreen(app, Some("进入全屏"))?,
    ])?;

    // 窗口
    let window_menu = Submenu::with_id_and_items(app, "window", "窗口", true, &[
        &PredefinedMenuItem::minimize(app, Some("最小化"))?,
        &PredefinedMenuItem::maximize(app, Some("最大化"))?,
    ])?;

    // 工具（关键功能入口）
    let tools_menu = Submenu::with_id_and_items(app, "tools", "工具", true, &[
        &MenuItem::with_id(app, "open-skills", "技能库", true, None::<&str>)?,
        &MenuItem::with_id(app, "open-mcp", "插件（MCP）", true, None::<&str>)?,
        &MenuItem::with_id(app, "open-ollama", "本地模型（Ollama）", true, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "open-stats", "用量统计", true, None::<&str>)?,
        &MenuItem::with_id(app, "open-tasks", "定时任务", true, None::<&str>)?,
        &MenuItem::with_id(app, "open-health", "运行时诊断", true, None::<&str>)?,
        &MenuItem::with_id(app, "open-memory", "长期记忆", true, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "open-workflow", "可视化工作流", true, None::<&str>)?,
    ])?;

    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &tools_menu])
}

// 全局快捷键（Phase 5）：进程级静态，供 plugin handler 与 setup 注册共享比对。
// 默认 CommandOrControl+Shift+Space（显示/隐藏主窗口）/ CommandOrControl+Shift+K（新建对话），
// 可在设置页自定义；SHORTCUTS 存当前已注册的 (toggle, new_chat) 用于运行时重注册。
static SHORTCUTS: std::sync::OnceLock<std::sync::Mutex<Option<(tauri_plugin_global_shortcut::Shortcut, tauri_plugin_global_shortcut::Shortcut)>>> = std::sync::OnceLock::new();

/// 注册全局快捷键（解析失败回退默认），并记录当前注册句柄供重新注册。
fn register_global_shortcuts(app: &tauri::AppHandle, toggle: &str, new_chat: &str) {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    let gs = app.global_shortcut();
    let t = Shortcut::from_str(toggle)
        .unwrap_or_else(|_| Shortcut::from_str(settings::DEFAULT_SHORTCUT_TOGGLE).unwrap());
    let n = Shortcut::from_str(new_chat)
        .unwrap_or_else(|_| Shortcut::from_str(settings::DEFAULT_SHORTCUT_NEW_CHAT).unwrap());
    if gs.register(t.clone()).is_err() {
        eprintln!("[shortcut] 注册 {} 失败（可能被占用），保持未注册", toggle);
    }
    if gs.register(n.clone()).is_err() {
        eprintln!("[shortcut] 注册 {} 失败（可能被占用），保持未注册", new_chat);
    }
    let slot = SHORTCUTS.get_or_init(|| std::sync::Mutex::new(None));
    *slot.lock().unwrap() = Some((t, n));
}

/// 运行时应用全局快捷键设置：先注销当前注册，再按新配置注册（前端保存设置后调用）。
#[tauri::command]
fn apply_global_shortcuts(app: tauri::AppHandle, toggle: String, new_chat: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    if let Some(slot) = SHORTCUTS.get() {
        if let Some((t, n)) = slot.lock().unwrap().take() {
            let _ = gs.unregister(t);
            let _ = gs.unregister(n);
        }
    }
    register_global_shortcuts(&app, &toggle, &new_chat);
    Ok(())
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let pair = SHORTCUTS
                        .get()
                        .and_then(|m| m.lock().ok())
                        .and_then(|g| g.clone());
                    if let Some((t, n)) = pair {
                        if shortcut == &t {
                            if let Some(win) = app.get_webview_window("main") {
                                if win.is_visible().unwrap_or(true) {
                                    let _ = win.hide();
                                } else {
                                    let _ = win.show();
                                    let _ = win.unminimize();
                                    let _ = win.set_focus();
                                }
                            }
                        } else if shortcut == &n {
                            let _ = app.emit("menu://action", "new-chat");
                        }
                    }
                })
                .build(),
        )
        .menu(build_app_menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            const ACTIONS: &[&str] = &[
                "about", "settings", "new-chat", "export-md",
                "toggle-sidebar", "toggle-theme",
                "open-skills", "open-mcp", "open-ollama",
                "open-stats", "open-tasks", "open-health",
                "open-memory", "open-workflow",
            ];
            if ACTIONS.contains(&id) {
                let _ = app.emit("menu://action", id);
            }
        })
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
            // IM 网关共享状态（后台任务与前端 im_status 共用）
            app.manage(im::ImGatewayState::shared());

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

            // 记忆维护线程：启动即跑一次，之后每 6 小时检查（每日约 4 次，幂等）。
            // 做重要度衰减 + 低价值遗忘 + FTS 索引清理，让长期记忆"越用越聪明"且不膨胀。
            {
                let mem_dir = app_dir.clone();
                std::thread::spawn(move || loop {
                    if let Ok(db) = Database::new(mem_dir.clone()) {
                        if let Ok(msg) = db.maintain_facts() {
                            eprintln!("[memory] {}", msg);
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_secs(6 * 3600));
                });
            }

            // 系统托盘（Phase 5）：常驻菜单栏图标，左键显示/隐藏主窗口，右键菜单可新建对话/退出。
            // 复用「menu://action」事件通道：前端 main.ts 已有 new-chat 分发，无需新增前端监听。
            {
                let tray_menu = tauri::menu::Menu::with_items(
                    app,
                    &[
                        &tauri::menu::MenuItem::with_id(app, "tray-show", "显示主窗口", true, None::<&str>)?,
                        &tauri::menu::MenuItem::with_id(app, "tray-new-chat", "新建对话", true, None::<&str>)?,
                        &tauri::menu::PredefinedMenuItem::separator(app)?,
                        &tauri::menu::PredefinedMenuItem::quit(app, Some("退出道生一"))?,
                    ],
                )?;
                let _tray = tauri::tray::TrayIconBuilder::with_id("main-tray")
                    // macOS 菜单栏用模板图（纯黑+透明，icon_as_template 让系统自动
                    // 适配深/浅色菜单栏；不能用彩色 app 图标——会带背景色块）
                    .icon(tauri::include_image!("icons/tray-icon.png"))
                    .icon_as_template(true)
                    .menu(&tray_menu)
                    .show_menu_on_left_click(false)
                    .tooltip("道生一 - AI Agent")
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "tray-new-chat" => {
                            let _ = app.emit("menu://action", "new-chat");
                        }
                        "tray-show" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.unminimize();
                                let _ = win.set_focus();
                            }
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        // 左键单击：切换主窗口显示/隐藏（再点托盘图标唤回）
                        if let tauri::tray::TrayIconEvent::Click {
                            button: tauri::tray::MouseButton::Left,
                            button_state: tauri::tray::MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(win) = app.get_webview_window("main") {
                                if win.is_visible().unwrap_or(true) {
                                    let _ = win.hide();
                                } else {
                                    let _ = win.show();
                                    let _ = win.set_focus();
                                }
                            }
                        }
                    })
                    .build(app)?;
            }

            // 全局快捷键（Phase 5）：注册后即使应用在后台/隐藏也能通过按键唤起。
            // 从设置读取自定义快捷键（未配置/解析失败回退默认）；注册失败（被占用）仅记录日志。
            {
                let (toggle, new_chat) = {
                    let db = app.state::<Database>();
                    let cipher = app.state::<settings::SecretCipher>();
                    match load_app_settings(db, cipher) {
                        Ok(s) => (s.global_shortcut_toggle, s.global_shortcut_new_chat),
                        Err(_) => (
                            settings::DEFAULT_SHORTCUT_TOGGLE.to_string(),
                            settings::DEFAULT_SHORTCUT_NEW_CHAT.to_string(),
                        ),
                    }
                };
                register_global_shortcuts(app.handle(), &toggle, &new_chat);
            }

            // devtools 默认不自动打开；需要调试时用环境变量开启：
            //   DAOSHENGYI_DEVTOOLS=1 npm run tauri dev
            #[cfg(debug_assertions)]
            {
                if std::env::var("DAOSHENGYI_DEVTOOLS").map(|v| v == "1").unwrap_or(false) {
                    if let Some(window) = app.get_webview_window("main") {
                        window.open_devtools();
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            app_version,
            send_message,
            chat_once,
            load_conversations,
            get_messages,
            save_conversation,
            delete_conversation_cmd,
            search_conversations_cmd,
            export_conversation_cmd,
            accumulate_usage,
            get_usage_agg,
            save_summary,
            get_summaries,
            save_fact,
            search_facts,
            get_preferences,
            list_facts,
            list_all_summaries,
            list_episodic,
            save_episodic_cmd,
            delete_episodic_cmd,
            episodic_covered,
            maintain_facts,
            save_app_settings,
            load_app_settings,
            apply_global_shortcuts,
            cancel_stream,
            list_models,
            touch_fact,
            delete_fact_cmd,
            update_fact_cmd,
            prune_facts,
            set_fact_embedding,
            search_by_embedding,
            web_search,
            send_im_message,
            fetch_page,
            system_diagnostics,
            write_text_file,
            write_file_agent,
            apply_edits,
            delete_file_agent,
            list_scheduled_tasks,
            save_scheduled_task,
            delete_scheduled_task,
            toggle_scheduled_task,
            set_prevent_sleep,
            debug_log,
            execute_command,
            git_operation,
            run_tests,
            analyze_project,
            kb_index,
            kb_search,
            kb_list,
            kb_delete,
            code_index,
            code_search,
            code_roots,
            code_stats,
            code_delete,
            workflow_save,
            workflow_list,
            workflow_get,
            workflow_delete,
            workflow_run_add,
            workflow_runs,
            im_start,
            im_stop,
            im_status,
            read_file,
            open_file,
            file_exists,
            read_attachment,
            extract_pdf_text,
            read_pdf_part,
            save_temp_attachment,
            ollama_status,
            ollama_setup,
            ollama_describe_image,
            ollama_embed,
            ocr_extract_image_text,
            save_temp_image,
            ocr_image_file,
            check_hardware,
            mcp_connect,
            mcp_disconnect,
            mcp_call_tool,
            mcp_list_tools,
            detect_browsers,
            list_tool_audit,
            clear_tool_audit,
            list_undo,
            undo_by_id,
            fetch_community_plugins,
            fetch_remote_plugin_endpoint,
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

#[cfg(test)]
mod tests {
    use super::{
        chunk_text, compute_edits, delete_file_impl, detect_test_framework, diff_lines,
        embed_model_installed, extract_redirected_files, format_unified_diff, nth_occurrence,
        parse_allowed_paths, parse_embed_response, path_within_any, run_shell_command,
        validate_git_operation, EditOp,
    };

    // Phase 3 知识库 RAG：分块纯函数
    #[test]
    fn chunk_text_short_text_single_chunk() {
        assert_eq!(chunk_text("第一行\n第二行", 800), vec!["第一行\n第二行"]);
        assert!(chunk_text("", 10).is_empty());
        assert!(chunk_text("   ", 10).is_empty());
    }

    #[test]
    fn chunk_text_splits_long_line() {
        let long = "字".repeat(100);
        let chunks = chunk_text(&long, 30);
        assert!(chunks.len() >= 3, "长行切成多块，实际 {}", chunks.len());
        assert!(chunks.iter().all(|c| c.chars().count() <= 30), "每块不超过 size");
        assert_eq!(chunks.concat().chars().count(), 100, "拼接后内容完整");
    }

    #[test]
    fn chunk_text_respects_newline_boundary() {
        // 两行合计超 size → 在新行前断开成两块
        let text = format!("{}\n{}", "a".repeat(30), "b".repeat(30));
        let chunks = chunk_text(&text, 50);
        assert_eq!(chunks.len(), 2, "两行合并超 size 时在新行前断开，实际 {}", chunks.len());
        assert_eq!(chunks[0].trim(), "a".repeat(30), "首块为第一行");
        assert_eq!(chunks[1].trim(), "b".repeat(30), "次块为第二行");
        // 超长行(>size)会被切成多块
        let long = chunk_text(&"b".repeat(200), 50);
        assert_eq!(long.len(), 4, "200 字符长行切成 4 块");
    }

    // P-A8 沙箱：路径白名单（组件级匹配，防前缀误判）+ 白名单解析
    #[test]
    fn path_within_any_matches_prefix_only() {
        use std::path::{Path, PathBuf};
        let dirs = [PathBuf::from("/Users/x/op")];
        assert!(path_within_any(Path::new("/Users/x/op"), &dirs), "等于白名单目录");
        assert!(path_within_any(Path::new("/Users/x/op/src/a.ts"), &dirs), "白名单子路径");
        assert!(!path_within_any(Path::new("/Users/x/op2/a.ts"), &dirs), "前缀相似但不同目录不误判");
        assert!(!path_within_any(Path::new("/Users/x"), &dirs), "父目录不命中");
        assert!(!path_within_any(Path::new("/a/b"), &[]), "空白名单无目录可匹配（调用方先判空再调用）");
    }

    #[test]
    fn parse_allowed_paths_expands_tilde() {
        let home = std::env::var("HOME").unwrap();
        let parsed = parse_allowed_paths(&["/Users/x/op".into(), "~/Pictures".into(), "  ".into()]);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], std::path::PathBuf::from("/Users/x/op"));
        assert_eq!(parsed[1], std::path::PathBuf::from(format!("{}/Pictures", home)));
    }

    // P-A6 本地语义 embedding：模型检测 + 响应解析（纯函数）
    #[test]
    fn embed_model_installed_detects() {
        let installed = vec![
            "llava-phi3:3.8b".to_string(),
            "nomic-embed-text:latest".to_string(),
        ];
        assert!(embed_model_installed(&installed));
        assert!(!embed_model_installed(&["llava-phi3:3.8b".to_string()]));
        assert!(!embed_model_installed(&[]));
    }

    #[test]
    fn parse_embed_response_extracts_vectors() {
        let json = serde_json::json!({
            "model": "nomic-embed-text",
            "embeddings": [[0.1, 0.2, 0.3], [1.0, 2.0, 3.0]]
        });
        let out = parse_embed_response(&json).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], vec![0.1, 0.2, 0.3]);
        assert_eq!(out[1], vec![1.0, 2.0, 3.0]);
    }

    #[test]
    fn parse_embed_response_rejects_bad_shape() {
        // 缺 embeddings 字段
        assert!(parse_embed_response(&serde_json::json!({ "model": "x" })).is_err());
        // 空向量元素
        assert!(parse_embed_response(&serde_json::json!({ "embeddings": [[]] })).is_err());
        // 非数组元素
        assert!(parse_embed_response(&serde_json::json!({ "embeddings": [123] })).is_err());
    }

    /// 在真实 HOME 下建独立临时目录（apply_edits 要求主目录内路径）。
    fn edit_test_dir(name: &str) -> std::path::PathBuf {
        let home = std::env::var("HOME").expect("HOME 应存在");
        let dir = std::path::Path::new(&home).join(format!("ds_edit_test_{}_{}", name, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn git_validate_allows_safe_ops() {
        assert!(validate_git_operation("status", &[]).is_ok());
        assert!(validate_git_operation("diff", &[]).is_ok());
        assert!(validate_git_operation("log", &["--oneline".to_string(), "-5".to_string()]).is_ok());
        assert!(validate_git_operation("commit", &["-m".to_string(), "feat: x".to_string()]).is_ok());
        assert!(validate_git_operation("push", &[]).is_ok());
    }

    #[test]
    fn git_validate_rejects_unknown_action() {
        assert!(validate_git_operation("reset", &[]).is_err());
        assert!(validate_git_operation("rm", &[]).is_err());
        assert!(validate_git_operation("clean", &[]).is_err());
        assert!(validate_git_operation("rebase", &[]).is_err());
    }

    #[test]
    fn git_validate_rejects_dangerous_args() {
        assert!(validate_git_operation("pull", &["--force".to_string()]).is_err());
        assert!(validate_git_operation("checkout", &["--hard".to_string()]).is_err());
        assert!(validate_git_operation("branch", &["--delete".to_string(), "x".to_string()]).is_err());
        // 正常参数不受影响
        assert!(validate_git_operation("checkout", &["main".to_string()]).is_ok());
    }

    #[test]
    fn detect_framework_picks_correct_command() {
        let dir = std::env::temp_dir().join(format!("ds_testfw_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        let (fw, cmd) = detect_test_framework(dir.to_str().unwrap());
        assert_eq!(fw, "npm");
        assert_eq!(cmd, vec!["npm", "test"]);

        // 删掉 package.json 只剩 Cargo.toml → 应检测为 cargo
        std::fs::remove_file(dir.join("package.json")).unwrap();
        std::fs::write(dir.join("Cargo.toml"), "").unwrap();
        let (fw2, cmd2) = detect_test_framework(dir.to_str().unwrap());
        assert_eq!(fw2, "cargo");
        assert_eq!(cmd2, vec!["cargo", "test"]);

        std::fs::remove_file(dir.join("Cargo.toml")).unwrap();
        std::fs::write(dir.join("pyproject.toml"), "").unwrap();
        let (fw3, cmd3) = detect_test_framework(dir.to_str().unwrap());
        assert_eq!(fw3, "pytest");
        assert!(cmd3[0].contains("python"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn detect_framework_unknown_when_no_manifest() {
        let dir = std::env::temp_dir().join(format!("ds_testfw_unknown_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (fw, cmd) = detect_test_framework(dir.to_str().unwrap());
        assert_eq!(fw, "unknown");
        assert!(cmd.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn diff_lines_marks_removed_and_added() {
        let ops = diff_lines("a\nb\nc\n", "a\nB\nc\n");
        let bi = ops.iter().position(|(_, t)| t == "b").unwrap();
        let cap_i = ops.iter().position(|(_, t)| t == "B").unwrap();
        assert_eq!(ops[bi].0, '-');
        assert_eq!(ops[cap_i].0, '+');
        // 相同行标记为 ' '
        let a_i = ops.iter().position(|(_, t)| t == "a").unwrap();
        assert_eq!(ops[a_i].0, ' ');
        // 插入（新增在末尾）与删除（末尾）也正确标记
        let ops2 = diff_lines("x\n", "x\ny\n");
        assert!(ops2.iter().any(|(k, t)| *k == '+' && t == "y"));
    }

    #[test]
    fn format_unified_diff_shows_hunks() {
        let old = "line1\nline2\nline3\nline4\nline5\nline6\n";
        let new = "line1\nline2\nline3\nLINE3B\nline5\nline6\n";
        let d = format_unified_diff(old, new);
        assert!(d.starts_with("@@ "), "diff 应以 @@ 头开始: {}", d);
        assert!(d.contains("-line4"), "应含删除行: {}", d);
        assert!(d.contains("+LINE3B"), "应含新增行: {}", d);
        assert!(d.contains(" line2"), "应含上下文行: {}", d);
        assert!(d.contains(" line5"), "应含上下文行: {}", d);
    }

    #[test]
    fn format_unified_diff_no_change() {
        assert_eq!(format_unified_diff("a\nb\n", "a\nb\n"), "（无改动）");
    }

    #[test]
    fn nth_occurrence_finds_occurrences() {
        assert_eq!(nth_occurrence("a-b-a-b", "a", 1), Some(0));
        assert_eq!(nth_occurrence("a-b-a-b", "a", 2), Some(4));
        assert_eq!(nth_occurrence("a-b-a-b", "z", 1), None);
    }

    #[test]
    fn apply_edits_replace_insert_delete() {
        let dir = edit_test_dir("ops");
        let file = dir.join("t.txt");
        std::fs::write(&file, "hello world\nfoo bar\nhello world\n").unwrap();
        let path = file.to_str().unwrap().to_string();

        // replace 默认第 1 次出现 → 只改第一处
        let r = compute_edits(
            path.clone(),
            vec![EditOp::Replace { old: "world".into(), new: "RUST".into(), occurrence: None }],
            false,
        )
        .unwrap();
        assert!(r.diff.contains("+hello RUST"), "diff 应含新增行: {}", r.diff);
        assert!(r.path == path);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "hello RUST\nfoo bar\nhello world\n",
            "replace 默认只应改第 1 次出现"
        );

        // insert after 锚点
        compute_edits(
            path.clone(),
            vec![EditOp::Insert { anchor: "foo bar".into(), position: "after".into(), text: "\nINSERTED".into() }],
            false,
        )
        .unwrap();
        assert!(
            std::fs::read_to_string(&file).unwrap().contains("foo bar\nINSERTED"),
            "插入后内容: {}",
            std::fs::read_to_string(&file).unwrap()
        );

        // delete occurrence=2：写两份 hello，删除第 2 次出现后应只剩 1 处
        std::fs::write(&file, "hello\nhello\n").unwrap();
        compute_edits(
            path.clone(),
            vec![EditOp::Delete { old: "hello".into(), occurrence: Some(2) }],
            false,
        )
        .unwrap();
        let content = std::fs::read_to_string(&file).unwrap();
        assert_eq!(content.matches("hello").count(), 1, "删除第 2 次出现后应只剩 1 处: {}", content);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn apply_edits_rejects_bad_path_or_missing_text() {
        let dir = edit_test_dir("reject");
        let file = dir.join("t2.txt");
        std::fs::write(&file, "abc\n").unwrap();
        let path = file.to_str().unwrap().to_string();

        // 相对路径拒绝
        assert!(compute_edits("relative.txt".into(), vec![], false).is_err());
        // 未匹配文本 → 报错且文件不变
        assert!(
            compute_edits(
                path.clone(),
                vec![EditOp::Replace { old: "不存在的文本".into(), new: "x".into(), occurrence: None }],
                false,
            )
            .is_err()
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "abc\n");
        // 编辑后无变化 → 报错
        assert!(
            compute_edits(
                path.clone(),
                vec![EditOp::Replace { old: "abc".into(), new: "abc".into(), occurrence: None }],
                false,
            )
            .is_err()
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn apply_edits_preview_does_not_write() {
        // P-A4 应用内 diff 确认：preview=true 只返回 diff 不写盘
        let dir = edit_test_dir("preview");
        let file = dir.join("p.txt");
        std::fs::write(&file, "hello world\n").unwrap();
        let path = file.to_str().unwrap().to_string();

        let r = compute_edits(
            path.clone(),
            vec![EditOp::Replace { old: "world".into(), new: "RUST".into(), occurrence: None }],
            true,
        )
        .unwrap();
        // 返回 diff 且标记「预览/未写盘」
        assert!(r.diff.contains("+hello RUST"), "diff 应含新增行: {}", r.diff);
        assert!(r.summary.contains("预览") && r.summary.contains("未写盘"), "summary 应标注预览: {}", r.summary);
        // 文件内容未变
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello world\n", "preview 不应写盘");
        // 随后真正应用（preview=false）→ 内容才变
        compute_edits(path.clone(),
            vec![EditOp::Replace { old: "world".into(), new: "RUST".into(), occurrence: None }],
            false).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello RUST\n");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn run_shell_supports_tilde_expansion_and_pipe() {
        // ~ 展开为 HOME
        let out = run_shell_command("echo ~", None, Some(10)).await.unwrap();
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
        let home = std::env::var("HOME").unwrap_or_default();
        if !home.is_empty() {
            assert_eq!(out.stdout.trim(), home, "~ 应展开为 HOME，实际: {}", out.stdout);
        }
        // 管道
        let out2 = run_shell_command("echo abc | tr a-z A-Z", None, Some(10)).await.unwrap();
        assert_eq!(out2.exit_code, 0, "stderr: {}", out2.stderr);
        assert_eq!(out2.stdout.trim(), "ABC", "管道应生效: {}", out2.stdout);
        // shell 内建 + &&
        let out3 = run_shell_command("cd /tmp && pwd", None, Some(10)).await.unwrap();
        assert_eq!(out3.exit_code, 0, "stderr: {}", out3.stderr);
        assert!(out3.stdout.contains("/tmp"), "cd && pwd 应生效: {}", out3.stdout);
    }

    #[tokio::test]
    async fn run_shell_timeout_kills_process_group() {
        let start = std::time::Instant::now();
        let out = run_shell_command("sleep 30", None, Some(2)).await.unwrap();
        assert!(out.timed_out, "应标记超时");
        assert!(out.stderr.contains("超时"), "stderr: {}", out.stderr);
        assert!(start.elapsed().as_secs() < 15, "应在 2s 超时终止而非等 30s（进程组被杀）");
    }

    #[test]
    fn extract_redirected_files_detects_output_files() {
        let dir = edit_test_dir("redir");
        let out = dir.join("out.txt");
        std::fs::write(&out, "x").unwrap();
        let cwd = dir.to_str().unwrap();
        let expect = out.to_str().unwrap().to_string();
        // > 相对路径
        assert_eq!(extract_redirected_files("ls > out.txt", Some(cwd)), vec![expect.clone()]);
        // >> 追加
        assert_eq!(extract_redirected_files("echo hi >> out.txt", Some(cwd)), vec![expect.clone()]);
        // 2> 错误重定向也生成文件
        assert_eq!(extract_redirected_files("cmd 2> out.txt", Some(cwd)), vec![expect.clone()]);
        // 排除 /dev/null 与 2>&1
        assert_eq!(extract_redirected_files("cmd > /dev/null 2>&1", Some(cwd)), Vec::<String>::new());
        // 引号内的 > 不误判
        assert_eq!(extract_redirected_files("echo \"a > b\"", Some(cwd)), Vec::<String>::new());
        // 不存在的文件不返回
        assert_eq!(extract_redirected_files("cmd > missing.txt", Some(cwd)), Vec::<String>::new());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn run_shell_unknown_command_reports_exit_127() {
        // 非可执行命令（如 list）：走 shell 后是「command not found」（exit 127）而非启动失败
        let out = run_shell_command("list", None, Some(5)).await.unwrap();
        assert_eq!(out.exit_code, 127, "list 应报 command not found: {}", out.stderr);
        assert!(
            out.stderr.contains("not found") || out.stderr.contains("未找到"),
            "stderr 应提示找不到命令: {}",
            out.stderr
        );
    }

    #[test]
    fn delete_file_agent_only_file_in_home() {
        let dir = edit_test_dir("del");
        let file = dir.join("del.txt");
        std::fs::write(&file, "x").unwrap();
        let path = file.to_str().unwrap().to_string();
        // 相对路径拒绝
        assert!(delete_file_impl("relative.txt".into()).is_err());
        // 删除文件成功
        assert!(delete_file_impl(path.clone()).unwrap().contains("已删除"));
        assert!(!file.exists());
        // 删除目录拒绝
        std::fs::write(&file, "x").unwrap();
        assert!(delete_file_impl(dir.to_str().unwrap().to_string()).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
