use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

pub async fn search_web(query: &str) -> Result<Vec<SearchResult>, String> {
    // 多源综合：百度 + 必应 + 360 + 搜狗 **并行** 抓取（全为国内可直连）。
    // 单源可能被反爬/返回空/质量差；更重要的是避免「单一源填满」——当某源被反爬
    // 或对查询解析失败时，其余源照常补上；且单源占比受限，防止无关结果刷屏。
    let baidu_fut = async { search_baidu(query).await.unwrap_or_default() };
    let bing_fut = async { search_bing(query).await.unwrap_or_default() };
    let so360_fut = async { search_360(query).await.unwrap_or_default() };
    let sogou_fut = async { search_sogou(query).await.unwrap_or_default() };
    let (baidu, bing, so360, sogou) = futures::join!(baidu_fut, bing_fut, so360_fut, sogou_fut);

    // 各源取前 N 条后合并去重（限制单一源占比：每源最多 5 条，总上限 15 条）
    let sources = [baidu, bing, so360, sogou];
    let mut seen = std::collections::HashSet::new();
    let mut merged = Vec::new();
    for src in sources.iter() {
        let mut src_added = 0;
        for r in src {
            if src_added >= 5 { break; }
            let key = dedup_key(&r.url);
            if seen.insert(key) {
                merged.push(r.clone());
                src_added += 1;
                if merged.len() >= 15 { break; }
            }
        }
        if merged.len() >= 15 { break; }
    }
    // 相关性过滤：剔除与查询词完全无共现词的结果（防止某源无关结果刷屏，
    // 如中文问题返回英文股票页）。
    if merged.len() >= 3 {
        let kept = filter_relevant(query, &merged);
        // 若过滤后仍有结果则用过滤后的，否则保留原结果（宁缺毋滥时也尽量给）
        if !kept.is_empty() { return Ok(kept); }
        return Ok(merged);
    }
    if !merged.is_empty() { return Ok(merged); }
    // 全部无结果再兜底 DuckDuckGo HTML（境外，国内直连可能不稳）
    search_duckduckgo(query).await
}

/// 相关性过滤（纯函数，可测试）：剔除与查询词无共现的结果，以及明显的低质噪声。
/// 查询中文按字切（"人工智能"→"人 工 智 能"），英文按词。
/// 过滤规则：
/// - 结果文本需命中查询词（任一查询字/词）；英文大小写不敏感
/// - 剔除明显无关的低质结果（单字词典释义 / 股票行情 / 论坛提问等噪声特征）
fn filter_relevant(query: &str, results: &[SearchResult]) -> Vec<SearchResult> {
    let query_terms: Vec<String> = cjk_terms(query).split_whitespace().map(|s| s.to_string()).collect();
    if query_terms.is_empty() { return Vec::new(); }
    // 低质噪声特征：单字/词典释义、股票行情、无意义问答
    let noise_patterns = [
        "的意思", "怎么读", "读音", "组成一个字", "拼音", "近义词", "反义词", "造句",
        "stock", "quote", "share price", "stock price", "finance.yahoo", "google finance",
        "ask-", "zhidao.baidu.com/question/",
    ];
    results
        .iter()
        .filter(|r| {
            let text = format!("{} {}", r.title, r.snippet).to_lowercase();
            // 命中任一查询词
            let has_query = query_terms.iter().any(|t| text.contains(&t.to_lowercase()));
            if !has_query { return false; }
            // 剔除噪声（标题命中即排除）
            let title_low = r.title.to_lowercase();
            !noise_patterns.iter().any(|n| title_low.contains(n))
        })
        .cloned()
        .collect()
}

/// 查询词切分（相关性过滤用）：中文按字切（FTS 同款 unigram），英文按空白词小写
fn cjk_terms(s: &str) -> String {
    let mut out = String::new();
    let mut prev_ascii = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            if prev_ascii { out.push(c); }
            else { out.push(' '); out.push(c.to_ascii_lowercase()); prev_ascii = true; }
        } else if c.is_whitespace() {
            prev_ascii = false;
        } else {
            out.push(' '); out.push(c); prev_ascii = false;
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 去重键：去掉协议/www 前缀与查询串/片段，按 域名+路径 归并
fn dedup_key(url: &str) -> String {
    let no_query = url.split(['?', '#']).next().unwrap_or(url).trim_end_matches('/');
    no_query
        .strip_prefix("https://").or_else(|| no_query.strip_prefix("http://"))
        .unwrap_or(no_query)
        .trim_start_matches("www.")
        .to_string()
}

/// 百度 HTML 搜索（国内直连稳定、中文覆盖率最高）。
/// 百度新版结果块 class="result c-container xpath-log new-pmd"，真实 URL 在
/// mu="..." 属性里（标题 <a> 的 href 是 baidu.com/link? 跳转，不可直接用），
/// 摘要藏在结果块内 <!--s-data:{"summaryData":...}--> JSON 注释中。
/// 注意：百度对高频/自动化访问偶发返回「安全验证」页（极短 HTML），需检测跳过。
async fn search_baidu(query: &str) -> Result<Vec<SearchResult>, String> {
    let url = format!("https://www.baidu.com/s?wd={}&rn=10", urlencoding(query));
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .cookie_store(true)
        .timeout(std::time::Duration::from_secs(8))
        .build().map_err(|e| format!("err:{}", e))?;

    let html = match client.get(&url)
        .header("Accept-Language", "zh-CN,zh;q=0.9")
        .header("Referer", "https://www.baidu.com/")
        .send().await
    {
        Ok(r) => match r.text().await { Ok(t) => t, Err(e) => return Err(format!("百度读取失败: {}", e)) },
        Err(e) => return Err(format!("百度连接失败: {}", e)),
    };

    // 安全验证页 / 无结果标记
    if html.len() < 3000 || html.contains("百度安全验证") || html.contains("wappass") || html.contains("请开启javascript") {
        eprintln!("[Baidu] 安全验证或无结果（{} 字节）", html.len());
        return Ok(Vec::new());
    }
    let results = parse_baidu(&html);
    if !results.is_empty() {
        eprintln!("[Baidu] {} results", results.len());
        return Ok(results);
    }
    eprintln!("[Baidu] 解析无结果");
    Ok(Vec::new())
}

/// 解析百度结果页：按结果块 class 分段，提取 mu= 真实 URL、<h3> 标题、s-data 摘要
fn parse_baidu(html: &str) -> Vec<SearchResult> {
    let mut results = Vec::new();
    let mut pos = 0;
    while results.len() < 10 {
        let start = match html[pos..].find("class=\"result c-container") {
            Some(i) => pos + i, None => break,
        };
        // 结果块结束：下一个 "class=\"result " 或 8KB 上限（块内可能嵌套 div）
        let end = match html[start + 5..].find("class=\"result ") {
            Some(i) => start + 5 + i, None => (start + 8000).min(html.len()),
        };
        let block = &html[start..end];

        let title = extract_baidu_title(block);
        let url = extract_baidu_mu(block);
        if title.is_empty() || url.is_empty() {
            pos = end + 5; continue;
        }
        let snippet = extract_baidu_summary(block);
        results.push(SearchResult {
            title,
            url,
            snippet: snippet.chars().take(300).collect(),
        });
        pos = end + 5;
    }
    results
}

/// 百度标题：结果块内第一个 <h3 ...>...</h3>（strip HTML）
fn extract_baidu_title(block: &str) -> String {
    extract_tag(block, "<h3", "</h3>")
}

/// 百度真实 URL：结果块内 mu="http..." 属性（跳过百度站内跳转/推荐/广告）
fn extract_baidu_mu(block: &str) -> String {
    let mut search_from = 0;
    while let Some(i) = block[search_from..].find("mu=\"") {
        let s = search_from + i + 4;
        let e = match block[s..].find('"') { Some(j) => s + j, None => break };
        let url = &block[s..e];
        search_from = e + 1;
        if !url.starts_with("http") { continue; }
        // 过滤百度站内跳转/推荐/广告/登录等
        if url.contains("baidu.com/link") || url.contains("recommend_list") || url.contains("nourl.ubs")
            || url.contains("top.baidu.com") || url.contains("aiqicha.baidu.com")
            || url.contains("passport.baidu.com") || url.contains("baidu.com/s?") {
            continue;
        }
        return url.to_string();
    }
    String::new()
}

/// 百度摘要：结果块内 <!--s-data:{...}--> JSON 的 summaryData.generalLines[].data[].text
fn extract_baidu_summary(block: &str) -> String {
    let sd = match block.find("<!--s-data:") { Some(i) => i + 11, None => return String::new() };
    let ed = match block[sd..].find("-->") { Some(i) => sd + i, None => return String::new() };
    let json_str = &block[sd..ed];
    // HTML 实体 → 普通字符再解析 JSON
    let json_clean = json_str
        .replace("&quot;", "\"").replace("&amp;", "&")
        .replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">");
    let v: serde_json::Value = match serde_json::from_str(&json_clean) { Ok(v) => v, Err(_) => return String::new() };
    let mut out = String::new();
    if let Some(lines) = v.pointer("/summaryData/generalLines").and_then(|x| x.as_array()) {
        for line in lines {
            if let Some(datas) = line.get("data").and_then(|x| x.as_array()) {
                for d in datas {
                    if let Some(t) = d.get("text").and_then(|x| x.as_str()) {
                        if !out.is_empty() { out.push(' '); }
                        out.push_str(&strip_html(t));
                    }
                }
            }
        }
    }
    out
}

/// 360 搜索（so.com）HTML 搜索（国内直连稳定、中文覆盖率较高）。
/// 结果块 class="res-list"，真实 URL 在 <a data-mdurl="真实URL"> 属性（href 是
/// so.com/link?m= 跳转，不可直接用），标题在 <h3 class="res-title">，摘要 <p class="res-desc">。
async fn search_360(query: &str) -> Result<Vec<SearchResult>, String> {
    let url = format!("https://www.so.com/s?q={}", urlencoding(query));
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .cookie_store(true)
        .timeout(std::time::Duration::from_secs(8))
        .build().map_err(|e| format!("err:{}", e))?;

    let html = match client.get(&url)
        .header("Accept-Language", "zh-CN,zh;q=0.9")
        .header("Referer", "https://www.so.com/")
        .send().await
    {
        Ok(r) => match r.text().await { Ok(t) => t, Err(e) => return Err(format!("360 读取失败: {}", e)) },
        Err(e) => return Err(format!("360 连接失败: {}", e)),
    };

    // 反爬判定：仅命中明确的反爬特征才跳过；只要页面含 res-list 结果标记就继续解析
    let anti_spider = ["antispider", "安全验证", "请输入验证码", "captcha", "访问过于频繁", "wappass"];
    if !html.contains("res-list") && (html.len() < 3000 || anti_spider.iter().any(|k| html.contains(k))) {
        eprintln!("[360] 安全验证或无结果（{} 字节）", html.len());
        return Ok(Vec::new());
    }
    let mut results = Vec::new();
    let mut pos = 0;
    while results.len() < 10 {
        let start = match html[pos..].find("class=\"res-list\"") {
            Some(i) => pos + i, None => break,
        };
        let end = match html[start + 12..].find("class=\"res-list\"") {
            Some(i) => start + 12 + i, None => (start + 3000).min(html.len()),
        };
        let block = &html[start..end];

        let url = extract_attr(block, "data-mdurl=\"", "\"");
        if url.is_empty() || url.contains("so.com/link") {
            pos = end + 12; continue;
        }
        let title = extract_360_title(block);
        let snippet = extract_360_desc(block);
        if title.is_empty() { pos = end + 12; continue; }
        results.push(SearchResult { title, url, snippet: snippet.chars().take(300).collect() });
        pos = end + 12;
    }
    if !results.is_empty() {
        eprintln!("[360] {} results", results.len());
        return Ok(results);
    }
    eprintln!("[360] 解析无结果");
    Ok(Vec::new())
}

/// 360 标题：<h3 class="res-title"> 内文本
fn extract_360_title(block: &str) -> String {
    extract_tag(block, "<h3", "</h3>")
}

/// 360 摘要：<p class="res-desc"> 内文本
fn extract_360_desc(block: &str) -> String {
    extract_tag(block, "<p class=\"res-desc\"", "</p>")
}

/// 搜狗 HTML 搜索（国内直连稳定、中文覆盖率较高）。
/// 结果块：企业卡片 class="vrwrap"（真实 URL 直接 href）+ 普通结果 class="rb"
/// （标题 <h3 class="pt">，链接是 /link?url= 跳转，需补全域名）。
async fn search_sogou(query: &str) -> Result<Vec<SearchResult>, String> {
    let url = format!("https://www.sogou.com/web?query={}", urlencoding(query));
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .cookie_store(true)
        .timeout(std::time::Duration::from_secs(8))
        .build().map_err(|e| format!("err:{}", e))?;

    let html = match client.get(&url)
        .header("Accept-Language", "zh-CN,zh;q=0.9")
        .header("Referer", "https://www.sogou.com/")
        .send().await
    {
        Ok(r) => match r.text().await { Ok(t) => t, Err(e) => return Err(format!("搜狗读取失败: {}", e)) },
        Err(e) => return Err(format!("搜狗连接失败: {}", e)),
    };

    if html.len() < 3000 || html.contains("antispider") || html.contains("请输入验证码") {
        eprintln!("[Sogou] 安全验证或无结果（{} 字节）", html.len());
        return Ok(Vec::new());
    }
    let mut results = Vec::new();
    let mut seen_urls = std::collections::HashSet::new();
    let mut pos = 0;
    // 先解析普通结果 rb，再补垂直/卡片结果 vr-title（整句查询搜狗常返回 vr 卡片而非 rb）
    while results.len() < 10 {
        let start = match html[pos..].find("class=\"rb\"") {
            Some(i) => pos + i, None => break,
        };
        let end = match html[start + 5..].find("class=\"rb\"") {
            Some(i) => start + 5 + i, None => (start + 2500).min(html.len()),
        };
        let block = &html[start..end];
        let title = extract_sogou_title(block);
        if !title.is_empty() {
            // 链接可能是相对路径 /link?url=...，补全搜狗域名
            let mut href = extract_attr(block, "href=\"", "\"");
            if href.starts_with('/') { href = format!("https://www.sogou.com{}", href); }
            let snippet = extract_sogou_summary(block);
            if href.starts_with("http") && seen_urls.insert(href.clone()) {
                results.push(SearchResult { title, url: href, snippet: snippet.chars().take(300).collect() });
            }
        }
        pos = end + 5;
    }
    // 补充 vr-title 卡片（标题在 <h3 class="vr-title"> 内的 <a> 中，链接可能是相对路径）
    if results.len() < 6 {
        let mut pos2 = 0;
        while results.len() < 10 {
            let start = match html[pos2..].find("class=\"vr-title") {
                Some(i) => pos2 + i, None => break,
            };
            let end = (start + 1000).min(html.len());
            let block = &html[start..end];
            // 提取 <a ...>...</a> 内的标题文本
            let title = extract_vr_title(block);
            let mut href = extract_attr(block, "href=\"", "\"");
            if href.starts_with('/') { href = format!("https://www.sogou.com{}", href); }
            if !title.is_empty() && href.starts_with("http") && seen_urls.insert(href.clone()) {
                results.push(SearchResult { title, url: href, snippet: String::new() });
            }
            pos2 = end;
        }
    }
    if !results.is_empty() {
        eprintln!("[Sogou] {} results", results.len());
        return Ok(results);
    }
    eprintln!("[Sogou] 解析无结果");
    Ok(Vec::new())
}

/// 搜狗标题：<h3 class="pt"> 内 <a> 文本
fn extract_sogou_title(block: &str) -> String {
    extract_tag(block, "<h3", "</h3>")
}

/// 搜狗 vr 卡片标题：<h3 class="vr-title"> 内第一个 <a> 的文本（排除 style 等噪声）
fn extract_vr_title(block: &str) -> String {
    // 在 h3 范围内找 <a ...>，取其闭合前文本
    let h3_start = match block.find("class=\"vr-title") { Some(i) => i, None => return String::new() };
    let seg = &block[h3_start..];
    let a_start = match seg.find("<a") { Some(i) => i, None => return String::new() };
    let a_gt = match seg[a_start..].find('>') { Some(i) => a_start + i + 1, None => return String::new() };
    let a_end = match seg[a_gt..].find("</a>") { Some(i) => a_gt + i, None => return String::new() };
    let raw = &seg[a_gt..a_end];
    // 只取可见文本（去标签、去注释）
    let clean = strip_html(raw);
    let clean = clean.replace("<!--red_beg-->", "").replace("<!--red_end-->", "");
    clean.trim().to_string()
}

/// 搜狗摘要：<div class="ft"> 内文本
fn extract_sogou_summary(block: &str) -> String {
    extract_tag(block, "<div class=\"ft\"", "</div>")
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

    /// 真实网络端到端验证百度解析（手动：cargo test -- --ignored test_baidu_live）
    #[tokio::test]
    #[ignore]
    async fn test_baidu_live() {
        let r = search_baidu("华为技术有限公司").await.expect("百度请求失败");
        assert!(!r.is_empty(), "百度无结果");
        assert!(r[0].title.len() > 0 && r[0].url.starts_with("http"), "结果格式异常: {:?}", r[0]);
        eprintln!("百度首条: {} — {}", r[0].title, r[0].url);
    }

    /// 真实网络端到端验证多源综合（手动：cargo test -- --ignored test_web_live）
    #[tokio::test]
    #[ignore]
    async fn test_web_live() {
        let r = search_web("华为技术有限公司").await.expect("综合搜索失败");
        assert!(!r.is_empty(), "综合搜索无结果");
        // 综合应包含百度/必应/360/搜狗多源结果
        eprintln!("综合搜索 {} 条，前 5 条:", r.len());
        for x in r.iter().take(5) { eprintln!("  {} — {}", x.title, x.url); }
    }

    /// 真实网络端到端验证 360 解析（手动：cargo test -- --ignored test_360_live）
    #[tokio::test]
    #[ignore]
    async fn test_360_live() {
        let r = search_360("华为技术有限公司").await.expect("360 请求失败");
        assert!(!r.is_empty(), "360 无结果");
        assert!(r[0].title.len() > 0 && r[0].url.starts_with("http"), "结果格式异常: {:?}", r[0]);
        eprintln!("360 首条: {} — {}", r[0].title, r[0].url);
    }

    /// 真实网络端到端验证搜狗解析（手动：cargo test -- --ignored test_sogou_live）
    #[tokio::test]
    #[ignore]
    async fn test_sogou_live() {
        let r = search_sogou("华为技术有限公司").await.expect("搜狗请求失败");
        assert!(!r.is_empty(), "搜狗无结果");
        assert!(r[0].title.len() > 0 && r[0].url.starts_with("http"), "结果格式异常: {:?}", r[0]);
        eprintln!("搜狗首条: {} — {}", r[0].title, r[0].url);
    }

    #[test]
    fn test_baidu_parser_synthetic() {
        // 构造一段贴近百度新版结构的 HTML：mu= 真实 URL + h3 标题 + s-data 摘要
        let html = r#"<div class="result c-container xpath-log new-pmd" mu="https://www.huawei.com/cn/" data-op="{}">
            <h3 class="c-title t"><a href="http://www.baidu.com/link?url=abc">华为 - 构建万物互联的智能世界</a></h3>
            <!--s-data:{"summaryData":{"generalLines":[{"data":[{"text":"华为创立于1987年，是<em>全球领先</em>的ICT企业"}]}]}}-->
        </div>
        <div class="result c-container xpath-log new-pmd" mu="http://www.baidu.com/link?url=jump">
            <h3 class="c-title t"><a href="http://www.baidu.com/link?url=jump">跳转站内被过滤</a></h3>
        </div>"#;
        let r = parse_baidu(html);
        assert_eq!(r.len(), 1, "应只保留真实 URL 结果，跳过站内跳转");
        assert_eq!(r[0].url, "https://www.huawei.com/cn/");
        assert_eq!(r[0].title, "华为 - 构建万物互联的智能世界");
        assert!(r[0].snippet.contains("华为创立于1987年"), "摘要应来自 s-data: {}", r[0].snippet);
    }

    #[test]
    fn test_dedup_key() {
        assert_eq!(dedup_key("https://www.huawei.com/cn/?a=1"), "huawei.com/cn");
        assert_eq!(dedup_key("http://huawei.com/cn/"), "huawei.com/cn");
        assert_eq!(dedup_key("https://example.com/path#frag"), "example.com/path");
        assert_eq!(dedup_key("https://example.com/path"), "example.com/path");
    }

    #[test]
    fn test_filter_relevant_keeps_matching_drops_unrelated() {
        let results = vec![
            SearchResult { title: "什么是人工神经网络 - 知乎".into(), url: "https://zhihu.com/a".into(), snippet: "人工神经网络由大量神经元组成".into() },
            SearchResult { title: "Microsoft Corporation (MSFT) Stock".into(), url: "https://finance.yahoo.com/quote/MSFT".into(), snippet: "stock price news".into() },
            SearchResult { title: "深度学习与神经网络入门".into(), url: "https://example.com/b".into(), snippet: "神经网络是深度学习的基础".into() },
        ];
        // 查询"人工智能神经网络"→ 字切后应保留含"神/经/网/络"的，剔除纯英文 MSFT
        let kept = filter_relevant("人工智能神经网络", &results);
        assert_eq!(kept.len(), 2, "应剔除无关的 MSFT 股票结果，保留中文相关结果: {:?}", kept.iter().map(|r| &r.title).collect::<Vec<_>>());
        assert!(kept.iter().any(|r| r.url.contains("zhihu")), "应保留知乎结果");
        assert!(!kept.iter().any(|r| r.url.contains("yahoo")), "应剔除 MSFT");
    }

    #[test]
    fn test_filter_relevant_english_case_insensitive() {
        let results = vec![
            SearchResult { title: "DeepSeek V4 model".into(), url: "https://x.com".into(), snippet: "deepseek".into() },
            SearchResult { title: "无关内容".into(), url: "https://y.com".into(), snippet: "xxx".into() },
        ];
        let kept = filter_relevant("DeepSeek", &results);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].url, "https://x.com");
    }

    #[test]
    fn test_filter_relevant_removes_noise() {
        let results = vec![
            // 命中查询但属词典释义噪声 → 应剔除
            SearchResult { title: "人工的意思_人工的解释".into(), url: "https://hanyu.com".into(), snippet: "人工 的意思".into() },
            // 命中查询的真实结果 → 应保留
            SearchResult { title: "人工神经网络入门教程".into(), url: "https://real.com".into(), snippet: "人工神经网络".into() },
            // 股票噪声 → 应剔除
            SearchResult { title: "Microsoft (MSFT) stock quote".into(), url: "https://finance.yahoo.com/quote/MSFT".into(), snippet: "microsoft stock price".into() },
        ];
        let kept = filter_relevant("人工神经网络", &results);
        assert_eq!(kept.len(), 1, "应只保留真实结果，剔除词典释义和股票噪声: {:?}", kept.iter().map(|r| &r.title).collect::<Vec<_>>());
        assert_eq!(kept[0].url, "https://real.com");
    }

    /// 诊断：清洗后关键词的搜索结果相关性（手动：cargo test search::tests::diag_ai_search -- --ignored --nocapture）
    #[tokio::test]
    #[ignore]
    async fn diag_ai_search() {
        let r = search_web("人工智能神经网络").await.expect("搜索失败");
        eprintln!("=== 查询'人工智能神经网络' 综合 {} 条 ===", r.len());
        for x in r.iter().take(10) {
            eprintln!("  [{}] {}", x.title.chars().take(40).collect::<String>(), x.url.chars().take(55).collect::<String>());
        }
    }
}

