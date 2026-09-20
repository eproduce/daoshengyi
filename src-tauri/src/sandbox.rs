//! 命令沙箱（吸收自 Codex 的 `SandboxMode`：`read-only` / `workspace-write` / `danger-full-access`）。
//!
//! macOS 用系统自带的 **Seatbelt**（`/usr/bin/sandbox-exec`）实现：
//! - `read-only`：禁止一切文件写入（/tmp、/dev 除外）——适合「只读调研/分析」；
//! - `workspace-write`：只允许写入**工作区目录**（+ /tmp、/dev、用户缓存）——日常首选；
//! - `off` / `danger-full-access`：不加沙箱（保持原行为，默认）。
//!
//! 网络策略三态（默认 `allow`，即完全不限）：
//! - `allow`：不限（默认）——本应用的工具本身需要联网；
//! - `loopback-only`：**断开外网、放行本机**（`(deny network*)` + 放行 localhost）——
//!   既能防「注入后把数据外发」，又保留「调本机 dev server / 本机 API」这类常见用法；
//! - `deny`：全断（**本机回环也断**，本机服务、unix socket、ssh-agent 一并不可用）。
//!
//! 注意：`sandbox-exec` 在 macOS 15+ 已被标记弃用但仍可用；**找不到可执行文件时自动降级为
//! 不加沙箱**（绝不因为沙箱不可用而让命令失败）。
//!
//! 纯函数 + 显式注入「沙箱是否可用」，便于单测与行为可预测。
//!
//! 真机行为（2026-09-20 实测，macOS 26.7）：
//! - `read-only` 下写 `/tmp` 成功、写 `$HOME` 被拒（`Operation not permitted`，文件未落地）；
//! - `workspace-write` 下写工作区内成功、写 `$HOME` 被拒；
//! - 沙箱内 `node -v` / `git --version` / `python3 -V` 等常用命令均正常；
//! - 网络：`allow` → 外网 200；`loopback-only` → 本机 200 / 外网被拒；`deny` → 两者均被拒。
//! - ⚠️ SBPL 的网络过滤器只认 `(remote ip "localhost:*")`；写成 `127.0.0.1:*` 会让
//!   **整个 profile 解析失败**（沙箱直接不生效）——这种静默失效最危险，已用单测钉住。

pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// 系统是否提供 sandbox-exec（macOS 才有；其他平台一律 false）
pub fn sandbox_available() -> bool {
    cfg!(target_os = "macos") && std::path::Path::new(SANDBOX_EXEC).exists()
}

/// 网络策略（见模块头说明）。默认 `Allow`：保持历史行为不变。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NetworkPolicy {
    #[default]
    Allow,
    LoopbackOnly,
    Deny,
}

impl NetworkPolicy {
    /// 从设置字符串解析；无法识别的值一律按 `Allow`（**不因为写错值而悄悄放宽限制之外的意外行为**）
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "loopback-only" | "loopback" | "local-only" => Self::LoopbackOnly,
            "deny" | "none" | "block" => Self::Deny,
            _ => Self::Allow,
        }
    }

    /// 追加到 profile 末尾的规则（必须排在 `(allow default)` 之后：Seatbelt 后匹配者胜）
    fn rules(self) -> &'static str {
        match self {
            Self::Allow => "",
            // ⚠️ 只能是 "localhost:*"：写成 "127.0.0.1:*" 会让整个 profile 解析失败（实测）
            Self::LoopbackOnly => {
                "(deny network*)\n(allow network-outbound (remote ip \"localhost:*\"))\n"
            }
            Self::Deny => "(deny network*)\n",
        }
    }
}

/// 沙箱配置（由设置 + 调用参数派生）。纯数据，便于单测与跨调用传递。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxConfig {
    /// `off` | `read-only` | `workspace-write`（其余值一律视为 off）
    pub mode: String,
    /// `workspace-write` 的可写根目录
    pub workspace: Option<String>,
    /// 用户主目录（用于放行 `~/Library/Caches`）
    pub home: String,
    pub network: NetworkPolicy,
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            mode: "off".to_string(),
            workspace: None,
            home: String::new(),
            network: NetworkPolicy::Allow,
        }
    }
}

impl SandboxConfig {
    pub fn new(mode: &str, workspace: Option<&str>, home: &str, network: NetworkPolicy) -> Self {
        Self {
            mode: mode.to_string(),
            workspace: workspace.map(|w| w.to_string()),
            home: home.to_string(),
            network,
        }
    }
}

/// 归一化一个要写进 profile 的路径，返回 1~2 条候选（原值 + 解析符号链接后的真实路径）。
///
/// - 拒绝含引号/换行/反斜杠的路径（会破坏 profile 语法）→ 返回空；
/// - **必须解析符号链接**：Seatbelt 匹配的是**真实路径**，而 macOS 上 `/var`→`/private/var`、
///   `/tmp`→`/private/tmp`、`$TMPDIR`=`/var/folders/...`。不解析就会出现
///   「**工作区内写入也被拒**」——真机实测（把 `$TMPDIR` 当工作区时必现），
///   而单测只断言 profile 文本，根本发现不了。
/// - 路径不存在时 canonicalize 失败 → 保留原值（用户可能还没建这个目录）。
fn safe_paths(p: &str) -> Vec<String> {
    let t = p.trim();
    if t.is_empty() || t.contains('"') || t.contains('\n') || t.contains('\\') {
        return Vec::new();
    }
    let raw = t.trim_end_matches('/').to_string();
    if raw.is_empty() {
        return Vec::new();
    }
    let mut out = vec![raw.clone()];
    if let Ok(real) = std::fs::canonicalize(&raw) {
        if let Some(s) = real.to_str() {
            let s = s.trim_end_matches('/').to_string();
            if !s.is_empty() && s != raw {
                out.push(s);
            }
        }
    }
    out
}

/// 生成 Seatbelt profile；返回 None = 不加沙箱（off / 未知模式 / workspace-write 缺工作区）
pub fn profile_for(cfg: &SandboxConfig) -> Option<String> {
    // 始终可写的最小集合：临时区 + /dev 的几个字面量。
    //
    // ⚠️ `/private/var/folders` 不能漏：macOS 的 `$TMPDIR` 就指向那里（**不是** `/tmp`），
    // 而 cargo / npm / node / 各种编译器都会往里写临时文件。漏掉它会让沙箱"严到不可用"
    // ——实测 `echo hi > $TMPDIR/x` 被拒。
    const ALLOW_COMMON: &str = "(subpath \"/private/tmp\") (subpath \"/private/var/tmp\") (subpath \"/private/var/folders\") (subpath \"/dev/fd\") (literal \"/dev/null\") (literal \"/dev/stdout\") (literal \"/dev/stderr\")";
    let net = cfg.network.rules();
    match cfg.mode.trim().to_ascii_lowercase().as_str() {
        "read-only" => Some(format!(
            "(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* {ALLOW_COMMON})\n{net}"
        )),
        "workspace-write" => {
            let ws = safe_paths(cfg.workspace.as_deref().unwrap_or(""));
            if ws.is_empty() {
                return None;
            }
            let ws_rules: String = ws.iter().map(|p| format!("(subpath \"{p}\") ")).collect();
            let cache: String = safe_paths(&cfg.home)
                .first()
                .map(|h| format!(" (subpath \"{h}/Library/Caches\")"))
                .unwrap_or_default();
            Some(format!(
                "(version 1)\n(allow default)\n(deny file-write*)\n\
                 (allow file-write* {ws_rules}{ALLOW_COMMON}{cache})\n{net}"
            ))
        }
        // off / danger-full-access / 未知值 → 不加沙箱
        _ => None,
    }
}

/// 构造 shell 形态的实际执行 (program, args)。`available` 显式传入以便单测（真实调用用 sandbox_available()）。
pub fn build_exec_impl(
    cfg: &SandboxConfig,
    command: &str,
    available: bool,
) -> (String, Vec<String>) {
    match profile_for(cfg) {
        Some(p) if available => (
            SANDBOX_EXEC.to_string(),
            vec![
                "-p".to_string(),
                p,
                "/bin/sh".to_string(),
                "-c".to_string(),
                command.to_string(),
            ],
        ),
        _ => (
            "/bin/sh".to_string(),
            vec!["-c".to_string(), command.to_string()],
        ),
    }
}

/// 便捷封装：按当前系统可用性决定是否加沙箱；同时返回是否真的加了沙箱（供日志/提示）
pub fn build_exec(cfg: &SandboxConfig, command: &str) -> (String, Vec<String>, bool) {
    let available = sandbox_available();
    let (prog, args) = build_exec_impl(cfg, command, available);
    let applied = prog == SANDBOX_EXEC;
    (prog, args, applied)
}

/// **argv 形态**的命令（`git`、测试命令等不经 shell 的调用）同样要能被沙箱覆盖。
/// 返回 None = 不加沙箱（off / 未知模式 / 缺工作区 / sandbox-exec 不可用）→ 调用方照常直跑。
///
/// 为什么需要它：`git_operation` / `run_tests` 原来是直接 `Command::new("git")` 起进程的，
/// **完全绕过了沙箱**——实测在 `read-only`（禁一切写入）下，仍可通过 `run_tests` 的自定义
/// 命令参数往任意路径写文件，也可用 `git clone` 写到任意目录。这个函数就是用来堵这个口的。
pub fn wrap_argv(
    cfg: &SandboxConfig,
    prog: &str,
    args: &[String],
    available: bool,
) -> Option<(String, Vec<String>)> {
    let profile = profile_for(cfg)?;
    if !available {
        return None;
    }
    let mut out = Vec::with_capacity(args.len() + 3);
    out.push("-p".to_string());
    out.push(profile);
    out.push(prog.to_string());
    out.extend(args.iter().cloned());
    Some((SANDBOX_EXEC.to_string(), out))
}

/// `wrap_argv` 的便捷版：按当前系统可用性决定
pub fn wrap_argv_auto(
    cfg: &SandboxConfig,
    prog: &str,
    args: &[String],
) -> Option<(String, Vec<String>)> {
    wrap_argv(cfg, prog, args, sandbox_available())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ro() -> SandboxConfig {
        SandboxConfig::new("read-only", None, "/Users/tester", NetworkPolicy::Allow)
    }
    fn ww(ws: &str) -> SandboxConfig {
        SandboxConfig::new(
            "workspace-write",
            Some(ws),
            "/Users/tester",
            NetworkPolicy::Allow,
        )
    }

    #[test]
    fn read_only_denies_all_writes() {
        let p = profile_for(&ro()).unwrap();
        assert!(p.contains("(deny file-write*)"));
        assert!(p.contains("/private/tmp"));
        assert!(!p.contains("/Users/tester"));
    }

    #[test]
    fn workspace_write_allows_only_workspace_and_tmp() {
        let p = profile_for(&ww("/Users/tester/proj")).unwrap();
        assert!(p.contains("(subpath \"/Users/tester/proj\")"));
        assert!(p.contains("/private/tmp"));
        assert!(p.contains("/Library/Caches"));
        assert!(p.contains("(deny file-write*)"));
    }

    #[test]
    fn every_mode_allows_the_real_system_temp_dir() {
        // macOS 的 $TMPDIR 是 /private/var/folders/...（**不是** /tmp）：
        // cargo/npm/node 都往里写临时文件，漏放行会让沙箱"严到不可用"（真机实测踩过）
        for cfg in [ro(), ww("/Users/tester/proj")] {
            let p = profile_for(&cfg).unwrap();
            assert!(
                p.contains("(subpath \"/private/var/folders\")"),
                "mode={} 的 profile 必须放行系统临时区",
                cfg.mode
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_path_is_recorded_in_resolved_form_too() {
        // /var → /private/var 这类符号链接：Seatbelt 按真实路径匹配，
        // 不带上解析后的形式就会出现「工作区内写入也被拒」
        let base = std::env::temp_dir().join(format!("dsy-sbx-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let link = base.join("link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&base, &link).unwrap();

        let paths = safe_paths(link.to_str().unwrap());
        assert_eq!(paths.len(), 2, "原值与解析值都应记录：{paths:?}");
        assert!(paths.iter().any(|p| p.ends_with("/link")));
        let real = std::fs::canonicalize(&base).unwrap();
        assert!(paths.iter().any(|p| p == real.to_str().unwrap()));

        // 不存在的路径：canonicalize 失败 → 保留原值，而不是整段丢弃
        let missing = base.join("not-created-yet");
        let got = safe_paths(missing.to_str().unwrap());
        assert_eq!(got.len(), 1);

        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn unsafe_path_returns_empty() {
        assert!(safe_paths("").is_empty());
        assert!(safe_paths("   ").is_empty());
        assert!(safe_paths("/tmp/a\"b").is_empty());
        assert!(safe_paths("/tmp/a\nb").is_empty());
        assert!(safe_paths("/tmp/a\\b").is_empty());
    }

    #[test]
    fn workspace_write_without_workspace_is_noop() {
        assert!(profile_for(&ww("   ")).is_none());
        let none_ws = SandboxConfig::new(
            "workspace-write",
            None,
            "/Users/tester",
            NetworkPolicy::Allow,
        );
        assert!(profile_for(&none_ws).is_none());
    }

    #[test]
    fn off_and_unknown_modes_are_noop() {
        for mode in ["off", "danger-full-access", "", "whatever"] {
            let cfg = SandboxConfig::new(mode, Some("/tmp/x"), "/Users/t", NetworkPolicy::Deny);
            assert!(profile_for(&cfg).is_none(), "mode={mode} 不应产生沙箱");
        }
    }

    #[test]
    fn unsafe_workspace_path_refuses_sandbox() {
        // 含引号/换行的路径会破坏 profile 语法 → 宁可不加沙箱，也不生成畸形 profile
        assert!(profile_for(&ww("/tmp/a\"b")).is_none());
        assert!(profile_for(&ww("/tmp/a\nb")).is_none());
    }

    // ---- 网络策略 ----

    #[test]
    fn network_policy_parse_falls_back_to_allow() {
        assert_eq!(
            NetworkPolicy::parse("loopback-only"),
            NetworkPolicy::LoopbackOnly
        );
        assert_eq!(
            NetworkPolicy::parse("  Local-Only "),
            NetworkPolicy::LoopbackOnly
        );
        assert_eq!(NetworkPolicy::parse("deny"), NetworkPolicy::Deny);
        assert_eq!(NetworkPolicy::parse("block"), NetworkPolicy::Deny);
        assert_eq!(NetworkPolicy::parse("allow"), NetworkPolicy::Allow);
        // 写错的值 → 回到默认 Allow（而不是变成"看起来收了、其实是别的东西"的意外行为）
        assert_eq!(NetworkPolicy::parse("loobpack"), NetworkPolicy::Allow);
        assert_eq!(NetworkPolicy::parse(""), NetworkPolicy::Allow);
    }

    #[test]
    fn network_allow_emits_no_rules() {
        assert_eq!(NetworkPolicy::Allow.rules(), "");
    }

    #[test]
    fn network_deny_blocks_everything_including_loopback() {
        assert_eq!(NetworkPolicy::Deny.rules(), "(deny network*)\n");
    }

    #[test]
    fn network_loopback_only_uses_the_only_filter_syntax_that_parses() {
        // 真机实测：`(remote ip "127.0.0.1:*")` 会让**整个 profile 解析失败**（沙箱静默不生效），
        // 只有 `localhost:*` 可用。这条断言就是防止有人"顺手改成 IP 显得更精确"。
        let rules = NetworkPolicy::LoopbackOnly.rules();
        assert!(rules.contains("(deny network*)"));
        assert!(rules.contains("(remote ip \"localhost:*\")"));
        assert!(
            !rules.contains("127.0.0.1"),
            "用 IP 字面量会让 profile 解析失败"
        );
    }

    #[test]
    fn network_rules_come_after_allow_default() {
        // Seatbelt 是「后匹配者胜」：网络 deny 必须排在 (allow default) 之后才生效
        let cfg = SandboxConfig::new("read-only", None, "/Users/t", NetworkPolicy::Deny);
        let p = profile_for(&cfg).unwrap();
        assert!(p.find("(deny network*)").unwrap() > p.find("(allow default)").unwrap());
    }

    #[test]
    fn build_exec_wraps_only_when_available() {
        let (prog, args) = build_exec_impl(&ro(), "ls", true);
        assert_eq!(prog, SANDBOX_EXEC);
        assert_eq!(args[0], "-p");
        assert_eq!(args[2], "/bin/sh");
        assert_eq!(args[4], "ls");

        // 沙箱不可用（或模式为 off）→ 退回裸 /bin/sh，命令照常执行
        let (prog2, args2) = build_exec_impl(&ro(), "ls", false);
        assert_eq!(prog2, "/bin/sh");
        assert_eq!(args2, vec!["-c".to_string(), "ls".to_string()]);

        let off = SandboxConfig::new("off", None, "/Users/t", NetworkPolicy::Deny);
        assert_eq!(build_exec_impl(&off, "ls", true).0, "/bin/sh");
    }

    #[test]
    fn build_exec_reports_applied_flag() {
        let (_prog, _args, applied) = build_exec(&ro(), "echo hi");
        if sandbox_available() {
            assert!(applied);
        } else {
            assert!(!applied, "非 macOS 或缺少 sandbox-exec 时必须降级");
        }
    }

    // ---- argv 形态（git / 测试命令）----

    #[test]
    fn wrap_argv_keeps_program_and_args_intact() {
        // git / 测试命令是 argv 形态，绝不能被拼成 shell 字符串
        //（否则参数里带空格时语义就漂了，正是这类"看起来等价"的改动会开出口子）
        let args = vec!["add".to_string(), "a b.txt".to_string()];
        let (prog, full) = wrap_argv(&ww("/tmp/ws"), "git", &args, true).unwrap();
        assert_eq!(prog, SANDBOX_EXEC);
        assert_eq!(full[0], "-p");
        assert_eq!(full[2], "git");
        assert_eq!(&full[3..], &["add".to_string(), "a b.txt".to_string()]);
    }

    #[test]
    fn wrap_argv_returns_none_when_sandbox_should_not_apply() {
        // 模式 off → None（调用方直跑）
        let off = SandboxConfig::new("off", Some("/tmp/ws"), "/Users/t", NetworkPolicy::Deny);
        assert!(wrap_argv(&off, "git", &[], true).is_none());
        // workspace-write 但没配工作区 → None
        let no_ws = SandboxConfig::new("workspace-write", None, "/Users/t", NetworkPolicy::Deny);
        assert!(wrap_argv(&no_ws, "git", &[], true).is_none());
        // sandbox-exec 不可用 → None
        assert!(wrap_argv(&ww("/tmp/ws"), "git", &[], false).is_none());
        // read-only 不需要工作区 → 可用（cargo test 这类只读命令也能被覆盖）
        assert!(wrap_argv(&ro(), "cargo", &["test".to_string()], true).is_some());
    }

    #[test]
    fn wrap_argv_carries_network_policy_too() {
        let cfg = SandboxConfig::new("read-only", None, "/Users/t", NetworkPolicy::Deny);
        let (_prog, full) = wrap_argv(&cfg, "curl", &[], true).unwrap();
        assert!(
            full[1].contains("(deny network*)"),
            "argv 路径也要带上网络策略"
        );
    }

    // ---- 真机 e2e（默认 ignored；改沙箱逻辑后必须手动跑一次）----
    //   cargo test --lib sandbox:: -- --ignored --nocapture
    //
    // 为什么必须有这层：单测只断言 profile **文本**，而"profile 文本正确"并不等于
    // "沙箱真的拦住了"——SBPL 语法写错时 sandbox-exec 会直接失败、沙箱静默不生效。
    // 2026-09-20 加这层之前，这批 profile 从未被真机验证过。

    fn run_sandboxed(cfg: &SandboxConfig, script: &str) -> std::process::Output {
        let (prog, args) = build_exec_impl(cfg, script, true);
        std::process::Command::new(prog)
            .args(args)
            .output()
            .expect("启动 sandbox-exec 失败")
    }

    #[test]
    #[ignore = "真机 e2e：需要 /usr/bin/sandbox-exec（macOS）"]
    fn real_sandbox_actually_blocks_writes_outside_workspace() {
        if !sandbox_available() {
            eprintln!("跳过：本机没有 {}（仅 macOS 有）", SANDBOX_EXEC);
            return;
        }
        let ws = std::env::temp_dir().join(format!("dsy-sbx-e2e-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&ws);
        let inside = ws.join("inside.txt");
        let home = std::env::var("HOME").unwrap_or_default();
        let outside = std::path::Path::new(&home)
            .join(format!("___dsy_sbx_probe_{}.txt", std::process::id()));
        let _ = std::fs::remove_file(&outside);

        let cfg = SandboxConfig::new(
            "workspace-write",
            Some(ws.to_str().unwrap()),
            &home,
            NetworkPolicy::Allow,
        );
        // 工作区内写入 → 应成功
        let ok = run_sandboxed(&cfg, &format!("echo hi > {}", inside.display()));
        assert!(
            inside.exists(),
            "工作区内写入应成功，stderr={}",
            String::from_utf8_lossy(&ok.stderr)
        );
        // 家目录写入 → 必须被拒，且文件不落地
        let denied = run_sandboxed(&cfg, &format!("echo nope > {}", outside.display()));
        assert!(!denied.status.success(), "沙箱没有拦住区外写入！");
        assert!(!outside.exists(), "被拒的写入仍留下了文件：{:?}", outside);
        assert!(
            String::from_utf8_lossy(&denied.stderr).contains("not permitted"),
            "错误信息应表明是被权限拒绝，实际={}",
            String::from_utf8_lossy(&denied.stderr)
        );

        let _ = std::fs::remove_file(&inside);
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    #[ignore = "真机 e2e：需要 /usr/bin/sandbox-exec（macOS）+ python3"]
    fn real_sandbox_network_matrix_on_loopback() {
        // 刻意**只用本机监听**验证：早先版本这里连的是 https://example.com，结果因为
        // 实时网络波动而误报（连不加沙箱的裸 curl 都失败了）——把外部依赖引进来的测试
        // 只会制造假失败，而真正要钉住的是「三态策略对连接的处理是否如文档所述」。
        if !sandbox_available() {
            eprintln!("跳过：本机没有 {}", SANDBOX_EXEC);
            return;
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定本机端口失败");
        let port = listener.local_addr().expect("取端口失败").port();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(16) {
                drop(stream);
            }
        });
        let home = std::env::var("HOME").unwrap_or_default();
        // 拼字符串时避开引号嵌套问题：直接写 python 一行式
        let probe = format!(
            "python3 -c \"import socket;socket.create_connection(('127.0.0.1',{port}),2)\""
        );
        for (policy, expect_ok, msg) in [
            (NetworkPolicy::Allow, true, "allow 应放行本机连接"),
            (
                NetworkPolicy::LoopbackOnly,
                true,
                "loopback-only 应放行本机连接（这正是它与 deny 的区别）",
            ),
            (
                NetworkPolicy::Deny,
                false,
                "deny 应阻断本机回环（unix socket / ssh-agent 也会一并不可用）",
            ),
        ] {
            let cfg = SandboxConfig::new("read-only", None, &home, policy);
            let out = run_sandboxed(&cfg, &probe);
            assert_eq!(
                out.status.success(),
                expect_ok,
                "{}（stderr={}）",
                msg,
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }

    #[test]
    #[ignore = "真机 e2e：需要 /usr/bin/sandbox-exec（macOS）"]
    fn real_sandbox_blocks_argv_style_commands_too() {
        // 回归点：git_operation / run_tests 原本是直接 `Command::new(...)` 起进程的，
        // **完全绕过沙箱**——`read-only` 下仍可借 `run_tests(command: "touch /Users/xx/y")`
        // 往区外写文件。这条测试盯的就是「argv 形态的命令也必须被沙箱覆盖」。
        if !sandbox_available() {
            eprintln!("跳过：本机没有 {}", SANDBOX_EXEC);
            return;
        }
        let home = std::env::var("HOME").unwrap_or_default();
        let victim = std::path::Path::new(&home)
            .join(format!("___dsy_sbx_argv_probe_{}.txt", std::process::id()));
        let _ = std::fs::remove_file(&victim);
        let args = vec![victim.display().to_string()];

        // ① 对照：不加沙箱（mode=off）应写入成功——证明命令本身没问题，测试不是空转
        let off = SandboxConfig::new("off", None, &home, NetworkPolicy::Allow);
        let plain = match wrap_argv(&off, "touch", &args, true) {
            Some((p, a)) => std::process::Command::new(p).args(a).output(),
            None => std::process::Command::new("touch").args(&args).output(),
        }
        .expect("运行 touch 失败");
        assert!(plain.status.success(), "对照组本身就失败了，测试无意义");
        assert!(victim.exists(), "对照组应写入成功");
        let _ = std::fs::remove_file(&victim);

        // ② read-only 沙箱 → 必须被拒，且文件不落地
        let guarded = SandboxConfig::new("read-only", None, &home, NetworkPolicy::Allow);
        let (prog, full) = wrap_argv(&guarded, "touch", &args, true).expect("read-only 应加沙箱");
        let out = std::process::Command::new(prog)
            .args(full)
            .output()
            .expect("运行失败");
        assert!(!out.status.success(), "argv 形态命令被沙箱漏放了！");
        assert!(!victim.exists(), "被拒的命令仍留下了文件：{:?}", victim);
    }
}
