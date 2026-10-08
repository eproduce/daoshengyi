import { describe, it, expect } from "vitest";
import { localPathFromHref } from "../src/utils/local-file-re";
import { renderLocalFileLink, renderMarkdownLink } from "../src/utils/local-file-link";

/**
 * 回归防线（2026-10-08 用户实测「无法打开产物」）：
 *
 * 模型按上游惯例把产物写成 Markdown 链接 `[标题](/Users/…/页面.html)`。
 * marked 会原样渲染 `<a href="/Users/…">`，webview 把它当**本站相对路径**去导航
 * ——Tauri 里表现为点击无反应 / 白屏。修复要把这类 href 识别成**本地文件路径**，
 * 改造成 `.local-file-link`（点击走 file_exists + open_file）。
 *
 * 这些用例同时钉住两个边界：① 协议相对 URL（`//host/…`）不能被误判为本地路径；
 * ② 扩展名表必须与 `LOCAL_FILE_RE` 同一份（零漂移，否则 .html 产物换了扩展名就点不开）。
 */
describe("localPathFromHref：Markdown 链接 href → 本地绝对文件路径", () => {
  it("识别普通绝对文件路径", () => {
    expect(localPathFromHref("/Users/wanghuan/道生一页面/量子理论详解-20261008.html")).toBe(
      "/Users/wanghuan/道生一页面/量子理论详解-20261008.html",
    );
    expect(localPathFromHref("/tmp/a/b.md")).toBe("/tmp/a/b.md");
  });

  it("百分号编码的 href 会被解码（模型常写 encodeURI 后的地址）", () => {
    const encoded = "/Users/wanghuan/%E9%81%93%E7%94%9F%E4%B8%80%E9%A1%B5%E9%9D%A2/x.html";
    expect(localPathFromHref(encoded)).toBe("/Users/wanghuan/道生一页面/x.html");
  });

  it("fragment 与 query 被剥掉", () => {
    expect(localPathFromHref("/tmp/a/b.html#L12")).toBe("/tmp/a/b.html");
    expect(localPathFromHref("/tmp/a/b.html?v=2")).toBe("/tmp/a/b.html");
  });

  it("排除协议相对 URL 与网络地址", () => {
    expect(localPathFromHref("//cdn.example.com/x.html")).toBeNull();
    expect(localPathFromHref("https://example.com/x.html")).toBeNull();
    expect(localPathFromHref("http://example.com/x.html")).toBeNull();
    expect(localPathFromHref("mailto:a@b.com")).toBeNull();
  });

  it("排除无扩展名 / 未知扩展名 / 非绝对路径 / 空值", () => {
    expect(localPathFromHref("/tmp/a/b")).toBeNull();
    expect(localPathFromHref("/tmp/a/b.unknownext")).toBeNull();
    expect(localPathFromHref("~/Documents/a.html")).toBeNull();
    expect(localPathFromHref("")).toBeNull();
    expect(localPathFromHref("a/b.html")).toBeNull();
  });

  it("带空格或已含其它正文的 href 不算纯路径", () => {
    expect(localPathFromHref("/tmp/a b/c.html")).toBeNull();
    expect(localPathFromHref("/tmp/a.html 说明")).toBeNull();
  });
});

describe("renderMarkdownLink / renderLocalFileLink：链接 HTML", () => {
  const unescape = (s: string) =>
    s
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");

  it("本地路径 → 可点击本地文件链接（带 data-path 供点击与存在性校验）", () => {
    const path = "/Users/wanghuan/道生一页面/量子理论详解-20261008.html";
    const html = renderMarkdownLink(path, "量子理论详解");
    expect(html).toContain('class="local-file-link"');
    expect(html).toContain(`data-path="${encodeURIComponent(path)}"`);
    expect(html).toContain("file:///Users/");
    expect(html).toContain("量子理论详解"); // 保留模型的链接文字（好看）
    expect(html).not.toContain('href="/Users/'); // 关键：不能保留会被 webview 当相对路径的 href
  });

  it("百分号编码的 href 归一化为真实路径（点击才找得到文件）", () => {
    const html = renderMarkdownLink("/tmp/%E4%B8%AD%E6%96%87/x.html", "标题");
    expect(html).toContain(`data-path="${encodeURIComponent("/tmp/中文/x.html")}"`);
  });

  it("网络链接保持普通 <a>（交给系统浏览器分支）", () => {
    expect(renderMarkdownLink("https://example.com/a", "站外")).toBe(
      '<a href="https://example.com/a">站外</a>',
    );
    expect(renderMarkdownLink("https://example.com/a", "站外", "标题")).toBe(
      '<a href="https://example.com/a" title="标题">站外</a>',
    );
    // 协议相对 URL 也不能被本地链接化
    expect(renderMarkdownLink("//cdn.example.com/x.html", "CDN")).toBe(
      '<a href="//cdn.example.com/x.html">CDN</a>',
    );
  });

  it("renderLocalFileLink：行号锚点与属性转义", () => {
    const one = renderLocalFileLink("/tmp/a.ts", "📄 a.ts:12", 12);
    expect(one).toContain('data-line="12"');
    expect(one).toContain(">📄 a.ts:12<");
    const quoted = renderLocalFileLink('/tmp/a"b.html', "x");
    expect(quoted).toContain("&quot;"); // 引号被转义，不破坏属性
    expect(unescape(quoted)).toContain('/tmp/a"b.html');
  });

  it("~/ 开头的路径退回 # 占位（无法构成合法 file URL），但路径仍在 title/data-path 里", () => {
    const html = renderLocalFileLink("~/Documents/a.html", "a.html");
    expect(html).toContain('href="#"');
    expect(html).toContain('title="~/Documents/a.html"');
    expect(html).toContain(`data-path="${encodeURIComponent("~/Documents/a.html")}"`);
  });
});
