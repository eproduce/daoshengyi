// 本地文件路径链接化正则（ChatMessage 渲染用，可测试）。
// 注意：扩展名备选必须「长优先」——html?/hpp 在 h 前、cpp 在 c 前，
// 否则正则引擎从左到右匹配会把 .html 截断成 .h、.cpp 截断成 .c，
// 导致链接路径错误（多出错误扩展名）、点击 file_exists 校验失败打不开。
// 注意：⚠️ 不能用 lookbehind（(?<!...)）排除 URL 前导 —— WKWebView/Safari 旧内核
// 不支持 ES2018 lookbehind，模块加载直接抛 SyntaxError 白屏。改为「前缀捕获组」：
//   - group 1 = 前导字符（路径在行首时为 `^` 空串；否则为前导的非 [\w/:] 字符）
//   - group 2 = 路径本身
// 调用方取 m[2]，路径起点 = m.index + m[1].length。
export const LOCAL_FILE_RE =
  /(^|[^\w\/:])((?:~\/|\/)[A-Za-z0-9_@.\/\-\u4e00-\u9fa5]*\/[^ \t\n\r\[\]\(\)"']*\.(?:csv|xlsx?|xlsm|pdf|docx?|txt|md|json|png|jpe?g|gif|webp|bmp|svg|py|js|ts|rs|toml|yaml|ya?ml|xml|log|sh|rb|go|java|cpp|c|hpp|html?|h|css|sql|db|zip|tar\.gz|7z))/gi; // eslint-disable-line no-useless-escape

/** 同上但**不带 `g`**：`g` 正则有 `lastIndex` 状态，复用同一实例会漏匹配。 */
const LOCAL_FILE_RE_NO_G = new RegExp(LOCAL_FILE_RE.source, "i");

/**
 * Markdown 链接的 href → 本地绝对文件路径；不是本地文件时返回 `null`。
 *
 * **为什么需要**：模型常把产物写成 Markdown 链接 `[标题](/Users/…/页面.html)`。
 * marked 会把 href 原样渲染成 `<a href="/Users/…">`，而 webview 会把它当作
 * **本站的相对路径**去导航（Tauri 里表现为点击无反应 / 白屏）——2026-10-08 用户
 * 实测「无法打开产物」就是这个原因。所以必须识别出来，改造成 `.local-file-link`，
 * 点击走 `file_exists` + `open_file`。
 *
 * 排除：协议相对 URL（`//host/…`）、不带 / 的路径（`~/…` 无法在 href 里表达）、
 * 以及扩展名不在白名单里的路径（与 `LOCAL_FILE_RE` 同一份扩展名表，零漂移）。
 */
export function localPathFromHref(href: string): string | null {
  const raw = (href || "").trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  const noFragment = raw.split("#")[0].split("?")[0];
  let decoded = noFragment;
  try {
    decoded = decodeURIComponent(noFragment);
  } catch {
    decoded = noFragment; // 含非法 % 序列时就按原样比对
  }
  const m = LOCAL_FILE_RE_NO_G.exec(decoded);
  if (!m) return null;
  if (m.index + (m[1] ?? "").length !== 0) return null; // 必须从头开始
  const path = m[2];
  if (path.length !== decoded.length) return null; // 整串必须就是一个路径
  return path;
}
