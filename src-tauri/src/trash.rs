//! 回收站：把 `delete_file` 从「永久删除」改成「移入 `<应用数据>/trash`」。
//!
//! ## 为什么做
//!
//! DSH 吸收计划 P0-4b：agent 误删文件是**不可逆**事故（尤其 `rm`/`delete_file` 交错时）。
//! 命令层已有 danger 分级门禁（删之前拦），但「删错了」只能靠 undo 表里的**文本快照**
//! 恢复文本文件，二进制/大文件直接丢失。这里改成实体移入回收站：可列表、可还原、可清空。
//!
//! ## 设计要点
//!
//! - **每项一个 sidecar**（`<entry>.orig` 存 JSON：原路径 + 删除时间）——不做全局索引，
//!   避免并发写冲突；列表就是「读目录 + 读 sidecar」，坏了单个条目也只影响自己。
//! - **同卷 rename，跨卷（EXDEV）回落 copy+remove**：用户文件可能在外置卷，
//!   rename 失败不能当成「删除失败」。
//! - **还原拒绝覆盖**：目标已存在就报错（宁可让用户自己处理，也不能默默盖掉新文件）。
//! - **还原只允许落回主目录**：sidecar 是磁盘上的普通文本，被改写也必须无害（防路径逃逸）。
//! - **自动清理**：超过 `AUTO_PURGE_DAYS` 的条目在下次删除时顺带清理，回收站不会无限膨胀。

use std::path::{Path, PathBuf};

/// 回收站条目保留天数（超过则在下次删除时自动清理）
pub const AUTO_PURGE_DAYS: u64 = 30;

/// sidecar 后缀：存「原路径 + 删除时间」，文件名即 `<entry>.orig`
const SIDECAR_EXT: &str = "orig";

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TrashEntry {
    /// 回收站内的条目名（也是还原时用的 id）
    pub id: String,
    /// 原文件名（展示用）
    pub name: String,
    /// 原绝对路径
    pub original: String,
    /// 字节数
    pub size: u64,
    /// 删除时间（Unix 秒）
    pub deleted_at: u64,
}

pub fn trash_dir(app_dir: &Path) -> PathBuf {
    app_dir.join("trash")
}

fn sidecar_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{}.{}", id, SIDECAR_EXT))
}

fn is_sidecar(p: &Path) -> bool {
    p.extension().and_then(|s| s.to_str()) == Some(SIDECAR_EXT)
}

/// 当前时间（Unix 毫秒）：删除时间戳统一从这一处取，便于测试注入
pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
/// 文件名安全化：去掉路径分隔符与危险字符（回收站里只放平铺文件）
pub fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == ':' || c == '\0' { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').to_string();
    if trimmed.is_empty() {
        "unnamed".to_string()
    } else {
        trimmed
    }
}

/// 条目 id：`<毫秒时间戳>-<安全文件名>`；同毫秒重名时加 `-1`/`-2` 后缀
pub fn unique_id(dir: &Path, name: &str, now_ms: u64) -> String {
    let base = format!("{}-{}", now_ms, safe_file_name(name));
    if !dir.join(&base).exists() {
        return base;
    }
    for i in 1..1000 {
        let cand = format!("{}-{}", base, i);
        if !dir.join(&cand).exists() {
            return cand;
        }
    }
    format!("{}-{}", base, now_ms) // 理论上到不了；仍保证不覆盖
}

/// 从 id 解析删除时间（毫秒）；解析不出返回 None
pub fn id_millis(id: &str) -> Option<u64> {
    let head = id.split('-').next()?;
    if head.len() < 10 || !head.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    head.parse::<u64>().ok()
}

/// 从 id 推导展示名（去末 `<毫秒>-` 前缀）：`1700000000000-lonely.txt` → `lonely.txt`。
/// 仅在 sidecar 缺失（孤儿条目）时用，保证用户仍看得懂这是哪个文件。
pub fn display_name_from_id(id: &str) -> String {
    let rest = match id.split_once('-') {
        Some((head, tail)) if head.len() >= 10 && head.chars().all(|c| c.is_ascii_digit()) => tail,
        _ => id,
    };
    let rest = rest.trim();
    if rest.is_empty() {
        id.to_string()
    } else {
        rest.to_string()
    }
}

/// 写入 sidecar（原路径 + 删除时间）
fn write_sidecar(dir: &Path, id: &str, original: &str, now_ms: u64) -> Result<(), String> {
    let payload = serde_json::json!({ "original": original, "deleted_at": now_ms / 1000 });
    std::fs::write(sidecar_path(dir, id), payload.to_string())
        .map_err(|e| format!("写入回收站索引失败: {}", e))
}

/// 读取 sidecar；坏了/缺失返回 None（该条目仍可列出，只是没法还原）
fn read_sidecar(dir: &Path, id: &str) -> Option<(String, u64)> {
    let text = std::fs::read_to_string(sidecar_path(dir, id)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let original = v.get("original")?.as_str()?.to_string();
    if original.is_empty() {
        return None;
    }
    let deleted_at = v.get("deleted_at").and_then(|x| x.as_u64()).unwrap_or(0);
    Some((original, deleted_at))
}

/// 移动文件（同卷 rename；跨卷 EXDEV 回落 copy+remove）
fn move_file(src: &Path, dst: &Path) -> Result<(), String> {
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    std::fs::copy(src, dst).map_err(|e| format!("复制到回收站失败: {}", e))?;
    std::fs::remove_file(src).map_err(|e| format!("移入回收站后删除原文件失败: {}", e))
}

/// 把文件移入回收站（**不删除内容**）。`src` 必须是已存在、非目录的文件。
pub fn move_to_trash(dir: &Path, src: &Path, now_ms: u64) -> Result<TrashEntry, String> {
    if src.is_dir() {
        return Err("仅允许删除文件，不删除目录（删除目录请用 git 或终端）".into());
    }
    if !src.exists() {
        return Err(format!("文件不存在: {}", src.display()));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("创建回收站目录失败: {}", e))?;
    let name = src
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unnamed")
        .to_string();
    let id = unique_id(dir, &name, now_ms);
    let dst = dir.join(&id);
    move_file(src, &dst)?;
    let original = src.display().to_string();
    // sidecar 写失败 → 回滚（宁可报错，也不留下「还原不了」的孤儿条目）
    if let Err(e) = write_sidecar(dir, &id, &original, now_ms) {
        let _ = move_file(&dst, src);
        return Err(e);
    }
    let size = std::fs::metadata(&dst).map(|m| m.len()).unwrap_or(0);
    Ok(TrashEntry {
        id,
        name,
        original,
        size,
        deleted_at: now_ms / 1000,
    })
}

/// 列出回收站条目（按删除时间倒序；无目录/空目录返回空列表）
pub fn list_trash(dir: &Path) -> Vec<TrashEntry> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<TrashEntry> = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() || is_sidecar(&p) {
            continue;
        }
        let Some(id) = p.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()) else {
            continue;
        };
        let meta = std::fs::metadata(&p).ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let (original, deleted_at) = match read_sidecar(dir, &id) {
            Some(v) => v,
            None => (String::new(), id_millis(&id).map(|ms| ms / 1000).unwrap_or(0)),
        };
        out.push(TrashEntry {
            name: if original.is_empty() {
                display_name_from_id(&id)
            } else {
                original
                    .rsplit('/')
                    .next()
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| id.clone())
            },
            id,
            original,
            size,
            deleted_at,
        });
    }
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at).then(b.id.cmp(&a.id)));
    out
}

/// 还原：移回原路径。`root` 为主目录（目标必须落在其中）；目标已存在则拒绝覆盖。
pub fn restore(dir: &Path, id: &str, root: &Path) -> Result<String, String> {
    let src = dir.join(id);
    if !src.is_file() {
        return Err(format!("回收站中找不到条目: {}", id));
    }
    let (original, _) = read_sidecar(dir, id)
        .ok_or_else(|| format!("条目 {} 缺少原始路径记录，无法自动还原（可手动从 {} 取出）", id, src.display()))?;
    let target = PathBuf::from(&original);
    if !target.is_absolute() || !target.starts_with(root) {
        return Err(format!(
            "原路径不在主目录内，为安全起见不自动还原: {}",
            original
        ));
    }
    if target.exists() {
        return Err(format!("原位置已存在同名文件，未覆盖: {}", original));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    move_file(&src, &target)?;
    let _ = std::fs::remove_file(sidecar_path(dir, id));
    Ok(format!("已还原：{}", original))
}

/// 清空回收站（删除所有条目与 sidecar），返回清理数量
pub fn empty_trash(dir: &Path) -> Result<usize, String> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Ok(0);
    };
    let mut n = 0;
    for e in rd.flatten() {
        let p = e.path();
        if p.is_file() {
            std::fs::remove_file(&p).map_err(|e| format!("清理失败 {}: {}", p.display(), e))?;
            n += 1;
        }
    }
    Ok(n)
}

/// 清理超过 `days` 天的条目（在下次删除时顺带调用），返回清理数量
pub fn purge_old(dir: &Path, now_ms: u64, days: u64) -> usize {
    let cutoff_ms = now_ms.saturating_sub(days.saturating_mul(24 * 60 * 60 * 1000));
    let mut n = 0;
    for entry in list_trash(dir) {
        let ms = id_millis(&entry.id).unwrap_or(now_ms);
        if ms < cutoff_ms {
            let _ = std::fs::remove_file(dir.join(&entry.id));
            let _ = std::fs::remove_file(sidecar_path(dir, &entry.id));
            n += 1;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "dsy-trash-{}-{}-{}",
            tag,
            std::process::id(),
            now_millis()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn move_list_restore_roundtrip_keeps_content() {
        let home = tmp_dir("home");
        let trash = tmp_dir("t1");
        let file = home.join("notes.txt");
        std::fs::write(&file, "重要内容").unwrap();

        let e = move_to_trash(&trash, &file, 1_700_000_000_000).unwrap();
        assert_eq!(e.name, "notes.txt");
        assert_eq!(e.original, file.display().to_string());
        assert_eq!(e.deleted_at, 1_700_000_000);
        assert!(!file.exists(), "原路径应已移走");
        assert!(trash.join(&e.id).exists(), "回收站里应有实体文件");

        let list = list_trash(&trash);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, e.id);
        assert_eq!(list[0].size, "重要内容".len() as u64);

        let msg = restore(&trash, &e.id, &home).unwrap();
        assert!(msg.contains("已还原"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "重要内容");
        assert!(!trash.join(&e.id).exists(), "还原后回收站条目应清除");
        assert!(list_trash(&trash).is_empty());
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&trash);
    }

    #[test]
    fn same_millisecond_names_do_not_collide() {
        let home = tmp_dir("home2");
        let trash = tmp_dir("t2");
        let a = home.join("dup.txt");
        std::fs::write(&a, "A").unwrap();
        let first = move_to_trash(&trash, &a, 1_700_000_000_000).unwrap();
        std::fs::write(&a, "B").unwrap();
        let second = move_to_trash(&trash, &a, 1_700_000_000_000).unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(std::fs::read_to_string(trash.join(&first.id)).unwrap(), "A");
        assert_eq!(std::fs::read_to_string(trash.join(&second.id)).unwrap(), "B");
        assert_eq!(list_trash(&trash).len(), 2);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&trash);
    }

    #[test]
    fn restore_refuses_to_overwrite_existing_file() {
        let home = tmp_dir("home3");
        let trash = tmp_dir("t3");
        let file = home.join("keep.txt");
        std::fs::write(&file, "旧").unwrap();
        let e = move_to_trash(&trash, &file, 1_700_000_000_000).unwrap();
        std::fs::write(&file, "新").unwrap(); // 用户又建了同名文件
        let err = restore(&trash, &e.id, &home).unwrap_err();
        assert!(err.contains("已存在"), "应拒绝覆盖: {}", err);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "新", "新文件不能被盖掉");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&trash);
    }

    #[test]
    fn restore_rejects_target_outside_root() {
        let home = tmp_dir("home4");
        let trash = tmp_dir("t4");
        let file = home.join("x.txt");
        std::fs::write(&file, "x").unwrap();
        let e = move_to_trash(&trash, &file, 1_700_000_000_000).unwrap();
        // 模拟 sidecar 被改成主目录之外的路径 → 必须拒绝（防路径逃逸）
        write_sidecar(&trash, &e.id, "/etc/passwd", 1_700_000_000_000).unwrap();
        let err = restore(&trash, &e.id, &home).unwrap_err();
        assert!(err.contains("主目录"), "应拒绝主目录外路径: {}", err);
        // 相对路径同样拒绝
        write_sidecar(&trash, &e.id, "relative/path.txt", 1_700_000_000_000).unwrap();
        assert!(restore(&trash, &e.id, &home).is_err());
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&trash);
    }

    #[test]
    fn move_to_trash_rejects_dirs_and_missing_files() {
        let trash = tmp_dir("t5");
        let dir = tmp_dir("dirfile");
        assert!(move_to_trash(&trash, &dir, 1).unwrap_err().contains("目录"));
        let missing = dir.join("nope.txt");
        assert!(move_to_trash(&trash, &missing, 1).unwrap_err().contains("不存在"));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&trash);
    }

    #[test]
    fn empty_trash_removes_all_entries_and_sidecars() {
        let home = tmp_dir("home6");
        let trash = tmp_dir("t6");
        for i in 0..3 {
            let f = home.join(format!("f{}.txt", i));
            std::fs::write(&f, "x").unwrap();
            move_to_trash(&trash, &f, 1_700_000_000_000 + i).unwrap();
        }
        assert_eq!(list_trash(&trash).len(), 3);
        let n = empty_trash(&trash).unwrap();
        assert_eq!(n, 6, "3 个文件 + 3 个 sidecar");
        assert!(list_trash(&trash).is_empty());
        // 空目录/不存在目录都返回 0，不报错
        assert_eq!(empty_trash(&trash).unwrap(), 0);
        assert_eq!(empty_trash(&tmp_dir("none7")).unwrap(), 0);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&trash);
    }

    #[test]
    fn purge_old_only_removes_expired_entries() {
        let home = tmp_dir("home8");
        let trash = tmp_dir("t8");
        let day_ms = 24 * 60 * 60 * 1000u64;
        let now = 1_700_000_000_000u64;
        // 40 天前的老条目 + 刚刚的新条目
        let old = home.join("old.txt");
        std::fs::write(&old, "old").unwrap();
        move_to_trash(&trash, &old, now - 40 * day_ms).unwrap();
        let fresh = home.join("fresh.txt");
        std::fs::write(&fresh, "fresh").unwrap();
        move_to_trash(&trash, &fresh, now).unwrap();

        let purged = purge_old(&trash, now, AUTO_PURGE_DAYS);
        assert_eq!(purged, 1);
        let left = list_trash(&trash);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].name, "fresh.txt");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&trash);
    }

    #[test]
    fn list_on_missing_dir_is_empty_and_helpers_are_safe() {
        let ghost = std::env::temp_dir().join("dsy-trash-not-here-xyz");
        assert!(list_trash(&ghost).is_empty());
        assert_eq!(purge_old(&ghost, 1, 30), 0);
        // 名字安全化：路径分隔符/隐藏前缀/空串
        assert_eq!(safe_file_name("a/b.txt"), "a_b.txt");
        assert_eq!(safe_file_name("..hidden"), "hidden");
        assert_eq!(safe_file_name("   "), "unnamed");
        assert_eq!(safe_file_name(""), "unnamed");
        // id 时间解析
        assert_eq!(id_millis("1700000000000-f.txt"), Some(1_700_000_000_000));
        assert_eq!(id_millis("notatimestamp-f.txt"), None);
    }

    #[test]
    fn entry_without_sidecar_still_lists_but_cannot_restore() {
        let home = tmp_dir("home9");
        let trash = tmp_dir("t9");
        // 手工放一个孤儿条目（模拟 sidecar 被删）
        std::fs::write(trash.join("1700000000000-lonely.txt"), "data").unwrap();
        let list = list_trash(&trash);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "lonely.txt", "无 sidecar 时用 id 推导展示名");
        assert_eq!(list[0].deleted_at, 1_700_000_000, "用 id 里的时间戳");
        assert_eq!(list[0].original, "");
        assert!(restore(&trash, "1700000000000-lonely.txt", &home).is_err());
        // 不存在的条目 → 明确报错
        assert!(restore(&trash, "ghost.txt", &home).is_err());
        // 展示名推导：去时间戳前缀；无前缀时原样返回
        assert_eq!(display_name_from_id("1700000000000-lonely.txt"), "lonely.txt");
        assert_eq!(display_name_from_id("plain.txt"), "plain.txt");
        assert_eq!(display_name_from_id("1700000000000-"), "1700000000000-");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&trash);
    }
}
