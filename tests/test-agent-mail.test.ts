import { describe, it, expect } from "vitest";
import {
  MAX_PER_TURN,
  composeMailBatch,
  formatMail,
  normalizeMailKind,
  type MailMessage,
} from "../src/utils/agent-mail.ts";

const msg = (id: number, over: Partial<MailMessage> = {}): MailMessage => ({
  id,
  from_agent: "main",
  to_agent: "调研员",
  kind: "note",
  content: `第 ${id} 条`,
  created_at: 1_700_000_000_000 + id,
  ...over,
});

/**
 * 信箱消费：这个功能的危险不在「能不能发」，而在**读的时机与去重**——
 * 吞掉新消息（漏读）或重复消费（重复执行）都是真事故。
 */
describe("composeMailBatch：只取本批，且返回本批 id", () => {
  it("没有消息时什么都不注入", () => {
    expect(composeMailBatch([], "调研员")).toEqual({ text: "", ids: [] });
  });

  it("标注来源与类型，且明确「不代表用户当前发言」", () => {
    const b = composeMailBatch([msg(1, { content: "先看构建脚本" })], "调研员");
    expect(b.text).toContain("成员信箱");
    expect(b.text).toContain("来自 main");
    expect(b.text).toContain("[note]");
    expect(b.text).toContain("先看构建脚本");
    expect(b.text).toContain("不代表用户当前发言");
    expect(b.ids).toEqual([1]);
  });

  it("超过单回合上限时只取前 N 条，并提示剩余数量（不能一次全塞进最后一条 user）", () => {
    const many = Array.from({ length: MAX_PER_TURN + 3 }, (_, i) => msg(i + 1));
    const b = composeMailBatch(many, "调研员");
    expect(b.ids).toHaveLength(MAX_PER_TURN);
    expect(b.ids).toEqual(many.slice(0, MAX_PER_TURN).map((m) => m.id));
    expect(b.text).toContain("另有 3 条未读");
  });

  it("ids 只含本批：调用方据此标记已读，读完到写库之间新来的消息不会被吞", () => {
    const b = composeMailBatch([msg(7), msg(8)], "调研员");
    // 假设此刻又来了 #9（未读）——它不在 ids 里，所以仍会留到下一回合
    expect(b.ids).not.toContain(9);
    const next = composeMailBatch([msg(9)], "调研员");
    expect(next.text).toContain("第 9 条");
  });

  it("单条过长会截断（否则把最后一条 user 挤爆）", () => {
    const b = composeMailBatch([msg(1, { content: "长".repeat(5000) })], "调研员");
    expect(b.text.length).toBeLessThan(1400);
  });

  it("内容里的换行/多余空白被折叠成单行（保持注入块紧凑）", () => {
    const b = composeMailBatch([msg(1, { content: "第一行\n\n第二行   第三行" })], "调研员");
    expect(b.text).toContain("第一行 第二行 第三行");
  });
});

describe("formatMail / normalizeMailKind", () => {
  it("展示行含 id、来源、类型与内容", () => {
    const line = formatMail(msg(5, { from_agent: "写手", kind: "question" }));
    expect(line).toContain("#5");
    expect(line).toContain("写手");
    expect(line).toContain("[question]");
  });

  it("未知类型退化成 note（存进一个没人认识的 kind 等于丢消息）", () => {
    expect(normalizeMailKind("QUESTION")).toBe("question");
    expect(normalizeMailKind("乱七八糟")).toBe("note");
    expect(normalizeMailKind(undefined)).toBe("note");
  });
});
