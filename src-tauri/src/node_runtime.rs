//! 自带 Node 运行时：让「生成 HTML 产物」不依赖用户本机装没装 Node。
//!
//! 背景：`answer_html` 的执行链是 `node am.mjs render …`，因此**必须有 Node ≥ 20**。
//! 此前只能靠 `node_candidates()` 去猜 Homebrew / nvm / volta / PATH 的位置，猜到就正常，
//! 猜不到就整条能力不可用 —— 而 Finder 启动的 app 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，
//! 「用户明明装了 Node 却没生效」是这类功能最常见的投诉。
//!
//! 做法与语音模型一致的**两条腿**：
//! 1. 优先用本机已有的 Node（用户自己的运行时，版本更新、零下载）；
//! 2. 都没有时，从 nodejs.org 下载官方 tarball 到 app 数据目录，**校验 SHASUMS256 后**才解出
//!    `bin/node` 使用。装进安装包会让 dmg 多出 50~70 MB 而绝大多数用户用不到，
//!    所以按需下载（一次性，之后离线可用）。
//!
//! 安全取舍：**校验失败一律拒绝安装**（宁可报错也不执行来路不明的二进制）；
//! 只从 `nodejs.org` 取，不做镜像自动切换（镜像的正确性无法自证）。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// 固定的 Node 版本（LTS）。
///
/// 为什么不取「最新」：产物渲染是**幂等优先**的能力，版本漂移会让同一份草稿在不同时间
/// 渲染出不同结果（上游 am.mjs 的排版依赖具体 Node 的小版本行为）。升级时改这里 + 跑
/// `cargo test --lib node_runtime` 与 onex 真机渲染测试即可。
pub const NODE_VERSION: &str = "22.14.0";

/// 解出的 node 所在目录（app 数据目录下，跟着 app 走，卸载即清）
pub fn managed_dir(base: &Path) -> PathBuf {
    base.join("runtime").join(format!("node-v{NODE_VERSION}"))
}

/// 受管 node 可执行文件路径
pub fn managed_bin(base: &Path) -> PathBuf {
    if cfg!(windows) {
        managed_dir(base).join("node.exe")
    } else {
        managed_dir(base).join("bin").join("node")
    }
}

/// 官方 tarball 的平台标记（与 nodejs.org 的命名一致）
pub fn platform_tag(os: &str, arch: &str) -> Option<String> {
    let os = match os {
        "macos" | "darwin" => "darwin",
        "linux" => "linux",
        _ => return None,
    };
    let arch = match arch {
        "aarch64" | "arm64" => "arm64",
        "x86_64" | "x64" => "x64",
        _ => return None,
    };
    Some(format!("{os}-{arch}"))
}

/// 当前平台标记（编译期决定，运行期不必探测）
pub fn current_platform_tag() -> Option<String> {
    platform_tag(std::env::consts::OS, std::env::consts::ARCH)
}

/// 官方 tarball 文件名（`node-v22.14.0-darwin-arm64.tar.gz`）
pub fn archive_name(version: &str, tag: &str) -> String {
    format!("node-v{version}-{tag}.tar.gz")
}

/// 官方下载地址（nodejs.org/dist 是唯一可信来源）
pub fn archive_url(version: &str, tag: &str) -> String {
    format!(
        "https://nodejs.org/dist/v{version}/{}",
        archive_name(version, tag)
    )
}

/// 校验和清单地址（同一目录下的 SHASUMS256.txt）
pub fn shasums_url(version: &str) -> String {
    format!("https://nodejs.org/dist/v{version}/SHASUMS256.txt")
}

/// 从 SHASUMS256.txt 里取出某个文件的 sha256。
///
/// 文件格式是 `"<64 hex>  <filename>"`（两空格）。**必须按文件名精确匹配**：
/// 清单里同时有 darwin-arm64 / darwin-x64 / linux-* / win-* 等几十个包，
/// 取「第一行」就会把别的平台的校验和安到本平台包上（等于没校验）。
pub fn shasum_for(shasums: &str, file_name: &str) -> Option<String> {
    for line in shasums.lines() {
        let mut it = line.split_whitespace();
        let Some(hash) = it.next() else { continue };
        let Some(name) = it.next() else { continue };
        if name == file_name && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(hash.to_ascii_lowercase());
        }
    }
    None
}

/// 对文件算 sha256（小写 hex）
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("打开文件失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读取文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 校验文件与期望 sha256 一致
pub fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let actual = sha256_file(path)?;
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!("校验和不匹配（期望 {expected}，实际 {actual}）"))
    }
}

/// 从 tarball 里只解出 `bin/node`（连同 `lib/` 不必：am.mjs 是单文件 CLI，不用 npm）。
///
/// 只挑需要的那一个成员，而不是整包解压：整包有 ~5000 个文件（含全部 .d.ts 与 npm），
/// 解出来又慢又占地方。
pub fn extract_node_binary(archive: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("打开压缩包失败：{e}"))?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(gz);
    std::fs::create_dir_all(dest_dir).map_err(|e| format!("建目录失败：{e}"))?;
    let bin_dir = dest_dir.join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| format!("建目录失败：{e}"))?;
    let target = bin_dir.join("node");
    let entries = tar.entries().map_err(|e| format!("读取压缩包失败：{e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("读取压缩包条目失败：{e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("条目路径不可读：{e}"))?
            .to_string_lossy()
            .to_string();
        // tarball 顶层是 `node-vX-darwin-arm64/`，取其中的 `bin/node`
        if !path.ends_with("/bin/node") || path.matches('/').count() != 2 {
            continue;
        }
        entry
            .unpack(&target)
            .map_err(|e| format!("解出 node 失败：{e}"))?;
        make_executable(&target)?;
        return Ok(target);
    }
    Err("压缩包里没有 bin/node（下载内容可能不是官方 Node 包）".to_string())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)
        .map_err(|e| format!("读取权限失败：{e}"))?
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).map_err(|e| format!("设置可执行权限失败：{e}"))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

// --- 下载与自举 ---

/// 进度事件名（前端可挂一个轻提示；不挂也不影响功能）
pub const EVENT_PROGRESS: &str = "html-runtime-progress";

/// 下载阶段（供前端与日志共用）
#[derive(Clone, serde::Serialize)]
pub struct RuntimeProgress {
    pub phase: &'static str,
    pub received: u64,
    pub total: u64,
    pub message: String,
}

fn emit(app: Option<&tauri::AppHandle>, phase: &'static str, received: u64, total: u64, msg: &str) {
    if let Some(app) = app {
        use tauri::Emitter;
        let _ = app.emit(
            EVENT_PROGRESS,
            RuntimeProgress {
                phase,
                received,
                total,
                message: msg.to_string(),
            },
        );
    }
}

/// 下载到 `dest`（.part 临时文件 + 完整性下限检查），返回写入字节数
pub async fn download_to(
    client: &reqwest::Client,
    app: Option<&tauri::AppHandle>,
    url: &str,
    dest: &Path,
) -> Result<u64, String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
    }
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载失败（{url}）：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败（{url}）：HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let tmp = dest.with_extension("part");
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("创建文件失败：{e}"))?;
    let mut received: u64 = 0;
    let mut last = std::time::Instant::now();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("读取下载流失败：{e}"))?
    {
        file.write_all(&chunk)
            .map_err(|e| format!("写文件失败：{e}"))?;
        received += chunk.len() as u64;
        if last.elapsed() >= std::time::Duration::from_millis(250) {
            last = std::time::Instant::now();
            emit(app, "downloading", received, total, "正在下载 Node 运行时");
        }
    }
    file.flush().map_err(|e| format!("落盘失败：{e}"))?;
    drop(file);
    // 明显不完整（服务器断流）→ 不进入校验阶段，直接失败
    if total > 0 && received < total / 2 {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("下载不完整：{received} / {total} 字节"));
    }
    std::fs::rename(&tmp, dest).map_err(|e| format!("重命名失败：{e}"))?;
    Ok(received)
}

/// 确保受管 Node 就绪：已存在 → 直接用；否则下载官方 tarball、校验 SHASUMS256、解出 `bin/node`。
///
/// 失败一律返回可读原因（工具层会把原因原样交给模型/用户），**不做静默降级**：
/// 「HTML 产物忽然不可用」比一句明确的报错难排查得多。
pub async fn ensure_managed_node(
    app: Option<&tauri::AppHandle>,
    base: &Path,
) -> Result<PathBuf, String> {
    let bin = managed_bin(base);
    if bin.exists() {
        return Ok(bin);
    }
    let tag = current_platform_tag().ok_or_else(|| {
        format!(
            "当前平台（{} / {}）暂不支持自动安装 Node，请自行安装 Node ≥ 20",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let dir = managed_dir(base);
    let downloads = base.join("runtime").join(".downloads");
    std::fs::create_dir_all(&downloads).map_err(|e| format!("建目录失败：{e}"))?;
    let archive = downloads.join(archive_name(NODE_VERSION, &tag));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|e| format!("创建下载客户端失败：{e}"))?;

    emit(app, "start", 0, 0, "准备下载 Node 运行时");
    download_to(&client, app, &archive_url(NODE_VERSION, &tag), &archive).await?;

    // 校验和清单是**必须**的：拿不到就无法证明这个二进制是官方的，宁可失败
    let shasums_path = downloads.join("SHASUMS256.txt");
    download_to(&client, app, &shasums_url(NODE_VERSION), &shasums_path).await?;
    let shasums =
        std::fs::read_to_string(&shasums_path).map_err(|e| format!("读取校验和清单失败：{e}"))?;
    let expected = shasum_for(&shasums, &archive_name(NODE_VERSION, &tag)).ok_or_else(|| {
        format!(
            "校验和清单里没有 {}，拒绝安装",
            archive_name(NODE_VERSION, &tag)
        )
    })?;

    emit(app, "verifying", 0, 0, "校验 Node 运行时");
    if let Err(e) = verify_sha256(&archive, &expected) {
        let _ = std::fs::remove_file(&archive);
        return Err(format!("Node 运行时安装已中止：{e}"));
    }

    emit(app, "extracting", 0, 0, "解出 node");
    let bin = extract_node_binary(&archive, &dir)?;
    let _ = std::fs::remove_file(&archive);
    let _ = std::fs::remove_file(&shasums_path);
    emit(app, "ready", 0, 0, "Node 运行时已就绪");
    Ok(bin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_tags_match_official_naming() {
        assert_eq!(platform_tag("macos", "aarch64").unwrap(), "darwin-arm64");
        assert_eq!(platform_tag("darwin", "x86_64").unwrap(), "darwin-x64");
        assert_eq!(platform_tag("linux", "arm64").unwrap(), "linux-arm64");
        assert!(platform_tag("windows", "x86_64").is_none());
        assert!(platform_tag("macos", "riscv64").is_none());
    }

    #[test]
    fn urls_point_at_the_pinned_official_dist() {
        let tag = "darwin-arm64";
        assert_eq!(
            archive_name("22.14.0", tag),
            "node-v22.14.0-darwin-arm64.tar.gz"
        );
        assert_eq!(
            archive_url("22.14.0", tag),
            "https://nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-arm64.tar.gz"
        );
        assert_eq!(
            shasums_url("22.14.0"),
            "https://nodejs.org/dist/v22.14.0/SHASUMS256.txt"
        );
    }

    #[test]
    fn shasum_lookup_matches_the_exact_file_not_the_first_line() {
        // 真实 SHASUMS256.txt 的形态：几十行、两空格分隔、大小写皆有
        let shasums = "\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v22.14.0-darwin-arm64.tar.gz
BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB  node-v22.14.0-darwin-x64.tar.gz
cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc  node-v22.14.0-linux-x64.tar.xz
";
        assert_eq!(
            shasum_for(shasums, "node-v22.14.0-darwin-x64.tar.gz").unwrap(),
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        );
        assert!(shasum_for(shasums, "node-v22.14.0-win-x64.zip").is_none());
        // 名字相似但不能被前缀匹配骗到
        assert!(shasum_for(shasums, "node-v22.14.0-darwin-arm64.tar").is_none());
    }

    #[test]
    fn sha256_verify_rejects_mismatch_and_accepts_match() {
        let dir = std::env::temp_dir().join(format!("dsy-node-sha-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("blob.bin");
        std::fs::write(&f, b"hello").unwrap();
        // sha256("hello")
        let expect = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert!(verify_sha256(&f, expect).is_ok());
        assert!(verify_sha256(&f, &"0".repeat(64)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **真机自举（默认忽略）**：真下载官方 tarball → 校验 → 解出 node → 能跑 `--version`。
    ///
    /// 这条测试是「用户没装 Node 也能用」的唯一硬证据（约 48 MB 下载，所以默认忽略；
    /// 发版前手动跑一次：`cargo test --lib node_runtime -- --ignored --nocapture`）。
    #[tokio::test]
    #[ignore]
    async fn live_download_verifies_and_runs_node() {
        let base = std::env::temp_dir().join(format!("dsy-node-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let bin = ensure_managed_node(None, &base)
            .await
            .expect("自举应成功（需要网络）");
        assert!(bin.exists(), "应解出 node：{}", bin.display());
        let out = tokio::process::Command::new(&bin)
            .arg("--version")
            .output()
            .await
            .expect("node 应能执行");
        assert!(out.status.success(), "node --version 应成功");
        let v = String::from_utf8_lossy(&out.stdout);
        assert!(v.trim().starts_with('v'), "应输出版本号，实际：{v}");
        eprintln!("[node-live] {} → {}", bin.display(), v.trim());
        // 第二次调用必须直接命中缓存（不重复下载）
        let again = ensure_managed_node(None, &base).await.unwrap();
        assert_eq!(again, bin);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn managed_paths_are_scoped_by_node_version() {
        let base = Path::new("/tmp/appdata");
        assert_eq!(
            managed_dir(base),
            PathBuf::from(format!("/tmp/appdata/runtime/node-v{NODE_VERSION}"))
        );
        let bin = managed_bin(base);
        assert!(bin.starts_with(managed_dir(base)));
        assert!(bin.ends_with("node") || bin.ends_with("node.exe"));
    }
}
