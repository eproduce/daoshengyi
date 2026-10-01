/// <reference types="vite/client" />

import { describe, it, expect } from "vitest";

/**
 * 回归防线：禁止 `src/**` 使用 ES2018 lookbehind（`(?<=` / `(?<!`）。
 *
 * 为什么必须用「源码扫描」这种非常规手段：
 * 应用跑在 WKWebView（macOS 12/13 用的是随系统版本的那个 JavaScriptCore）里，该引擎
 * **不支持** lookbehind；而且 JSC 对正则字面量是**懒编译**——模块照常加载，直到
 * **首次执行到那个正则**才抛
 * `SyntaxError: Invalid regular expression: invalid group specifier name`。
 *
 * 要命的是 Node/V8（本测试、vite build、eslint 都在其上）**支持** lookbehind：
 * 所有常规门禁全绿，问题只在用户机器上炸。
 *
 * 2026-10-02 实测踩到：`utils/verify-receipts.ts` 的 splitSentences 用 lookbehind 切句，
 * 该函数跑在「回合收尾的断言门禁」里 → 异常冒泡到外层 catch → streamingContent 被清空，
 * 27 轮工具调用 + 2429 字最终汇报整轮丢弃，用户只看到「回复生成中断」。
 *
 * 替代写法：捕获组 + replace（见 `utils/local-file-re.ts`、`utils/verify-receipts.ts`）。
 */

/** 用 Vite 的原始文本导入扫描源码（tests/tsconfig.json 里 types: []，没有 node:fs 类型） */
const SOURCES = import.meta.glob("../src/**/*.{ts,vue}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** lookbehind 标记 */
const LOOKBEHIND = /\(\?<[=!]/;

/** 去掉注释后再扫描：文档注释里会举例提到 lookbehind（如 local-file-re.ts 的说明） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释 / JSDoc
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // 行注释（`[^:]` 避免误伤 https:// ）
}

describe("生产 WebView 兼容性：src 不得使用 lookbehind", () => {
  it("至少扫到源码文件（防止扫描路径写错导致空跑）", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
  });

  it("没有任何 (?<= / (?<! （WKWebView 的 JSC 不支持，Node 侧测不出来）", () => {
    const hits: string[] = [];
    for (const [file, raw] of Object.entries(SOURCES)) {
      const code = stripComments(raw);
      code.split("\n").forEach((line, i) => {
        if (LOOKBEHIND.test(line)) hits.push(`${file.replace("../", "")}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(hits, `发现 lookbehind，请改用「捕获组 + replace」写法：\n${hits.join("\n")}`).toEqual(
      [],
    );
  });
});
