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

use std::net::{Ipv4Addr, Ipv6Addr, ToSocketAddrs};

/// SSRF 策略
#[derive(Debug, Clone)]
pub struct SsrfPolicy {
    /// 是否拒绝私有/保留地址（默认 true）
    pub deny_private: bool,
    /// 完全放行的 hostname 白名单（精确或子域；命中即使解析到私有地址也放行）
    pub allow_hosts: Vec<String>,
    /// 允许解析到私有地址的 hostname（环回/链路本地/未指定等最危险段仍拦）
    pub allow_private_hosts: Vec<String>,
}

impl Default for SsrfPolicy {
    fn default() -> Self {
        Self {
            deny_private: true,
            allow_hosts: Vec::new(),
            allow_private_hosts: Vec::new(),
        }
    }
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

/// 环回 / 链路本地 / 未指定：即使命中 allow_private_hosts 也不放行的最危险段
fn is_loopback_or_link_local(ip: &str) -> bool {
    if let Ok(v4) = ip.parse::<Ipv4Addr>() {
        return v4.is_loopback() || v4.is_link_local() || v4.is_unspecified();
    }
    if let Ok(v6) = ip.parse::<Ipv6Addr>() {
        return v6.is_loopback() || ipv6_is_link_local(&v6) || v6.is_unspecified();
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

/// 主入口：对完整 URL 做 SSRF 判定。通过返回 Ok；命中内网/保留地址返回 Err（含明确原因）。
pub fn check_url(url: &str, policy: &SsrfPolicy) -> Result<(), String> {
    let host = extract_host(url).ok_or_else(|| "无法解析 URL 主机名".to_string())?;
    if !policy.deny_private {
        return Ok(());
    }
    // 完全白名单：命中即放行（即使解析到私有地址）
    if host_match(&host, &policy.allow_hosts) {
        return Ok(());
    }
    // 收集目标 IP：host 本身就是 IP 字面量则直接用；域名则做一次 DNS 解析再按 IP 校验
    let ips: Vec<String> = if host.parse::<Ipv4Addr>().is_ok() || host.parse::<Ipv6Addr>().is_ok() {
        vec![host.clone()]
    } else {
        match (host.as_str(), 0u16).to_socket_addrs() {
            Ok(addrs) => addrs.map(|a| a.ip().to_string()).collect(),
            // 解析失败（NXDOMAIN 等）：请求本身会失败，不在此误拦
            Err(_) => return Ok(()),
        }
    };
    if ips.is_empty() {
        return Ok(());
    }
    // allow_private_hosts 命中：允许私有地址，但环回/链路本地/未指定仍拦
    let allow_private = host_match(&host, &policy.allow_private_hosts);
    if allow_private {
        if ips.iter().any(|ip| is_loopback_or_link_local(ip)) {
            return Err(block_msg(&host));
        }
        return Ok(());
    }
    if ips.iter().any(|ip| is_private_ip(ip)) {
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
    fn ip_literal_blocked_unless_allowed() {
        let p = SsrfPolicy::default();
        assert!(check_url("http://127.0.0.1:8080/", &p).is_err());
        assert!(check_url("http://192.168.1.1/admin", &p).is_err());
        assert!(check_url("http://169.254.169.254/latest/meta-data", &p).is_err());
        assert!(check_url("https://8.8.8.8/", &p).is_ok());
        assert!(check_url("http://[::1]:3000/", &p).is_err());
        // allow_hosts 白名单精确放行私有 IP
        let allow = SsrfPolicy {
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
            check_url("http://localhost/", &p).is_err(),
            "localhost 应被拦截"
        );
        // 子域白名单
        let b = SsrfPolicy {
            allow_hosts: vec!["example.com".into()],
            ..Default::default()
        };
        assert!(check_url("http://api.example.com/x", &b).is_ok());
        // allow_private_hosts 命中 localhost → 仍拦环回
        let a = SsrfPolicy {
            allow_private_hosts: vec!["localhost".into()],
            ..Default::default()
        };
        assert!(
            check_url("http://localhost:8080/", &a).is_err(),
            "allow_private_hosts 不能放行环回"
        );
    }
}
