use serde::Serialize;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// Brave Search API（免费，无需 API Key 的基础搜索）
pub async fn search_web(query: &str) -> Result<Vec<SearchResult>, String> {
    // 优先尝试 DuckDuckGo HTML
    if let Ok(results) = search_ddg(query).await {
        if !results.is_empty() { return Ok(results); }
    }
    // 回退：Wikipedia 直接搜索（结构化数据）
    search_wiki(query).await
}

async fn search_ddg(query: &str) -> Result<Vec<SearchResult>, String> {
    let url = format!("https://lite.duckduckgo.com/lite/?q={}", urlencoding(query));
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")
        .build().map_err(|e| format!("客户端: {}", e))?;
    let resp = client.get(&url).send().await.map_err(|e| format!("请求: {}", e))?;
    let html = resp.text().await.map_err(|e| format!("读取: {}", e))?;

    let mut results = Vec::new();
    // lite.duckduckgo.com 使用表格结构
    let mut pos = 0;
    while results.len() < 8 {
        let link_start = match html[pos..].find("<a rel=\"nofollow\" href=\"") {
            Some(i) => pos + i + 24,
            None => break,
        };
        let link_end = match html[link_start..].find('"') {
            Some(i) => link_start + i,
            None => break,
        };
        let raw_url = html[link_start..link_end].to_string();

        let title_start = match html[link_end..].find('>') {
            Some(i) => link_end + i + 1,
            None => break,
        };
        let title_end = match html[title_start..].find("</a>") {
            Some(i) => title_start + i,
            None => break,
        };
        let title = html[title_start..title_end].trim().to_string();

        let snippet_start = match html[title_end..].find("<td class=\"result-snippet\">") {
            Some(i) => title_end + i + 28,
            None => { pos = link_end + 1; continue; }
        };
        let snippet_end = match html[snippet_start..].find("</td>") {
            Some(i) => snippet_start + i,
            None => { pos = link_end + 1; continue; }
        };
        let snippet = strip_html(&html[snippet_start..snippet_end]);

        if !title.is_empty() && !snippet.is_empty() {
            results.push(SearchResult { title, url: clean_ddg_url(&raw_url), snippet });
        }
        pos = snippet_end + 1;
    }
    eprintln!("[搜索 DDG] {} 条", results.len());
    Ok(results)
}

async fn search_wiki(query: &str) -> Result<Vec<SearchResult>, String> {
    let url = format!(
        "https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch={}&format=json&srlimit=5",
        urlencoding(query)
    );
    let client = reqwest::Client::builder()
        .user_agent("daoshengyi/0.1 (AI Assistant)")
        .build().map_err(|e| format!("客户端: {}", e))?;
    let resp = client.get(&url).send().await.map_err(|e| format!("请求: {}", e))?;
    let data: WikiResponse = resp.json().await.map_err(|e| format!("解析: {}", e))?;

    let results: Vec<SearchResult> = data.query.search.iter().take(5).map(|p| {
        SearchResult {
            title: p.title.clone(),
            url: format!("https://zh.wikipedia.org/wiki/{}", p.title.replace(' ', "_")),
            snippet: strip_html(&p.snippet),
        }
    }).collect();
    eprintln!("[搜索 Wiki] {} 条", results.len());
    Ok(results)
}

#[derive(Deserialize)]
struct WikiResponse { query: WikiQuery }
#[derive(Deserialize)]
struct WikiQuery { search: Vec<WikiPage> }
#[derive(Deserialize)]
struct WikiPage { title: String, snippet: String }

fn clean_ddg_url(raw: &str) -> String {
    if let Some(start) = raw.find("//") {
        let rest = &raw[start + 2..];
        if let Some(end) = rest.find("//") {
            return format!("https://{}", &rest[..end]);
        }
    }
    if raw.starts_with("http") { return raw.to_string(); }
    format!("https:{}", raw)
}

fn strip_html(s: &str) -> String {
    let mut r = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        if c == '<' { in_tag = true; continue; }
        if c == '>' { in_tag = false; continue; }
        if !in_tag { r.push(c); }
    }
    r.trim().replace("&quot;", "\"").replace("&amp;", "&")
        .replace("&lt;", "<").replace("&gt;", ">")
        .replace("&nbsp;", " ").replace("&#91;", "[").replace("&#93;", "]")
}

fn urlencoding(s: &str) -> String {
    let mut result = String::new();
    for c in s.chars() {
        match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => result.push(c),
            ' ' => result.push('+'),
            _ => {
                let bytes = c.to_string().into_bytes();
                for b in bytes {
                    result.push_str(&format!("%{:02X}", b));
                }
            }
        }
    }
    result
}
