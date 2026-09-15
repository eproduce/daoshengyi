//! 内置浏览器自动化（CDP 直连）——替代 puppeteer MCP 插件
//!
//! 为什么内置（依据 docs/AGENT_DIAGNOSIS_2026-09-15.md 实测）：
//! - `puppeteer_evaluate` 失败 12/17、`puppeteer_navigate` 失败 8/24；
//! - 依赖 npx + Node + puppeteer 缓存的 Chrome，旧版内核在新 macOS 上会被 SIGKILL；
//! - 与内置能力同名的插件会挤占工具 schema 预算并诱发选错工具。
//!
//! 现在只依赖**本机已存在的浏览器内核**，自己说 CDP（Chrome DevTools Protocol）：
//! 1. 探测内核：优先 `chrome-headless-shell`（启动最快），其次 puppeteer 的
//!    Chrome for Testing，最后系统 Chrome/Edge/Chromium/Brave；
//! 2. `--headless --remote-debugging-port=<空闲端口>` 启动，profile 放应用数据目录；
//! 3. 轮询 `/json/version` 等就绪，从 `/json/list` 取 page 目标的 `webSocketDebuggerUrl`；
//! 4. 连页面级 WebSocket，按自增 id 发命令、跳过事件、取同 id 响应；
//! 5. 会话常驻（全局单例，任务内多次调用复用同一个页面），任务结束由 `browser_close` 关闭。

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

/// CDP 单条命令超时（截图/导航等慢命令共用；超时即判定浏览器无响应）
const CDP_TIMEOUT: Duration = Duration::from_secs(30);
/// 浏览器启动就绪等待上限
const READY_TIMEOUT: Duration = Duration::from_secs(20);

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Session {
    child: tokio::process::Child,
    ws: WsStream,
    next_id: u64,
    port: u16,
    binary: String,
}

impl Drop for Session {
    fn drop(&mut self) {
        // 全局单例：被替换/清空时确保子进程不残留
        let _ = self.child.start_kill();
    }
}

static SESSION: OnceLock<Mutex<Option<Session>>> = OnceLock::new();

fn session_slot() -> &'static Mutex<Option<Session>> {
    SESSION.get_or_init(|| Mutex::new(None))
}

// ── 纯函数（可单测）─────────────────────────────────────────────────────

/// 构造一条 CDP 请求报文
pub fn cdp_request(id: u64, method: &str, params: &Value) -> String {
    json!({ "id": id, "method": method, "params": params }).to_string()
}

/// 从一条 CDP 报文中取出与 `id` 匹配的响应结果。
/// 返回 `Some(Err(msg))` 表示浏览器返回了 error；`None` 表示这是事件或不相关的响应。
pub fn match_cdp_response(text: &str, id: u64) -> Option<Result<Value, String>> {
    let v: Value = serde_json::from_str(text).ok()?;
    if v.get("id").and_then(|x| x.as_u64()) != Some(id) {
        return None; // 事件（Page.loadEventFired 等）或其它响应：跳过
    }
    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("CDP 调用失败");
        return Some(Err(msg.to_string()));
    }
    Some(Ok(v.get("result").cloned().unwrap_or(Value::Null)))
}

/// 生成嵌进 JS 的字符串字面量（安全转义引号/换行/反斜杠）
pub fn js_string_literal(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/// 从 `Runtime.evaluate` 的返回值里抽出可读文本
pub fn evaluate_value_to_text(result: &Value) -> String {
    if let Some(exc) = result.get("exceptionDetails") {
        let msg = exc
            .get("exception")
            .and_then(|e| e.get("description"))
            .or_else(|| exc.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("脚本执行异常");
        return format!("脚本执行异常: {msg}");
    }
    match result.get("result").and_then(|r| r.get("value")) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => "（无返回值）".to_string(),
        Some(other) => other.to_string(),
    }
}

// ── 内核探测 ────────────────────────────────────────────────────────────

/// 在目录下找形如 `<dir>/<version>/...` 的最新版本子目录（按名字倒序取第一个）
fn newest_version_dir(dir: &std::path::Path) -> Option<PathBuf> {
    let mut names: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    names.sort_by(|a, b| b.file_name().cmp(&a.file_name())); // 版本号目录名字典序≈版本序
    names.into_iter().next()
}

/// 探测可用的浏览器内核（返回 None 表示本机没有可用内核）
pub fn probe_browser() -> Option<PathBuf> {
    // 0) 显式指定优先（便于测试/自定义）
    if let Ok(p) = std::env::var("DAOSHENGYI_BROWSER") {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Some(path);
        }
    }
    let home = std::env::var("HOME").ok().map(PathBuf::from);
    if let Some(home) = home.as_ref() {
        let cache = home.join(".cache/puppeteer");
        // 1) chrome-headless-shell（专为无头设计，启动最快、无 GUI）
        if let Some(v) = newest_version_dir(&cache.join("chrome-headless-shell")) {
            if let Some(sub) = newest_version_dir(&v) {
                let exe = sub.join("chrome-headless-shell");
                if exe.is_file() {
                    return Some(exe);
                }
            }
        }
        // 2) puppeteer 缓存的 Chrome for Testing
        if let Some(v) = newest_version_dir(&cache.join("chrome")) {
            if let Some(sub) = newest_version_dir(&v) {
                let exe = sub
                    .join("Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
                if exe.is_file() {
                    return Some(exe);
                }
            }
        }
    }
    // 3) 系统浏览器
    const SYSTEM: &[&str] = &[
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
    SYSTEM
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

/// 是否需要显式传 `--headless`（chrome-headless-shell 本身即无头，不认该参数）
fn needs_headless_flag(binary: &std::path::Path) -> bool {
    !binary
        .file_name()
        .map(|n| n.to_string_lossy().contains("chrome-headless-shell"))
        .unwrap_or(false)
}

/// 取一个空闲本地端口（绑定 0 让系统分配后释放）
pub fn free_port() -> Option<u16> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
    l.local_addr().ok().map(|a| a.port())
}

// ── 启动与连接 ──────────────────────────────────────────────────────────

async fn wait_ready(port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/json/version");
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    let client = reqwest::Client::new();
    while tokio::time::Instant::now() < deadline {
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err(format!("浏览器调试端口 {port} 未在 {READY_TIMEOUT:?} 内就绪"))
}

/// 取页面级 WebSocket 调试地址（无 page 目标时新建一个）
async fn page_ws_url(port: u16) -> Result<String, String> {
    let client = reqwest::Client::new();
    let list_url = format!("http://127.0.0.1:{port}/json/list");
    if let Ok(resp) = client.get(&list_url).send().await {
        if let Ok(items) = resp.json::<Vec<Value>>().await {
            if let Some(url) = items
                .iter()
                .find(|i| i.get("type").and_then(|t| t.as_str()) == Some("page"))
                .and_then(|i| i.get("webSocketDebuggerUrl"))
                .and_then(|u| u.as_str())
            {
                return Ok(url.to_string());
            }
        }
    }
    // 兜底：显式新建标签页（Chrome 111+ 要求 PUT）
    let new_url = format!("http://127.0.0.1:{port}/json/new?about:blank");
    let resp = client
        .put(&new_url)
        .send()
        .await
        .map_err(|e| format!("新建标签页失败: {e}"))?;
    resp.json::<Value>()
        .await
        .map_err(|e| format!("解析新建标签页响应失败: {e}"))?
        .get("webSocketDebuggerUrl")
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "浏览器未返回页面调试地址".to_string())
}

/// 发送一条 CDP 命令并等待同 id 响应
async fn cdp(session: &mut Session, method: &str, params: Value) -> Result<Value, String> {
    let id = session.next_id;
    session.next_id += 1;
    session
        .ws
        .send(Message::Text(cdp_request(id, method, &params)))
        .await
        .map_err(|e| format!("发送 CDP 命令失败: {e}"))?;
    let deadline = tokio::time::Instant::now() + CDP_TIMEOUT;
    loop {
        let remain = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remain.is_zero() {
            return Err(format!("CDP 命令 {method} 超时（{:?}）", CDP_TIMEOUT));
        }
        let msg = match tokio::time::timeout(remain, session.ws.next()).await {
            Err(_) => return Err(format!("CDP 命令 {method} 超时无响应")),
            Ok(None) => return Err("浏览器连接已断开".to_string()),
            Ok(Some(Err(e))) => return Err(format!("浏览器连接错误: {e}")),
            Ok(Some(Ok(m))) => m,
        };
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Binary(b) => String::from_utf8_lossy(&b).to_string(),
            _ => continue, // Ping/Pong/Close 等
        };
        if let Some(res) = match_cdp_response(&text, id) {
            return res;
        }
    }
}

/// 确保会话存在（首次调用启动浏览器）；返回是否为新启动
async fn ensure_session(app_dir: &std::path::Path) -> Result<bool, String> {
    let mut slot = session_slot().lock().await;
    if let Some(s) = slot.as_mut() {
        // 进程已退出（如被系统杀掉）→ 重建
        if matches!(s.child.try_wait(), Ok(None)) {
            return Ok(false);
        }
        *slot = None;
    }
    let binary = probe_browser().ok_or_else(|| {
        "未找到可用浏览器内核。请安装 Chrome/Edge，或先运行过 puppeteer（会缓存 Chrome for Testing）。"
            .to_string()
    })?;
    let port = free_port().ok_or_else(|| "无法分配本地端口".to_string())?;
    let profile = app_dir.join("browser-profile");
    std::fs::create_dir_all(&profile).map_err(|e| format!("创建浏览器 profile 目录失败: {e}"))?;

    let mut cmd = tokio::process::Command::new(&binary);
    if needs_headless_flag(&binary) {
        cmd.arg("--headless=new");
    }
    cmd.arg(format!("--remote-debugging-port={port}"))
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-gpu")
        .arg("--window-size=1440,900")
        .arg("about:blank")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(false);
    let child = cmd.spawn().map_err(|e| {
        format!(
            "启动浏览器失败（{}）: {e}",
            binary.display()
        )
    })?;

    wait_ready(port).await?;
    let ws_url = page_ws_url(port).await?;
    let (ws, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .map_err(|e| format!("连接浏览器调试通道失败: {e}"))?;
    let mut session = Session {
        child,
        ws,
        next_id: 1,
        port,
        binary: binary.display().to_string(),
    };
    // 开启 Page 域（截图/导航需要）
    let _ = cdp(&mut session, "Page.enable", json!({})).await;
    *slot = Some(session);
    Ok(true)
}

/// 以会话执行闭包（内部处理启动 + 加锁）
async fn with_session<T, F>(app_dir: PathBuf, f: F) -> Result<T, String>
where
    F: for<'a> FnOnce(
        &'a mut Session,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<T, String>> + Send + 'a>,
    >,
{
    ensure_session(&app_dir).await?;
    let mut slot = session_slot().lock().await;
    let session = slot.as_mut().ok_or_else(|| "浏览器会话不可用".to_string())?;
    f(session).await
}

async fn eval_js(session: &mut Session, expression: &str) -> Result<String, String> {
    let res = cdp(
        session,
        "Runtime.evaluate",
        json!({
            "expression": expression,
            "returnByValue": true,
            "awaitPromise": true,
        }),
    )
    .await?;
    Ok(evaluate_value_to_text(&res))
}

async fn wait_load(session: &mut Session) -> Result<(), String> {
    // 轮询 readyState：比等 Page.loadEventFired 事件简单，且对 SPA 也够用
    for _ in 0..40 {
        let state = eval_js(session, "document.readyState").await.unwrap_or_default();
        if state.contains("complete") {
            // 再等一拍，给同步渲染留时间（实测 SPA 首帧常晚于 complete）
            tokio::time::sleep(Duration::from_millis(300)).await;
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(()) // 不等死：超时也让调用方拿到当前页面状态
}

// ── 对外命令实现 ────────────────────────────────────────────────────────

/// 打开网址，返回【标题 + 最终地址 + 正文前 4000 字】，供模型直接阅读
pub async fn navigate(app_dir: PathBuf, url: &str) -> Result<String, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("url 不能为空".to_string());
    }
    with_session(app_dir, move |s| {
        Box::pin(async move {
            let res = cdp(s, "Page.navigate", json!({ "url": url })).await?;
            if let Some(err) = res.get("errorText").and_then(|t| t.as_str()) {
                if !err.is_empty() && err != "net::ERR_ABORTED" {
                    return Err(format!("导航失败: {err}"));
                }
            }
            wait_load(s).await?;
            let snap = eval_js(
                s,
                "JSON.stringify({title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').slice(0, 4000)})",
            )
            .await?;
            let v: Value = serde_json::from_str(&snap).unwrap_or(Value::Null);
            let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("");
            let final_url = v.get("url").and_then(|t| t.as_str()).unwrap_or(&url);
            let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("");
            Ok(format!(
                "✅ 已打开\n标题: {title}\n地址: {final_url}\n\n正文（前 4000 字）:\n{text}"
            ))
        })
    })
    .await
}

/// 在页面里执行 JS（返回表达式结果）
pub async fn evaluate(app_dir: PathBuf, script: &str) -> Result<String, String> {
    if script.trim().is_empty() {
        return Err("script 不能为空".to_string());
    }
    let script = script.to_string();
    with_session(app_dir, move |s| {
        Box::pin(async move {
            // 用 async IIFE + awaitPromise 包裹：既支持同步表达式，也支持返回 Promise
            // 的异步脚本（如 `await fetch(...).then(r=>r.json())`）。
            let expr = format!(
                "(async () => {{ try {{ const __v = await (0, eval)({}); return (typeof __v === 'string') ? __v : JSON.stringify(__v); }} catch (e) {{ return 'ERR:' + (e && e.message ? e.message : String(e)); }} }})()",
                js_string_literal(&script)
            );
            eval_js(s, &expr).await
        })
    })
    .await
}

/// 截图保存到指定路径（缺省存到应用数据目录 screenshots/）
pub async fn screenshot(app_dir: PathBuf, path: Option<String>) -> Result<String, String> {
    with_session(app_dir.clone(), move |s| {
        Box::pin(async move {
            let res = cdp(
                s,
                "Page.captureScreenshot",
                json!({ "format": "png", "captureBeyondViewport": true }),
            )
            .await?;
            let b64 = res
                .get("data")
                .and_then(|d| d.as_str())
                .ok_or_else(|| "截图返回数据为空".to_string())?;
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| format!("截图 base64 解码失败: {e}"))?;
            let target = match path.filter(|p| !p.trim().is_empty()) {
                Some(p) => PathBuf::from(p),
                None => {
                    let dir = app_dir.join("screenshots");
                    std::fs::create_dir_all(&dir).ok();
                    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
                    dir.join(format!("browser-{ts}.png"))
                }
            };
            if let Some(parent) = target.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent).ok();
                }
            }
            std::fs::write(&target, &bytes).map_err(|e| format!("写入截图失败: {e}"))?;
            Ok(format!(
                "✅ 截图已保存: {}\n（{} 字节，PNG）",
                target.display(),
                bytes.len()
            ))
        })
    })
    .await
}

/// 点击元素（选择器为 CSS selector；找不到会明确返回，便于模型改写选择器）
pub async fn click(app_dir: PathBuf, selector: &str) -> Result<String, String> {
    if selector.trim().is_empty() {
        return Err("selector 不能为空".to_string());
    }
    let selector = selector.to_string();
    with_session(app_dir, move |s| {
        Box::pin(async move {
            let expr = format!(
                "(() => {{ const el = document.querySelector({sel}); if (!el) return 'NOT_FOUND'; el.scrollIntoView({{block:'center'}}); el.click(); return 'OK:' + (el.tagName || '') + '|' + (el.textContent || '').trim().slice(0,60); }})()",
                sel = js_string_literal(&selector)
            );
            let r = eval_js(s, &expr).await?;
            if r == "NOT_FOUND" {
                return Ok(format!("❌ 未找到元素：{selector}（请检查 CSS 选择器，或先用 browser_evaluate 查看页面结构）"));
            }
            Ok(format!("✅ 已点击：{r}"))
        })
    })
    .await
}

/// 填写输入框（用原型 value setter + input/change 事件，兼容 React 受控组件）
pub async fn fill(app_dir: PathBuf, selector: &str, value: &str) -> Result<String, String> {
    if selector.trim().is_empty() {
        return Err("selector 不能为空".to_string());
    }
    let (selector, value) = (selector.to_string(), value.to_string());
    with_session(app_dir, move |s| {
        Box::pin(async move {
            let expr = format!(
                "(() => {{ const el = document.querySelector({sel}); if (!el) return 'NOT_FOUND'; const v = {val}; el.focus(); const d = Object.getOwnPropertyDescriptor(el.__proto__ || Object.getPrototypeOf(el), 'value'); if (d && d.set) {{ d.set.call(el, v); }} else {{ el.value = v; }} el.dispatchEvent(new Event('input', {{bubbles:true}})); el.dispatchEvent(new Event('change', {{bubbles:true}})); return 'OK'; }})()",
                sel = js_string_literal(&selector),
                val = js_string_literal(&value)
            );
            let r = eval_js(s, &expr).await?;
            if r == "NOT_FOUND" {
                return Ok(format!("❌ 未找到输入框：{selector}"));
            }
            Ok(format!("✅ 已填写：{selector}"))
        })
    })
    .await
}

/// 关闭浏览器（任务收尾时调用；未运行则直接返回）
pub async fn close() -> String {
    let mut slot = session_slot().lock().await;
    if slot.take().is_some() {
        "浏览器已关闭".to_string()
    } else {
        "浏览器未运行".to_string()
    }
}

/// 当前状态（是否运行 / 内核 / 端口）
pub async fn status() -> Value {
    let mut slot = session_slot().lock().await;
    match slot.as_mut() {
        Some(s) => {
            let alive = matches!(s.child.try_wait(), Ok(None));
            json!({ "running": alive, "binary": s.binary, "port": s.port })
        }
        None => json!({ "running": false, "binary": Value::Null, "port": Value::Null }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cdp_request_contains_id_method_params() {
        let s = cdp_request(7, "Page.navigate", &json!({"url": "https://example.com"}));
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["id"], 7);
        assert_eq!(v["method"], "Page.navigate");
        assert_eq!(v["params"]["url"], "https://example.com");
    }

    #[test]
    fn match_cdp_response_skips_events_and_matches_id() {
        // 事件（无 id）→ None
        assert!(match_cdp_response(r#"{"method":"Page.loadEventFired"}"#, 1).is_none());
        // 其它 id 的响应 → None
        assert!(match_cdp_response(r#"{"id":2,"result":{}}"#, 1).is_none());
        // 同 id 成功
        let ok = match_cdp_response(r#"{"id":1,"result":{"frameId":"A"}}"#, 1).unwrap();
        assert_eq!(ok.unwrap()["frameId"], "A");
        // 同 id 报错 → Err（携带 message）
        let err = match_cdp_response(r#"{"id":1,"error":{"message":"boom"}}"#, 1).unwrap();
        assert_eq!(err.unwrap_err(), "boom");
        // 非 JSON → None（不能 panic）
        assert!(match_cdp_response("not-json", 1).is_none());
    }

    #[test]
    fn js_string_literal_escapes_quotes_and_newlines() {
        let l = js_string_literal("a\"b\nc\\d");
        assert_eq!(l, "\"a\\\"b\\nc\\\\d\"");
        // 中文与单引号原样保留（单引号在双引号字面量里无需转义）
        assert_eq!(js_string_literal("你好'x"), "\"你好'x\"");
    }

    #[test]
    fn evaluate_value_to_text_handles_types_and_exceptions() {
        assert_eq!(
            evaluate_value_to_text(&json!({"result": {"type":"string","value":"ok"}})),
            "ok"
        );
        assert_eq!(
            evaluate_value_to_text(&json!({"result": {"type":"number","value":42}})),
            "42"
        );
        assert_eq!(
            evaluate_value_to_text(&json!({"result": {"type":"object"}})),
            "（无返回值）"
        );
        let e = evaluate_value_to_text(&json!({
            "exceptionDetails": {"exception": {"description": "ReferenceError: x is not defined"}}
        }));
        assert!(e.contains("ReferenceError"));
    }

    #[test]
    fn free_port_returns_bindable_port() {
        let p = free_port().expect("应能分配端口");
        assert!(p > 1024);
        // 端口应可再次绑定（说明已释放）
        assert!(std::net::TcpListener::bind(("127.0.0.1", p)).is_ok());
    }

    #[test]
    fn headless_flag_rule() {
        assert!(!needs_headless_flag(std::path::Path::new(
            "/x/chrome-headless-shell"
        )));
        assert!(needs_headless_flag(std::path::Path::new(
            "/x/Google Chrome for Testing"
        )));
    }

    #[test]
    fn probe_browser_never_panics() {
        // 本机可能没有任何内核；只要不 panic 且返回路径存在即合法
        if let Some(p) = probe_browser() {
            assert!(p.is_file(), "探测到的内核必须真实存在: {}", p.display());
        }
    }

    /// 真机端到端：启动内核 → 打开本地页面 → evaluate → 截图 → 关闭。
    /// 默认忽略（需要本机浏览器内核，约 3~8 秒）；用
    /// `cargo test --lib browser:: -- --ignored --nocapture` 显式运行。
    #[tokio::test]
    #[ignore = "需要本机浏览器内核，显式 --ignored 运行"]
    async fn cdp_end_to_end_navigate_evaluate_screenshot() {
        let dir = std::env::temp_dir().join("dsy-browser-e2e");
        std::fs::create_dir_all(&dir).unwrap();
        let page = dir.join("t.html");
        std::fs::write(
            &page,
            "<!doctype html><title>CDP-T</title><h1 id=\"x\">hello-cdp</h1>",
        )
        .unwrap();

        let url = format!("file://{}", page.display());
        let out = navigate(dir.clone(), &url).await.expect("导航应成功");
        assert!(out.contains("hello-cdp"), "页面正文应被抓到: {out}");
        assert!(out.contains("CDP-T"), "标题应被抓到: {out}");

        let v = evaluate(dir.clone(), "document.getElementById('x').textContent")
            .await
            .expect("evaluate 应成功");
        assert_eq!(v, "hello-cdp");

        let shot_path = dir.join("t.png").display().to_string();
        let shot = screenshot(dir.clone(), Some(shot_path.clone()))
            .await
            .expect("截图应成功");
        assert!(shot.contains("已保存"), "{shot}");
        assert!(std::path::Path::new(&shot_path).is_file(), "截图文件应存在");

        let st = status().await;
        assert_eq!(st["running"], true);

        close().await;
        assert_eq!(status().await["running"], false);
    }
}
