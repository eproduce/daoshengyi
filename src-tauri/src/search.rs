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
    // 回退 必应 HTML
    search_bing(query).await
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

/// 必应 HTML 搜索
async fn search_bing(query: &str) -> Result<Vec<SearchResult>, String> {
    let url = format!("https://www.bing.com/search?q={}&count=10&setlang=zh-cn", urlencoding(query));
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0")
        .timeout(std::time::Duration::from_secs(10))
        .build().map_err(|e| format!("err:{}", e))?;

    let html = client.get(&url).send().await.map_err(|e| format!("err:{}", e))?
        .text().await.map_err(|e| format!("err:{}", e))?;

    let mut results = Vec::new();
    let mut pos = 0;
    while results.len() < 8 {
        let algo = match html[pos..].find("class=\"b_algo\"") {
            Some(i) => pos + i, None => break,
        };
        let end = match html[algo..].find("</li>") {
            Some(i) => algo + i, None => break,
        };
        let block = &html[algo..end];
        let title = extract_tag(block, "<h2>", "</h2>");
        let url = extract_attr(block, "href=\"", "\"");
        let snippet = extract_tag(block, "<p>", "</p>");
        if !title.is_empty() {
            results.push(SearchResult { title, url, snippet: snippet.chars().take(300).collect() });
        }
        pos = end + 5;
    }
    eprintln!("[Bing] {} results", results.len());
    Ok(results)
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
