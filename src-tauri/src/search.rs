use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// DuckDuckGo HTML 搜索（Rust 端，无 CORS 限制）
pub async fn search_web(query: &str) -> Result<Vec<SearchResult>, String> {
    let url = format!("https://html.duckduckgo.com/html/?q={}", urlencoding(query));
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .build()
        .map_err(|e| format!("客户端错误: {}", e))?;

    let resp = client.get(&url).send().await.map_err(|e| format!("请求失败: {}", e))?;
    let html = resp.text().await.map_err(|e| format!("读取失败: {}", e))?;

    let mut results = Vec::new();
    // 解析 DDG HTML 结果
    let mut pos = 0;
    while results.len() < 8 {
        // 找到下一个结果链接
        let link_start = match html[pos..].find("result__a") {
            Some(i) => pos + i,
            None => break,
        };
        // 提取 URL
        let href_start = match html[link_start..].find("href=\"") {
            Some(i) => link_start + i + 6,
            None => { pos = link_start + 1; continue; }
        };
        let href_end = match html[href_start..].find('"') {
            Some(i) => href_start + i,
            None => { pos = link_start + 1; continue; }
        };
        let raw_url = &html[href_start..href_end];

        // 提取标题
        let title_end = match html[href_start..].find("</a>") {
            Some(i) => href_start + i,
            None => { pos = link_start + 1; continue; }
        };
        let title = strip_html(&html[href_end + 2..title_end]);

        // 提取摘要
        let snippet_tag = match html[title_end..].find("result__snippet") {
            Some(i) => title_end + i,
            None => { pos = link_start + 1; continue; }
        };
        let snippet_start = match html[snippet_tag..].find('>') {
            Some(i) => snippet_tag + i + 1,
            None => { pos = link_start + 1; continue; }
        };
        let snippet_end = match html[snippet_start..].find("</a>") {
            Some(i) => snippet_start + i,
            None => { pos = link_start + 1; continue; }
        };
        let snippet = strip_html(&html[snippet_start..snippet_end]);

        // 清理 DDG 重定向 URL
        let clean_url = if let Some(uddg) = raw_url.find("uddg=") {
            let encoded = &raw_url[uddg + 5..];
            let end = encoded.find('&').unwrap_or(encoded.len());
            url_decode(&encoded[..end]).unwrap_or_else(|| raw_url.to_string())
        } else {
            raw_url.to_string()
        };

        if !title.is_empty() && !snippet.is_empty() {
            results.push(SearchResult { title, url: clean_url, snippet });
        }
        pos = snippet_end + 1;
    }

    Ok(results)
}

fn strip_html(s: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        if c == '<' { in_tag = true; continue; }
        if c == '>' { in_tag = false; continue; }
        if !in_tag { result.push(c); }
    }
    result.trim().to_string()
}

fn url_decode(s: &str) -> Option<String> {
    let mut result = String::new();
    let mut i = 0;
    let bytes = s.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &s[i + 1..i + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                result.push(byte as char);
                i += 3;
                continue;
            }
        } else if bytes[i] == b'+' {
            result.push(' ');
            i += 1;
            continue;
        }
        result.push(bytes[i] as char);
        i += 1;
    }
    Some(result)
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
