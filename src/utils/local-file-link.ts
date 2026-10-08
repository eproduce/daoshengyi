// 本地文件链接的 HTML 渲染（纯函数，可测）。
//
// ## 为什么单独抽出来
//
// `ChatMessage.vue` 里有**两条**路径都要产出「可点击的本地文件链接」：
//
// 1. 正文 / 行内代码里的裸路径（`linkifyLocalPaths` → `LOCAL_FILE_RE`）；
// 2. **Markdown 链接** `[标题](/绝对/路径.html)`（marked 的 `link` token）。
//
// ② 是最容易漏的一条：marked 会把 href 原样写成 `<a href="/Users/…">`，而 webview
// 把它当成**本站的相对路径**去导航（Tauri 里表现为点击无反应 / 白屏）。
// 2026-10-08 用户实测「无法打开产物」的根因就是它——模型按上游惯例把产物写成
// Markdown 链接，点击后什么都没发生。
//
// 所以「本地路径 → 链接 HTML」只能有一处实现：`renderLocalFileLink`（属性顺序与转义
// 规则固定，同时被裸路径与 Markdown 链接两条路径复用）。

import { localPathFromHref } from "./local-file-re";

/** 属性值转义：路径可能含引号 / & / <，直接拼进 HTML 会破坏结构 */
const esc = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * 生成可点击的本地文件链接。
 *
 * - `href` 用真实 `file://` 地址（悬停看状态栏 / 右键复制链接 / 复制渲染内容都可用）；
 *   `~/` 开头的路径无法构成合法 file URL → 退回 `#` 占位（真实路径仍在 data-path/title）。
 * - 点击由 `onContentClick` 拦截（preventDefault）走 `file_exists` + `open_file`，
 *   webview 不会真的去导航 `file://`。
 */
export function renderLocalFileLink(
  path: string,
  innerHtml: string,
  line?: number | string | null,
): string {
  const href = path.startsWith("/")
    ? `file://${encodeURI(path).replace(/#/g, "%23").replace(/\?/g, "%3F")}`
    : "#";
  const ln = line ? ` data-line="${esc(String(line))}"` : "";
  return (
    `<a href="${href}" title="${esc(path)}" class="local-file-link" ` +
    `data-path="${encodeURIComponent(path)}"${ln}>${innerHtml}</a>`
  );
}

/**
 * Markdown 链接（marked `link` renderer）渲染：
 * - href 是**本地绝对文件路径** → 走 `renderLocalFileLink`（可点击、存在性可校验）；
 * - 其余 → 普通 `<a>`，交给 `onContentClick` 的 web 链接分支（系统浏览器打开）。
 */
export function renderMarkdownLink(href: string, innerHtml: string, title?: string | null): string {
  const local = localPathFromHref(href || "");
  if (local) return renderLocalFileLink(local, innerHtml);
  const t = title ? ` title="${esc(title)}"` : "";
  return `<a href="${esc(href || "")}"${t}>${innerHtml}</a>`;
}
