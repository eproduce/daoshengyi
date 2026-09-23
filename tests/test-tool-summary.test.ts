import { it, expect, describe } from "vitest";
import {
  summarizeTools,
  stripToolCards,
  stripToolCardsForDisplay,
  splitLeadingToolCards,
  parsePersistedTools,
} from "../src/utils/tool-summary.ts";

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

  // 回归：老数据的 message.tools 为空（DB 早期没这列），此时剥卡片 = 把工具记录删掉
  it("没有结构化记录时**不剥**正文卡片（否则工具历史整个消失）", () => {
    const content = `${doneCard("x")}\n\n## 结论`;
    expect(stripToolCardsForDisplay(content, undefined)).toBe(content);
    expect(stripToolCardsForDisplay(content, [])).toBe(content);
    // 有结构化记录时照旧剥掉（界面上只留折叠组，避免显示两遍）
    expect(stripToolCardsForDisplay(content, [{}])).toBe("## 结论");
    // 空正文不抛错
    expect(stripToolCardsForDisplay(undefined, [{}])).toBe("");
  });
});

// 反解：老会话在 DB 里没有结构化 tools，只有正文卡片。反解出卡片就能让老会话也折叠展示。
describe("从正文反解工具卡 splitLeadingToolCards", () => {
  it("🔧 卡片：工具名/参数/结果都抽出来，正文其余部分不动", () => {
    const content = `${doneCard("web_search")}\n\n## 结论\n\n确实如此。`;
    const { tools, body } = splitLeadingToolCards(content);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("web_search");
    expect(tools[0].status).toBe("done");
    expect(tools[0].argsPreview).toBe("{}"); // details 里的围栏被去掉
    expect(tools[0].resultPreview).toBe("ok");
    expect(body).toBe("## 结论\n\n确实如此。");
  });

  it("连续多张卡片全部解析，顺序与正文一致", () => {
    const content = `${doneCard("a")}\n\n${doneCard("b")}\n\n答案`;
    const { tools, body } = splitLeadingToolCards(content);
    expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
    expect(body).toBe("答案");
  });

  it("🌐 搜索卡片：查询写进参数预览，结果块直取", () => {
    const { tools, body } = splitLeadingToolCards(`${searchCard}\n\n结论`);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("web_search");
    expect(tools[0].argsPreview).toContain("今天的金价");
    expect(tools[0].resultPreview).toContain("A");
    expect(body).toBe("结论");
  });

  it("失败单行：解析成 error 卡片（工具名如实标为未知，不编）", () => {
    const content = `${failCard}\n\n后面还有正文`;
    const { tools, body } = splitLeadingToolCards(content);
    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe("error");
    expect(tools[0].name).toBe("未知工具");
    expect(tools[0].error).toBe("连接超时");
    expect(body).toBe("后面还有正文");
  });

  it("没有卡片 / 空值 → 零卡片、正文原样（调用方据此走「不剥」分支）", () => {
    const plain = "### 普通标题\n\n正文";
    expect(splitLeadingToolCards(plain)).toEqual({ tools: [], body: plain });
    expect(splitLeadingToolCards(undefined)).toEqual({ tools: [], body: "" });
    expect(splitLeadingToolCards("")).toEqual({ tools: [], body: "" });
  });

  it("不变量：剥掉的就是解析出来的（两边不会不一致）", () => {
    const content = `${doneCard("a")}\n\n${failCard}\n\n${searchCard}\n\n## 结论`;
    const { tools, body } = splitLeadingToolCards(content);
    expect(tools).toHaveLength(3);
    expect(stripToolCards(content)).toBe(body);
    // 解析出的卡片数 == 摘要里统计的次数（老会话折叠头的数字不会对不上）
    expect(summarizeTools(tools).count).toBe(3);
  });
});

// 真实回归：工具卡原先只在内存，重载历史后整段工具记录消失。
// 现在它随消息落库，读回时必须容错（库里的数据可能来自旧版本/被外部改过/半截写入）。
describe("读回持久化的工具卡 parsePersistedTools", () => {
  it("正常数据：字段齐全原样读回", () => {
    const raw = JSON.stringify([
      {
        name: "web_search",
        server: "app",
        status: "done",
        durationMs: 1234,
        argsPreview: '{"query":"x"}',
        resultPreview: "3 条结果",
      },
    ]);
    expect(parsePersistedTools(raw)).toEqual([
      {
        name: "web_search",
        server: "app",
        status: "done",
        durationMs: 1234,
        argsPreview: '{"query":"x"}',
        resultPreview: "3 条结果",
        error: undefined,
      },
    ]);
  });

  it("空值/坏 JSON/非数组 → undefined（= 没有结构化记录，显示层据此保留正文卡片）", () => {
    expect(parsePersistedTools(null)).toBeUndefined();
    expect(parsePersistedTools(undefined)).toBeUndefined();
    expect(parsePersistedTools("")).toBeUndefined();
    expect(parsePersistedTools("{不是 JSON")).toBeUndefined();
    expect(parsePersistedTools('{"name":"x"}')).toBeUndefined(); // 对象不是数组
    expect(parsePersistedTools('"web_search"')).toBeUndefined();
    expect(parsePersistedTools("[]")).toBeUndefined(); // 空数组也没得渲染
  });

  it("缺字段/错类型的条目被补齐或丢弃，不让整页报错", () => {
    const raw = JSON.stringify([
      { name: "ok_tool" },
      { name: "   " }, // 没有工具名 → 丢
      { nope: 1 }, // 没有 name → 丢
      null,
      "字符串条目",
      { name: "weird", status: "unknown-status", server: 123, durationMs: "1" },
    ]);
    const got = parsePersistedTools(raw);
    expect(got?.map((t) => t.name)).toEqual(["ok_tool", "weird"]);
    expect(got?.[0].status).toBe("done"); // 缺 status → 默认 done
    expect(got?.[0].server).toBe("app"); // 缺 server → app
    expect(got?.[1].status).toBe("done"); // 非法 status → done（不产生非法枚举值）
    expect(got?.[1].server).toBe("app"); // 非字符串 server → app
    expect(got?.[1].durationMs).toBeUndefined(); // 非数字耗时 → 丢掉而不是 NaN
  });

  it("错误卡保留 error 文本（否则失败原因在重载后看不见了）", () => {
    const raw = JSON.stringify([
      { name: "run_command", server: "app", status: "error", error: "exit=1" },
    ]);
    const got = parsePersistedTools(raw);
    expect(got?.[0].status).toBe("error");
    expect(got?.[0].error).toBe("exit=1");
  });
});
