//! llama.cpp（`llama-server`）本地运行时后端。
//!
//! ## 为什么要这个模块
//!
//! 用户反馈「Ollama 太浪费资源」。2026-09-17 在本机（Intel Mac / llava-phi3 3.8B）实测：
//!
//! | 运行时 | 模型加载后 | 空闲时 | 说明 |
//! | --- | --- | --- | --- |
//! | Ollama | 20MB(Go daemon) + **4505MB**(它自己 spawn 的 llama-server 子进程) | 4.5GB 常驻到 `keep_alive`（默认 5 分钟）到期 | 多一层守护进程 + 默认 `n_slots=4` 多留 KV |
//! | 裸 llama.cpp（`-c 2048 -np 1`） | **3928MB** | **0**：进程退出即归还 | 无守护进程、mmap 权重可被 OS 回收 |
//!
//! 速度**基本一致**（同一张 768px 图：41.5s vs 44.6s），所以换运行时的收益是
//! **内存与常驻**，不是推理速度。
//!
//! ## 零下载迁移
//!
//! Ollama 模型库里的 blob 本质就是 GGUF（实测两个 blob 均以魔数 `GGUF` 开头），
//! manifest 里 `model` / `projector` 两层正好对应 llama.cpp 的
//! `-m model.gguf --mmproj mmproj.gguf` —— 因此可以硬链接导入，**不重复占磁盘、无需重新下载**。
//!
//! ## 生命周期策略（相对 Ollama 的核心优势）
//!
//! 按需启动 + 空闲自动退出：只有真正要识图时才拉起 llama-server，`IDLE_KILL_SECS` 秒无请求就
//! 停掉进程，做到**空闲 0 常驻**。应用退出时也会一并停止。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::OnceLock;

use tauri::Manager as _;

/// llama-server 监听端口（刻意避开 Ollama 的 11434，两者可共存互不干扰）
pub const LLAMA_PORT: u16 = 18080;
/// 上下文长度：视觉描述只需「看图说话」，2048 足够（越大越费 KV cache）
pub const LLAMA_CTX: u32 = 2048;
/// 空闲多久后自动停止服务（毫秒 0 常驻的关键）
pub const IDLE_KILL_SECS: u64 = 120;
/// 启动就绪最长等待（模型 2.3GB + 投影器 608MB，首次加载约 10~20 秒）
const READY_TIMEOUT_SECS: u64 = 90;

/// 本应用启动的 llama-server PID（0 = 未运行）
static SERVER_PID: AtomicU32 = AtomicU32::new(0);
/// 最后一次使用时刻（Unix 秒）：空闲看门狗据此回收进程
static LAST_USED: AtomicU64 = AtomicU64::new(0);
/// 启动互斥：避免并发请求各拉一个进程（那才是真的浪费）
static SPAWN_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// --- 纯函数区（全部可单测） ---

/// `llama-server` 候选路径：优先应用自己的 runtimes 目录，再系统常见位置。
/// `brew install llama.cpp` 会装到 `/opt/homebrew/bin`(ARM) 或 `/usr/local/bin`(Intel)。
pub fn bin_candidates(app_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(dir) = app_dir {
        v.push(dir.join("runtimes/llama-server"));
    }
    v.push(PathBuf::from("/usr/local/bin/llama-server"));
    v.push(PathBuf::from("/opt/homebrew/bin/llama-server"));
    v.push(PathBuf::from("/usr/bin/llama-server"));
    v
}

/// 返回可用的 llama-server 路径；都没有时用 `which` 兜底（处理用户自定义安装位置）。
pub fn llama_bin(app_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = bin_candidates(app_dir).into_iter().find(|p| p.exists()) {
        return Some(p);
    }
    let out = std::process::Command::new("which")
        .arg("llama-server")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

/// 本应用托管的 GGUF 模型目录（`<应用数据>/models`）
pub fn models_dir(app_dir: &Path) -> PathBuf {
    app_dir.join("models")
}

/// GGUF 魔数校验（Ollama 的 blob 也是 GGUF，这是「零下载导入」的依据）
pub fn is_gguf_magic(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && &bytes[..4] == b"GGUF"
}

/// Ollama blob 路径：digest `sha256:abcd…` → 文件名 `sha256-abcd…`
pub fn blob_path(blobs_dir: &Path, digest: &str) -> PathBuf {
    blobs_dir.join(digest.replace(':', "-"))
}

/// 解析 Ollama manifest，取出 `(模型 blob digest, 投影器 blob digest)`。
/// 只认 `.model` / `.projector` 两种 layer（其余 template/params 是文本配置，不需要）。
pub fn parse_ollama_manifest(v: &serde_json::Value) -> Option<(String, Option<String>)> {
    let layers = v.get("layers")?.as_array()?;
    let mut model: Option<String> = None;
    let mut projector: Option<String> = None;
    for layer in layers {
        let media = layer
            .get("mediaType")
            .and_then(|m| m.as_str())
            .unwrap_or("");
        let digest = layer.get("digest").and_then(|d| d.as_str()).unwrap_or("");
        if digest.is_empty() {
            continue;
        }
        if media.ends_with(".model") && model.is_none() {
            model = Some(digest.to_string());
        } else if media.ends_with(".projector") && projector.is_none() {
            projector = Some(digest.to_string());
        }
    }
    model.map(|m| (m, projector))
}

/// 文件名安全化：`llava-phi3:3.8b` → `llava-phi3-3.8b`
pub fn sanitize_name(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// 判断某个 GGUF 文件是不是「多模态投影器」（llama.cpp 用 `--mmproj` 加载）
fn looks_like_projector(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    name.contains("mmproj") || name.contains("projector") || name.contains("clip")
}

/// 从 `(路径, 字节数)` 列表里挑出「模型 + 投影器」：
/// 投影器优先选带 mmproj/projector/clip 的，模型选剩下最大的那个。
pub fn pick_model_pair(entries: &[(PathBuf, u64)]) -> Option<(PathBuf, Option<PathBuf>)> {
    let projector = entries
        .iter()
        .filter(|(p, _)| looks_like_projector(p))
        .max_by_key(|(_, s)| *s)
        .map(|(p, _)| p.clone());
    let model = entries
        .iter()
        .filter(|(p, _)| !looks_like_projector(p))
        .max_by_key(|(_, s)| *s)
        .map(|(p, _)| p.clone())?;
    Some((model, projector))
}

/// 默认线程数：物理/逻辑核数减 2（留出给 UI 与系统），至少 2。
pub fn default_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(2).max(2))
        .unwrap_or(4)
}

/// 组装 llama-server 启动参数（纯函数，便于单测）：
/// `-np 1` 只保留一份 KV cache 是省内存的关键（Ollama 默认 4 份）。
pub fn server_args(model: &Path, mmproj: Option<&Path>, threads: usize) -> Vec<String> {
    let mut args = vec![
        "-m".to_string(),
        model.display().to_string(),
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        LLAMA_PORT.to_string(),
        "-c".to_string(),
        LLAMA_CTX.to_string(),
        "-t".to_string(),
        threads.max(1).to_string(),
        "-np".to_string(),
        "1".to_string(),
    ];
    if let Some(p) = mmproj {
        args.push("--mmproj".to_string());
        args.push(p.display().to_string());
    }
    args
}

/// 列出目录下**魔数正确**的 GGUF 文件及其大小（脏文件/损坏文件直接跳过）
pub fn list_gguf(dir: &Path) -> Vec<(PathBuf, u64)> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("gguf") {
            continue;
        }
        let Ok(meta) = p.metadata() else { continue };
        if !meta.is_file() || meta.len() < 1024 {
            continue;
        }
        let Ok(mut f) = std::fs::File::open(&p) else {
            continue;
        };
        let mut magic = [0u8; 4];
        use std::io::Read as _;
        if f.read_exact(&mut magic).is_err() || !is_gguf_magic(&magic) {
            continue;
        }
        out.push((p, meta.len()));
    }
    out
}

// --- 进程生命周期 ---

#[derive(Debug, Clone, serde::Serialize)]
pub struct ServerInfo {
    pub port: u16,
    pub model: String,
    pub has_projector: bool,
    /// 本次是否新拉起了进程（false = 复用已在跑的）
    pub spawned: bool,
}

/// 服务是否就绪（llama.cpp 的 `GET /health` 返回 `{"status":"ok"}`）
pub async fn health_ok() -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    else {
        return false;
    };
    match client
        .get(format!("http://127.0.0.1:{}/health", LLAMA_PORT))
        .send()
        .await
    {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
}

/// 标记「刚刚用过」，推迟空闲回收
pub fn touch() {
    LAST_USED.store(now_secs(), Ordering::SeqCst);
}

/// 停止由本应用启动的 llama-server（空闲回收 / 应用退出时调用）
pub fn stop_server() {
    let pid = SERVER_PID.swap(0, Ordering::SeqCst);
    if pid != 0 {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
}

/// 进程是否由本应用持有且仍在运行
pub fn serving() -> bool {
    SERVER_PID.load(Ordering::SeqCst) != 0
}

/// 距离上次使用过去了多少秒（未启用时返回 None）
pub fn idle_secs() -> Option<u64> {
    if !serving() {
        return None;
    }
    let last = LAST_USED.load(Ordering::SeqCst);
    Some(now_secs().saturating_sub(last))
}

/// 空闲看门狗：每 30 秒检查一次，超过 `IDLE_KILL_SECS` 无使用就停服务（只启动一次）
fn start_watchdog() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            if let Some(idle) = idle_secs() {
                if idle >= IDLE_KILL_SECS {
                    stop_server();
                }
            }
        }
    });
}

/// 确保 llama-server 就绪并返回信息；已在运行则复用（不会重复拉起进程）。
pub async fn ensure_server(app: &tauri::AppHandle) -> Result<ServerInfo, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let bin = llama_bin(Some(&app_dir)).ok_or_else(|| {
        "未找到 llama-server（可 `brew install llama.cpp`，或把二进制放到应用数据目录 runtimes/ 下）"
            .to_string()
    })?;
    let dir = models_dir(&app_dir);
    let entries = list_gguf(&dir);
    let (model, mmproj) = pick_model_pair(&entries).ok_or_else(|| {
        format!(
            "未在 {} 找到 GGUF 模型（可在设置里「从 Ollama 导入」，硬链接导入无需重新下载）",
            dir.display()
        )
    })?;

    start_watchdog();

    let lock = SPAWN_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _guard = lock.lock().await;

    let label = model
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("model.gguf")
        .to_string();
    let info = |spawned: bool| ServerInfo {
        port: LLAMA_PORT,
        model: label.clone(),
        has_projector: mmproj.is_some(),
        spawned,
    };

    // 已在跑且健康 → 直接复用
    if health_ok().await {
        touch();
        return Ok(info(false));
    }
    // 残留进程（端口被占但不健康）→ 先清掉再拉新的
    stop_server();

    let args = server_args(&model, mmproj.as_deref(), default_threads());
    let child = tokio::process::Command::new(&bin)
        .args(&args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("启动 llama-server 失败: {}", e))?;
    if let Some(pid) = child.id() {
        SERVER_PID.store(pid, Ordering::SeqCst);
    }
    touch();

    // 等待就绪（首次加载 2.9GB 权重需要十几秒）
    let rounds = READY_TIMEOUT_SECS * 2; // 每轮 500ms
    for _ in 0..rounds {
        if health_ok().await {
            return Ok(info(true));
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    stop_server();
    Err(format!(
        "llama-server 启动超时（{} 秒）：{}",
        READY_TIMEOUT_SECS,
        bin.display()
    ))
}

// --- 从 Ollama 模型库导入（零下载） ---

#[derive(Debug, Clone, serde::Serialize)]
pub struct ImportReport {
    pub label: String,
    pub model_file: String,
    pub projector_file: Option<String>,
    pub model_mb: u64,
    /// hardlink=硬链接（不额外占盘）/ copy=复制 / exists=已存在跳过
    pub model_link: String,
    pub projector_link: Option<String>,
}

#[derive(Debug, PartialEq)]
enum LinkKind {
    Hardlink,
    Copy,
    Exists,
}

impl LinkKind {
    fn as_str(&self) -> &'static str {
        match self {
            LinkKind::Hardlink => "hardlink",
            LinkKind::Copy => "copy",
            LinkKind::Exists => "exists",
        }
    }
}

/// 优先硬链接（同一卷上零成本、零额外磁盘），失败再复制
fn link_or_copy(src: &Path, dst: &Path) -> Result<LinkKind, String> {
    if dst.exists() {
        return Ok(LinkKind::Exists);
    }
    if std::fs::hard_link(src, dst).is_ok() {
        return Ok(LinkKind::Hardlink);
    }
    std::fs::copy(src, dst)
        .map(|_| LinkKind::Copy)
        .map_err(|e| format!("导入 {} 失败: {}", src.display(), e))
}

/// 递归收集 manifest 文件（限深度，避免异常目录结构下扫太久）
fn collect_manifests(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 || out.len() > 200 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_manifests(&p, depth - 1, out);
        } else if p.is_file() {
            out.push(p);
        }
    }
}

/// 从 manifest 路径推模型名：`…/manifests/registry.ollama.ai/library/llava-phi3/latest` → `llava-phi3:latest`
fn label_from_manifest(path: &Path) -> String {
    let tag = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("latest")
        .to_string();
    let family = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("model")
        .to_string();
    format!("{}:{}", family, tag)
}

/// Ollama 模型库根目录（支持 `OLLAMA_MODELS` 覆盖）
pub fn ollama_models_root() -> Option<PathBuf> {
    if let Some(v) = std::env::var_os("OLLAMA_MODELS") {
        if !v.is_empty() {
            return Some(PathBuf::from(v));
        }
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".ollama/models"))
}

/// 扫描 Ollama 模型库，返回第一个「带投影器的多模态模型」及其实体文件路径：
/// `(label, 模型 blob, 投影器 blob)`
pub fn find_ollama_multimodal(root: &Path) -> Option<(String, PathBuf, PathBuf)> {
    let manifests = root.join("manifests");
    let mut files = Vec::new();
    collect_manifests(&manifests, 5, &mut files);
    // 优先 llava/vision 系的多模态模型（多模态通常带 projector；再按名字偏好排序）
    files.sort_by_key(|p| {
        let s = p.to_string_lossy().to_ascii_lowercase();
        let pref = if s.contains("llava") || s.contains("vision") || s.contains("vl") {
            0
        } else {
            1
        };
        (pref, s)
    });
    for m in files {
        let Ok(text) = std::fs::read_to_string(&m) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let Some((model_digest, Some(proj_digest))) = parse_ollama_manifest(&v) else {
            continue; // 纯文本模型不代管
        };
        let model_blob = blob_path(&root.join("blobs"), &model_digest);
        let proj_blob = blob_path(&root.join("blobs"), &proj_digest);
        if !model_blob.exists() || !proj_blob.exists() {
            continue;
        }
        return Some((label_from_manifest(&m), model_blob, proj_blob));
    }
    None
}

/// 把 Ollama 的多模态模型导入到本应用模型目录（硬链接优先，**不新增磁盘占用、无需下载**）。
pub fn import_from_ollama(app: &tauri::AppHandle) -> Result<ImportReport, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dest = models_dir(&app_dir);
    std::fs::create_dir_all(&dest).map_err(|e| format!("创建模型目录失败: {}", e))?;
    let root =
        ollama_models_root().ok_or("未找到 Ollama 模型目录（HOME / OLLAMA_MODELS 均不可用）")?;
    if !root.exists() {
        return Err(format!(
            "Ollama 模型目录不存在：{}（需先在 Ollama 中拉取多模态模型）",
            root.display()
        ));
    }
    let (label, model_blob, proj_blob) = find_ollama_multimodal(&root).ok_or_else(|| {
        format!(
            "未在 {} 找到「带投影器」的多模态模型（如 llava-phi3）",
            root.display()
        )
    })?;
    // 双保险：确认确实是 GGUF（Ollama blob 格式若变更，这里会明确报错而不是留个坏文件）
    for (p, what) in [(&model_blob, "模型"), (&proj_blob, "投影器")] {
        let mut f = std::fs::File::open(p).map_err(|e| format!("读取{}失败: {}", what, e))?;
        let mut magic = [0u8; 4];
        use std::io::Read as _;
        f.read_exact(&mut magic)
            .map_err(|e| format!("读取{}失败: {}", what, e))?;
        if !is_gguf_magic(&magic) {
            return Err(format!(
                "{} 不是 GGUF 格式（{}），无法交给 llama.cpp：该 Ollama 模型可能不是 llama.cpp 系模型",
                what,
                p.display()
            ));
        }
    }
    let name = sanitize_name(&label);
    let model_out = dest.join(format!("{}.gguf", name));
    let proj_out = dest.join(format!("{}-mmproj.gguf", name));
    let model_link = link_or_copy(&model_blob, &model_out)?;
    let projector_link = link_or_copy(&proj_blob, &proj_out)?;
    let model_mb = std::fs::metadata(&model_out)
        .map(|m| m.len() / 1_048_576)
        .unwrap_or(0);
    Ok(ImportReport {
        label,
        model_file: model_out
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string(),
        projector_file: Some(
            proj_out
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string(),
        ),
        model_mb,
        model_link: model_link.as_str().to_string(),
        projector_link: Some(projector_link.as_str().to_string()),
    })
}

/// 运行时状态（供设置面板展示）
#[derive(Debug, Clone, serde::Serialize)]
pub struct RuntimeStatus {
    pub bin_found: bool,
    pub bin_path: String,
    pub models_dir: String,
    pub models: Vec<String>,
    pub serving: bool,
    pub idle_secs: Option<u64>,
    pub port: u16,
    pub idle_kill_secs: u64,
    /// 当前会被加载的模型文件名（空 = 还没导入模型）
    pub active_model: String,
    /// 是否带投影器（多模态可用）
    pub has_projector: bool,
}

pub fn status(app: &tauri::AppHandle) -> RuntimeStatus {
    let app_dir = app.path().app_data_dir().ok();
    let bin = llama_bin(app_dir.as_deref());
    let dir = app_dir
        .as_deref()
        .map(models_dir)
        .unwrap_or_else(|| PathBuf::from(""));
    let entries = list_gguf(&dir);
    let pair = pick_model_pair(&entries);
    let active_model = pair
        .as_ref()
        .and_then(|(m, _)| m.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let has_projector = pair.as_ref().map(|(_, p)| p.is_some()).unwrap_or(false);
    let mut models: Vec<String> = entries
        .iter()
        .map(|(p, _)| {
            p.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string()
        })
        .collect();
    models.sort();
    RuntimeStatus {
        bin_found: bin.is_some(),
        bin_path: bin.map(|p| p.display().to_string()).unwrap_or_default(),
        models_dir: dir.display().to_string(),
        models,
        serving: serving(),
        idle_secs: idle_secs(),
        port: LLAMA_PORT,
        idle_kill_secs: IDLE_KILL_SECS,
        active_model,
        has_projector,
    }
}

/// 模型是否已就绪（有 llama-server + 至少一个可用的模型对）
pub fn ready(app_dir: Option<&Path>) -> bool {
    let Some(dir) = app_dir.map(models_dir) else {
        return false;
    };
    llama_bin(app_dir).is_some() && pick_model_pair(&list_gguf(&dir)).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn gguf_magic_detects() {
        assert!(is_gguf_magic(b"GGUF\x03\x00"));
        assert!(!is_gguf_magic(b"GGU"));
        assert!(!is_gguf_magic(b"JSON{}"));
        assert!(!is_gguf_magic(b""));
    }

    #[test]
    fn blob_path_maps_digest() {
        let blobs = p("/home/u/.ollama/models/blobs");
        assert_eq!(
            blob_path(&blobs, "sha256:377876be20ba"),
            blobs.join("sha256-377876be20ba")
        );
        // 没有冒号（异常输入）也不崩
        assert_eq!(blob_path(&blobs, "abc"), blobs.join("abc"));
    }

    #[test]
    fn parse_manifest_extracts_model_and_projector() {
        // 结构与真实 llava-phi3 manifest 一致
        let v = serde_json::json!({
            "schemaVersion": 2,
            "layers": [
                { "mediaType": "application/vnd.ollama.image.model", "digest": "sha256:3778", "size": 2318919200u64 },
                { "mediaType": "application/vnd.ollama.image.projector", "digest": "sha256:004f", "size": 607648960u64 },
                { "mediaType": "application/vnd.ollama.image.template", "digest": "sha256:c608", "size": 100 },
                { "mediaType": "application/vnd.ollama.image.params", "digest": "sha256:cadf", "size": 20 }
            ]
        });
        assert_eq!(
            parse_ollama_manifest(&v),
            Some(("sha256:3778".to_string(), Some("sha256:004f".to_string())))
        );
    }

    #[test]
    fn parse_manifest_handles_text_only_and_garbage() {
        let text_only = serde_json::json!({
            "layers": [{ "mediaType": "application/vnd.ollama.image.model", "digest": "sha256:aa" }]
        });
        assert_eq!(
            parse_ollama_manifest(&text_only),
            Some(("sha256:aa".to_string(), None))
        );
        // 垃圾输入 → None（调用方跳过该 manifest，绝不 panic）
        assert_eq!(parse_ollama_manifest(&serde_json::json!({})), None);
        assert_eq!(
            parse_ollama_manifest(&serde_json::json!({ "layers": "x" })),
            None
        );
        assert_eq!(
            parse_ollama_manifest(&serde_json::json!({ "layers": [] })),
            None
        );
    }

    #[test]
    fn sanitize_name_makes_safe_filenames() {
        assert_eq!(sanitize_name("llava-phi3:3.8b"), "llava-phi3-3.8b");
        assert_eq!(sanitize_name("a/b c"), "a-b-c");
        assert_eq!(sanitize_name("正常.gguf"), "--.gguf");
    }

    #[test]
    fn pick_model_pair_prefers_projector_by_name_and_largest_rest() {
        let entries = vec![
            (p("/m/llava-phi3-3.8b.gguf"), 2_318_919_200u64),
            (p("/m/llava-phi3-3.8b-mmproj.gguf"), 607_648_960u64),
            (p("/m/tiny.gguf"), 10_000u64),
        ];
        let (model, proj) = pick_model_pair(&entries).unwrap();
        assert_eq!(model, p("/m/llava-phi3-3.8b.gguf"));
        assert_eq!(proj, Some(p("/m/llava-phi3-3.8b-mmproj.gguf")));
    }

    #[test]
    fn pick_model_pair_without_projector_still_works() {
        let entries = vec![(p("/m/text.gguf"), 100u64), (p("/m/big.gguf"), 200u64)];
        let (model, proj) = pick_model_pair(&entries).unwrap();
        assert_eq!(model, p("/m/big.gguf"));
        assert_eq!(proj, None);
    }

    #[test]
    fn pick_model_pair_returns_none_when_only_projector_or_empty() {
        let only_proj = vec![(p("/m/mmproj.gguf"), 100u64)];
        assert!(pick_model_pair(&only_proj).is_none());
        assert!(pick_model_pair(&[]).is_none());
    }

    #[test]
    fn server_args_pin_single_slot_and_small_ctx() {
        let args = server_args(&p("/m/m.gguf"), Some(&p("/m/mm.gguf")), 6);
        let joined = args.join(" ");
        assert!(joined.contains("-m /m/m.gguf"));
        assert!(joined.contains("--mmproj /m/mm.gguf"));
        assert!(joined.contains("-np 1"), "必须单并发：{}", joined);
        assert!(joined.contains(&format!("-c {}", LLAMA_CTX)));
        assert!(joined.contains("-t 6"));
        // 只监听本机回环，不暴露到局域网
        assert!(joined.contains("--host 127.0.0.1"));
        assert!(joined.contains(&format!("--port {}", LLAMA_PORT)));
        // 线程数下限保护
        let zero = server_args(&p("/m/m.gguf"), None, 0).join(" ");
        assert!(zero.contains("-t 1"));
    }

    #[test]
    fn default_threads_leaves_headroom() {
        assert!(default_threads() >= 2);
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        assert!(default_threads() <= cores);
    }

    #[test]
    fn label_from_manifest_uses_family_and_tag() {
        let path = p("/u/.ollama/models/manifests/registry.ollama.ai/library/llava-phi3/latest");
        assert_eq!(label_from_manifest(&path), "llava-phi3:latest");
        // 极端输入不崩：无父目录时家族名回落为 model（文件名仍作为 tag）
        assert_eq!(label_from_manifest(&p("x")), "model:x");
    }

    #[test]
    fn ollama_models_root_honours_env_override() {
        // 真实环境里 HOME 一定存在；OLLAMA_MODELS 覆盖优先（这里只验证不 panic 且为绝对路径）
        let root = ollama_models_root().expect("HOME 应存在");
        assert!(root.is_absolute());
    }

    /// 本机装了 Ollama 时就顺路验证「真 manifest → 真 blob」的整条发现链路：
    /// 这正是「零下载导入」的关键依据（blob 必须是 GGUF）。本机没装/没有多模态模型 → 跳过。
    #[test]
    fn find_ollama_multimodal_on_real_store_if_present() {
        let Some(root) = ollama_models_root() else {
            return;
        };
        if !root.join("manifests").exists() {
            return;
        }
        let Some((label, model, proj)) = find_ollama_multimodal(&root) else {
            return; // 本机无「带投影器」的多模态模型 → 不算失败
        };
        assert!(
            label.contains(':'),
            "标签应形如 llava-phi3:latest，实际 {}",
            label
        );
        assert!(model.exists(), "模型 blob 应存在: {}", model.display());
        assert!(proj.exists(), "投影器 blob 应存在: {}", proj.display());
        use std::io::Read as _;
        for p in [&model, &proj] {
            let mut f = std::fs::File::open(p).unwrap();
            let mut magic = [0u8; 4];
            f.read_exact(&mut magic).unwrap();
            assert!(
                is_gguf_magic(&magic),
                "Ollama blob 应为 GGUF（零下载导入的前提）：{}",
                p.display()
            );
        }
    }

    #[test]
    fn list_gguf_ignores_non_gguf_and_missing_dir() {
        let dir = std::env::temp_dir().join(format!("dsy-gguf-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        // 真实 GGUF 都是 MB 级；小于 1KB 的视为未下完的残片，直接跳过
        let mut real = b"GGUF\x03\x00\x00\x00".to_vec();
        real.resize(2048, 0);
        std::fs::write(dir.join("real.gguf"), &real).unwrap();
        std::fs::write(dir.join("fake.gguf"), vec![b'x'; 2048]).unwrap();
        std::fs::write(dir.join("tiny.gguf"), b"GGUF").unwrap();
        std::fs::write(dir.join("note.txt"), b"GGUF").unwrap();
        let found = list_gguf(&dir);
        assert_eq!(
            found.len(),
            1,
            "只应认魔数正确且体积合理的 GGUF：{:?}",
            found
        );
        assert_eq!(
            found[0].0.file_name().unwrap().to_str().unwrap(),
            "real.gguf"
        );
        let _ = std::fs::remove_dir_all(&dir);
        // 不存在的目录 → 空列表（不 panic）
        assert!(list_gguf(&p("/definitely/not/here")).is_empty());
    }

    #[test]
    fn link_or_copy_reports_exists_and_only_links_once() {
        let dir = std::env::temp_dir().join(format!("dsy-link-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let src = dir.join("src.bin");
        let dst = dir.join("dst.bin");
        std::fs::write(&src, b"hello").unwrap();
        assert_eq!(link_or_copy(&src, &dst).unwrap(), LinkKind::Hardlink);
        // 第二次调用 → 已存在，跳过（避免覆盖用户可能手动替换过的文件）
        assert_eq!(link_or_copy(&src, &dst).unwrap(), LinkKind::Exists);
        assert_eq!(std::fs::read(&dst).unwrap(), b"hello");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stop_server_is_safe_when_not_running() {
        // 未运行时停止不应 panic，也不应误杀（PID 恒为 0）
        stop_server();
        assert!(!serving());
        assert_eq!(idle_secs(), None);
    }
}
