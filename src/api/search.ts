interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * DuckDuckGo 搜索（通过 HTML 页面解析，无需 API Key）
 */
export async function searchDDG(query: string): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url);
  const html = await resp.text();

  const results: SearchResult[] = [];
  // 解析结果块
  const blockRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = blockRegex.exec(html)) !== null && results.length < 8) {
    const rawUrl = match[1];
    const title = match[2].replace(/<[^>]+>/g, "").trim();
    const snippet = match[3].replace(/<[^>]+>/g, "").trim();
    // 清理 URL（DDG 用重定向包装）
    const urlMatch = rawUrl.match(/uddg=(https?%3A[^&]+)/);
    const cleanUrl = urlMatch ? decodeURIComponent(urlMatch[1]) : rawUrl;
    if (title && snippet) {
      results.push({ title, url: cleanUrl, snippet });
    }
  }

  return results;
}

/**
 * 将搜索结果格式化为注入上下文的文本
 */
export function formatSearchResults(query: string, results: { title: string; url: string; snippet: string }[]): string {
  if (results.length === 0) return "";
  let ctx = `\n\n[联网搜索结果] 用户查询: "${query}"\n`;
  results.forEach((r, i) => {
    ctx += `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}\n`;
  });
  ctx += "\n请基于以上搜索结果回答用户的问题，并引用来源。";
  ctx += "\n回复要求：先说明「共找到 N 条有用信息」或「未找到可靠公开信息」，再用编号列表整理出关键信息+来源链接，格式清晰美观，禁止原样粘贴搜索结果。\n";
  return ctx;
}
