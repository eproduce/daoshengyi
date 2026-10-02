//! 网络代理解析与注入（2026-10-02）
//!
//! 实战背景：用户机器上代理软件以 **fake-IP** 模式劫持 DNS ——
//! `dig +short A upload.wikimedia.org` 返回 `198.18.0.89`（RFC 2544 基准网段，不是真实地址），
//! 于是 shell 里的 curl / wget / pip / git 直连**必然随机超时或被重置**；而代理端口本身是通的
//! （`curl -x http://127.0.0.1:7897 ...` 能访问）。agent 当时只能围绕同一个下载任务反复重写
//! 脚本重试，把整轮工具轮次烧光（45 次 run_command）。
//!
//! 此前只有 `scutil --proxy` 一条路：用户没在系统设置里开「系统代理」时它全为 0，
//! 什么都拿不到。本模块补齐三级来源（优先级从高到低）：
//!   ① 用户显式环境变量（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY，大小写皆认）
//!   ② macOS 系统代理（`scutil --proxy`）
//!   ③ 本机常见代理端口自动探测（先 TCP 连通，再用 HTTP `CONNECT` 握手确认“这确实是代理”）
//!
//! 解析结果缓存 5 分钟（探测有等待成本，命令是高频调用）；用环境变量
//! `DAOSHENGYI_NO_PROXY=1` 可整体关闭“自动探测 + 注入”。
//!
//! 注入点：`run_command`（lib.rs::run_shell_command_with）与 `exec_command`（pty.rs::pty_spawn_with）。
//! 同时注入 `NO_PROXY`，避免回环/本机服务被误代理。

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 常见本地代理端口（Clash / Surge / QuantumultX / V2Ray 等的默认值）
pub const COMMON_PROXY_PORTS: &[u16] =
    &[7897, 7890, 7891, 1080, 1087, 8888, 8080, 6152, 8889, 2017];
/// 注入代理时排除的地址（回环/本机服务不该走代理）
pub const NO_PROXY_VALUE: &str = "localhost,127.0.0.1,::1,0.0.0.0";
/// 短路开关：设为 `1` / `true` / `yes` 时不做任何代理解析与注入
pub const DISABLE_ENV: &str = "DAOSHENGYI_NO_PROXY";

const CACHE_TTL: Duration = Duration::from_secs(300);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(120);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(700);
/// 探测总预算：代理软件没开时不能让每个命令都白等（缓存未命中时最多等这么久）
const PROBE_BUDGET: Duration = Duration::from_millis(2000);

/// 缓存：(解析时刻, 结果)。`None` 也要缓存 —— 「没有可用代理」同样值得记住，
/// 否则每次执行命令都要重扫一遍端口。
static CACHE: Mutex<Option<(Instant, Option<String>)>> = Mutex::new(None);

/// 从 `scutil --proxy` 输出解析系统代理（纯函数，便于单测）。
/// 只有对应协议 `Enable` 为 1 且 host/port 非空才算数；优先 HTTPS，其次 HTTP。
pub fn system_proxy_from(text: &str) -> Option<String> {
    let mut enabled = false;
    let mut host: Option<String> = None;
    let mut port: Option<String> = None;
    for line in text.lines() {
        let t = line.trim();
        if let Some(v) = t.strip_prefix("HTTPSEnable") {
            enabled = enabled || v.contains('1');
        } else if let Some(v) = t.strip_prefix("HTTPSProxy") {
            host = Some(v.trim().trim_start_matches(':').trim().to_string());
        } else if let Some(v) = t.strip_prefix("HTTPSPort") {
            port = Some(v.trim().trim_start_matches(':').trim().to_string());
        } else if let Some(v) = t.strip_prefix("HTTPEnable") {
            enabled = enabled || v.contains('1');
        } else if let Some(v) = t.strip_prefix("HTTPProxy") {
            if host.is_none() {
                host = Some(v.trim().trim_start_matches(':').trim().to_string());
            }
        } else if let Some(v) = t.strip_prefix("HTTPPort") {
            if port.is_none() {
                port = Some(v.trim().trim_start_matches(':').trim().to_string());
            }
        }
    }
    if !enabled {
        return None;
    }
    match (host, port) {
        (Some(h), Some(p)) if !h.is_empty() && !p.is_empty() && p != "0" => {
            Some(format!("http://{}:{}", h, p))
        }
        _ => None,
    }
}

/// 读取 macOS 系统代理
pub fn system_proxy() -> Option<String> {
    let out = std::process::Command::new("scutil")
        .arg("--proxy")
        .output()
        .ok()?;
    system_proxy_from(&String::from_utf8_lossy(&out.stdout))
}

/// 补全代理 URL 的 scheme（`127.0.0.1:7897` → `http://127.0.0.1:7897`）
pub fn normalize_proxy_url(v: &str) -> String {
    let v = v.trim().trim_end_matches('/');
    if v.contains("://") {
        v.to_string()
    } else {
        format!("http://{v}")
    }
}

/// 从环境变量取值（纯函数，`lookup` 便于单测）。顺序即优先级，大小写都认。
pub fn env_proxy_from(lookup: impl Fn(&str) -> Option<String>) -> Option<String> {
    for k in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if let Some(v) = lookup(k) {
            let v = v.trim();
            if !v.is_empty() {
                return Some(normalize_proxy_url(v));
            }
        }
    }
    None
}

/// 读取进程环境变量里的代理
pub fn env_proxy() -> Option<String> {
    env_proxy_from(|k| std::env::var(k).ok())
}

/// 用户是否明确要求关闭自动代理处理
pub fn disabled() -> bool {
    match std::env::var(DISABLE_ENV) {
        Ok(v) => {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes" || v == "on"
        }
        Err(_) => false,
    }
}

/// 探测某端口是否为 HTTP 代理：发出 `CONNECT` 后只要收到一行 `HTTP/...` 状态行即可。
/// 200（隧道建立）、407（要认证）、403（被拒）都说明“这是代理”；无响应或非 HTTP → 不是。
pub fn is_http_proxy(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) else {
        return false;
    };
    let _ = s.set_write_timeout(Some(HANDSHAKE_TIMEOUT));
    let _ = s.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    if s.write_all(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 64];
    match s.read(&mut buf) {
        Ok(n) if n > 0 => String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/"),
        _ => false,
    }
}

/// 依次探测候选端口，返回第一个可用代理（`check` 注入便于单测）。
/// 受 `PROBE_BUDGET` 限制：端口全不通时最多等这么久。
pub fn first_working_proxy(ports: &[u16], check: impl Fn(u16) -> bool) -> Option<String> {
    let deadline = Instant::now() + PROBE_BUDGET;
    for &p in ports {
        if Instant::now() >= deadline {
            break;
        }
        if check(p) {
            return Some(format!("http://127.0.0.1:{p}"));
        }
    }
    None
}

/// 走完三级来源（不含缓存）
pub fn resolve_uncached() -> Option<String> {
    if disabled() {
        return None;
    }
    if let Some(p) = env_proxy() {
        return Some(p);
    }
    if let Some(p) = system_proxy() {
        return Some(p);
    }
    first_working_proxy(COMMON_PROXY_PORTS, is_http_proxy)
}

/// 有效代理（带 5 分钟缓存）。命中自动探测结果时打一条日志，便于排查“为什么走了代理”。
pub fn effective_proxy() -> Option<String> {
    if disabled() {
        return None;
    }
    let now = Instant::now();
    {
        let guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, val)) = guard.as_ref() {
            if now.saturating_duration_since(*at) < CACHE_TTL {
                return val.clone();
            }
        }
    }
    let val = resolve_uncached();
    if let Some(p) = val.as_deref() {
        eprintln!("[proxy] 使用代理 {p}（已注入到命令环境，可用 NO_PROXY 排除回环地址）");
    }
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some((now, val.clone()));
    val
}

/// 需要注入到子进程的环境变量对（无可用代理 → 空）
pub fn env_pairs_for_commands() -> Vec<(&'static str, String)> {
    match effective_proxy() {
        Some(p) => proxy_env_pairs(&p),
        None => Vec::new(),
    }
}

/// 代理对应的环境变量（大小写各一份：curl/git/npm/pip 认的大小写不一致）
pub fn proxy_env_pairs(proxy: &str) -> Vec<(&'static str, String)> {
    let p = normalize_proxy_url(proxy);
    vec![
        ("HTTP_PROXY", p.clone()),
        ("http_proxy", p.clone()),
        ("HTTPS_PROXY", p.clone()),
        ("https_proxy", p.clone()),
        ("ALL_PROXY", p.clone()),
        ("all_proxy", p),
        ("NO_PROXY", NO_PROXY_VALUE.to_string()),
        ("no_proxy", NO_PROXY_VALUE.to_string()),
    ]
}

/// 仅测试用：清空缓存（不在非测试代码里调用）
#[cfg(test)]
pub fn clear_cache() {
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// 用户机器实测输出（没开系统代理）—— 必须返回 None。
    /// 这正是「原来拿不到代理」的原因：系统代理为空，而实际代理跑在 7897。
    #[test]
    fn system_proxy_ignores_disabled_all_zero() {
        let real = "<dictionary> {\n  FTPPassive : 1\n  HTTPEnable : 0\n  HTTPPort : 0\n  \
                    HTTPProxy : 0.0.0.0\n  HTTPSEnable : 0\n  HTTPSPort : 0\n  HTTPSProxy : 0.0.0.0\n  \
                    ProxyAutoConfigEnable : 0\n  SOCKSEnable : 0\n}\n";
        assert_eq!(system_proxy_from(real), None);
    }

    #[test]
    fn system_proxy_parses_enabled_block() {
        let t = "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n  \
                 HTTPSEnable : 1\n  HTTPSPort : 7897\n  HTTPSProxy : 127.0.0.1\n}\n";
        assert_eq!(
            system_proxy_from(t).as_deref(),
            Some("http://127.0.0.1:7897")
        );
    }

    #[test]
    fn system_proxy_enabled_but_port_zero_is_none() {
        let t = "HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 0\n";
        assert_eq!(system_proxy_from(t), None);
    }

    #[test]
    fn normalize_proxy_url_adds_scheme_and_strips_trailing_slash() {
        assert_eq!(
            normalize_proxy_url("127.0.0.1:7897"),
            "http://127.0.0.1:7897"
        );
        assert_eq!(
            normalize_proxy_url(" http://127.0.0.1:7897/ "),
            "http://127.0.0.1:7897"
        );
        assert_eq!(
            normalize_proxy_url("socks5://127.0.0.1:1080"),
            "socks5://127.0.0.1:1080"
        );
    }

    #[test]
    fn env_proxy_prefers_https_then_http_and_skips_blank() {
        let hit = env_proxy_from(|k| match k {
            "HTTPS_PROXY" => Some("  ".into()),
            "https_proxy" => Some("127.0.0.1:7897".into()),
            "HTTP_PROXY" => Some("127.0.0.1:9999".into()),
            _ => None,
        });
        assert_eq!(hit.as_deref(), Some("http://127.0.0.1:7897"));

        assert_eq!(env_proxy_from(|_| None), None);
    }

    #[test]
    fn first_working_proxy_skips_dead_ports_and_returns_first_hit() {
        let got = first_working_proxy(&[1, 2, 3], |p| p == 3);
        assert_eq!(got.as_deref(), Some("http://127.0.0.1:3"));
        assert_eq!(first_working_proxy(&[1, 2], |_| false), None);
        // 空候选表 → None（不能 panic）
        assert_eq!(first_working_proxy(&[], |_| true), None);
    }

    #[test]
    fn env_pairs_cover_case_variants_and_no_proxy() {
        let pairs = proxy_env_pairs("127.0.0.1:7897");
        let get = |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone());
        for k in [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
        ] {
            assert_eq!(
                get(k).as_deref(),
                Some("http://127.0.0.1:7897"),
                "{k} 应被设置"
            );
        }
        assert_eq!(get("NO_PROXY").as_deref(), Some(NO_PROXY_VALUE));
        assert!(
            NO_PROXY_VALUE.contains("127.0.0.1"),
            "回环必须排除，否则本机服务会被代理"
        );
    }

    /// 起一个「假代理」监听端口：回一行 HTTP 状态行 → 应被识别为代理
    #[test]
    fn is_http_proxy_accepts_real_handshake() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for conn in l.incoming() {
                let Ok(mut s) = conn else { break };
                let mut b = [0u8; 128];
                let _ = s.read(&mut b);
                let _ = s.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n");
            }
        });
        assert!(is_http_proxy(port), "收到 HTTP/ 状态行应判定为代理");
    }

    /// 端口在监听但不是 HTTP 代理（只接受连接、不回话）→ 不能误判
    #[test]
    fn is_http_proxy_rejects_silent_port() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for conn in l.incoming() {
                let Ok(s) = conn else { break };
                // 挂住不回复，模拟“监听但不是代理”的服务
                std::thread::sleep(Duration::from_millis(300));
                drop(s);
            }
        });
        assert!(!is_http_proxy(port), "无 HTTP 响应不能当成代理");
    }

    /// 没人监听的端口 → 快速返回 false（不能卡住命令执行）
    #[test]
    fn is_http_proxy_fast_on_closed_port() {
        // 绑定后立刻释放，确保该端口无人监听
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let t0 = Instant::now();
        assert!(!is_http_proxy(port));
        assert!(t0.elapsed() < CONNECT_TIMEOUT + Duration::from_millis(400));
    }

    #[test]
    fn disabled_flag_respects_env() {
        clear_cache();
        std::env::set_var(DISABLE_ENV, "1");
        assert!(disabled());
        assert_eq!(effective_proxy(), None, "关闭时不得返回代理");
        std::env::set_var(DISABLE_ENV, "no");
        assert!(!disabled());
        std::env::remove_var(DISABLE_ENV);
        clear_cache();
    }
}
