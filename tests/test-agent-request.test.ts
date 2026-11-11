import { describe, it, expect } from "vitest";
import {
  appendVolatileContext,
  assembleRequest,
  pruneToBudget,
  totalMsgChars,
  type HistoryMessage,
  type ModelMessage,
} from "../src/utils/agent-request.ts";
import { composeAssistantContent, splitLeadingToolCards } from "../src/utils/tool-summary.ts";

/**
 * 请求装配：`sendMessage` 里最不该靠肉眼保证的一段（模型看到什么）。
 * 两条不变量写在这里：
 *   ① 前缀稳定（system + 历史逐字稳定；易变内容只追加到最后一条 user）
 *   ② 模型可见即已记录（遗留 UI 卡片剥掉；空正文不发、且不与 origins 错位）
 */
const M = (role: string, content: string, extra: Partial<HistoryMessage> = {}): HistoryMessage => ({
  role,
  content,
  ...extra,
});

const strip = (m: HistoryMessage) => splitLeadingToolCards(m.content).body;

const opts = (over: Partial<Parameters<typeof assembleRequest>[1]> = {}) => ({
  systemPrompt: "SYSTEM",
  maxContextMessages: 50,
  supportsImages: true,
  compactBefore: 0,
  compactSummary: "",
  modelVisibleContent: strip,
  ...over,
});

describe("assembleRequest：窗口与顺序", () => {
  it("system 在最前，历史按序跟随；origins 与 messages 一一对应", () => {
    const out = assembleRequest([M("user", "a"), M("assistant", "b")], opts());
    expect(out.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(out.origins).toEqual([null, 0, 1]);
  });

  it("没有 system 提示词就不注入（不造空 system）", () => {
    const out = assembleRequest([M("user", "a")], opts({ systemPrompt: "" }));
    expect(out.messages[0].role).toBe("user");
  });

  it("过滤掉 system 角色与仍在流式中的消息", () => {
    const out = assembleRequest(
      [M("system", "旧系统"), M("user", "a"), M("assistant", "半个回复", { streaming: true })],
      opts(),
    );
    expect(out.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("只取最近 maxContextMessages 条，origins 记录**原始**序号（裁剪后仍能对上摘要范围）", () => {
    const hist = [M("user", "0"), M("assistant", "1"), M("user", "2"), M("assistant", "3")];
    const out = assembleRequest(hist, opts({ maxContextMessages: 2 }));
    expect(out.messages.map((m) => m.content)).toEqual(["SYSTEM", "2", "3"]);
    expect(out.origins).toEqual([null, 2, 3]);
    expect(out.histStart).toBe(2);
  });

  it("被压缩覆盖（compactBefore）的历史不发送，改由摘要替代", () => {
    const out = assembleRequest(
      [M("user", "老1"), M("assistant", "老2"), M("user", "新")],
      opts({ compactBefore: 2, compactSummary: "前面聊了 X" }),
    );
    expect(out.messages[0].role).toBe("system");
    expect(String(out.messages[1].content)).toContain("已压缩的历史对话摘要");
    expect(String(out.messages[1].content)).toContain("前面聊了 X");
    expect(out.messages.map((m) => m.content)).not.toContain("老1");
    expect(out.messages.map((m) => m.content)).toContain("新");
  });
});

describe("assembleRequest：图片与遗留卡片", () => {
  it("支持图片 → 多模态 content 数组（文本 + image_url）", () => {
    const out = assembleRequest(
      [M("user", "看图", { images: [{ base64: "data:image/png;base64,AAA" }] })],
      opts(),
    );
    const c = out.messages[1].content as { type: string }[];
    expect(Array.isArray(c)).toBe(true);
    expect(c[0]).toEqual({ type: "text", text: "看图" });
    expect(c[1]).toMatchObject({ type: "image_url" });
  });

  it("不支持图片（DeepSeek）→ 只发文本，绝不发 image_url（否则 400）", () => {
    const out = assembleRequest(
      [M("user", "看图", { images: [{ base64: "x" }] })],
      opts({ supportsImages: false }),
    );
    expect(typeof out.messages[1].content).toBe("string");
    expect(JSON.stringify(out.messages)).not.toContain("image_url");
  });

  it("老会话遗留的 UI 卡片被剥掉（模型不该看到自己写过卡片）", () => {
    const legacy =
      "### 🔧 调用工具：`web_search`\n\n<details><summary>参数</summary>\n\n```json\n{}\n```\n\n</details>\n\n最终答案。";
    const out = assembleRequest([M("assistant", legacy, { tools: [] })], opts());
    expect(out.messages[1].content).toBe("最终答案。");
  });

  it("空正文不发，且**不占 origins 位**（原实现会错位 → 裁剪时删错消息）", () => {
    const out = assembleRequest([M("user", "问题"), M("assistant", "   ")], opts());
    expect(out.messages).toHaveLength(2); // system + user
    expect(out.origins).toEqual([null, 0]); // 不该出现第 3 个 origin
  });
});

describe("appendVolatileContext：前缀稳定", () => {
  it("追加到**最后一条 user**，不动 system（前缀一变提示词缓存就失效）", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "问" },
      { role: "assistant", content: "答" },
      { role: "user", content: "再问" },
    ];
    appendVolatileContext(msgs, ["记忆：用户喜欢简洁"]);
    expect(msgs[0].content).toBe("SYSTEM");
    expect(msgs[1].content).toBe("问");
    expect(msgs[3].content).toBe("再问\n\n[本次补充上下文]\n记忆：用户喜欢简洁");
  });

  it("多模态 content 追加一个文本片段（不破坏图片结构）", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url" }] },
    ];
    appendVolatileContext(msgs, ["RAG：片段"]);
    const c = msgs[0].content as { type: string; text?: string }[];
    expect(c).toHaveLength(3);
    expect(c[2].type).toBe("text");
    expect(c[2].text).toContain("RAG：片段");
  });

  it("没有 user 消息时补一条（宁可多一条，也不能让易变内容无处安放）", () => {
    const msgs: ModelMessage[] = [{ role: "system", content: "S" }];
    appendVolatileContext(msgs, ["时间：现在"]);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].role).toBe("user");
  });

  it("没有易变内容 → 原样返回（不改任何消息）", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "问" }];
    appendVolatileContext(msgs, []);
    expect(msgs[0].content).toBe("问");
  });
});

describe("pruneToBudget：两相裁剪", () => {
  const big = (n: number) => "x".repeat(n);

  it("不超预算 → 什么都不做", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "S" },
      { role: "user", content: "短" },
    ];
    const origins = [null, 0];
    pruneToBudget({ messages, origins, covered: new Set(), maxChars: 1000 });
    expect(messages).toHaveLength(2);
  });

  it("第一相：先删「已被摘要覆盖」的老段（摘要已是它的有损替代）", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "S" },
      { role: "user", content: big(600) }, // 被摘要覆盖
      { role: "user", content: big(600) }, // 未覆盖
      { role: "user", content: "尾" },
    ];
    const origins = [null, 0, 1, 2];
    // 总量 1 + 600 + 600 + 1 = 1202 > 1100 → 删掉被覆盖的那条即达标
    pruneToBudget({ messages, origins, covered: new Set([0]), maxChars: 1100 });
    expect(messages.map((m) => m.content)).toEqual(["S", big(600), "尾"]);
    expect(origins).toEqual([null, 1, 2]);
  });

  it("第二相：删尽覆盖段仍超长 → 从最早的非 system 删，system 永不删", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "S" },
      { role: "user", content: big(600) },
      { role: "user", content: big(600) },
      { role: "user", content: big(600) },
      { role: "user", content: "尾" },
    ];
    const origins = [null, 0, 1, 2, 3];
    // 总量 1803 > 700：删两条后剩 S + 600 + 尾 = 602 达标（不会把最后一条也删掉）
    pruneToBudget({ messages, origins, covered: new Set(), maxChars: 700 });
    expect(messages[0].content).toBe("S");
    expect(messages.map((m) => m.content)).toEqual(["S", big(600), "尾"]);
    expect(origins).toEqual([null, 2, 3]); // 序号跟着消息一起删（不再错位）
    expect(origins.length).toBe(messages.length);
  });

  it("总共只剩 2 条时停手（不把对话裁成一条）", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: big(600) },
      { role: "user", content: big(600) },
    ];
    const origins = [null, 0];
    pruneToBudget({ messages, origins, covered: new Set(), maxChars: 10 });
    expect(messages).toHaveLength(2);
  });
});

describe("端到端：新数据（正文已无卡片）与老数据都能装配出干净上下文", () => {
  it("新数据：content 只有答案，tools 走结构化字段", () => {
    const content = composeAssistantContent("结论：已生成。", 2);
    const out = assembleRequest([M("user", "做个报告"), M("assistant", content)], opts());
    expect(String(out.messages[2].content)).toBe("结论：已生成。");
    expect(totalMsgChars(out.messages)).toBeLessThan(40 + 20);
  });
});
