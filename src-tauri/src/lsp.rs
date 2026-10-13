//! LSP 桥：接本机已装的语言服务器，给 Agent 补上「语义级导航」。
//!
//! ## 为什么
//!
//! `code_search`（向量检索）能给「相关的代码片段 + 行号」，但**定义/引用/诊断/重命名**
//! 这类问题本质上要靠编译器前端的语义分析。VS Code 里的这些能力都来自语言服务器，
//! 而语言服务器讲的是公开协议（LSP over stdio）——我们照 `mcp.rs` 的进程模式接一层即可，
//! **零新依赖**。
//!
//! ## 设计
//!
//! - **帧**：`Content-Length: N\r\n\r\n{json}`（与 MCP 的 stdio 不同：LSP 是长度前缀而非换行分隔）
//! - **会话复用**：服务器冷启动很贵（rust-analyzer 要建索引），按 `(server, root)` 缓存进程；
//!   `lsp_stop` 可显式关（应用退出时进程随父进程结束）
//! - **读线程 + 通道**：stdout 由独立线程按帧解析后塞进 `mpsc`，请求侧用 `recv_timeout`
//!   等自己的 `id`，这样「服务器不回/回得慢」不会把命令挂死
//! - **服务端 → 客户端 的请求**（`workspace/configuration`、`client/registerCapability` 等）
//!   必须应答，否则服务器会阻塞等我们（这是接 LSP 最容易踩的坑）
//!
//! ## 只读、安全
//!
//! 全部动作都是**只读查询**；`rename` 只返回**预览**（各文件几处、改成什么），不写盘
//! （真正的落盘交给既有的 `apply_edits` / `replace_string` 管线，仍过 diff 确认与撤销）。
//! 服务器二进制只从固定候选目录探测，不由调用方传任意命令。

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------- 服务器注册表

/// 支持的语言服务器（探测顺序即优先级）
pub struct LspServerSpec {
    pub id: &'static str,
    /// 面向人的语言描述
    pub lang: &'static str,
    pub cmd: &'static str,
    pub args: &'static [&'static str],
    /// 该 server 认的 LSP languageId（决定 didOpen 报什么）
    pub language_ids: &'static [&'static str],
}

pub const SERVERS: &[LspServerSpec] = &[
    LspServerSpec {
        id: "rust-analyzer",
        lang: "Rust",
        cmd: "rust-analyzer",
        args: &[],
        language_ids: &["rust"],
    },
    LspServerSpec {
        id: "typescript-language-server",
        lang: "TypeScript / JavaScript",
        cmd: "typescript-language-server",
        args: &["--stdio"],
        language_ids: &[
            "typescript",
            "typescriptreact",
            "javascript",
            "javascriptreact",
        ],
    },
    LspServerSpec {
        id: "vue-language-server",
        lang: "Vue",
        cmd: "vue-language-server",
        args: &["--stdio"],
        language_ids: &["vue"],
    },
    LspServerSpec {
        id: "gopls",
        lang: "Go",
        cmd: "gopls",
        args: &[],
        language_ids: &["go"],
    },
    LspServerSpec {
        id: "pyright-langserver",
        lang: "Python",
        cmd: "pyright-langserver",
        args: &["--stdio"],
        language_ids: &["python"],
    },
    LspServerSpec {
        id: "pylsp",
        lang: "Python",
        cmd: "pylsp",
        args: &[],
        language_ids: &["python"],
    },
    LspServerSpec {
        id: "clangd",
        lang: "C / C++",
        cmd: "clangd",
        args: &[],
        language_ids: &["c", "cpp"],
    },
];

/// 扩展名 → LSP languageId（未知扩展名回退 `plaintext`）
pub fn language_id_for(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "rs" => "rust",
        "ts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "vue" => "vue",
        "go" => "go",
        "py" => "python",
        "c" => "c",
        "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        "json" => "json",
        "md" => "markdown",
        _ => "plaintext",
    }
}

/// 一次启动所需的程序与参数（PATH 里的可执行文件，或 VS Code 扩展内置的服务器）
#[derive(Debug, Clone)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// 来源标签（PATH / VS Code 扩展 …），用于报错与 lsp_status
    pub source: String,
}

/// 候选启动方式（按优先级）：先 `PATH` / 常见目录，再 **VS Code 扩展内置**的服务器。
///
/// 之所以要第二条：实测用户机器上 `~/.cargo/bin/rust-analyzer` 常常只是 **rustup shim**
/// （组件没装 → 一启动就报错退出），而 VS Code 的 rust-analyzer 扩展里躺着**真二进制**；
/// Vue 的 Volar 语言服务（Node 脚本）也同理。逐个尝试比猜哪个能用可靠。
pub fn server_candidates(spec: &LspServerSpec, home: &str) -> Vec<Launch> {
    let mut out: Vec<Launch> = Vec::new();
    if let Some(bin) = resolve_bin(spec.cmd, home) {
        out.push(Launch {
            program: bin,
            args: spec.args.iter().map(|s| s.to_string()).collect(),
            source: "PATH".to_string(),
        });
    }
    for (program, args, source) in vscode_bundled(spec.id, home) {
        out.push(Launch {
            program,
            args,
            source,
        });
    }
    out
}

/// VS Code / VS Code Insiders 扩展目录里内置的语言服务器（版本号大者优先）
fn vscode_bundled(id: &str, home: &str) -> Vec<(PathBuf, Vec<String>, String)> {
    if home.is_empty() {
        return Vec::new();
    }
    let roots = [
        PathBuf::from(home).join(".vscode/extensions"),
        PathBuf::from(home).join(".vscode-insiders/extensions"),
    ];
    let mut hits: Vec<(u64, PathBuf, Vec<String>, String)> = Vec::new();
    for root in roots {
        let Ok(rd) = std::fs::read_dir(&root) else {
            continue;
        };
        for e in rd.flatten() {
            let dir = e.path();
            if !dir.is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            match id {
                "rust-analyzer" if name.starts_with("rust-lang.rust-analyzer") => {
                    let p = dir.join("server/rust-analyzer");
                    if p.is_file() {
                        hits.push((ver_key(&name), p, Vec::new(), "VS Code 扩展".to_string()));
                    }
                }
                "vue-language-server" if name.starts_with("vue.volar") => {
                    let script = dir.join("dist/language-server.js");
                    if script.is_file() {
                        // Node 脚本：用本机 node 跑，而不是当作可执行文件
                        if let Some(node) = crate::answer_html::node_candidates(home)
                            .into_iter()
                            .find(|p| p.is_file())
                        {
                            hits.push((
                                ver_key(&name),
                                node,
                                vec![script.to_string_lossy().to_string(), "--stdio".to_string()],
                                "VS Code 扩展（Node）".to_string(),
                            ));
                        }
                    }
                }
                _ => {}
            }
        }
    }
    hits.sort_by_key(|h| std::cmp::Reverse(h.0));
    hits.into_iter().map(|(_, p, a, s)| (p, a, s)).collect()
}

/// 从扩展目录名里抽 x.y.z 当优先级键（比字符串排序准）
fn ver_key(dir_name: &str) -> u64 {
    let chars: Vec<char> = dir_name.chars().collect();
    let mut i = 0;
    // 跳到第一段数字（扩展名形如 `rust-lang.rust-analyzer-0.3.3081-darwin-x64`）
    while i < chars.len() && !chars[i].is_ascii_digit() {
        i += 1;
    }
    let mut nums: Vec<u64> = Vec::new();
    let mut cur: u64 = 0;
    let mut has = false;
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_digit() {
            cur = cur
                .saturating_mul(10)
                .saturating_add((c as u8 - b'0') as u64);
            has = true;
            i += 1;
            continue;
        }
        if c == '.' && has {
            nums.push(cur);
            cur = 0;
            has = false;
            i += 1;
            if nums.len() == 3 {
                break;
            }
            continue;
        }
        break; // 版本号段结束（如 `-darwin-x64`）
    }
    if has && nums.len() < 3 {
        nums.push(cur);
    }
    let major = nums.first().copied().unwrap_or(0);
    let minor = nums.get(1).copied().unwrap_or(0);
    let patch = nums.get(2).copied().unwrap_or(0);
    major.saturating_mul(1_000_000) + minor.saturating_mul(10_000) + patch
}

/// 收服务器 stderr 的小尾巴（启动失败的真正原因通常只在那里出現）
fn spawn_stderr_reader(stderr: std::process::ChildStderr) -> std::sync::Arc<Mutex<String>> {
    let buf = std::sync::Arc::new(Mutex::new(String::new()));
    let out = buf.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {
                    if let Ok(mut s) = out.lock() {
                        s.push_str(&line);
                        if s.len() > 4096 {
                            let cut = s.len() - 4096;
                            *s = s.chars().skip(cut).collect();
                        }
                    }
                }
            }
        }
    });
    buf
}

fn stderr_tail(buf: &std::sync::Arc<Mutex<String>>) -> String {
    let s = buf.lock().map(|g| g.clone()).unwrap_or_default();
    let t = s.trim();
    if t.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = t.chars().collect();
    let start = chars.len().saturating_sub(300);
    chars[start..].iter().collect::<String>()
}
pub fn resolve_bin(cmd: &str, home: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        dirs.extend(path.split(':').filter(|s| !s.is_empty()).map(PathBuf::from));
    }
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/bin"));
    if !home.is_empty() {
        let h = PathBuf::from(home);
        dirs.push(h.join(".cargo/bin"));
        dirs.push(h.join(".local/bin"));
        dirs.push(h.join(".volta/bin"));
        // nvm：~/.nvm/versions/node/vX.Y.Z/bin（取版本号最大者优先）
        let mut nvm: Vec<PathBuf> = Vec::new();
        if let Ok(rd) = std::fs::read_dir(h.join(".nvm/versions/node")) {
            for e in rd.flatten() {
                nvm.push(e.path().join("bin"));
            }
        }
        nvm.sort();
        nvm.reverse();
        dirs.extend(nvm);
    }
    for d in dirs {
        let p = d.join(cmd);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

// ---------------------------------------------------------------- 帧编解码（纯函数）

/// 把一条 JSON 消息编成 LSP 帧
pub fn encode_lsp_message(json: &str) -> Vec<u8> {
    let mut out = format!("Content-Length: {}\r\n\r\n", json.len()).into_bytes();
    out.extend_from_slice(json.as_bytes());
    out
}

/// 从累积缓冲里取出**一个**完整消息体（不足一帧时返回 None，并把已消费的部分移出）。
///
/// 写成分页安全的形式：先把头部读完（`\r\n\r\n`），再按 `Content-Length` 等够正文——
/// 服务器把一帧拆成多次 `read` 是常态。
pub fn take_lsp_message(buf: &mut Vec<u8>) -> Option<String> {
    let sep = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    let header = String::from_utf8_lossy(&buf[..sep]).to_string();
    let mut len: Option<usize> = None;
    for line in header.split("\r\n") {
        if let Some(rest) = line.strip_prefix("Content-Length:") {
            len = rest.trim().parse::<usize>().ok();
        }
    }
    let len = len?;
    let start = sep + 4;
    if buf.len() < start + len {
        return None;
    }
    let body = String::from_utf8_lossy(&buf[start..start + len]).to_string();
    buf.drain(..start + len);
    Some(body)
}

/// 本地路径 → `file://` URI（只转义 URI 里非法的字符，中文保留原样）
pub fn path_to_uri(path: &str) -> String {
    let mut p = path.to_string();
    if !p.starts_with('/') {
        p = format!("/{}", p);
    }
    let mut out = String::from("file://");
    for ch in p.chars() {
        match ch {
            ' ' => out.push_str("%20"),
            '#' => out.push_str("%23"),
            '?' => out.push_str("%3F"),
            '%' => out.push_str("%25"),
            _ => out.push(ch),
        }
    }
    out
}

/// `file://` URI → 本地路径（百分号解码）
pub fn uri_to_path(uri: &str) -> String {
    let raw = uri.strip_prefix("file://").unwrap_or(uri);
    let mut out = String::new();
    let bytes: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '%' && i + 2 < bytes.len() {
            let hex: String = bytes[i + 1..i + 3].iter().collect();
            if let Ok(b) = u8::from_str_radix(&hex, 16) {
                out.push(b as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    // 非 ASCII 的百分号编码是多字节 UTF-8：上面的逐字节还原会散架，这里统一兜底
    if out.contains('\u{FFFD}') || out.chars().any(|c| (c as u32) < 0x20) {
        return percent_decode_utf8(raw);
    }
    out
}

fn percent_decode_utf8(raw: &str) -> String {
    let mut bytes: Vec<u8> = Vec::new();
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '%' && i + 2 < chars.len() {
            let hex: String = chars[i + 1..i + 3].iter().collect();
            if let Ok(b) = u8::from_str_radix(&hex, 16) {
                bytes.push(b);
                i += 3;
                continue;
            }
        }
        let mut tmp = [0u8; 4];
        bytes.extend_from_slice(chars[i].encode_utf8(&mut tmp).as_bytes());
        i += 1;
    }
    String::from_utf8_lossy(&bytes).to_string()
}

/// Agent 给的 1-based 行列（**按字符**计数）→ LSP 的 0-based line + UTF-16 code unit 列。
pub fn to_lsp_position(line_text: &str, line_1based: u32, char_1based: u32) -> (u32, u32) {
    let line0 = line_1based.saturating_sub(1);
    let char0 = char_1based.saturating_sub(1) as usize;
    let utf16: u32 = line_text
        .chars()
        .take(char0)
        .map(|c| c.len_utf16() as u32)
        .sum();
    (line0, utf16)
}

/// 从文件内容取第 n 行（1-based）
pub fn line_of(content: &str, line_1based: u32) -> &str {
    content
        .lines()
        .nth(line_1based.saturating_sub(1) as usize)
        .unwrap_or("")
}

/// LSP SymbolKind 数字 → 可读标签
pub fn symbol_kind_label(k: i64) -> &'static str {
    match k {
        1 => "文件",
        2 => "模块",
        3 => "命名空间",
        4 => "包",
        5 => "类",
        6 => "方法",
        7 => "属性",
        8 => "字段",
        9 => "构造器",
        10 => "枚举",
        11 => "接口",
        12 => "函数",
        13 => "变量",
        14 => "常量",
        15 => "字符串",
        16 => "数字",
        17 => "布尔",
        18 => "数组",
        19 => "对象",
        20 => "键",
        21 => "空",
        22 => "枚举成员",
        23 => "结构体",
        24 => "事件",
        25 => "运算符",
        26 => "类型参数",
        _ => "符号",
    }
}

// ---------------------------------------------------------------- 会话

/// 一个常驻的语言服务器会话
pub struct LspSession {
    pub key: String,
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<serde_json::Value>,
    next_id: i64,
    /// 已 didOpen 的文件（避免重复打开）
    opened: Vec<String>,
    /// 服务器 stderr 的小尾巴（启动失败时报给用户）
    stderr: std::sync::Arc<Mutex<String>>,
    /// 读线程收到的消息数（诊断用：超时时报出「到底收到没收到」）
    recv_count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

/// 全局会话表（命令是同步的，持锁期间不 await，安全）
static SESSIONS: Mutex<Vec<LspSession>> = Mutex::new(Vec::new());

impl LspSession {
    fn send(&mut self, value: &serde_json::Value) -> Result<(), String> {
        let text = serde_json::to_string(value).map_err(|e| format!("序列化失败: {}", e))?;
        let frame = encode_lsp_message(&text);
        self.stdin
            .write_all(&frame)
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("写入语言服务器失败（进程可能已退出）: {}", e))
    }

    fn notify(&mut self, method: &str, params: serde_json::Value) -> Result<(), String> {
        self.send(&serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    /// 发一个请求并等自己的响应；期间要替服务器应答它反向发来的请求
    fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params
        }))?;
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(format!(
                    "等待语言服务器响应 `{}` 超时（{} ms）",
                    method,
                    timeout.as_millis()
                ));
            }
            match self.rx.recv_timeout(left) {
                Ok(msg) => {
                    // 服务器 → 客户端的请求：必须应答，否则服务器会一直等我们
                    if msg.get("method").is_some() && msg.get("id").is_some() {
                        let rid = msg["id"].clone();
                        let name = msg["method"].as_str().unwrap_or("");
                        let result = if name == "workspace/configuration" {
                            // 按要几项答几项（rust-analyzer 会问一堆配置）
                            let n = msg["params"]["items"]
                                .as_array()
                                .map(|a| a.len())
                                .unwrap_or(1);
                            serde_json::Value::Array(vec![serde_json::Value::Null; n.max(1)])
                        } else {
                            serde_json::Value::Null
                        };
                        self.send(&serde_json::json!({
                            "jsonrpc": "2.0", "id": rid, "result": result
                        }))?;
                        continue;
                    }
                    if msg.get("id").and_then(|v| v.as_i64()) == Some(id) {
                        if let Some(err) = msg.get("error") {
                            return Err(format!("语言服务器返回错误: {}", err));
                        }
                        return Ok(msg
                            .get("result")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null));
                    }
                    // 其余通知（publishDiagnostics / logMessage …）丢弃
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err(format!(
                        "等待语言服务器响应 `{}` 超时（{} ms；读线程共收到 {} 条消息）",
                        method,
                        timeout.as_millis(),
                        self.recv_count.load(std::sync::atomic::Ordering::Relaxed)
                    ))
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(format!(
                        "语言服务器进程已退出（读取线程结束），无法完成 `{}`",
                        method
                    ))
                }
            }
        }
    }

    /// 打开文档（position 类请求前必须做）
    fn ensure_open(&mut self, path: &str) -> Result<String, String> {
        let uri = path_to_uri(path);
        if self.opened.iter().any(|u| u == &uri) {
            return Ok(uri);
        }
        let text =
            std::fs::read_to_string(path).map_err(|e| format!("读取 {} 失败: {}", path, e))?;
        self.notify(
            "textDocument/didOpen",
            serde_json::json!({
                "textDocument": {
                    "uri": uri,
                    "languageId": language_id_for(path),
                    "version": 1,
                    "text": text,
                }
            }),
        )?;
        self.opened.push(uri.clone());
        Ok(uri)
    }

    /// 收集某方法的通知（诊断是推送式的，只能这样等一会儿）
    fn collect_notifications(
        &mut self,
        method: &str,
        uri: &str,
        wait: Duration,
    ) -> Vec<serde_json::Value> {
        let deadline = Instant::now() + wait;
        let mut out = Vec::new();
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            match self.rx.recv_timeout(left.min(Duration::from_millis(500))) {
                Ok(msg) => {
                    if msg.get("method").and_then(|m| m.as_str()) == Some(method) {
                        let u = msg["params"]["uri"].as_str().unwrap_or("");
                        if uri.is_empty() || u == uri {
                            out.push(msg["params"].clone());
                        }
                    } else if msg.get("method").is_some() && msg.get("id").is_some() {
                        // 顺手把服务器请求答掉（否则它可能不再推送）
                        let rid = msg["id"].clone();
                        let _ = self.send(&serde_json::json!({
                            "jsonrpc": "2.0", "id": rid, "result": serde_json::Value::Null
                        }));
                    }
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        out
    }
}

impl Drop for LspSession {
    fn drop(&mut self) {
        // 尽力优雅退出；失败也无所谓（父进程结束时子进程会被回收）
        let _ = self.notify("exit", serde_json::Value::Null);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start_session(spec: &LspServerSpec, launch: &Launch, root: &str) -> Result<LspSession, String> {
    let mut child = Command::new(&launch.program)
        .args(&launch.args)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // stderr 必须抓着：启动失败的真正原因（如 rustup shim 「component 未安装」）只在那里
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 {} 失败: {}", launch.program.display(), e))?;
    let stdin = child.stdin.take().ok_or("无法获取语言服务器 stdin")?;
    let stdout = child.stdout.take().ok_or("无法获取语言服务器 stdout")?;
    let stderr = child.stderr.take().map(spawn_stderr_reader);

    // 读线程：按帧解析后投进通道（这样「服务器不响应」不会挂死命令）
    let (tx, rx) = mpsc::channel::<serde_json::Value>();
    let recv_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = recv_count.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            // 1) 头部：**读到空行才算完**。服务器常会多带 Content-Type 等头；
            //    读到一个 Content-Length 就抢着读正文，会把后面的头当成正文内容 →
            //    JSON 解析失败 → 表现为「服务器不回 initialize」（这里踩过）。
            let mut head: Vec<u8> = Vec::new();
            let mut len: Option<usize> = None;
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => return,
                    Ok(_) => {}
                    Err(_) => return,
                }
                let trimmed = line.trim_end_matches(['\r', '\n']);
                let end_of_head = trimmed.is_empty();
                if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
                    len = rest.trim().parse::<usize>().ok();
                }
                head.extend_from_slice(line.as_bytes());
                if end_of_head {
                    break;
                }
            }
            // 2) 正文：按声明长度精确读（一帧拆成多次 read 是常态）
            if let Some(n) = len {
                let mut body = vec![0u8; n];
                if reader.read_exact(&mut body).is_err() {
                    return;
                }
                buf.extend_from_slice(&head);
                buf.extend_from_slice(&body);
            }
            while let Some(text) = take_lsp_message(&mut buf) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if tx.send(v).is_err() {
                        return;
                    }
                }
            }
        }
    });

    let mut session = LspSession {
        key: format!("{}|{}", spec.id, root),
        child,
        stdin,
        rx,
        next_id: 1,
        opened: Vec::new(),
        stderr: stderr
            .clone()
            .unwrap_or_else(|| std::sync::Arc::new(Mutex::new(String::new()))),
        recv_count,
    };
    let root_uri = path_to_uri(root);
    if let Err(e) = session.request(
        "initialize",
        serde_json::json!({
            "processId": std::process::id(),
            "clientInfo": { "name": "daoshengyi", "version": env!("CARGO_PKG_VERSION") },
            "rootUri": root_uri,
            "workspaceFolders": [{ "uri": root_uri, "name": "workspace" }],
            "capabilities": {
                "textDocument": {
                    "definition": { "linkSupport": true },
                    "implementation": { "linkSupport": true },
                    "references": {},
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "documentSymbol": { "hierarchicalDocumentSymbolSupport": true },
                    "publishDiagnostics": { "relatedInformation": false },
                    "rename": { "prepareSupport": false }
                },
                "workspace": { "symbol": {}, "workspaceFolders": true, "configuration": true },
                "window": { "workDoneProgress": true }
            },
            "initializationOptions": serde_json::Value::Null,
        }),
        Duration::from_secs(30),
    ) {
        // 带上服务器自己的输出：rustup shim 的「Unknown binary」就在这里
        let tail = stderr_tail(&session.stderr);
        let _ = session.child.kill();
        return Err(if tail.is_empty() {
            e
        } else {
            format!("{}（服务器输出：{}）", e, tail)
        });
    }
    session.notify("initialized", serde_json::json!({}))?;
    Ok(session)
}

/// 取（或新建）会话
fn with_session<T>(
    server_id: Option<&str>,
    root: &str,
    timeout: Duration,
    f: impl FnOnce(&mut LspSession) -> Result<T, String>,
) -> Result<T, String> {
    if root.trim().is_empty() {
        return Err("需要 root 参数（项目根目录绝对路径）".to_string());
    }
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("项目目录不存在: {}", root));
    }
    let home = std::env::var("HOME").unwrap_or_default();
    // 选服务器：显式指定 > 按 root 里的文件类型猜
    let spec: &LspServerSpec = if let Some(id) = server_id.filter(|s| !s.trim().is_empty()) {
        SERVERS
            .iter()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("未知的语言服务器「{}」，可用：{}", id, available_ids()))?
    } else {
        pick_server(root_path).ok_or_else(|| {
            format!(
                "在 {} 里没找到可识别的项目文件，无法自动选择语言服务器；可用 lsp_status 查看已装服务器",
                root
            )
        })?
    };
    let candidates = server_candidates(spec, &home);
    if candidates.is_empty() {
        return Err(format!(
            "未找到 {}（{}）。安装建议：{}",
            spec.cmd,
            spec.lang,
            install_hint(spec.id)
        ));
    }

    let key = format!("{}|{}", spec.id, root);
    let mut guard = SESSIONS.lock().map_err(|_| "会话表锁失败".to_string())?;
    let idx = guard.iter().position(|s| s.key == key);
    let mut session = match idx {
        Some(i) => guard.remove(i),
        None => {
            // 持锁启动（几十毫秒~几秒）：避免并发请求各起一个进程。
            // 候选逐个试：PATH 上的可能是失效的 rustup shim，VS Code 扩展里那份才是真二进制。
            let mut started: Option<LspSession> = None;
            let mut errs: Vec<String> = Vec::new();
            for c in &candidates {
                match start_session(spec, c, root) {
                    Ok(s) => {
                        started = Some(s);
                        break;
                    }
                    Err(e) => errs.push(format!("[{} {}] {}", c.source, c.program.display(), e)),
                }
            }
            match started {
                Some(s) => s,
                None => {
                    return Err(format!(
                        "语言服务器 {} 启动失败（已试 {} 个候选）：\n{}",
                        spec.id,
                        candidates.len(),
                        errs.join("\n")
                    ))
                }
            }
        }
    };
    let result = f(&mut session);
    // 只有在会话仍可用时才放回缓存（出错时丢弃，下次重建）
    if result.is_err() {
        drop(session);
    } else {
        guard.push(session);
    }
    drop(guard);
    let _ = timeout; // 超时由各请求自己带
    result
}

/// 按项目里存在的文件挑选服务器（优先级即 SERVERS 顺序）
fn pick_server(root: &Path) -> Option<&'static LspServerSpec> {
    let mut exts: Vec<String> = Vec::new();
    collect_exts(root, 0, &mut exts);
    SERVERS.iter().find(|spec| {
        spec.language_ids
            .iter()
            .any(|id| exts.iter().any(|e| e == id))
    })
}

/// 看图认语言：把扩展名收集成 languageId
fn collect_exts(dir: &Path, depth: usize, out: &mut Vec<String>) {
    if depth > 2 || out.len() > 200 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            collect_exts(&p, depth + 1, out);
        } else if let Some(s) = p.to_str() {
            out.push(language_id_for(s).to_string());
        }
    }
}

fn available_ids() -> String {
    SERVERS.iter().map(|s| s.id).collect::<Vec<_>>().join(" / ")
}

fn install_hint(id: &str) -> String {
    match id {
        "typescript-language-server" => {
            "npm i -g typescript-language-server typescript（需要在**沙箱外**的终端里装）"
                .to_string()
        }
        "vue-language-server" => "npm i -g @vue/language-server".to_string(),
        "gopls" => "go install golang.org/x/tools/gopls@latest".to_string(),
        "pyright-langserver" => "npm i -g pyright".to_string(),
        "pylsp" => "pip install python-lsp-server".to_string(),
        "clangd" => "xcode-select --install 或 brew install llvm".to_string(),
        "rust-analyzer" => "rustup component add rust-analyzer".to_string(),
        _ => "请先用 lsp_status 查看本机已装服务器".to_string(),
    }
}

// ---------------------------------------------------------------- 结果格式化

fn fmt_location(root: &str, loc: &serde_json::Value) -> String {
    let uri = loc
        .get("uri")
        .or_else(|| loc.get("targetUri"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let range = loc
        .get("range")
        .or_else(|| loc.get("targetSelectionRange"))
        .or_else(|| loc.get("targetRange"));
    let (line, ch) = range
        .map(|r| {
            (
                r["start"]["line"].as_i64().unwrap_or(0) + 1,
                r["start"]["character"].as_i64().unwrap_or(0) + 1,
            )
        })
        .unwrap_or((1, 1));
    let path = uri_to_path(uri);
    let shown = path
        .strip_prefix(root)
        .map(|s| s.trim_start_matches('/'))
        .unwrap_or(&path);
    format!("{}:{}:{}", shown, line, ch)
}

fn fmt_hover(result: &serde_json::Value) -> String {
    let c = result
        .get("contents")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let text = match c {
        serde_json::Value::String(s) => s,
        serde_json::Value::Object(_) => c["value"].as_str().unwrap_or("").to_string(),
        serde_json::Value::Array(items) => items
            .iter()
            .map(|i| {
                i.as_str()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| i["value"].as_str().unwrap_or("").to_string())
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    text.trim().to_string()
}

fn fmt_symbols(items: &[serde_json::Value], indent: usize, limit: usize, out: &mut Vec<String>) {
    for it in items.iter().take(limit) {
        let name = it["name"].as_str().unwrap_or("?");
        let kind = symbol_kind_label(it["kind"].as_i64().unwrap_or(0));
        let range = it
            .get("range")
            .or_else(|| it.get("location").and_then(|l| l.get("range")));
        let line = range
            .map(|r| r["start"]["line"].as_i64().unwrap_or(0) + 1)
            .unwrap_or(0);
        out.push(format!(
            "{}{} · {} (第 {} 行)",
            "  ".repeat(indent),
            name,
            kind,
            line
        ));
        if let Some(children) = it.get("children").and_then(|c| c.as_array()) {
            fmt_symbols(children, indent + 1, limit, out);
        }
    }
}

fn fmt_rename(result: &serde_json::Value, root: &str, new_name: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut total = 0usize;
    if let Some(changes) = result.get("changes").and_then(|c| c.as_object()) {
        for (uri, edits) in changes {
            let path = uri_to_path(uri);
            let shown = path
                .strip_prefix(root)
                .map(|s| s.trim_start_matches('/'))
                .unwrap_or(&path);
            let n = edits.as_array().map(|a| a.len()).unwrap_or(0);
            total += n;
            for e in edits.as_array().into_iter().flatten().take(5) {
                let line = e["range"]["start"]["line"].as_i64().unwrap_or(0) + 1;
                let ch = e["range"]["start"]["character"].as_i64().unwrap_or(0) + 1;
                lines.push(format!("{}:{}:{} → {}", shown, line, ch, new_name));
            }
            if n > 5 {
                lines.push(format!("{} …（该文件另外 {} 处）", shown, n - 5));
            }
        }
    }
    if total == 0 {
        return "（语言服务器没有给出重命名编辑：可能光标不在可重命名的符号上）".to_string();
    }
    format!(
        "【重命名预览】共 {} 处（**未写入**任何文件；确认后用 replace_string / apply_patch 落地）：\n{}",
        total,
        lines.join("\n")
    )
}

// ---------------------------------------------------------------- 命令

#[derive(Debug, serde::Serialize)]
pub struct LspServerInfo {
    pub id: String,
    pub lang: String,
    pub cmd: String,
    pub found: bool,
    /// 将被使用的程序路径（第一个候选）
    pub path: String,
    /// 候选来源（PATH / VS Code 扩展 …）
    pub source: String,
    /// 未安装时的安装建议（已安装为空）
    pub hint: String,
    pub languages: Vec<String>,
}

/// 列出支持的服务器与本机是否可用（供 Agent 选型与给用户安装建议）
#[tauri::command]
pub fn lsp_status() -> Vec<LspServerInfo> {
    let home = std::env::var("HOME").unwrap_or_default();
    SERVERS
        .iter()
        .map(|s| {
            let c = server_candidates(s, &home).into_iter().next();
            let found = c.is_some();
            LspServerInfo {
                id: s.id.to_string(),
                lang: s.lang.to_string(),
                cmd: s.cmd.to_string(),
                found,
                path: c
                    .as_ref()
                    .map(|l| l.program.to_string_lossy().to_string())
                    .unwrap_or_default(),
                source: c.as_ref().map(|l| l.source.clone()).unwrap_or_default(),
                hint: if found {
                    String::new()
                } else {
                    install_hint(s.id)
                },
                languages: s.language_ids.iter().map(|l| l.to_string()).collect(),
            }
        })
        .collect()
}

/// 一次导航/分析查询（只读）。`action`：
/// `definition` | `references` | `implementation` | `hover` | `symbols` |
/// `workspace_symbols` | `diagnostics` | `rename`
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri 命令的参数就是接口形状，不便打包成结构体
pub fn lsp_query(
    root: String,
    action: String,
    server: Option<String>,
    path: Option<String>,
    line: Option<u32>,
    character: Option<u32>,
    query: Option<String>,
    new_name: Option<String>,
    wait_ms: Option<u64>,
) -> Result<String, String> {
    let action = action.trim().to_string();
    let root_clean = root.trim().trim_end_matches('/').to_string();
    let wait = Duration::from_millis(wait_ms.unwrap_or(20_000).clamp(1_000, 180_000));
    let need_pos = matches!(
        action.as_str(),
        "definition" | "references" | "implementation" | "hover" | "rename"
    );
    let path = path.unwrap_or_default();
    let (line_no, char_no) = (line.unwrap_or(1).max(1), character.unwrap_or(1).max(1));

    // 位置类请求：先把文件读进来算 UTF-16 列（LSP 的 character 是 UTF-16 code unit）
    let mut lsp_pos = (0u32, 0u32);
    if need_pos {
        if path.trim().is_empty() {
            return Err(format!("{} 需要 path 参数（文件绝对路径）", action));
        }
        let content = std::fs::read_to_string(path.trim())
            .map_err(|e| format!("读取 {} 失败: {}", path, e))?;
        let text_line = line_of(&content, line_no);
        lsp_pos = to_lsp_position(text_line, line_no, char_no);
    }

    with_session(server.as_deref(), &root_clean, wait, |s| {
        match action.as_str() {
        "diagnostics" => {
            if path.trim().is_empty() {
                return Err("diagnostics 需要 path 参数（文件绝对路径）".to_string());
            }
            let uri = s.ensure_open(path.trim())?;
            let got = s.collect_notifications(
                "textDocument/publishDiagnostics",
                &uri,
                Duration::from_millis(wait_ms.unwrap_or(8_000).clamp(500, 60_000)),
            );
            let mut lines: Vec<String> = Vec::new();
            for params in &got {
                for d in params["diagnostics"].as_array().cloned().unwrap_or_default() {
                    let sev = match d["severity"].as_i64().unwrap_or(1) {
                        1 => "错误",
                        2 => "警告",
                        3 => "信息",
                        _ => "提示",
                    };
                    let l = d["range"]["start"]["line"].as_i64().unwrap_or(0) + 1;
                    lines.push(format!(
                        "- [{}] {}:{} {}",
                        sev,
                        path.trim(),
                        l,
                        d["message"].as_str().unwrap_or("")
                    ));
                }
            }
            if lines.is_empty() {
                return Ok(format!(
                    "（{} 暂无诊断：要么确实干净，要么服务器还在建索引——可稍后重试或调大 wait_ms）",
                    path.trim()
                ));
            }
            Ok(format!("【诊断】{} 共 {} 条：\n{}", path.trim(), lines.len(), lines.join("\n")))
        }
        "symbols" => {
            if path.trim().is_empty() {
                return Err("symbols 需要 path 参数（文件绝对路径）".to_string());
            }
            let uri = s.ensure_open(path.trim())?;
            let res = s.request(
                "textDocument/documentSymbol",
                serde_json::json!({ "textDocument": { "uri": uri } }),
                wait,
            )?;
            let items = res.as_array().cloned().unwrap_or_default();
            if items.is_empty() {
                return Ok(format!("（{} 里没有解析出符号）", path.trim()));
            }
            let mut out = Vec::new();
            fmt_symbols(&items, 0, 60, &mut out);
            Ok(format!(
                "【文件符号】{}：\n{}",
                path.trim(),
                out.join("\n")
            ))
        }
        "workspace_symbols" => {
            let q = query.unwrap_or_default();
            let res = s.request(
                "workspace/symbol",
                serde_json::json!({ "query": q }),
                wait,
            )?;
            let items = res.as_array().cloned().unwrap_or_default();
            if items.is_empty() {
                return Ok(format!(
                    "（工作区里没找到匹配「{}」的符号；服务器可能仍在建索引，稍后可重试）",
                    q
                ));
            }
            let mut out: Vec<String> = Vec::new();
            for it in items.iter().take(40) {
                let name = it["name"].as_str().unwrap_or("?");
                let kind = symbol_kind_label(it["kind"].as_i64().unwrap_or(0));
                let loc = it.get("location").cloned().unwrap_or(serde_json::Value::Null);
                out.push(format!("- {} · {} — {}", name, kind, fmt_location(&root_clean, &loc)));
            }
            Ok(format!(
                "【工作区符号】匹配「{}」共 {} 处：\n{}",
                q,
                items.len(),
                out.join("\n")
            ))
        }
        "hover" => {
            let uri = s.ensure_open(path.trim())?;
            let res = s.request(
                "textDocument/hover",
                serde_json::json!({
                    "textDocument": { "uri": uri },
                    "position": { "line": lsp_pos.0, "character": lsp_pos.1 }
                }),
                wait,
            )?;
            let text = fmt_hover(&res);
            if text.is_empty() {
                return Ok("（该位置没有悬停信息）".to_string());
            }
            Ok(format!("【悬停】{}:{}:{}\n{}", path.trim(), line_no, char_no, text))
        }
        "rename" => {
            let new_name = new_name.unwrap_or_default();
            if new_name.trim().is_empty() {
                return Err("rename 需要 new_name 参数（新名字）".to_string());
            }
            let uri = s.ensure_open(path.trim())?;
            let res = s.request(
                "textDocument/rename",
                serde_json::json!({
                    "textDocument": { "uri": uri },
                    "position": { "line": lsp_pos.0, "character": lsp_pos.1 },
                    "newName": new_name.trim()
                }),
                wait,
            )?;
            Ok(fmt_rename(&res, &root_clean, new_name.trim()))
        }
        "definition" | "references" | "implementation" => {
            let uri = s.ensure_open(path.trim())?;
            let (method, pos_key) = match action.as_str() {
                "definition" => ("textDocument/definition", true),
                "implementation" => ("textDocument/implementation", true),
                _ => ("textDocument/references", false),
            };
            let params = if pos_key {
                serde_json::json!({
                    "textDocument": { "uri": uri },
                    "position": { "line": lsp_pos.0, "character": lsp_pos.1 }
                })
            } else {
                serde_json::json!({
                    "textDocument": { "uri": uri },
                    "position": { "line": lsp_pos.0, "character": lsp_pos.1 },
                    "context": { "includeDeclaration": true }
                })
            };
            let res = s.request(method, params, wait)?;
            let items: Vec<serde_json::Value> = match res {
                serde_json::Value::Array(a) => a,
                serde_json::Value::Null => Vec::new(),
                other => vec![other],
            };
            if items.is_empty() {
                return Ok(format!(
                    "（{} 在 {}:{}:{} 没有结果——光标可能不在符号上，或服务器仍在建索引）",
                    match action.as_str() {
                        "definition" => "跳转定义",
                        "implementation" => "查找实现",
                        _ => "查找引用",
                    },
                    path.trim(),
                    line_no,
                    char_no
                ));
            }
            let label = match action.as_str() {
                "definition" => "定义",
                "implementation" => "实现",
                _ => "引用",
            };
            let mut out: Vec<String> = Vec::new();
            for it in items.iter().take(50) {
                out.push(format!("- {}", fmt_location(&root_clean, it)));
            }
            Ok(format!(
                "【{}】{}:{}:{} → 共 {} 处：\n{}",
                label,
                path.trim(),
                line_no,
                char_no,
                items.len(),
                out.join("\n")
            ))
        }
        other => Err(format!(
            "未知 action「{}」。可用：definition / references / implementation / hover / symbols / workspace_symbols / diagnostics / rename",
            other
        )),
    }
    })
}

/// 关闭会话（`root` 省略则全部关闭）
#[tauri::command]
pub fn lsp_stop(root: Option<String>, server: Option<String>) -> Result<String, String> {
    let want_root = root.map(|r| r.trim().trim_end_matches('/').to_string());
    let mut guard = SESSIONS.lock().map_err(|_| "会话表锁失败".to_string())?;
    let before = guard.len();
    guard.retain(|s| {
        let keep_root = match &want_root {
            Some(r) => !s.key.ends_with(&format!("|{}", r)),
            None => false,
        };
        let keep_server = match server.as_deref() {
            Some(sv) if !sv.trim().is_empty() => !s.key.starts_with(&format!("{}|", sv)),
            _ => false,
        };
        keep_root || keep_server
    });
    let closed = before - guard.len();
    guard.clear();
    Ok(format!("已关闭 {} 个语言服务器会话", closed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrip_handles_split_reads() {
        let msg = r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#;
        let frame = encode_lsp_message(msg);
        assert!(String::from_utf8_lossy(&frame).starts_with("Content-Length: "));
        // 一次给全
        let mut buf = frame.clone();
        assert_eq!(take_lsp_message(&mut buf).unwrap(), msg);
        assert!(buf.is_empty());
        // 分两次给（先头一半，再余下）
        let mut buf2 = frame[..10].to_vec();
        assert!(take_lsp_message(&mut buf2).is_none(), "不足一帧应返回 None");
        buf2.extend_from_slice(&frame[10..]);
        assert_eq!(take_lsp_message(&mut buf2).unwrap(), msg);
        // 两帧粘一起
        let mut buf3 = frame.clone();
        buf3.extend_from_slice(&frame);
        assert!(take_lsp_message(&mut buf3).is_some());
        assert!(take_lsp_message(&mut buf3).is_some());
        assert!(take_lsp_message(&mut buf3).is_none());
    }

    #[test]
    fn uri_conversion_roundtrips_paths_with_spaces_and_cjk() {
        for p in [
            "/Users/tester/op/proj/src/main.rs",
            "/Users/tester/my dir/a b.ts",
            "/Users/tester/项目/代码.rs",
        ] {
            let uri = path_to_uri(p);
            assert!(uri.starts_with("file:///"));
            // 中文与空格：中文原样、空格转义
            if p.contains(' ') {
                assert!(uri.contains("%20"));
            }
            assert_eq!(uri_to_path(&uri), p);
        }
        assert_eq!(uri_to_path("file:///tmp/a%20b.md"), "/tmp/a b.md");
    }

    #[test]
    fn lsp_position_counts_utf16_units() {
        // ASCII：字符序 == UTF-16 序
        assert_eq!(to_lsp_position("let x = 1;", 3, 5), (2, 4));
        // 中文（BMP，1 个 UTF-16 单元）
        assert_eq!(to_lsp_position("中文abc", 1, 3), (0, 2));
        // emoji（星形平面，2 个 UTF-16 单元）——这正是不能直接用字符数的地方
        assert_eq!(to_lsp_position("😀ab", 1, 2), (0, 2));
        // 越界不 panic
        assert_eq!(to_lsp_position("a", 1, 99), (0, 1));
    }

    #[test]
    fn language_id_and_line_lookup() {
        assert_eq!(language_id_for("/a/b.rs"), "rust");
        assert_eq!(language_id_for("/a/b.TSX"), "typescriptreact");
        assert_eq!(language_id_for("/a/b.vue"), "vue");
        assert_eq!(language_id_for("/a/b.unknown"), "plaintext");
        let src = "one\ntwo\nthree";
        assert_eq!(line_of(src, 2), "two");
        assert_eq!(line_of(src, 99), "");
    }

    #[test]
    fn symbol_kind_labels_are_human_readable() {
        assert_eq!(symbol_kind_label(12), "函数");
        assert_eq!(symbol_kind_label(23), "结构体");
        assert_eq!(symbol_kind_label(999), "符号");
    }

    #[test]
    fn location_format_shortens_to_relative_path() {
        let loc = serde_json::json!({
            "uri": "file:///Users/tester/op/proj/src/main.rs",
            "range": { "start": { "line": 9, "character": 4 }, "end": { "line": 9, "character": 8 } }
        });
        assert_eq!(
            fmt_location("/Users/tester/op/proj", &loc),
            "src/main.rs:10:5"
        );
        // definition 常见的 LocationLink 形态
        let link = serde_json::json!({
            "targetUri": "file:///Users/tester/op/proj/src/lib.rs",
            "targetSelectionRange": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } }
        });
        assert_eq!(
            fmt_location("/Users/tester/op/proj", &link),
            "src/lib.rs:1:1"
        );
    }

    #[test]
    fn resolve_bin_finds_rust_analyzer_or_reports_absence() {
        let home = std::env::var("HOME").unwrap_or_default();
        // 契约：要么返回真实存在的文件，要么 None（不能返回不存在的路径）
        if let Some(p) = resolve_bin("rust-analyzer", &home) {
            assert!(p.is_file());
        }
        assert!(resolve_bin("definitely-not-a-real-binary-xyz", &home).is_none());
    }

    #[test]
    fn ver_key_orders_extension_versions() {
        assert!(
            ver_key("rust-lang.rust-analyzer-0.3.3081-darwin-x64")
                > ver_key("rust-lang.rust-analyzer-0.3.3073-darwin-x64")
        );
        assert_eq!(ver_key("vue.volar-3.3.13"), 3_030_013);
        assert_eq!(ver_key("no-version-here"), 0);
    }

    #[test]
    fn server_candidates_include_vscode_bundled_rust_analyzer_when_present() {
        let home = std::env::var("HOME").unwrap_or_default();
        let ra = SERVERS.iter().find(|s| s.id == "rust-analyzer").unwrap();
        for c in server_candidates(ra, &home) {
            // 契约：候选要么是存在的文件，要么不该出现（否则会白启动一次）
            assert!(c.program.is_file(), "候选应存在：{}", c.program.display());
            assert!(!c.source.is_empty());
        }
    }

    /// 真机 e2e（需本机有可用的 rust-analyzer）：`cargo test --lib -- --ignored lsp_real`
    #[test]
    #[ignore]
    fn lsp_real_rust_analyzer_symbols_and_definition() {
        let home = std::env::var("HOME").unwrap();
        let ra = SERVERS.iter().find(|s| s.id == "rust-analyzer").unwrap();
        if server_candidates(ra, &home).is_empty() {
            eprintln!("跳过：本机没有可用的 rust-analyzer（PATH 或 VS Code 扩展）");
            return;
        }
        let root = env!("CARGO_MANIFEST_DIR").to_string(); // src-tauri
        let repo = std::path::Path::new(&root)
            .parent()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let target = format!("{}/src-tauri/src/skill_pack.rs", repo);
        assert!(std::path::Path::new(&target).is_file(), "被测文件应存在");

        // 1) 工作区符号：这个符号名在本仓唯一
        let out = lsp_query(
            repo.clone(),
            "workspace_symbols".to_string(),
            None,
            None,
            None,
            None,
            Some("slugify".to_string()),
            None,
            Some(60_000),
        )
        .expect("workspace_symbols 应成功");
        eprintln!("[e2e] {}\n{}", repo, out);
        assert!(
            out.contains("slugify"),
            "工作区符号应命中 slugify，实际输出：{}",
            out
        );

        // 2) 文件符号：技能包模块里的函数应被解析出来
        let out2 = lsp_query(
            repo.clone(),
            "symbols".to_string(),
            None,
            Some(target.clone()),
            None,
            None,
            None,
            None,
            Some(60_000),
        )
        .expect("documentSymbol 应成功");
        eprintln!("[e2e] {}", out2);
        assert!(
            out2.contains("export_skill_pack") || out2.contains("entry_kind"),
            "文件符号应包含该模块里的函数，实际输出：{}",
            out2
        );
        let _ = lsp_stop(Some(repo), None);
    }
}
