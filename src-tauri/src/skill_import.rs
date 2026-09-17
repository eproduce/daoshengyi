//! P1-9a 技能外部导入：扫描其他 agent 工具的「技能/提示词」目录。
//!
//! ## 为什么
//!
//! 用户往往已经在别处攒了技能（Claude Code 的 `~/.claude/skills/*/SKILL.md`、Codex 的
//! `~/.codex/prompts/*.md`、Cursor 的 `.cursor/rules/*.mdc`）。这些文件格式本来就接近
//! （Markdown + 可选 frontmatter），让用户手抄一遍纯属浪费。
//!
//! ## 设计
//!
//! - **扫描在 Rust 侧**：要递归目录、限制深度与体积、跳过隐藏目录，放这里比前端逐层
//!   `list_dir` 更省往返，也更容易做边界控制。
//! - **只读**：本模块不改任何外部文件；解析与去重在前端 `utils/skill-import.ts` 做
//!   （那里能看到现有技能表，才能决定「新增/更新/冲突」）。
//! - **边界**：只允许扫描**主目录内**或**当前工作区内**的目录（其余一律跳过），
//!   单文件 ≤ 256KB、总条目 ≤ 200、深度 ≤ 3 —— 防止误扫整个磁盘或把上下文撑爆。

use std::path::{Path, PathBuf};

/// 单个来源目录的扫描规格（前端按平台拼好传进来）
#[derive(Debug, serde::Deserialize)]
pub struct SkillSourceSpec {
    /// 来源标识（claude-code / codex / cursor / generic），仅回传用于展示
    pub id: String,
    /// 人读标签（Claude Code 技能 …）
    pub label: String,
    /// 绝对目录（支持 `~/` 前缀）
    pub dir: String,
    /// 只收指定文件名（如 `SKILL.md`）；None = 收目录下所有 .md/.mdc
    pub file_name: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct ExternalSkillFile {
    /// 来源标识（对应入参 SkillSourceSpec.id）
    pub source: String,
    /// 来源标签
    pub label: String,
    /// 文件绝对路径（导入时作为 importUrl，便于「再次导入=更新」）
    pub path: String,
    /// 文件名（无 frontmatter 时作为技能名兜底）
    pub name: String,
    pub content: String,
    pub bytes: usize,
}

/// 单文件上限：超过则跳过（技能正文不该这么大）
pub const MAX_SKILL_BYTES: u64 = 256 * 1024;
/// 单次扫描总条目上限
pub const MAX_SKILL_FILES: usize = 200;
/// 递归深度上限（含根目录层）
pub const MAX_SKILL_DEPTH: usize = 3;

/// 是否是要收的文件：指定了文件名就精确匹配（忽略大小写），否则收 .md/.mdc
fn is_candidate_file(path: &Path, file_name: Option<&str>) -> bool {
    let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    match file_name {
        Some(want) => name.eq_ignore_ascii_case(want),
        None => {
            let lower = name.to_ascii_lowercase();
            lower.ends_with(".md") || lower.ends_with(".mdc")
        }
    }
}

/// 递归收集候选文件（纯文件系统操作，便于单测）。
/// 规则：跳过隐藏项（以 `.` 开头）、跳过符号链接目录、深度与条目数上限。
pub fn collect_skill_files(root: &Path, file_name: Option<&str>, depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    collect_inner(root, file_name, depth, &mut out);
    out.sort();
    out.truncate(MAX_SKILL_FILES);
    out
}

fn collect_inner(root: &Path, file_name: Option<&str>, depth: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 || out.len() >= MAX_SKILL_FILES {
        return;
    }
    let Ok(rd) = std::fs::read_dir(root) else {
        return;
    };
    for ent in rd.flatten() {
        if out.len() >= MAX_SKILL_FILES {
            return;
        }
        let p = ent.path();
        let name = ent.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // 跳过 .git/.DS_Store 之类
        }
        let Ok(ft) = ent.file_type() else { continue };
        if ft.is_symlink() {
            continue; // 不跟进符号链接（避免环与越界）
        }
        if ft.is_dir() {
            collect_inner(&p, file_name, depth - 1, out);
        } else if ft.is_file() && is_candidate_file(&p, file_name) {
            out.push(p);
        }
    }
}

/// 目录是否允许扫描：必须位于主目录或工作区内（防误扫系统目录）
pub fn dir_allowed(dir: &Path, home: &Path, workspace: Option<&Path>) -> bool {
    let inside_home = dir == home || dir.starts_with(home);
    let inside_ws = workspace.map(|w| dir == w || dir.starts_with(w)).unwrap_or(false);
    inside_home || inside_ws
}

/// 展开 `~` 前缀
fn expand_tilde(dir: &str, home: &Path) -> PathBuf {
    if dir == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = dir.strip_prefix("~/") {
        return home.join(rest);
    }
    PathBuf::from(dir)
}

/// 扫描多个来源目录，返回可直接导入的技能文件（只读，不改外部文件）
#[tauri::command]
pub fn scan_external_skills(
    sources: Vec<SkillSourceSpec>,
    workspace: Option<String>,
) -> Result<Vec<ExternalSkillFile>, String> {
    let home = std::env::var("HOME").map_err(|_| "无法获取用户主目录".to_string())?;
    let home = PathBuf::from(home);
    let ws = workspace.filter(|w| !w.trim().is_empty()).map(PathBuf::from);
    let mut out: Vec<ExternalSkillFile> = Vec::new();
    for spec in sources {
        let dir = expand_tilde(spec.dir.trim(), &home);
        if !dir_allowed(&dir, &home, ws.as_deref()) {
            continue; // 越界目录静默跳过（前端不会给出这种规格）
        }
        for file in collect_skill_files(&dir, spec.file_name.as_deref(), MAX_SKILL_DEPTH) {
            if out.len() >= MAX_SKILL_FILES {
                break;
            }
            let Ok(meta) = std::fs::metadata(&file) else { continue };
            if meta.len() > MAX_SKILL_BYTES {
                continue; // 超大文件跳过（技能正文不该这么大）
            }
            let Ok(content) = std::fs::read_to_string(&file) else {
                continue; // 非 UTF-8 / 不可读 → 跳过
            };
            if content.trim().is_empty() {
                continue;
            }
            out.push(ExternalSkillFile {
                source: spec.id.clone(),
                label: spec.label.clone(),
                name: file
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string(),
                path: file.display().to_string(),
                bytes: meta.len() as usize,
                content,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "dsy-skill-scan-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn collects_named_skill_files_recursively() {
        let root = tmp("named");
        write(&root.join("alpha/SKILL.md"), "---\nname: a\n---\nA");
        write(&root.join("beta/SKILL.md"), "---\nname: b\n---\nB");
        write(&root.join("beta/README.md"), "不该被收（只收 SKILL.md）");
        let files = collect_skill_files(&root, Some("SKILL.md"), 3);
        let names: Vec<String> = files
            .iter()
            .map(|p| p.parent().unwrap().file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["alpha", "beta"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn collects_all_markdown_when_no_name_filter() {
        let root = tmp("any");
        write(&root.join("prompts/a.md"), "A");
        write(&root.join("prompts/b.mdc"), "B");
        write(&root.join("prompts/c.txt"), "C");
        write(&root.join("nested/d.md"), "D");
        let files = collect_skill_files(&root, None, 3);
        assert_eq!(files.len(), 3, "应收到 2 个 .md/.mdc + 1 个嵌套 .md");
        assert!(files.iter().all(|p| p.extension().and_then(|e| e.to_str()) != Some("txt")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_hidden_dirs_and_respects_depth() {
        let root = tmp("hidden");
        write(&root.join(".git/SKILL.md"), "隐藏目录里的不收");
        write(&root.join("keep/SKILL.md"), "收");
        write(&root.join("l1/l2/l3/deep/SKILL.md"), "太深，不收");
        let files = collect_skill_files(&root, Some("SKILL.md"), MAX_SKILL_DEPTH);
        assert_eq!(files.len(), 1, "只应收到 keep/SKILL.md");
        assert!(files[0].to_string_lossy().contains("keep"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_dir_is_empty_not_error() {
        let ghost = tmp("ghost").join("nope");
        assert!(collect_skill_files(&ghost, Some("SKILL.md"), 3).is_empty());
    }

    #[test]
    fn candidate_file_matching() {
        assert!(is_candidate_file(Path::new("/x/SKILL.md"), Some("skill.md")));
        assert!(is_candidate_file(Path::new("/x/a.MDC"), None));
        assert!(!is_candidate_file(Path::new("/x/a.txt"), None));
        assert!(!is_candidate_file(Path::new("/x/SKILL.md"), Some("other.md")));
    }

    #[test]
    fn dir_allowed_requires_home_or_workspace() {
        let home = PathBuf::from("/Users/tester");
        let ws = PathBuf::from("/Volumes/work/proj");
        assert!(dir_allowed(&home.join(".claude/skills"), &home, None));
        assert!(dir_allowed(&home, &home, None));
        assert!(dir_allowed(&ws.join("proj/.cursor/rules"), &home, Some(&ws)));
        assert!(!dir_allowed(Path::new("/etc"), &home, None));
        assert!(!dir_allowed(Path::new("/Users/other/skills"), &home, None));
    }

    #[test]
    fn expand_tilde_handles_home_and_nested() {
        let home = PathBuf::from("/Users/tester");
        assert_eq!(expand_tilde("~", &home), home);
        assert_eq!(expand_tilde("~/.claude/skills", &home), home.join(".claude/skills"));
        assert_eq!(expand_tilde("/abs/dir", &home), PathBuf::from("/abs/dir"));
    }
}
