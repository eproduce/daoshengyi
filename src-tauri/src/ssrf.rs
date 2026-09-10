//! SSRF 防护模块
//!
//! 背景：agent 会用 `fetch_page` 抓取用户/模型给出的 URL，若目标不设防，
//! 恶意/误给的 URL 可能指向内网（127.0.0.1 / 192.168.x / 云元数据 169.254.169.254 等），
//! 造成 SSRF（服务端请求伪造）。
//!
//! 策略判定思路借鉴 OpenClaw security-runtime 的"策略判定"，但为自研纯函数实现：
//! 解析出 hostname → 解析成 IP → 若属私有/保留段则拦截（按解析后 IP 校验，缓解
//! DNS rebinding，而非仅校验 hostname）；支持 allowHosts / allowPrivateHosts 白名单（子域通配）。
//!
//! 本模块尽量保持纯函数 + 同步判定，便于离线单测；DNS 解析只在域名场景发生。

use std::net::{Ipv4Addr, Ipv6Addr};

/// SSRF 策略
#[derive(Debug, Clone)]
pub struct SsrfPolicy {
    /// 是否拒绝私有/保留地址（默认 true）
    pub deny_private: bool,
    /// 是否放行**本机环回**（127.0.0.0/8、::1、localhost）。默认 true。
    /// 桌面 agent 需抓取本机预览服务/本地 API（提示词本身就引导用本地静态服务验证渲染）；
    /// 且同能力已可由 run_command 的 curl 直接达到，拦 fetch_page 无实际安全收益。
    /// 置 false 则恢复「环回也拦」的严格模式。
    pub allow_loopback: bool,
    /// 完全放行的 hostname 白名单（精确或子域；命中即使解析到私有地址也放行）
    pub allow_hosts: Vec<String>,
    /// 允许解析到私有地址的 hostname（环回/链路本地/未指定等最危险段仍拦）
    pub allow_private_hosts: Vec<String>,
}

impl Default for SsrfPolicy {
    fn default() -> Self {
        Self {
            deny_private: true,
            allow_loopback: true,
            allow_hosts: Vec::new(),
            allow_private_hosts: Vec::new(),
        }
    }
}

/// hostname/IP 文本是否指向本机环回（localhost、*.localhost、127.0.0.0/8、::1）
pub fn is_loopback_host(host: &str) -> bool {
    let h = host.trim().trim_end_matches('.').to_lowercase();
    if h == "localhost" || h.ends_with(".localhost") {
        return true;
    }
    if let Ok(v4) = h.parse::<Ipv4Addr>() {
        return v4.is_loopback();
    }
    if let Ok(v6) = h.parse::<Ipv6Addr>() {
        return v6.is_loopback();
    }
    false
}

/// 判定某个 IP 文本是否属于私有/保留/不可路由段（纯函数，离线可测）
pub fn is_private_ip(ip: &str) -> bool {
    if let Ok(v4) = ip.parse::<Ipv4Addr>() {
        return v4.is_private()
            || v4.is_loopback()
            || v4.is_link_local()
            || v4.is_unspecified()
            || v4.is_broadcast();
    }
    if let Ok(v6) = ip.parse::<Ipv6Addr>() {
        return v6.is_loopback()
            || v6.is_unique_local()
            || ipv6_is_link_local(&v6)
            || v6.is_unspecified()
            || v6.is_multicast();
    }
    false
}

/// IPv6 链路本地：fe80::/10（兼容稳定 API，不用已改名的 is_unicast_link_local）
fn ipv6_is_link_local(v6: &Ipv6Addr) -> bool {
    (v6.segments()[0] & 0xffc0) == 0xfe80
}

/// 从 URL 提取 hostname（去 scheme / userinfo / 端口 / 路径，纯函数可测）
pub fn extract_host(url: &str) -> Option<String> {
    let s = url.trim();
    let rest = s.split_once("://").map(|(_, r)| r).unwrap_or(s);
    let after_auth = rest.split('@').next_back().unwrap_or(rest);
    let host_port = after_auth.split(['/', '?', '#']).next().unwrap_or("");
    if host_port.is_empty() {
        return None;
    }
    let host = if let Some(stripped) = host_port.strip_prefix('[') {
        stripped.split_once(']').map(|(h, _)| h).unwrap_or(stripped)
    } else {
        host_port.split(':').next().unwrap_or(host_port)
    };
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

/// hostname 是否命中白名单（支持子域：allow=example.com 命中 foo.example.com）
fn host_match(host: &str, list: &[String]) -> bool {
    let h = host.trim().to_lowercase();
    list.iter().any(|a| {
        let a = a.trim().trim_start_matches('.').to_lowercase();
        !a.is_empty() && (h == a || h.ends_with(&format!(".{}", a)))
    })
}

fn block_msg(host: &str) -> String {
    format!("目标地址 {} 为内网/保留地址，已按 SSRF 策略拦截", host)
}

/// 非 HTTP(S) 的 URL（file:、data:、无 scheme 裸路径等）返回给用户的**明确引导**；
/// 正常 http(s) URL 返回 None，交给后续 SSRF 校验。
/// 背景：agent 常把本地生成的 file:// 或磁盘路径当网页交给 fetch_page 去“验证渲染”，
/// 但 fetch_page 只抓 HTTP(S) 网页——这里直接点明正确工具，避免晦涩的“无法解析 URL 主机名”。
pub fn unsupported_scheme_hint(url: &str) -> Option<String> {
    let s = url.trim().to_lowercase();
    if s.starts_with("file:") {
        return Some(
            "fetch_page 不能抓取本地 file:// 文件（仅支持 HTTP(S) 网页）。读取本地文件内容请用 read_file；验证本地 HTML/页面渲染请用浏览器自动化（puppeteer_navigate 打开后 puppeteer_screenshot 截图），不要用 fetch_page 打开本地文件。"
                .to_string(),
        );
    }
    if !(s.starts_with("http://") || s.starts_with("https://")) {
        return Some(format!(
            "fetch_page 仅支持 http/https 网页 URL（收到无法识别的主机名或 scheme：{}）。请检查 URL 是否完整（形如 https://example.com/page）——本地文件/路径不能用 fetch_page，请改用 read_file 或浏览器自动化。",
            url.trim()
        ));
    }
    None
}

/// 域名是否属于“内网形态”（无需解析也应拦）：单标签主机名（localhost/router/nas…）、
/// 明确私有/内网后缀（.local/.internal/.lan/.corp/.home.arpa/.localhost）与云元数据域名。
/// 判定只看 hostname 形态、不依赖系统 DNS——本地代理/翻墙工具常把公网域名解析成
/// 内网/fake-ip（如 127.0.0.1），若按“解析后 IP”拦截会误伤几乎所有正常网站。
fn is_internal_hostname(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_lowercase();
    if !h.contains('.') {
        return true; // 单标签 = 内网主机名（localhost / router / nas 等）
    }
    const INTERNAL_SUFFIXES: [&str; 6] = [
        ".local", ".internal", ".lan", ".corp", ".home.arpa", ".localhost",
    ];
    if INTERNAL_SUFFIXES.iter().any(|s| h.ends_with(s)) {
        return true;
    }
    h == "metadata.google.internal" || h.ends_with(".metadata.google.internal")
}

/// 主入口：对完整 URL 做 SSRF 判定。通过返回 Ok；命中内网/保留地址返回 Err（含明确原因）。
pub fn check_url(url: &str, policy: &SsrfPolicy) -> Result<(), String> {
    let host = extract_host(url).ok_or_else(|| {
        "URL 缺少可解析的主机名（本地 file:// 文件请用 read_file 读取、或浏览器自动化打开验证；网页 URL 需为 http://… 或 https://… 且带域名）"
            .to_string()
    })?;
    if !policy.deny_private {
        return Ok(());
    }
    // 完全白名单：命中即放行
    if host_match(&host, &policy.allow_hosts) {
        return Ok(());
    }
    // 本机环回默认放行（allow_loopback）：本机预览服务/本地 API 是桌面 agent 的正常工作流
    //（提示词引导用本地静态服务验证渲染）；且同能力已可由 run_command 的 curl 达到，
    // 拦 fetch_page 无实际安全收益。需要严格模式可在设置里关掉。
    if policy.allow_loopback && is_loopback_host(&host) {
        return Ok(());
    }
    let is_ip = host.parse::<Ipv4Addr>().is_ok() || host.parse::<Ipv6Addr>().is_ok();
    if is_ip {
        // IP 字面量：直接按私有/保留段拦截（SSRF 主要威胁面：直连内网/云元数据）
        if is_private_ip(&host) {
            return Err(block_msg(&host));
        }
        return Ok(());
    }
    // 域名：仅对“内网形态”主机名拦截；普通公网域名一律放行（不做系统 DNS 解析后 IP
    // 校验——否则本地代理 fake-ip/DNS 改写会把正常网站误判成内网，表现为“很多网站被
    // 定义成内网”，导致 fetch_page 抓取权威站点全被拦）。
    if is_internal_hostname(&host) {
        // allow_private_hosts：可放行内网形态，但 localhost（环回）等最危险仍拦
        if host_match(&host, &policy.allow_private_hosts)
            && !(host == "localhost" || host.starts_with("localhost."))
        {
            return Ok(());
        }
        return Err(block_msg(&host));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_ipv4_segments() {
        // 私有/环回/链路本地/未指定/广播
        for ip in [
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.1",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "255.255.255.255",
        ] {
            assert!(is_private_ip(ip), "{} 应判为私有/保留", ip);
        }
        // 边界外与公网
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "114.114.114.114",
            "172.15.255.255",
            "172.32.0.1",
            "192.169.1.1",
        ] {
            assert!(!is_private_ip(ip), "{} 不应判为私有", ip);
        }
    }

    #[test]
    fn private_ipv6_segments() {
        for ip in [
            "::1",
            "::",
            "fc00::1",
            "fd12:3456::abcd",
            "fe80::1",
            "ff02::1",
        ] {
            assert!(is_private_ip(ip), "{} 应判为私有/保留", ip);
        }
        for ip in ["2001:4860:4860::8888", "2606:4700::1111"] {
            assert!(!is_private_ip(ip), "{} 不应判为私有", ip);
        }
    }

    #[test]
    fn extract_host_cases() {
        assert_eq!(
            extract_host("https://example.com/path?a=1"),
            Some("example.com".into())
        );
        assert_eq!(
            extract_host("http://user:pw@example.com:8080/x"),
            Some("example.com".into())
        );
        assert_eq!(
            extract_host("http://127.0.0.1:3000/"),
            Some("127.0.0.1".into())
        );
        assert_eq!(extract_host("https://[::1]:8080/x"), Some("::1".into()));
        assert_eq!(extract_host("http://[fd12::1]/"), Some("fd12::1".into()));
        assert_eq!(extract_host("example.com"), Some("example.com".into()));
        assert_eq!(extract_host(""), None);
        assert_eq!(extract_host("https://"), None);
    }

    #[test]
    fn unsupported_scheme_hint_cases() {
        // file:// 与裸本地路径 → 明确引导（提示走 read_file/浏览器自动化）
        let f = unsupported_scheme_hint("file:///Users/u/a/攻略.html").unwrap();
        assert!(f.contains("file://"), "应点名 file 文件");
        assert!(f.contains("read_file"));
        let f2 = unsupported_scheme_hint("/Users/u/a/攻略.html").unwrap();
        assert!(f2.contains("http/https"), "裸路径应提示仅支持 http(s)");
        assert!(unsupported_scheme_hint("data:text/html,x").is_some());
        // 正常 http(s) 返回 None（不误伤）
        assert!(unsupported_scheme_hint("https://example.com/a").is_none());
        assert!(unsupported_scheme_hint("http://127.0.0.1:8000/x").is_none());
    }

    #[test]
    fn ip_literal_blocked_unless_allowed() {
        let p = SsrfPolicy::default();
        // 本机环回默认放行（桌面 agent 需抓取本机预览服务/本地 API）
        assert!(check_url("http://127.0.0.1:8080/", &p).is_ok());
        assert!(check_url("http://[::1]:3000/", &p).is_ok());
        // 私有网段 / 链路本地 / 云元数据仍拦
        assert!(check_url("http://192.168.1.1/admin", &p).is_err());
        assert!(check_url("http://10.0.0.5/", &p).is_err());
        assert!(check_url("http://169.254.169.254/latest/meta-data", &p).is_err());
        assert!(check_url("https://8.8.8.8/", &p).is_ok());
        // 严格模式（allow_loopback=false）恢复「环回也拦」
        let strict = SsrfPolicy {
            allow_loopback: false,
            ..Default::default()
        };
        assert!(check_url("http://127.0.0.1:8080/", &strict).is_err());
        assert!(check_url("http://[::1]:3000/", &strict).is_err());
        // allow_hosts 白名单精确放行私有 IP（严格模式下亦可用）
        let allow = SsrfPolicy {
            allow_loopback: false,
            allow_hosts: vec!["127.0.0.1".into()],
            ..Default::default()
        };
        assert!(check_url("http://127.0.0.1:3000/", &allow).is_ok());
    }

    #[test]
    fn deny_off_allows_all() {
        let p = SsrfPolicy {
            deny_private: false,
            ..Default::default()
        };
        assert!(check_url("http://127.0.0.1/", &p).is_ok());
        assert!(check_url("http://192.168.1.1/", &p).is_ok());
    }

    #[test]
    fn hostname_resolution_blocked() {
        // localhost 由系统 hosts 稳定解析到环回——离线单测可用
        let p = SsrfPolicy::default();
        assert!(
            check_url("http://localhost/", &p).is_ok(),
            "本机环回默认放行（本机预览服务/本地 API 是正常开发流程）"
        );
        assert!(check_url("http://preview.localhost:8765/x", &p).is_ok());
        // 严格模式 → 环回也拦
        let strict = SsrfPolicy {
            allow_loopback: false,
            ..Default::default()
        };
        assert!(
            check_url("http://localhost/", &strict).is_err(),
            "严格模式下 localhost 应被拦截"
        );
        // 子域白名单
        let b = SsrfPolicy {
            allow_hosts: vec!["example.com".into()],
            ..Default::default()
        };
        assert!(check_url("http://api.example.com/x", &b).is_ok());
        // allow_private_hosts 命中 localhost → 严格模式下仍拦环回（需 allow_hosts 才能放行）
        let a = SsrfPolicy {
            allow_loopback: false,
            allow_private_hosts: vec!["localhost".into()],
            ..Default::default()
        };
        assert!(
            check_url("http://localhost:8080/", &a).is_err(),
            "allow_private_hosts 不能放行环回"
        );
    }
}
