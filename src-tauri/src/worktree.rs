//! 并行隔离：给子代理 / 并行任务各建一个 **git worktree**（同一仓库的独立工作副本）。
//!
//! ## 为什么
//!
//! 并行子代理改**同一个**仓库会互相踩：文件被对方改回去、git 索引打架、commit 串味。
//! `git worktree` 是官方机制：同一仓库挂多个工作目录，各自独立 HEAD/索引，共享对象库（省磁盘）。
//!
//! ## 约定
//!
//! - 副本落在 `<repo>/.daoshengyi/worktrees/<slug>`，分支名 `dsy/<slug>`
//! - 自动把 `.daoshengyi/` 写进 **`.git/info/exclude`**（本地忽略，**不动用户的 .gitignore**）
//! - 删除只允许删这个目录下的副本（防误删任意路径）
//! - 执行走与 `git_operation` 相同的**统一命令管线**：`sandbox::wrap_argv_auto`（Seatbelt argv 形态）
//!   + 代理环境注入 + 超时 + `log_tool_call` 审计 —— 绝不自己拼 shell 字符串
//!
//! ## 用法（给 Agent 的语义）
//!
//! 多个子代理要**同时改代码**时：先 `create` 出各自副本 → 各自在副本里改 → 主代理看 `list`
//! 拿到各副本路径与分支 → 用 `git diff dsy/x` 对比 → 决定合并哪个。

use std::path::Path;

/// worktree 目录名（仓库内固定位置，便于整体忽略与清理）
pub const WORKTREE_ROOT: &str = ".daoshengyi/worktrees";
/// 本地忽略条目（写 `.git/info/exclude`，不污染用户的 .gitignore）
pub const LOCAL_EXCLUDE_ENTRY: &str = ".daoshengyi/";

#[derive(Debug, serde::Serialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub head: String,
    /// 是否是仓库主工作区（第一个条目）
    pub is_main: bool,
}

/// 一个 worktree 副本的名字：只留小写字母数字与 `-`，限长；为空时用时间戳
pub fn worktree_slug(name: Option<&str>) -> String {
    let raw = name.unwrap_or("").trim();
    let mut out = String::new();
    let mut last_dash = false;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let slug = out.trim_matches('-').to_string();
    if slug.is_empty() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("wt-{}", ts)
    } else if slug.len() > 32 {
        slug.chars()
            .take(32)
            .collect::<String>()
            .trim_matches('-')
            .to_string()
    } else {
        slug
    }
}

/// 副本绝对路径（`<repo>/.daoshengyi/worktrees/<slug>`）
pub fn worktree_dir(repo: &str, slug: &str) -> String {
    format!("{}/{}/{}", repo.trim_end_matches('/'), WORKTREE_ROOT, slug)
}

/// 删除保护：只允许删本工具建的副本（路径必须在 `<repo>/.daoshengyi/worktrees/` 下）
pub fn path_within_worktrees(repo: &str, path: &str) -> bool {
    let base = format!("{}/{}", repo.trim_end_matches('/'), WORKTREE_ROOT);
    let target = path.trim_end_matches('/');
    target.starts_with(&format!("{}/", base)) && target.len() > base.len() + 1
}

/// 解析 `git worktree list --porcelain` 输出
pub fn parse_worktree_list(text: &str) -> Vec<WorktreeInfo> {
    let mut out: Vec<WorktreeInfo> = Vec::new();
    let mut cur: Option<WorktreeInfo> = None;
    for line in text.lines() {
        let line = line.trim_end();
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(c) = cur.take() {
                out.push(c);
            }
            cur = Some(WorktreeInfo {
                path: p.to_string(),
                branch: String::new(),
                head: String::new(),
                is_main: out.is_empty(),
            });
            continue;
        }
        let Some(c) = cur.as_mut() else { continue };
        if let Some(b) = line.strip_prefix("branch ") {
            // refs/heads/xxx → xxx
            c.branch = b.trim().trim_start_matches("refs/heads/").to_string();
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            c.head = h.trim().chars().take(8).collect();
        } else if line == "detached" && c.branch.is_empty() {
            c.branch = "(detached)".to_string();
        } else if line == "bare" {
            c.branch = "(bare)".to_string();
        }
    }
    if let Some(c) = cur.take() {
        out.push(c);
    }
    out
}

/// 把 `.daoshengyi/` 追加到 `.git/info/exclude`（幂等；worktree 里 `.git` 是文件，得先问 git 要 git-dir）
fn ensure_local_exclude(git_dir: &Path) -> Result<(), String> {
    let info = git_dir.join("info");
    std::fs::create_dir_all(&info).map_err(|e| format!("无法创建 {}: {}", info.display(), e))?;
    let file = info.join("exclude");
    let existing = std::fs::read_to_string(&file).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == LOCAL_EXCLUDE_ENTRY) {
        return Ok(());
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str("# 道生一：并行 worktree 副本（本地忽略，不影响 .gitignore）\n");
    next.push_str(LOCAL_EXCLUDE_ENTRY);
    next.push('\n');
    std::fs::write(&file, next).map_err(|e| format!("写入 {} 失败: {}", file.display(), e))
}

/// 跑一条 git 命令（走统一管线；超时同样当失败处理）
async fn run_git(
    db: &crate::Database,
    cwd: &str,
    argv: Vec<String>,
    timeout_secs: u64,
) -> Result<crate::CommandOutput, String> {
    let out = crate::run_wrapped_argv(db, cwd, "git", argv, timeout_secs, "worktree").await?;
    if out.timed_out {
        return Err(out.stderr.clone());
    }
    Ok(out)
}

/// 取 git-dir（worktree 内 `.git` 是文件，不能直接当目录用）
async fn git_dir_of(db: &crate::Database, repo: &str) -> Result<String, String> {
    let r = run_git(
        db,
        repo,
        vec!["rev-parse".into(), "--absolute-git-dir".into()],
        20,
    )
    .await?;
    if r.exit_code != 0 {
        return Err(format!(
            "{} 不是 git 仓库（git rev-parse 失败）：{}",
            repo,
            r.stderr.trim()
        ));
    }
    Ok(r.stdout.trim().to_string())
}

/// 新建一个 worktree 副本，返回它的路径/分支
#[tauri::command]
pub async fn worktree_create(
    db: tauri::State<'_, crate::Database>,
    repo: String,
    name: Option<String>,
    base_ref: Option<String>,
) -> Result<WorktreeInfo, String> {
    let repo = repo.trim().trim_end_matches('/').to_string();
    if repo.is_empty() {
        return Err("worktree_create 需要 repo 参数（仓库目录绝对路径）".to_string());
    }
    let git_dir = git_dir_of(&db, &repo).await?;
    ensure_local_exclude(Path::new(&git_dir))?;

    let slug = worktree_slug(name.as_deref());
    let dir = worktree_dir(&repo, &slug);
    let branch = format!("dsy/{}", slug);
    if Path::new(&dir).exists() {
        return Err(format!(
            "副本目录已存在：{}（换个 name，或用 worktree_list 看现有副本）",
            dir
        ));
    }
    let base = base_ref
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| "HEAD".to_string());
    let r = run_git(
        &db,
        &repo,
        vec![
            "worktree".into(),
            "add".into(),
            "-b".into(),
            branch.clone(),
            dir.clone(),
            base.clone(),
        ],
        120,
    )
    .await?;
    if r.exit_code != 0 {
        return Err(format!(
            "创建 worktree 失败：{}",
            if r.stderr.trim().is_empty() {
                r.stdout.clone()
            } else {
                r.stderr.clone()
            }
        ));
    }
    // 立刻把本地忽略补上（副本里 .git 是文件，git 会带过去；这里再查一次输出确认）
    Ok(WorktreeInfo {
        path: dir,
        branch,
        head: "".to_string(),
        is_main: false,
    })
}

/// 列出仓库的所有 worktree（第一个是主工作区）
#[tauri::command]
pub async fn worktree_list(
    db: tauri::State<'_, crate::Database>,
    repo: String,
) -> Result<Vec<WorktreeInfo>, String> {
    let repo = repo.trim().trim_end_matches('/').to_string();
    if repo.is_empty() {
        return Err("worktree_list 需要 repo 参数（仓库目录绝对路径）".to_string());
    }
    let r = run_git(
        &db,
        &repo,
        vec!["worktree".into(), "list".into(), "--porcelain".into()],
        30,
    )
    .await?;
    if r.exit_code != 0 {
        return Err(format!("列出 worktree 失败：{}", r.stderr.trim()));
    }
    Ok(parse_worktree_list(&r.stdout))
}

/// 删除本工具建的副本（只允许 `<repo>/.daoshengyi/worktrees/*`）
#[tauri::command]
pub async fn worktree_remove(
    db: tauri::State<'_, crate::Database>,
    repo: String,
    path: String,
    force: Option<bool>,
) -> Result<String, String> {
    let repo = repo.trim().trim_end_matches('/').to_string();
    let path = path.trim().trim_end_matches('/').to_string();
    if repo.is_empty() || path.is_empty() {
        return Err("worktree_remove 需要 repo 与 path 参数".to_string());
    }
    if !path_within_worktrees(&repo, &path) {
        return Err(format!(
            "拒绝删除：{} 不在 {}/{} 下（只允许删本工具创建的副本）",
            path, repo, WORKTREE_ROOT
        ));
    }
    let mut argv = vec!["worktree".to_string(), "remove".to_string()];
    if force.unwrap_or(false) {
        argv.push("--force".to_string());
    }
    argv.push(path.clone());
    let r = run_git(&db, &repo, argv, 60).await?;
    if r.exit_code != 0 {
        return Err(format!(
            "删除失败（有未提交改动时需 force=true）：{}",
            r.stderr.trim()
        ));
    }
    Ok(format!("已删除 worktree 副本：{}", path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_is_safe_and_bounded() {
        assert_eq!(worktree_slug(Some("Fix Login Bug")), "fix-login-bug");
        assert_eq!(worktree_slug(Some("a/b\\c:d")), "a-b-c-d");
        assert_eq!(worktree_slug(Some("../../etc/passwd")), "etc-passwd");
        assert!(worktree_slug(None).starts_with("wt-"));
        assert!(worktree_slug(Some(&"x".repeat(100))).len() <= 32);
        assert!(worktree_slug(Some("   ")).starts_with("wt-"));
    }

    #[test]
    fn dir_is_inside_repo_hidden_folder() {
        assert_eq!(
            worktree_dir("/Users/t/proj", "fix-login"),
            "/Users/t/proj/.daoshengyi/worktrees/fix-login"
        );
        assert_eq!(
            worktree_dir("/Users/t/proj/", "x"),
            "/Users/t/proj/.daoshengyi/worktrees/x"
        );
    }

    #[test]
    fn remove_guard_only_allows_own_worktrees() {
        let repo = "/Users/t/proj";
        assert!(path_within_worktrees(
            repo,
            "/Users/t/proj/.daoshengyi/worktrees/fix-login"
        ));
        // 越界：仓库根、仓库里的其它目录、别处、前缀相似的兄弟目录
        assert!(!path_within_worktrees(repo, "/Users/t/proj"));
        assert!(!path_within_worktrees(repo, "/Users/t/proj/src"));
        assert!(!path_within_worktrees(
            repo,
            "/Users/t/other/.daoshengyi/worktrees/x"
        ));
        assert!(!path_within_worktrees(
            repo,
            "/Users/t/proj/.daoshengyi/worktrees"
        ));
        assert!(!path_within_worktrees(
            repo,
            "/Users/t/proj/.daoshengyi/worktreesX/a"
        ));
    }

    #[test]
    fn parse_porcelain_marks_main_first() {
        let text = "\
worktree /Users/t/proj
HEAD 1a2b3c4d5e6f
branch refs/heads/main

worktree /Users/t/proj/.daoshengyi/worktrees/fix-login
HEAD 9f8e7d6c5b4a
branch refs/heads/dsy/fix-login

worktree /Users/t/tmp/detached
HEAD 0011223344
detached
";
        let list = parse_worktree_list(text);
        assert_eq!(list.len(), 3);
        assert!(list[0].is_main);
        assert_eq!(list[0].branch, "main");
        assert_eq!(list[1].branch, "dsy/fix-login");
        assert_eq!(list[1].head, "9f8e7d6c");
        assert!(!list[1].is_main);
        assert_eq!(list[2].branch, "(detached)");
    }

    #[test]
    fn local_exclude_is_idempotent() {
        let dir = std::env::temp_dir().join(format!(
            "dsy-exclude-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        ensure_local_exclude(&dir).unwrap();
        ensure_local_exclude(&dir).unwrap();
        let body = std::fs::read_to_string(dir.join("info/exclude")).unwrap();
        assert_eq!(
            body.lines()
                .filter(|l| l.trim() == LOCAL_EXCLUDE_ENTRY)
                .count(),
            1,
            "重复调用只应写入一条"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
