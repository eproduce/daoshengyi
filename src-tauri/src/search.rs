use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

pub async fn search_web(query: &str, brave_key: &str) -> Result<Vec<SearchResult>, String> {
    // 优先 Brave Search API（免费 2000 次/月，全球可用）
    if !brave_key.is_empty() {
        if let Ok(r) = search_brave(query, brave_key).await {
            if !r.is_empty() { return Ok(r); }
        }
    }
    // 回退 必应 HTML（有时被反爬返回 0 条）
    if let Ok(r) = search_bing(query).await {
        if !r.is_empty() { return Ok(r); }
    }
    // 再回退 DuckDuckGo HTML（无鉴权、无质询，对中文/企业查询稳定）
    search_duckduckgo(query).await
}

/// Brave Search API
async fn search_brave(query: &str, key: &str) -> Result<Vec<SearchResult>, String> {
    let url = format!("https://api.search.brave.com/res/v1/web/search?q={}&count=8&search_lang=zh", urlencoding(query));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build().map_err(|e| format!("err:{}", e))?;

    let data: BraveResponse = client.get(&url)
        .header("Accept", "application/json")
        .header("Accept-Encoding", "gzip")
        .header("X-Subscription-Token", key)
        .send().await.map_err(|e| format!("err:{}", e))?
        .json().await.map_err(|e| format!("err:{}", e))?;

    let results: Vec<SearchResult> = data.web.results.iter().map(|r| SearchResult {
        title: r.title.clone(),
        url: r.url.clone(),
        snippet: r.description.clone(),
    }).collect();
    eprintln!("[Brave] {} results", results.len());
    Ok(results)
}

/// 必应 HTML 搜索（Bing DOM 改版后结果块为 <li class="b_algo">，标题 <h2><a>）。
/// 依次尝试必应中国（cn.bing.com，国内直连稳定）与国际版（www.bing.com，境外质量更全），
/// 取第一个非空结果；每个域名独立短超时，避免某域名不可达时干等拖慢搜索。
async fn search_bing(query: &str) -> Result<Vec<SearchResult>, String> {
    let mut last_err = "必应搜索无结果".to_string();
    for domain in ["cn.bing.com", "www.bing.com"] {
        let url = format!("https://{}/search?q={}&count=10&setlang=zh-cn", domain, urlencoding(query));
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0")
            .timeout(std::time::Duration::from_secs(6))
            .build().map_err(|e| format!("err:{}", e))?;

        let html = match client.get(&url).send().await {
            Ok(r) => match r.text().await {
                Ok(t) => t,
                Err(e) => { last_err = format!("必应 {} 读取失败: {}", domain, e); continue; }
            },
            Err(e) => { last_err = format!("必应 {} 连接失败: {}", domain, e); continue; }
        };

        let mut results = Vec::new();
        let mut pos = 0;
        while results.len() < 10 {
            let start = match html[pos..].find("<li class=\"b_algo\"") {
                Some(i) => pos + i, None => break,
            };
            let end = match html[start..].find("</li>") {
                Some(i) => start + i, None => break,
            };
            let block = &html[start..end];
            let title = extract_h2(block);
            let url = extract_h2_link(block);
            let snippet = extract_bing_caption(block);
            if !title.is_empty() && !url.is_empty() {
                results.push(SearchResult { title, url, snippet: snippet.chars().take(300).collect() });
            }
            pos = end + 5;
        }
        if !results.is_empty() {
            eprintln!("[Bing {}] {} results", domain, results.len());
            return Ok(results);
        }
        last_err = format!("必应 {} 无结果", domain);
    }
    eprintln!("[Bing] {}", last_err);
    Ok(Vec::new())
}

/// 提取 Bing 标题：<h2 ...>...</h2>（开标签允许带属性）
fn extract_h2(block: &str) -> String {
    let open_start = match block.find("<h2") { Some(i) => i, None => return String::new() };
    let gt = match block[open_start..].find('>') { Some(i) => open_start + i + 1, None => return String::new() };
    let close = match block[gt..].find("</h2>") { Some(i) => gt + i, None => return String::new() };
    strip_html(&block[gt..close])
}

/// 从 <h2 ...> 标签起提取真实结果链接（跳过结果块前部内嵌的 CSS 链接）
fn extract_h2_link(block: &str) -> String {
    let h2 = match block.find("<h2") { Some(i) => i, None => return String::new() };
    extract_attr(&block[h2..], "href=\"", "\"")
}

/// 提取 Bing 摘要：class="b_caption" 区域内第一个 <p ...> 正文
fn extract_bing_caption(block: &str) -> String {
    let cap_start = match block.find("class=\"b_caption\"") {
        Some(i) => i, None => return extract_tag(block, "<p", "</p>"),
    };
    let after = &block[cap_start..];
    let p_start = match after.find("<p") { Some(i) => i + 2, None => return String::new() };
    let p_gt = match after[p_start..].find('>') { Some(i) => p_start + i + 1, None => return String::new() };
    let p_end = match after[p_gt..].find("</p>") { Some(i) => p_gt + i, None => return String::new() };
    strip_html(&after[p_gt..p_end])
}

/// DuckDuckGo HTML 搜索（无鉴权，适合中文/企业信息查询）。
/// 注意：DDG 对自动化请求有反爬（间歇返回 202 anomaly 质询页），
/// 故用 cookie 会话 + 多 UA 轮换 + 失败重试提高成功率；结果链接是
/// //duckduckgo.com/l/?uddg=<urlencoded>&rut=... 重定向形式，需解码出真实 URL。
async fn search_duckduckgo(query: &str) -> Result<Vec<SearchResult>, String> {
    let uas = [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    ];
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .timeout(std::time::Duration::from_secs(10))
        .build().map_err(|e| format!("err:{}", e))?;

    let mut last_err = "DuckDuckGo 搜索无结果".to_string();
    for attempt in 0..3 {
        let ua = uas[attempt % uas.len()];
        // 先访问首页建立 cookie 会话，降低被质询概率
        let _ = client.get("https://html.duckduckgo.com/html/")
            .header("User-Agent", ua)
            .send().await;
        let url = format!("https://html.duckduckgo.com/html/?q={}", urlencoding(query));
        let resp = client.get(&url)
            .header("User-Agent", ua)
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .header("Referer", "https://html.duckduckgo.com/")
            .send().await.map_err(|e| format!("err:{}", e))?;
        let status = resp.status();
        let html = resp.text().await.map_err(|e| format!("err:{}", e))?;
        // 202 / anomaly 质询页或无结果标记 → 换 UA 重试
        if status != 200 || html.contains("anomaly") || !html.contains("result__a") {
            last_err = format!("DuckDuckGo 返回 {}（反爬，重试 {}/3）", status, attempt + 1);
            continue;
        }
        let results = parse_ddg(&html);
        if !results.is_empty() {
            eprintln!("[DuckDuckGo] {} results", results.len());
            return Ok(results);
        }
        last_err = format!("DuckDuckGo 无结果（重试 {}/3）", attempt + 1);
    }
    eprintln!("[DuckDuckGo] {}", last_err);
    Ok(Vec::new())
}

/// 解析 DDG HTML 结果页（class="result__a" 标题 + result__snippet 摘要）
fn parse_ddg(html: &str) -> Vec<SearchResult> {
    let mut results = Vec::new();
    let mut pos = 0;
    while results.len() < 8 {
        let start = match html[pos..].find("result__a") {
            Some(i) => pos + i, None => break,
        };
        let a_start = match html[..start].rfind("<a") { Some(i) => i, None => break };
        let href = extract_attr(&html[a_start..start], "href=\"", "\"");
        let title_end = match html[start..].find("</a>") { Some(i) => start + i, None => break };
        let title = strip_html(&html[start..title_end]);
        let mut snippet = String::new();
        if let Some(s) = html[title_end..].find("result__snippet") {
            let s = title_end + s;
            if let Some(e) = html[s..].find("</a>") {
                snippet = strip_html(&html[s..s + e]);
            }
        }
        let url = decode_ddg_url(&href);
        if !title.is_empty() && !url.is_empty() {
            results.push(SearchResult { title, url, snippet: snippet.chars().take(300).collect() });
        }
        pos = title_end + 5;
    }
    results
}

/// 从 DDG 重定向链接中解码真实 URL（uddg 参数为双重 URL 编码）
fn decode_ddg_url(href: &str) -> String {
    if let Some(idx) = href.find("uddg=") {
        let rest = &href[idx + 5..];
        let end = rest.find('&').unwrap_or(rest.len());
        return percent_decode(&percent_decode(&rest[..end]));
    }
    if href.starts_with("//") { return format!("https:{}", href); }
    href.to_string()
}

/// 简易 percent-decode（%XX → 字节）
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Deserialize)]
struct BraveResponse { web: BraveWeb }
#[derive(Deserialize)]
struct BraveWeb { results: Vec<BraveResult> }
#[derive(Deserialize)]
struct BraveResult { title: String, url: String, description: String }

fn extract_tag(html: &str, open: &str, close: &str) -> String {
    let start = match html.find(open) {
        Some(i) => match html[i + open.len()..].find('>') {
            Some(j) => i + open.len() + j + 1,
            None => i + open.len(),
        },
        None => return String::new(),
    };
    let end = match html[start..].find(close) {
        Some(i) => start + i, None => return String::new(),
    };
    strip_html(&html[start..end])
}

fn extract_attr(html: &str, attr: &str, quote: &str) -> String {
    let start = match html.find(attr) { Some(i) => i + attr.len(), None => return String::new() };
    let end = match html[start..].find(quote) { Some(i) => start + i, None => return String::new() };
    html[start..end].to_string()
}

fn strip_html(s: &str) -> String {
    let mut r = String::new(); let mut in_tag = false;
    for c in s.chars() {
        if c == '<' { in_tag = true; continue; }
        if c == '>' { in_tag = false; continue; }
        if !in_tag { r.push(c); }
    }
    r.replace("&quot;","\"").replace("&amp;","&").replace("&lt;","<").replace("&gt;",">").replace("&nbsp;"," ").trim().to_string()
}

fn urlencoding(s: &str) -> String {
    let mut result = String::new();
    for c in s.chars() {
        match c { 'A'..='Z'|'a'..='z'|'0'..='9'|'-'|'_'|'.'|'~' => result.push(c), ' ' => result.push('+'), _ => { for b in c.to_string().into_bytes() { result.push_str(&format!("%{:02X}", b)); } } }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_percent_decode() {
        assert_eq!(percent_decode("https%3A%2F%2Fwww.huawei.com%2Fcn%2F"), "https://www.huawei.com/cn/");
        assert_eq!(percent_decode("abc"), "abc");
    }

    #[test]
    fn test_decode_ddg_url_double_encoding() {
        // 真实 DDG href：uddg 值先 URL 编码整条 URL，中文路径再编码一次；& 是 HTML 实体
        let href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fbaike.baidu.com%2Fitem%2F%25E5%258D%258E%25E4%25B8%25BA%25E6%258A%2580%25E6%259C%25AF%25E6%259C%2589%25E9%2599%2590%25E5%2585%25AC%25E5%258F%25B8%2F6455903&amp;rut=abc";
        assert_eq!(decode_ddg_url(href), "https://baike.baidu.com/item/华为技术有限公司/6455903");
    }

    #[test]
    fn test_decode_ddg_url_plain_https() {
        // 纯 ASCII 的 uddg 一次解码即为最终 URL
        let href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.huawei.com%2Fcn%2F&amp;rut=abc";
        assert_eq!(decode_ddg_url(href), "https://www.huawei.com/cn/");
    }

    /// 真实网络端到端验证（手动：cargo test -- --ignored test_duckduckgo_live）
    #[tokio::test]
    #[ignore]
    async fn test_duckduckgo_live() {
        let r = search_duckduckgo("华为技术有限公司").await.expect("DDG 请求失败");
        assert!(!r.is_empty(), "DDG 无结果");
        assert!(r[0].title.len() > 0 && r[0].url.starts_with("http"), "结果格式异常: {:?}", r[0]);
        eprintln!("DDG 首条: {} — {}", r[0].title, r[0].url);
    }

    /// 真实网络端到端验证 Bing 修复后的解析（手动：cargo test -- --ignored test_bing_live）
    #[tokio::test]
    #[ignore]
    async fn test_bing_live() {
        let r = search_bing("华为技术有限公司").await.expect("Bing 请求失败");
        assert!(!r.is_empty(), "Bing 无结果");
        assert!(r[0].title.len() > 0 && r[0].url.starts_with("http"), "结果格式异常: {:?}", r[0]);
        eprintln!("Bing 首条: {} — {}", r[0].title, r[0].url);
    }
}
