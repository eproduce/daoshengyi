//! 命令执行策略引擎（S1，Codex 能力整合第一批落地）
//!
//! 借鉴 OpenAI Codex `execpolicy` 的机制，做了轻量本地实现（不引 Starlark 等重型依赖）：
//! 规则文件 `app_data/execpolicy.rules`（纯文本，每行一条规则，`#` 注释；文件顺序优先、首条命中生效）。
//!
//! 规则语法：
//! ```text
//! allow  <命令前缀>            # 匹配则直接放行（即使命中内置危险模式）
//! deny   <命令前缀>            # 匹配则直接拦截
//! prompt <命令前缀>            # 匹配则必须用户确认
//! network allow|deny <域名>     # 网络域名白/黑名单（S8 预留，当前忽略不解析）
//! ```
//!
//! 前缀匹配：命令按空白拆 token（引号感知），规则前缀逐 token 比对；规则 token 以 `=` 结尾时
//! 按「命令 token 以该规则 token 开头」匹配（覆盖 `dd if=/dev/...` 这类值随命令变化的参数）。
//!
//! 与现有审批的关系：`runCommand` 先查策略（deny 拦截 / allow 放行 / prompt 或未命中走现有
//! manual/smart/yolo 三档审批）；前端 `DANGEROUS_PATTERNS` 仍是未命中规则时的兜底。

use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny,
    Prompt,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub action: Decision,
    pub pattern: Vec<String>,
}

/// 默认规则：迁移原前端 `DANGEROUS_PATTERNS` 为 deny 前缀规则。
/// 规则文件不存在或为空时自动落盘此内容（开箱即有基础保护）。
pub const DEFAULT_RULES: &str = r#"# 道生一 · 命令执行策略（S1）
# 语法：allow | deny | prompt <命令前缀>（按 token 前缀匹配；文件顺序优先、首条命中生效）
# 示例：allow git status     —— 该命令不再确认
#       deny  rm -rf          —— 直接拦截
#       network allow github.com  —— 网络域名白名单（预留）
# 若误改导致命令被拦：设置→权限→命令执行策略 可「恢复默认」。

# —— 内置危险命令（deny 硬拦截；想放行请在文件更前面加 allow）——
deny rm -rf
deny rm -fr
deny sudo
deny mkfs
deny dd if=
deny shutdown
deny reboot
deny git reset --hard
deny git push --force
deny chmod -R 777
"#;

/// 命令字符串 → token 列表（引号感知：`"a b"` / `'c d'` 保留为单个 token）
pub fn tokenize(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in s.chars() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else {
                    cur.push(c);
                }
            }
            None => {
                if c == '\'' || c == '"' {
                    quote = Some(c);
                } else if c.is_whitespace() {
                    if !cur.is_empty() {
                        out.push(std::mem::take(&mut cur));
                    }
                } else {
                    cur.push(c);
                }
            }
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// 解析一行规则；注释 / 空行 / 非法格式 / `network ...`（S8 预留）返回 None
pub fn parse_rule(line: &str) -> Option<Rule> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let mut it = line.splitn(2, char::is_whitespace);
    let action = it.next()?.trim().to_ascii_lowercase();
    let rest = it.next()?.trim();
    if rest.is_empty() || action.starts_with("network") {
        return None;
    }
    let action = match action.as_str() {
        "allow" => Decision::Allow,
        "deny" => Decision::Deny,
        "prompt" => Decision::Prompt,
        _ => return None,
    };
    Some(Rule {
        action,
        pattern: tokenize(rest),
    })
}

/// 解析整个规则文件内容 → 命令规则列表
pub fn parse_rules(content: &str) -> Vec<Rule> {
    content.lines().filter_map(parse_rule).collect()
}

/// 规则 token 匹配：默认精确相等；规则 token 以 `=` 结尾时命令 token 以其为前缀
fn token_matches(cmd: &str, pat: &str) -> bool {
    if pat.ends_with('=') {
        cmd.starts_with(pat)
    } else {
        cmd == pat
    }
}

/// 前缀匹配：规则 pattern 是命令 token 序列的前缀
fn prefix_matches(tokens: &[String], pattern: &[String]) -> bool {
    if pattern.is_empty() || pattern.len() > tokens.len() {
        return false;
    }
    tokens
        .iter()
        .zip(pattern.iter())
        .all(|(t, p)| token_matches(t, p))
}

/// 评估命令：返回 (决策, 命中规则描述)；文件顺序优先、首条命中生效；未命中返回 (None, None)
pub fn evaluate_command(cmd: &str, rules: &[Rule]) -> (Decision, Option<String>) {
    let tokens = tokenize(cmd);
    if tokens.is_empty() {
        return (Decision::None, None);
    }
    for r in rules {
        if prefix_matches(&tokens, &r.pattern) {
            return (r.action.clone(), Some(r.pattern.join(" ")));
        }
    }
    (Decision::None, None)
}

/// 规则文件路径
pub fn rules_path(app_dir: &std::path::Path) -> PathBuf {
    app_dir.join("execpolicy.rules")
}

/// 读取规则：文件不存在或为空 → 落盘默认规则并返回；存在 → 按内容解析
pub fn load_rules(app_dir: &std::path::Path) -> Vec<Rule> {
    let p = rules_path(app_dir);
    match std::fs::read_to_string(&p) {
        Ok(s) if !s.trim().is_empty() => parse_rules(&s),
        _ => {
            let _ = std::fs::create_dir_all(app_dir);
            let _ = std::fs::write(&p, DEFAULT_RULES);
            parse_rules(DEFAULT_RULES)
        }
    }
}

/// 当前策略评估结果（前端可读）
#[derive(Debug, Clone, serde::Serialize)]
pub struct PolicyResult {
    pub decision: String, // "allow" | "deny" | "prompt" | "none"
    pub matched: Option<String>,
}

fn policy_result(app: &tauri::AppHandle, command: &str) -> PolicyResult {
    let app_dir = app.path().app_data_dir().unwrap_or_default();
    let rules = load_rules(&app_dir);
    let (d, m) = evaluate_command(command, &rules);
    PolicyResult {
        decision: match d {
            Decision::Allow => "allow",
            Decision::Deny => "deny",
            Decision::Prompt => "prompt",
            Decision::None => "none",
        }
        .to_string(),
        matched: m,
    }
}

/// 执行前评估命令策略（前端 /run 与 run_command 工具调用前调用）
#[tauri::command]
pub fn check_command_policy(
    app: tauri::AppHandle,
    command: String,
) -> Result<PolicyResult, String> {
    Ok(policy_result(&app, &command))
}

/// 测试一条命令的决策（设置页用，不落盘）
#[tauri::command]
pub fn test_command_policy(app: tauri::AppHandle, command: String) -> Result<PolicyResult, String> {
    Ok(policy_result(&app, &command))
}

/// 读取当前规则文件内容（设置页编辑用）
#[tauri::command]
pub fn list_exec_rules(app: tauri::AppHandle) -> Result<String, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let p = rules_path(&app_dir);
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(_) => {
            let _ = std::fs::create_dir_all(&app_dir);
            let _ = std::fs::write(&p, DEFAULT_RULES);
            Ok(DEFAULT_RULES.to_string())
        }
    }
}

/// 保存整份规则文件（设置页编辑）
#[tauri::command]
pub fn save_exec_rules(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    std::fs::write(rules_path(&app_dir), content).map_err(|e| e.to_string())
}

/// 恢复默认规则
#[tauri::command]
pub fn reset_exec_rules(app: tauri::AppHandle) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    std::fs::write(rules_path(&app_dir), DEFAULT_RULES).map_err(|e| e.to_string())
}

/// 追加一条规则（供「审批后记住此命令」等场景，追加到文件末尾）
#[tauri::command]
pub fn append_command_rule(app: tauri::AppHandle, rule: String) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    let p = rules_path(&app_dir);
    let mut content = std::fs::read_to_string(&p).unwrap_or_else(|_| DEFAULT_RULES.to_string());
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&rule);
    content.push('\n');
    std::fs::write(&p, content).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_handles_quotes() {
        assert_eq!(tokenize("rm -rf /tmp/x"), vec!["rm", "-rf", "/tmp/x"]);
        assert_eq!(tokenize("echo \"a b\" 'c d'"), vec!["echo", "a b", "c d"]);
        assert_eq!(tokenize(""), Vec::<String>::new());
    }

    #[test]
    fn parse_rule_variants() {
        let r = parse_rule("allow git status").unwrap();
        assert_eq!(r.action, Decision::Allow);
        assert_eq!(r.pattern, vec!["git", "status"]);
        assert_eq!(parse_rule("deny rm -rf").unwrap().action, Decision::Deny);
        assert_eq!(parse_rule("prompt sudo").unwrap().action, Decision::Prompt);
        assert!(parse_rule("# 注释").is_none());
        assert!(parse_rule("").is_none());
        assert!(parse_rule("unknown foo").is_none());
        assert!(parse_rule("network allow github.com").is_none());
    }

    #[test]
    fn evaluate_allow_deny_prompt_none() {
        let rules = vec![
            Rule {
                action: Decision::Deny,
                pattern: tokenize("sudo"),
            },
            Rule {
                action: Decision::Allow,
                pattern: tokenize("git status"),
            },
        ];
        assert_eq!(evaluate_command("sudo rm -rf /", &rules).0, Decision::Deny);
        assert_eq!(
            evaluate_command("git status --short", &rules).0,
            Decision::Allow
        );
        assert_eq!(evaluate_command("ls -la", &rules).0, Decision::None);
    }

    #[test]
    fn default_rules_catch_dangerous() {
        let rules = parse_rules(DEFAULT_RULES);
        assert_eq!(evaluate_command("rm -rf /tmp/x", &rules).0, Decision::Deny);
        assert_eq!(evaluate_command("rm -fr /tmp", &rules).0, Decision::Deny);
        assert_eq!(
            evaluate_command("sudo apt install x", &rules).0,
            Decision::Deny
        );
        assert_eq!(
            evaluate_command("dd if=/dev/zero of=/dev/sda bs=1M", &rules).0,
            Decision::Deny
        );
        assert_eq!(
            evaluate_command("git push --force origin main", &rules).0,
            Decision::Deny
        );
        assert_eq!(evaluate_command("git status", &rules).0, Decision::None);
        assert_eq!(evaluate_command("ls", &rules).0, Decision::None);
    }

    #[test]
    fn first_match_wins_order() {
        let rules = vec![
            Rule {
                action: Decision::Allow,
                pattern: tokenize("git push --force"),
            },
            Rule {
                action: Decision::Deny,
                pattern: tokenize("git push"),
            },
        ];
        assert_eq!(
            evaluate_command("git push --force origin", &rules).0,
            Decision::Allow
        );
        let reversed = vec![rules[1].clone(), rules[0].clone()];
        assert_eq!(
            evaluate_command("git push --force origin", &reversed).0,
            Decision::Deny
        );
    }

    #[test]
    fn token_with_equals_is_prefix_match() {
        let rules = vec![Rule {
            action: Decision::Deny,
            pattern: tokenize("dd if="),
        }];
        assert_eq!(
            evaluate_command("dd if=/dev/zero of=/x", &rules).0,
            Decision::Deny
        );
    }

    #[test]
    fn parse_rules_skips_comments_and_network() {
        let rules = parse_rules("# hi\ndeny rm -rf\n\nnetwork allow github.com\nallow git status");
        assert_eq!(rules.len(), 2);
    }
}
