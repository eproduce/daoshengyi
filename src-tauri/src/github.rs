//! PR 工作流：把本机 `gh` CLI 封装成内置工具（列 PR / 看 PR / 建 PR / 评论 / 看 diff / 看检查）。
//!
//! ## 安全边界（为什么不让 Agent 直接 `run_command gh ...`）
//!
//! - **动作白名单**：只提供只读动作 + `pr_create` / `pr_comment`；
//!   **不提供** merge / close / reopen —— 这类不可逆的远端操作不该由模型一键做掉。
//! - 参数由纯函数 `gh_argv` 拼装，**没有「用户传任意 gh 子命令」的口子**（连参数数组都不透传）。
//! - 执行走统一命令管线 `run_wrapped_argv`：Seatbelt 沙箱 + 代理注入 + 超时 + `log_tool_call` 审计。
//!
//! ## 前置
//!
//! 需要本机已装 `gh` 并登录（`gh auth login`）。没装/没登录时返回**可照做的**错误提示。

/// 允许的动作（白名单；按字面量匹配）
pub const ACTIONS: &[&str] = &[
    "pr_list",
    "pr_view",
    "pr_create",
    "pr_comment",
    "pr_diff",
    "pr_checks",
    "auth_status",
];

/// 把动作 + 参数拼成 gh 的 argv（纯函数，便于单测）。
///
/// 返回 `Err` 的情形都是「参数不合法」——**不要**把 gh 报错留给运行期才发现。
pub fn gh_argv(
    action: &str,
    number: Option<i64>,
    title: Option<&str>,
    body: Option<&str>,
    base: Option<&str>,
    limit: Option<i64>,
) -> Result<Vec<String>, String> {
    let a = action.trim();
    let num = number.map(|n| n.to_string());
    let lim = limit.unwrap_or(20).clamp(1, 100).to_string();
    let t = title.unwrap_or("").trim().to_string();
    let b = body.unwrap_or("").trim().to_string();
    let base = base.unwrap_or("").trim().to_string();
    match a {
        "pr_list" => Ok(vec![
            "pr".into(),
            "list".into(),
            "--limit".into(),
            lim,
            "--json".into(),
            "number,title,state,isDraft,headRefName,author,updatedAt,url".into(),
        ]),
        "pr_view" => {
            let mut v = vec!["pr".to_string(), "view".to_string()];
            if let Some(n) = &num {
                v.push(n.clone());
            }
            v.push("--json".into());
            v.push(
                "number,title,state,isDraft,author,headRefName,baseRefName,url,mergeable,reviewDecision,body,additions,deletions,changedFiles"
                    .into(),
            );
            Ok(v)
        }
        "pr_diff" => {
            let mut v = vec!["pr".to_string(), "diff".to_string()];
            if let Some(n) = &num {
                v.push(n.clone());
            }
            Ok(v)
        }
        "pr_checks" => {
            let mut v = vec!["pr".to_string(), "checks".to_string()];
            if let Some(n) = &num {
                v.push(n.clone());
            }
            Ok(v)
        }
        "pr_create" => {
            if t.is_empty() {
                return Err("pr_create 需要 title 参数（PR 标题）".to_string());
            }
            if b.is_empty() {
                return Err(
                    "pr_create 需要 body 参数（PR 描述；建议写清改了什么/为什么/怎么验）"
                        .to_string(),
                );
            }
            let mut v = vec![
                "pr".to_string(),
                "create".to_string(),
                "--title".to_string(),
                t,
                "--body".to_string(),
                b,
            ];
            if !base.is_empty() {
                v.push("--base".to_string());
                v.push(base);
            }
            Ok(v)
        }
        "pr_comment" => {
            if b.is_empty() {
                return Err("pr_comment 需要 body 参数（评论内容）".to_string());
            }
            let mut v = vec!["pr".to_string(), "comment".to_string()];
            if let Some(n) = &num {
                v.push(n.clone());
            }
            v.push("--body".to_string());
            v.push(b);
            Ok(v)
        }
        "auth_status" => Ok(vec!["auth".into(), "status".into()]),
        other => Err(format!(
            "未知 action「{}」。可用：{}（**不提供** merge / close 等不可逆操作）",
            other,
            ACTIONS.join(" / ")
        )),
    }
}

/// 权限不足 / 未登录时的可照做提示
pub fn auth_hint(stderr: &str) -> String {
    let s = stderr.to_lowercase();
    if s.contains("not logged") || s.contains("gh auth login") || s.contains("authentication") {
        "尚未登录 GitHub：请在终端执行 `gh auth login`（需 `repo` + `workflow` 权限）".to_string()
    } else if s.contains("command not found") || s.contains("no such file") {
        "未找到 gh CLI：`brew install gh` 后 `gh auth login`".to_string()
    } else {
        String::new()
    }
}

#[derive(Debug, serde::Serialize)]
pub struct GhOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub timed_out: bool,
}

/// 执行一次 gh 操作。`cwd` 用于定位仓库（gh 按当前目录的 remote 推断仓库）
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri 命令的参数就是接口形状，不便打包成结构体
pub async fn gh_operation(
    db: tauri::State<'_, crate::Database>,
    cwd: String,
    action: String,
    number: Option<i64>,
    title: Option<String>,
    body: Option<String>,
    base: Option<String>,
    limit: Option<i64>,
    timeout_secs: Option<u64>,
) -> Result<GhOutput, String> {
    let argv = gh_argv(
        &action,
        number,
        title.as_deref(),
        body.as_deref(),
        base.as_deref(),
        limit,
    )?;
    let cwd = cwd.trim().to_string();
    let out = crate::run_wrapped_argv(
        &db,
        &cwd,
        "gh",
        argv,
        timeout_secs.unwrap_or(60).clamp(10, 180),
        "gh",
    )
    .await?;
    // 没装 gh 时 spawn 会失败（错误信息里带 no such file）→ 这里换成安装提示
    if out.exit_code != 0 {
        let hint = auth_hint(&format!("{} {}", out.stdout, out.stderr));
        if !hint.is_empty() {
            return Err(format!("{}\n（{}）", out.stderr.trim(), hint));
        }
    }
    Ok(GhOutput {
        stdout: out.stdout,
        stderr: out.stderr,
        exit_code: out.exit_code,
        timed_out: out.timed_out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pr_list_limits_and_asks_json_fields() {
        let a = gh_argv("pr_list", None, None, None, None, None).unwrap();
        assert_eq!(a[0], "pr");
        assert_eq!(a[1], "list");
        assert!(a.contains(&"--limit".to_string()));
        let joined = a.join(" ");
        assert!(joined.contains("--json"));
        assert!(joined.contains("headRefName"));
        // limit 越界会被夹到 1..=100
        let big = gh_argv("pr_list", None, None, None, None, Some(9999)).unwrap();
        assert!(big.join(" ").contains("100"));
    }

    #[test]
    fn pr_view_without_number_targets_current_branch() {
        let a = gh_argv("pr_view", None, None, None, None, None).unwrap();
        assert_eq!(a[..2], ["pr".to_string(), "view".to_string()]);
        assert!(a.contains(&"--json".to_string()));
        let b = gh_argv("pr_view", Some(42), None, None, None, None).unwrap();
        assert_eq!(b[2], "42", "带号时把号放在子命令之后");
    }

    #[test]
    fn pr_create_requires_title_and_body() {
        assert!(gh_argv("pr_create", None, None, Some("b"), None, None)
            .unwrap_err()
            .contains("title"));
        assert!(gh_argv("pr_create", None, Some("t"), None, None, None)
            .unwrap_err()
            .contains("body"));
        let a = gh_argv(
            "pr_create",
            None,
            Some("标题"),
            Some("描述"),
            Some("main"),
            None,
        )
        .unwrap();
        assert!(a.contains(&"--base".to_string()));
    }

    #[test]
    fn comment_and_diff_shapes() {
        assert!(gh_argv("pr_comment", None, None, None, None, None).is_err());
        let c = gh_argv("pr_comment", Some(7), None, Some("看这里"), None, None).unwrap();
        assert_eq!(
            c[..3],
            ["pr".to_string(), "comment".to_string(), "7".to_string()]
        );
        let d = gh_argv("pr_diff", Some(7), None, None, None, None).unwrap();
        assert_eq!(d, vec!["pr", "diff", "7"]);
    }

    #[test]
    fn dangerous_or_unknown_actions_are_rejected() {
        for bad in [
            "pr_merge",
            "pr_close",
            "pr_reopen",
            "api",
            "repo delete",
            "",
        ] {
            let e = gh_argv(bad, Some(1), None, Some("x"), None, None).unwrap_err();
            assert!(e.contains("未知 action"), "{} 应被拒绝：{}", bad, e);
        }
    }

    #[test]
    fn auth_errors_get_actionable_hint() {
        assert!(auth_hint("error: not logged into any GitHub hosts").contains("gh auth login"));
        assert!(auth_hint("gh: command not found").contains("brew install gh"));
        assert_eq!(auth_hint("some other failure"), "");
    }
}
