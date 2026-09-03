//! 安全审计自检（O6，OpenClaw 能力整合第二批）
//!
//! doctor 式配置自检：核查命令执行策略兜底 / 路径白名单 / 密钥文件权限 /
//! SSRF 防护 / 命令审批模式 / IM 网关白名单。决策纯函数便于单测；
//! lib.rs 负责从数据库/设置/文件系统组装 `SecurityInput` 后调用 `run_checks`。
//!
//! 借鉴 OpenClaw「security audit + doctor」机制，但按道生一自身配置项自研，
//! 不照搬其实现与命名。

/// 单条自检结果（前端 HealthPanel「安全审计」区块展示）
#[derive(Debug, Clone, serde::Serialize)]
pub struct SecurityCheck {
    pub id: &'static str,
    pub name: &'static str,
    pub ok: bool,
    pub detail: String,
}

/// 自检输入（由命令层从真实配置组装）
pub struct SecurityInput<'a> {
    /// execpolicy.rules 原始内容（含默认规则文本）
    pub rules_text: &'a str,
    /// 文件/命令路径白名单（allowed_paths）
    pub allowed_paths: &'a [String],
    /// SSRF：是否拒绝抓取内网/保留地址
    pub ssrf_deny_private: bool,
    /// 危险命令审批模式：manual / smart / yolo
    pub approval_mode: &'a str,
    /// secret.key 文件权限是否 0600（组/其他无权限位；非 unix 恒 true）
    pub key_mode_ok: bool,
    /// 密钥能否加载（SecretCipher::new 成功）
    pub key_loadable: bool,
    /// IM 网关是否启用
    pub im_enabled: bool,
    /// IM 网关白名单是否为空
    pub im_whitelist_empty: bool,
}

/// 系统危险目录：命中即视为白名单配置过宽（配合沙箱 P-A8 语义）
const DANGEROUS_DIRS: &[&str] = &[
    "/etc", "/bin", "/sbin", "/usr", "/System", "/private", "/dev", "/proc", "/sys", "/var/root",
];

/// 依次执行全部自检，返回结构化结果列表
pub fn run_checks(inp: &SecurityInput) -> Vec<SecurityCheck> {
    vec![
        execpolicy_check(inp.rules_text),
        allowed_paths_check(inp.allowed_paths),
        secret_key_check(inp.key_mode_ok, inp.key_loadable),
        ssrf_check(inp.ssrf_deny_private),
        approval_mode_check(inp.approval_mode),
        im_gateway_check(inp.im_enabled, inp.im_whitelist_empty),
    ]
}

/// 命令执行策略：必须有 deny 兜底（默认 deny rm -rf / sudo / mkfs 等）
fn execpolicy_check(rules_text: &str) -> SecurityCheck {
    let rules = crate::execpolicy::parse_rules(rules_text);
    let deny = rules.iter().filter(|r| r.action == crate::execpolicy::Decision::Deny).count();
    let allow = rules.iter().filter(|r| r.action == crate::execpolicy::Decision::Allow).count();
    let prompt = rules.len().saturating_sub(deny + allow);
    SecurityCheck {
        id: "execpolicy",
        name: "命令执行策略兜底",
        ok: deny > 0,
        detail: if deny > 0 {
            format!("共 {} 条规则：deny {} / allow {} / prompt {}，危险命令有 deny 兜底", rules.len(), deny, allow, prompt)
        } else {
            "规则文件缺失或没有 deny 兜底（建议保留默认：deny rm -rf / sudo / mkfs 等）".to_string()
        },
    }
}

/// 路径白名单：空=读不设限（写仍限主目录，属默认）；命中系统危险目录=过宽
fn allowed_paths_check(paths: &[String]) -> SecurityCheck {
    let bad: Vec<&String> = paths
        .iter()
        .filter(|p| {
            let t = p.trim();
            t == "/" || DANGEROUS_DIRS.iter().any(|d| t == *d || t.starts_with(&format!("{}/", d)))
        })
        .collect();
    SecurityCheck {
        id: "allowed_paths",
        name: "路径白名单",
        ok: bad.is_empty(),
        detail: if bad.is_empty() {
            if paths.is_empty() {
                "未配置白名单（Agent 读操作不限、写操作仍限主目录；可在设置→权限收紧）".to_string()
            } else {
                format!("已配置 {} 条白名单，未含系统危险目录", paths.len())
            }
        } else {
            format!("白名单含危险目录：{}（建议移除）", bad.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("、"))
        },
    }
}

/// 密钥文件：0600 权限 + 可加载
fn secret_key_check(mode_ok: bool, loadable: bool) -> SecurityCheck {
    let ok = mode_ok && loadable;
    SecurityCheck {
        id: "secret_key",
        name: "密钥文件安全",
        ok,
        detail: if ok {
            "secret.key 权限 0600 且可正常加载".to_string()
        } else if !loadable {
            "无法加载密钥文件（secret.key 缺失或损坏？）".to_string()
        } else {
            "secret.key 权限非 0600（组/其他可读），建议收紧为仅属主可读写".to_string()
        },
    }
}

/// SSRF 防护：拒绝内网/保留地址（fetch_page 等出站请求）
fn ssrf_check(deny_private: bool) -> SecurityCheck {
    SecurityCheck {
        id: "ssrf",
        name: "SSRF 防护",
        ok: deny_private,
        detail: if deny_private {
            "已开启：拒绝抓取内网/保留地址（环回/链路本地最危险段必拦）".to_string()
        } else {
            "已关闭内网地址拦截（fetch_page/web_search 可访问内网，建议开启）".to_string()
        },
    }
}

/// 命令审批模式：yolo 自动批准危险命令 = 高风险
fn approval_mode_check(mode: &str) -> SecurityCheck {
    let is_yolo = mode == "yolo";
    SecurityCheck {
        id: "approval",
        name: "命令审批模式",
        ok: !is_yolo,
        detail: if is_yolo {
            "YOLO 模式：危险命令自动批准、不弹确认（请仅在可信环境使用）".to_string()
        } else {
            match mode {
                "smart" => "Smart 模式：由辅助模型智能判断危险命令".to_string(),
                "manual" => "手动模式：危险命令需用户确认（最安全）".to_string(),
                other => format!("当前审批模式：{}", other),
            }
        },
    }
}

/// IM 网关：启用但无 chat_id 白名单 = 任何会话可触发
fn im_gateway_check(enabled: bool, whitelist_empty: bool) -> SecurityCheck {
    let ok = !enabled || !whitelist_empty;
    SecurityCheck {
        id: "im_gateway",
        name: "IM 网关白名单",
        ok,
        detail: if !enabled {
            "IM 网关未启用".to_string()
        } else if whitelist_empty {
            "IM 网关已启用但白名单为空（任意会话可触发 Agent，建议在设置→即时聊天填写 chat_id 白名单）".to_string()
        } else {
            "IM 网关已启用且配置了会话白名单".to_string()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> SecurityInput<'static> {
        SecurityInput {
            rules_text: crate::execpolicy::DEFAULT_RULES,
            allowed_paths: &[],
            ssrf_deny_private: true,
            approval_mode: "manual",
            key_mode_ok: true,
            key_loadable: true,
            im_enabled: false,
            im_whitelist_empty: true,
        }
    }

    fn by_id<'a>(checks: &'a [SecurityCheck], id: &str) -> &'a SecurityCheck {
        checks.iter().find(|c| c.id == id).expect("check exists")
    }

    #[test]
    fn default_config_all_ok() {
        let checks = run_checks(&base());
        assert!(checks.iter().all(|c| c.ok), "默认配置应全部通过: {:?}", checks);
    }

    #[test]
    fn execpolicy_missing_deny_warns() {
        let mut inp = base();
        inp.rules_text = "# 只有 allow 没有 deny\nallow git status\n";
        assert!(!by_id(&run_checks(&inp), "execpolicy").ok, "无 deny 兜底应告警");
    }

    #[test]
    fn dangerous_allowed_path_warns() {
        let mut inp = base();
        let p1 = vec![String::from("/etc"), String::from("/Users/me/work")];
        inp.allowed_paths = &p1;
        assert!(!by_id(&run_checks(&inp), "allowed_paths").ok, "含 /etc 应告警");
        let p2 = vec![String::from("/Users/me/work"), String::from("/Users/me/notes")];
        inp.allowed_paths = &p2;
        assert!(by_id(&run_checks(&inp), "allowed_paths").ok, "仅主目录子路径应通过");
    }

    #[test]
    fn secret_key_and_ssrf_checks() {
        let mut inp = base();
        inp.key_mode_ok = false;
        assert!(!by_id(&run_checks(&inp), "secret_key").ok, "密钥权限非 0600 应告警");
        inp.key_mode_ok = true;
        inp.key_loadable = false;
        assert!(!by_id(&run_checks(&inp), "secret_key").ok, "密钥不可加载应告警");
        let mut inp2 = base();
        inp2.ssrf_deny_private = false;
        assert!(!by_id(&run_checks(&inp2), "ssrf").ok, "SSRF 关闭应告警");
    }

    #[test]
    fn yolo_and_im_checks() {
        let mut inp = base();
        inp.approval_mode = "yolo";
        assert!(!by_id(&run_checks(&inp), "approval").ok, "yolo 应告警");
        inp.approval_mode = "smart";
        assert!(by_id(&run_checks(&inp), "approval").ok, "smart 通过");
        let mut inp2 = base();
        inp2.im_enabled = true;
        inp2.im_whitelist_empty = true;
        assert!(!by_id(&run_checks(&inp2), "im_gateway").ok, "IM 启用+空白名单应告警");
        inp2.im_whitelist_empty = false;
        assert!(by_id(&run_checks(&inp2), "im_gateway").ok, "IM 启用+白名单通过");
    }
}
