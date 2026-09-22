import { it, expect, describe } from "vitest";
import { summarizeTools, stripToolCards } from "../src/utils/tool-summary.ts";

// 真实生成格式（见 chat.ts）：🔧 卡片 = 标题 + 参数 details + 结果 details
const doneCard = (tool: string) =>
  "### 🔧 调用工具：`" +
  tool +
  "`\n\n" +
  "<details><summary>参数</summary>\n\n```json\n{}\n```\n\n</details>" +
  "\n<details><summary>✅ 工具结果</summary>\n\n```\nok\n```\n\n</details>";

// 🌐 搜索卡片 = 标题 + 查询行 + 结果 details
const searchCard =
  "### 🌐 联网搜索\n\n**查询**：`今天的金价`\n\n" +
  "<details><summary>共 5 条结果</summary>\n\n- **A**\n  <https://a.com>\n  摘要\n\n</details>";

const failCard = "> ❌ 工具调用失败: `连接超时`";

describe("工具调用分组摘要 summarizeTools", () => {
  it("按首次出现顺序去重计数，超出 3 个用 +N 收尾", () => {
    const s = summarizeTools([
      { name: "web_search", status: "done", durationMs: 1200 },
      { name: "web_search", status: "done", durationMs: 800 },
      { name: "fetch_page", status: "done", durationMs: 500 },
      { name: "run_tests", status: "done", durationMs: 100 },
      { name: "git", status: "done", durationMs: 50 },
    ]);
    expect(s.count).toBe(5);
    expect(s.namesLabel).toBe("web_search ×2、fetch_page、run_tests、+1");
    expect(s.totalMs).toBe(2650);
    expect(s.statusLabel).toBe("全部成功");
  });

  it("运行中 / 有失败 的状态文案", () => {
    expect(summarizeTools([{ name: "a", status: "running" }]).statusLabel).toBe("运行中…");
    expect(
      summarizeTools([
        { name: "a", status: "done" },
        { name: "b", status: "error" },
      ]).statusLabel,
    ).toBe("1 成功 · 1 失败");
    expect(summarizeTools([{ name: "a", status: "error" }]).statusLabel).toBe("1 次失败");
  });

  it("空列表不炸", () => {
    const s = summarizeTools([]);
    expect(s.count).toBe(0);
    expect(s.namesLabel).toBe("");
    expect(s.statusLabel).toBe("全部成功");
  });
});

describe("剥离正文里的工具卡片 stripToolCards", () => {
  it("剥掉开头的 🔧 卡片，保留真正的回答", () => {
    const content = `${doneCard("web_search")}\n\n${doneCard("fetch_page")}\n\n这是最终答案。`;
    expect(stripToolCards(content)).toBe("这是最终答案。");
  });

  it("剥掉 🌐 搜索卡片与失败卡片", () => {
    const content = `${searchCard}\n\n${failCard}\n\n最终答案`;
    expect(stripToolCards(content)).toBe("最终答案");
  });

  it("没有卡片时原样返回", () => {
    const plain = "## 标题\n\n正常内容，含 <details> 字面量也无妨。";
    expect(stripToolCards(plain)).toBe(plain);
  });

  it("正文里讲到卡片写法时不会被误删（形状对不上就停）", () => {
    const talk = "### 🔧 调用工具 只是文本，不会执行\n\n这是解释段落。";
    expect(stripToolCards(talk)).toBe(talk);
  });

  it("只有卡片没有正文 → 返回空串", () => {
    expect(stripToolCards(`${doneCard("x")}\n`)).toBe("");
  });

  it("卡片后紧跟标题正文也能正确切开", () => {
    const content = `${doneCard("x")}\n\n## 结论\n\n确实如此。`;
    expect(stripToolCards(content)).toBe("## 结论\n\n确实如此。");
  });
});
