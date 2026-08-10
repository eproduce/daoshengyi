use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// SearXNG 公共实例（JSON API，无需 Key）
const SEARXNG_INSTANCES: &[&str] = &[
    "https://search.sapti.me",
    "https://searx.be",
    "https://search.inetol.net",
    "https://search.hbubli.cc",
];

pub async fn search_web(query: &str) -> Result<Vec<SearchResult>, String> {
    for base in SEARXNG_INSTANCES {
        if let Ok(r) = search_searxng(base, query).await {
            if !r.is_empty() { return Ok(r); }
        }
    }
    Ok(vec![])
}

async fn search_searxng(base_url: &str, query: &str) -> Result<Vec<SearchResult>, String> {
    let url = format!("{}/search?q={}&format=json&language=zh-CN&categories=general", base_url, urlencoding(query));
    let client = reqwest::Client::builder()
        .user_agent("daoshengyi/0.1")
        .timeout(std::time::Duration::from_secs(10))
        .build().map_err(|e| format!("err:{}", e))?;

    let resp = client.get(&url).send().await.map_err(|e| format!("err:{}", e))?;
    let data: SearxResponse = resp.json().await.map_err(|e| format!("err:{}", e))?;

    let results: Vec<SearchResult> = data.results.iter().take(8).map(|r| {
        SearchResult {
            title: r.title.clone(),
            url: r.url.clone(),
            snippet: r.content.clone().unwrap_or_default().chars().take(300).collect(),
        }
    }).collect();
    eprintln!("[SearXNG {}] {} results", base_url, results.len());
    Ok(results)
}

#[derive(Deserialize)]
struct SearxResponse { results: Vec<SearxResult> }
#[derive(Deserialize)]
struct SearxResult {
    title: String,
    url: String,
    content: Option<String>,
}

fn urlencoding(s: &str) -> String {
    let mut result = String::new();
    for c in s.chars() {
        match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => result.push(c),
            ' ' => result.push('+'),
            _ => {
                let bytes = c.to_string().into_bytes();
                for b in bytes { result.push_str(&format!("%{:02X}", b)); }
            }
        }
    }
    result
}
