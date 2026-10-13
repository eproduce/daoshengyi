//! 技能包（批量导入导出）：把多个技能打成一个 `.zip`，也能把别处导出的包装回来。
//!
//! ## 包格式（v1，**同时就是上游 agentskills 目录形态**）
//!
//! ```text
//! manifest.json                   # 包元信息 + 每个技能的路由/能力声明/哈希位
//! <slug>/SKILL.md                 # 技能正文（带 frontmatter）
//! <slug>/references/<ref>.md      # 可选：参考资料
//! ```
//!
//! 为什么用 `<slug>/SKILL.md` 而不是扁平的 `<slug>.md`：这个布局**可以直接丢进
//! `~/.agents/skills/` 或 `~/.claude/skills/`**，被 Claude Code / Codex / DSH 原样读走
//! —— 导出即互操作，而不是只能我们自己读回来（见 `docs/SKILL_COMPATIBILITY.md`）。
//! 纯中文技能名会得到空 slug → 退化成 `skill-<n>`（真名在 frontmatter 与 manifest 里，
//! 目录名只是给上游一个合法的 kebab-case 名字）。
//!
//! ## 安全（解包一律按不可信输入处理）
//!
//! - 条目路径必须在包内：拒绝绝对路径、反斜杠、空段、`.`、`..`、超过 3 层
//! - 只认 `manifest.json` / `<dir>/SKILL.md` / `<dir>/references/<file>`，其余忽略
//! - 条目数 ≤ 200（另有总量上限）、单条目 ≤ 256KB、总量 ≤ 8MB、非 UTF-8 跳过
//! - **只读进内存**返回前端，Rust 不直接往技能目录落任何文件（落盘与冲突决策在前端）

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::PathBuf;

/// 包格式标识（写进 manifest；读回时只做记录，不做拒绝，便于未来版本兼容）
pub const PACK_FORMAT: &str = "daoshengyi-skillpack";
pub const PACK_VERSION: u32 = 1;
pub const MANIFEST_NAME: &str = "manifest.json";
/// 单包技能上限
pub const MAX_PACK_ENTRIES: usize = 200;
/// 单条目字节上限（与技能扫描器同口径）
pub const MAX_ENTRY_BYTES: u64 = 256 * 1024;
/// 整包字节上限（解包时的累计预算）
pub const MAX_PACK_TOTAL_BYTES: u64 = 8 * 1024 * 1024;
/// slug 长度上限
const MAX_SLUG_LEN: usize = 48;
/// 包内路径最大层数（`a/references/b.md` = 3 层）
const MAX_DEPTH: usize = 3;

/// 导出入参：一个技能（正文 + 可选参考资料 + 路由/能力声明）
///
/// **必须 `rename_all = "camelCase"`**：前端按 appSettings.ts 同款约定发 camelCase，
/// 而 serde 默认会**静默忽略**对不上的字段（本项目踩过同类坑：字段名不一致 → 值全丢）。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub when_to_use: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub requires_tools: Vec<String>,
    #[serde(default)]
    pub requires_servers: Vec<String>,
    /// 技能正文 Markdown（已含 frontmatter，前端 `exportAsMd` 产出）
    pub content: String,
    #[serde(default)]
    pub references: Vec<SkillPackRefInput>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackRefInput {
    pub title: String,
    pub content: String,
}

/// 解包结果条目
#[derive(Debug, serde::Serialize)]
pub struct SkillPackEntry {
    /// 包内路径（如 `code-review/SKILL.md`）
    pub path: String,
    pub content: String,
    pub bytes: usize,
}

/// 解包结果
#[derive(Debug, serde::Serialize)]
pub struct SkillPackRead {
    /// 包内 manifest（原样回传；缺失为 null）
    pub manifest: Option<serde_json::Value>,
    pub entries: Vec<SkillPackEntry>,
    /// 被忽略的条目数（不合格式 / 超限 / 非 UTF-8）
    pub ignored: usize,
}

/// 包内条目类型
#[derive(Debug, PartialEq, Eq)]
pub enum EntryKind {
    Manifest,
    Skill,
    Reference,
}

/// 目录名 slug：只保留 ASCII 字母数字与 `-._`，其余（中文、空格、路径字符）折叠成 `-`。
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches(|c: char| c == '-' || c == '.').to_string();
    if trimmed.chars().count() > MAX_SLUG_LEN {
        trimmed
            .chars()
            .take(MAX_SLUG_LEN)
            .collect::<String>()
            .trim_end_matches('-')
            .to_string()
    } else {
        trimmed
    }
}

/// 去重：`base` 已被占用则追加 `-2`、`-3`…（同名技能不能互相覆盖）
pub fn unique_slug(base: &str, used: &mut HashSet<String>) -> String {
    let base = if base.is_empty() { "skill" } else { base };
    if used.insert(base.to_string()) {
        return base.to_string();
    }
    for i in 2..1000usize {
        let cand = format!("{}-{}", base, i);
        if used.insert(cand.clone()) {
            return cand;
        }
    }
    format!("{}-x", base)
}

/// 判定包内路径是否可接受（安全边界，按不可信输入处理），并给出条目类型。
pub fn entry_kind(path: &str) -> Option<EntryKind> {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') {
        return None;
    }
    let segs: Vec<&str> = path.split('/').collect();
    if segs.len() > MAX_DEPTH {
        return None;
    }
    if segs.iter().any(|s| s.is_empty() || *s == "." || *s == "..") {
        return None;
    }
    match segs.as_slice() {
        [one] if *one == MANIFEST_NAME => Some(EntryKind::Manifest),
        [_, file] if *file == "SKILL.md" => Some(EntryKind::Skill),
        [_, "references", _] => Some(EntryKind::Reference),
        _ => None,
    }
}

/// 参考资料在包内的文件名（去路径字符、限长；空则回退 `ref-N.md`）
pub fn ref_file_name(title: &str, index: usize) -> String {
    let slug = slugify(title);
    if slug.is_empty() {
        format!("ref-{}.md", index + 1)
    } else {
        format!("{}.md", slug)
    }
}

/// 技能包 zip 的文件名：清洗路径分隔符与首尾杂字符，空则给默认名。
pub fn pack_file_name(raw: Option<&str>) -> String {
    let cleaned: String = raw
        .unwrap_or("")
        .trim()
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == ':' {
                '-'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned
        .trim_matches(|c: char| c == '.' || c == '-' || c.is_whitespace())
        .to_string();
    if cleaned.is_empty() {
        format!("道生一技能包-{}.zip", epoch_secs())
    } else if cleaned.to_ascii_lowercase().ends_with(".zip") {
        cleaned
    } else {
        format!("{}.zip", cleaned)
    }
}

fn epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 写 zip 的选项（每次构造，避免依赖 `FileOptions: Copy` 的实现细节）
fn zip_options() -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644)
}

/// 导出技能包到产物目录（`~/Documents/道生一产物/`），返回 zip 的绝对路径。
#[tauri::command]
pub fn export_skill_pack(
    skills: Vec<SkillPackInput>,
    file_name: Option<String>,
) -> Result<String, String> {
    if skills.is_empty() {
        return Err("没有可导出的技能（请先勾选）".to_string());
    }
    if skills.len() > MAX_PACK_ENTRIES {
        return Err(format!("一次最多导出 {} 个技能", MAX_PACK_ENTRIES));
    }
    let home = std::env::var("HOME").map_err(|_| "无法获取用户主目录".to_string())?;
    let dir = crate::artifact_root(&home);
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建产物目录: {}", e))?;
    let out = dir.join(pack_file_name(file_name.as_deref()));

    // 先算好所有条目（slug 去重 + manifest），再一次性写 zip
    let mut used: HashSet<String> = HashSet::new();
    let mut metas: Vec<serde_json::Value> = Vec::new();
    let mut planned: Vec<(String, String)> = Vec::new();
    for s in &skills {
        let slug = unique_slug(&slugify(&s.name), &mut used);
        let skill_path = format!("{}/SKILL.md", slug);
        planned.push((skill_path.clone(), s.content.clone()));
        let mut refs: Vec<serde_json::Value> = Vec::new();
        for (i, r) in s.references.iter().enumerate() {
            let p = format!("{}/references/{}", slug, ref_file_name(&r.title, i));
            planned.push((p.clone(), r.content.clone()));
            refs.push(serde_json::json!({ "title": r.title, "file": p }));
        }
        metas.push(serde_json::json!({
            "name": s.name,
            "slug": slug,
            "description": s.description,
            "category": s.category,
            "version": s.version,
            "whenToUse": s.when_to_use,
            "tags": s.tags,
            "requires": { "tools": s.requires_tools, "servers": s.requires_servers },
            "file": skill_path,
            "references": refs,
        }));
    }
    let manifest = serde_json::json!({
        "format": PACK_FORMAT,
        "version": PACK_VERSION,
        "exportedAt": epoch_secs(),
        "count": metas.len(),
        "skills": metas,
    });
    let manifest_text = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("manifest 序列化失败: {}", e))?;

    let file = std::fs::File::create(&out).map_err(|e| format!("无法创建技能包: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file(MANIFEST_NAME, zip_options())
        .map_err(|e| format!("写入 manifest 失败: {}", e))?;
    zip.write_all(manifest_text.as_bytes())
        .map_err(|e| format!("写入 manifest 失败: {}", e))?;
    for (path, content) in planned {
        zip.start_file(path.as_str(), zip_options())
            .map_err(|e| format!("写入 {} 失败: {}", path, e))?;
        zip.write_all(content.as_bytes())
            .map_err(|e| format!("写入 {} 失败: {}", path, e))?;
    }
    zip.finish().map_err(|e| format!("技能包收尾失败: {}", e))?;
    Ok(out.to_string_lossy().to_string())
}

/// 读取技能包：返回条目（内存中），由前端决定怎么写进技能库。
#[tauri::command]
pub fn import_skill_pack(path: String) -> Result<SkillPackRead, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("技能包不存在: {}", path));
    }
    let file = std::fs::File::open(&p).map_err(|e| format!("无法打开技能包: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("不是有效的 zip 技能包: {}", e))?;
    // 明显异常的包直接拒绝（正常包条目数 ≈ 技能数 × (1 + 参考资料数)）
    if archive.len() > MAX_PACK_ENTRIES * 3 {
        return Err(format!(
            "技能包条目过多（{} 项），已拒绝解包",
            archive.len()
        ));
    }
    let mut entries: Vec<SkillPackEntry> = Vec::new();
    let mut manifest: Option<serde_json::Value> = None;
    let mut ignored = 0usize;
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut item = archive
            .by_index(i)
            .map_err(|e| format!("读取条目失败: {}", e))?;
        if item.is_dir() {
            continue;
        }
        let name = item.name().to_string();
        let kind = match entry_kind(&name) {
            Some(k) => k,
            None => {
                ignored += 1;
                continue;
            }
        };
        if item.size() > MAX_ENTRY_BYTES {
            ignored += 1;
            continue;
        }
        total += item.size();
        if total > MAX_PACK_TOTAL_BYTES {
            ignored += 1;
            continue;
        }
        let mut buf = Vec::new();
        if item.read_to_end(&mut buf).is_err() {
            ignored += 1;
            continue;
        }
        let content = match String::from_utf8(buf) {
            Ok(c) => c,
            Err(_) => {
                ignored += 1;
                continue;
            }
        };
        if kind == EntryKind::Manifest {
            manifest = serde_json::from_str(&content).ok();
            continue;
        }
        entries.push(SkillPackEntry {
            bytes: content.len(),
            path: name,
            content,
        });
    }
    if entries.is_empty() {
        return Err("技能包里没有找到技能（期望 <名字>/SKILL.md 结构）".to_string());
    }
    Ok(SkillPackRead {
        manifest,
        entries,
        ignored,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "dsy-skill-pack-{}-{}-{}",
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

    #[test]
    fn slugify_keeps_ascii_and_folds_rest() {
        assert_eq!(slugify("Code Review"), "code-review");
        assert_eq!(slugify("code_review.v2"), "code_review.v2");
        assert_eq!(slugify("a//b"), "a-b");
        assert_eq!(slugify("../../etc/passwd"), "etc-passwd");
        assert_eq!(slugify("代码审查"), "", "纯中文 → 空，由调用方回退 skill-N");
        assert!(slugify(&"x".repeat(80)).chars().count() <= MAX_SLUG_LEN);
    }

    #[test]
    fn unique_slug_numbers_duplicates() {
        let mut used = HashSet::new();
        assert_eq!(unique_slug("review", &mut used), "review");
        assert_eq!(unique_slug("review", &mut used), "review-2");
        assert_eq!(unique_slug("review", &mut used), "review-3");
        assert_eq!(unique_slug("", &mut used), "skill");
    }

    #[test]
    fn entry_kind_accepts_only_whitelisted_shapes() {
        assert_eq!(entry_kind("manifest.json"), Some(EntryKind::Manifest));
        assert_eq!(entry_kind("review/SKILL.md"), Some(EntryKind::Skill));
        assert_eq!(
            entry_kind("review/references/a.md"),
            Some(EntryKind::Reference)
        );
        // 安全边界：绝对路径 / 上跳 / 反斜杠 / 空段 / 过深 / 其它文件
        assert_eq!(entry_kind("/etc/passwd"), None);
        assert_eq!(entry_kind("../evil/SKILL.md"), None);
        assert_eq!(entry_kind("a/../../SKILL.md"), None);
        assert_eq!(entry_kind("a\\b/SKILL.md"), None);
        assert_eq!(entry_kind("a//SKILL.md"), None);
        assert_eq!(entry_kind("a/b/c/SKILL.md"), None);
        assert_eq!(entry_kind("review/README.md"), None);
        assert_eq!(entry_kind("review/references/deep/x.md"), None);
    }

    #[test]
    fn ref_and_pack_file_names_are_sanitized() {
        assert_eq!(ref_file_name("API 设计", 0), "api.md");
        assert_eq!(ref_file_name("参考资料", 2), "ref-3.md");
        assert_eq!(pack_file_name(Some("我的包")), "我的包.zip");
        assert_eq!(pack_file_name(Some("a/b.zip")), "a-b.zip");
        assert_eq!(pack_file_name(Some("  ..  ")), pack_file_name(None));
        assert!(pack_file_name(None).starts_with("道生一技能包-"));
    }

    #[test]
    fn pack_input_accepts_frontend_camel_case() {
        // 前端发 camelCase；若字段名对不上，serde 会静默丢值（whenToUse/requires 全空）
        let v = serde_json::json!({
            "name": "代码审查",
            "description": "d",
            "category": "开发",
            "version": "1.0",
            "whenToUse": "需要审查时",
            "tags": ["review"],
            "requiresTools": ["read_file"],
            "requiresServers": ["GitHub"],
            "content": "body",
            "references": [{ "title": "清单", "content": "看命名" }]
        });
        let input: SkillPackInput = serde_json::from_value(v).unwrap();
        assert_eq!(input.when_to_use, "需要审查时");
        assert_eq!(input.requires_tools, vec!["read_file".to_string()]);
        assert_eq!(input.requires_servers, vec!["GitHub".to_string()]);
        assert_eq!(input.tags, vec!["review".to_string()]);
        assert_eq!(input.references[0].title, "清单");
    }

    #[test]
    fn export_then_import_roundtrip_keeps_content_and_manifest() {
        let dir = tmp("roundtrip");
        let out = dir.join("pack.zip");
        // 直接写 zip（绕过 artifact_root，测试不碰用户产物目录）
        let input = vec![
            SkillPackInput {
                name: "代码审查".to_string(),
                description: "审查代码".to_string(),
                category: "开发".to_string(),
                version: "1.0".to_string(),
                when_to_use: "需要审查时".to_string(),
                tags: vec!["review".to_string()],
                requires_tools: vec!["read_file".to_string()],
                requires_servers: vec![],
                content: "---\nname: 代码审查\n---\n正文".to_string(),
                references: vec![SkillPackRefInput {
                    title: "Checklist".to_string(),
                    content: "1. 看命名".to_string(),
                }],
            },
            SkillPackInput {
                // 与第一个同名 → slug 必须去重，不能互相覆盖
                name: "代码审查".to_string(),
                description: "".to_string(),
                category: "".to_string(),
                version: "".to_string(),
                when_to_use: "".to_string(),
                tags: vec![],
                requires_tools: vec![],
                requires_servers: vec![],
                content: "---\nname: 代码审查2\n---\n正文2".to_string(),
                references: vec![],
            },
        ];
        write_pack_for_test(&out, &input);
        let read = read_pack_for_test(&out);
        assert_eq!(read.ignored, 0);
        let paths: Vec<String> = read.entries.iter().map(|e| e.path.clone()).collect();
        assert_eq!(
            paths,
            vec![
                "skill/SKILL.md",
                "skill/references/checklist.md",
                "skill-2/SKILL.md"
            ]
        );
        assert!(read.entries[0].content.contains("正文"));
        assert!(read.entries[1].content.contains("看命名"));
        let m = read.manifest.expect("manifest 应能解析");
        assert_eq!(m["format"], PACK_FORMAT);
        assert_eq!(m["count"], 2);
        assert_eq!(m["skills"][0]["name"], "代码审查");
        assert_eq!(m["skills"][0]["requires"]["tools"][0], "read_file");
        assert_eq!(m["skills"][1]["slug"], "skill-2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_ignores_unsafe_and_oversized_entries() {
        let dir = tmp("guards");
        let out = dir.join("bad.zip");
        {
            let file = std::fs::File::create(&out).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip_options();
            zip.start_file("../evil/SKILL.md", opts).unwrap();
            zip.write_all(b"escape").unwrap();
            zip.start_file("ok/SKILL.md", opts).unwrap();
            zip.write_all(b"ok body").unwrap();
            zip.start_file("ok/references/big.md", opts).unwrap(); // 形状合法但超大 → 忽略
            zip.write_all(&vec![b'x'; 300 * 1024]).unwrap();
            zip.finish().unwrap();
        }
        let read = read_pack_for_test(&out);
        assert_eq!(read.entries.len(), 1);
        assert_eq!(read.entries[0].path, "ok/SKILL.md");
        assert_eq!(read.ignored, 2, "越界路径与超大条目都应被忽略");
        assert!(read.manifest.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 测试用的最小 zip 读写（不经过 artifact_root，避免污染用户产物目录）----

    fn write_pack_for_test(out: &std::path::Path, skills: &[SkillPackInput]) {
        let mut used = HashSet::new();
        let mut planned: Vec<(String, String)> = Vec::new();
        let mut metas: Vec<serde_json::Value> = Vec::new();
        for s in skills {
            let slug = unique_slug(&slugify(&s.name), &mut used);
            let sp = format!("{}/SKILL.md", slug);
            planned.push((sp.clone(), s.content.clone()));
            let mut refs = Vec::new();
            for (i, r) in s.references.iter().enumerate() {
                let p = format!("{}/references/{}", slug, ref_file_name(&r.title, i));
                planned.push((p.clone(), r.content.clone()));
                refs.push(serde_json::json!({ "title": r.title, "file": p }));
            }
            metas.push(serde_json::json!({
                "name": s.name,
                "slug": slug,
                "requires": { "tools": s.requires_tools, "servers": s.requires_servers },
                "references": refs,
            }));
        }
        let manifest = serde_json::json!({
            "format": PACK_FORMAT,
            "version": PACK_VERSION,
            "count": metas.len(),
            "skills": metas,
        });
        let file = std::fs::File::create(out).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file(MANIFEST_NAME, zip_options()).unwrap();
        zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes())
            .unwrap();
        for (p, c) in planned {
            zip.start_file(p.as_str(), zip_options()).unwrap();
            zip.write_all(c.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    fn read_pack_for_test(path: &std::path::Path) -> SkillPackRead {
        import_skill_pack(path.to_string_lossy().to_string()).expect("应能解包")
    }
}
