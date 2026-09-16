//! 命令沙箱（吸收自 Codex 的 `SandboxMode`：`read-only` / `workspace-write` / `danger-full-access`）。
//!
//! macOS 用系统自带的 **Seatbelt**（`/usr/bin/sandbox-exec`）实现：
//! - `read-only`：禁止一切文件写入（/tmp、/dev 除外）——适合「只读调研/分析」；
//! - `workspace-write`：只允许写入**工作区目录**（+ /tmp、/dev、用户缓存）——日常首选；
//! - `off` / `danger-full-access`：不加沙箱（保持原行为，默认）。
//!
//! 注意：`sandbox-exec` 在 macOS 15+ 已被标记弃用但仍可用；**找不到可执行文件时自动降级为
//! 不加沙箱**（绝不因为沙箱不可用而让命令失败）。网络不做限制（本应用的工具需要联网）。
//!
//! 纯函数 + 显式注入「沙箱是否可用」，便于单测与行为可预测。

pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// 系统是否提供 sandbox-exec（macOS 才有；其他平台一律 false）
pub fn sandbox_available() -> bool {
    cfg!(target_os = "macos") && std::path::Path::new(SANDBOX_EXEC).exists()
}

/// 写入路径安全性：Seatbelt profile 里路径用双引号包裹，故拒绝含引号/换行/反斜杠的路径
fn safe_path(p: &str) -> Option<String> {
    let t = p.trim();
    if t.is_empty() || t.contains('"') || t.contains('\n') || t.contains('\\') {
        return None;
    }
    Some(t.trim_end_matches('/').to_string())
}

/// 生成 Seatbelt profile；返回 None = 不加沙箱（off / 未知模式 / workspace-write 缺工作区）
pub fn profile_for(mode: &str, workspace: Option<&str>, home: &str) -> Option<String> {
    // /tmp、/dev 与用户缓存始终可写：否则大量常规命令（写临时文件、写日志）会直接失败
    let allow_common = "(subpath \"/private/tmp\") (subpath \"/private/var/tmp\") \
                        (subpath \"/dev/fd\") (literal \"/dev/null\") \
                        (literal \"/dev/stdout\") (literal \"/dev/stderr\")"
        .to_string();
    match mode.trim().to_ascii_lowercase().as_str() {
        "read-only" => Some(format!(
            "(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* {allow_common})\n"
        )),
        "workspace-write" => {
            let ws = safe_path(workspace.unwrap_or(""))?;
            let cache = safe_path(home)
                .map(|h| format!(" (subpath \"{h}/Library/Caches\")"))
                .unwrap_or_default();
            Some(format!(
                "(version 1)\n(allow default)\n(deny file-write*)\n\
                 (allow file-write* (subpath \"{ws}\") {allow_common}{cache})\n"
            ))
        }
        // off / danger-full-access / 未知值 → 不加沙箱
        _ => None,
    }
}

/// 构造实际执行的 (program, args)。`available` 显式传入以便单测（真实调用用 sandbox_available()）。
pub fn build_exec_impl(
    mode: &str,
    workspace: Option<&str>,
    home: &str,
    command: &str,
    available: bool,
) -> (String, Vec<String>) {
    match profile_for(mode, workspace, home) {
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
pub fn build_exec(
    mode: &str,
    workspace: Option<&str>,
    home: &str,
    command: &str,
) -> (String, Vec<String>, bool) {
    let available = sandbox_available();
    let (prog, args) = build_exec_impl(mode, workspace, home, command, available);
    let applied = prog == SANDBOX_EXEC;
    (prog, args, applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_denies_all_writes() {
        let p = profile_for("read-only", None, "/Users/tester").unwrap();
        assert!(p.contains("(deny file-write*)"));
        assert!(p.contains("/private/tmp"));
        assert!(!p.contains("/Users/tester"));
    }

    #[test]
    fn workspace_write_allows_only_workspace_and_tmp() {
        let p = profile_for("workspace-write", Some("/Users/tester/proj"), "/Users/tester").unwrap();
        assert!(p.contains("(subpath \"/Users/tester/proj\")"));
        assert!(p.contains("/private/tmp"));
        assert!(p.contains("/Library/Caches"));
        assert!(p.contains("(deny file-write*)"));
    }

    #[test]
    fn workspace_write_without_workspace_is_noop() {
        assert!(profile_for("workspace-write", None, "/Users/tester").is_none());
        assert!(profile_for("workspace-write", Some("   "), "/Users/tester").is_none());
    }

    #[test]
    fn off_and_unknown_modes_are_noop() {
        assert!(profile_for("off", Some("/tmp/x"), "/Users/tester").is_none());
        assert!(profile_for("danger-full-access", Some("/tmp/x"), "/Users/tester").is_none());
        assert!(profile_for("", Some("/tmp/x"), "/Users/tester").is_none());
        assert!(profile_for("whatever", Some("/tmp/x"), "/Users/tester").is_none());
    }

    #[test]
    fn unsafe_workspace_path_refuses_sandbox() {
        // 含引号/换行的路径会破坏 profile 语法 → 宁可不加沙箱，也不生成畸形 profile
        assert!(profile_for("workspace-write", Some("/tmp/a\"b"), "/Users/t").is_none());
        assert!(profile_for("workspace-write", Some("/tmp/a\nb"), "/Users/t").is_none());
    }

    #[test]
    fn build_exec_wraps_only_when_available() {
        let (prog, args) = build_exec_impl("read-only", None, "/Users/t", "ls", true);
        assert_eq!(prog, SANDBOX_EXEC);
        assert_eq!(args[0], "-p");
        assert_eq!(args[2], "/bin/sh");
        assert_eq!(args[4], "ls");

        // 沙箱不可用（或模式为 off）→ 退回裸 /bin/sh，命令照常执行
        let (prog2, args2) = build_exec_impl("read-only", None, "/Users/t", "ls", false);
        assert_eq!(prog2, "/bin/sh");
        assert_eq!(args2, vec!["-c".to_string(), "ls".to_string()]);

        let (prog3, _) = build_exec_impl("off", None, "/Users/t", "ls", true);
        assert_eq!(prog3, "/bin/sh");
    }

    #[test]
    fn build_exec_reports_applied_flag() {
        let (prog, _args, applied) = build_exec("read-only", None, "", "echo hi");
        if sandbox_available() {
            assert_eq!(prog, SANDBOX_EXEC);
            assert!(applied);
        } else {
            assert!(!applied, "非 macOS 或缺少 sandbox-exec 时必须降级");
        }
    }
}
