import { describe, it, expect } from "vitest";
import { auditContext, auditToMarkdown, type ContextPart } from "../src/utils/context-audit.ts";

const part = (id: string, label: string, text: string, extra: Partial<ContextPart> = {}): ContextPart => ({
  id,
  label,
  text,
  ...extra,
});

describe("auditContext：占比与排序", () => {
  it("按 token 降序排列，占比之和为 1", () => {
    const a = auditContext([
      part("tools", "工具定义", "x".repeat(400)),
      part("skills", "技能指令", "y".repeat(40)),
      part("history", "历史消息", "z".repeat(120)),
    ]);
    expect(a.rows.map((r) => r.id)).toEqual(["tools", "history", "skills"]);
    const sum = a.rows.reduce((n, r) => n + r.share, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(a.totalTokens).toBeGreaterThan(0);
    expect(a.totalChars).toBe(560);
  });

  it("中文按字计 token（估算口径与 tokens.ts 一致）", () => {
    const a = auditContext([part("skills", "技能指令", "技能说明文字")]);
    expect(a.rows[0].tokens).toBe(6);
  });

  it("空上下文不炸（占比 0，给出默认建议）", () => {
    const a = auditContext([]);
    expect(a.totalTokens).toBe(0);
    expect(a.rows).toEqual([]);
    expect(a.hints.join()).toContain("占比均衡");
  });
});

describe("auditContext：针对性与可操作建议", () => {
  it("工具定义过大 → 建议 tool_search 延迟加载 / 精简 MCP", () => {
    const a = auditContext([
      part("tools", "工具定义（schema）", "t".repeat(1000), { count: 77 }),
      part("history", "历史消息", "h".repeat(100)),
    ]);
    const hint = a.hints.find((h) => h.includes("工具定义")) ?? "";
    expect(hint).toContain("77 个");
    expect(hint).toContain("tool_search");
  });

  it("技能指令过大 → 提示按需注入与关闭不常用技能", () => {
    const a = auditContext([
      part("skills", "技能指令", "技".repeat(400), { count: 9 }),
      part("history", "历史消息", "h".repeat(20)),
    ]);
    expect(a.hints.join()).toContain("技能指令占");
    expect(a.hints.join()).toContain("≤2 个");
  });

  it("历史消息占比过半 → 指向压缩/新对话", () => {
    const a = auditContext([
      part("history", "历史消息", "h".repeat(2000), { count: 40, growing: true }),
      part("tools", "工具定义", "t".repeat(100)),
    ]);
    const hint = a.hints.find((h) => h.includes("历史消息占")) ?? "";
    expect(hint).toContain("new_context_window");
    expect(hint).toContain("82%");
  });

  it("提供窗口时可给出占窗口比例，并提示压缩阈值", () => {
    const a = auditContext([part("history", "历史消息", "h".repeat(900))], 1000);
    expect(a.windowShare).not.toBeNull();
    expect(a.hints.join()).toContain("占模型窗口");
    expect(a.hints.join()).toContain("82%");
  });
});

describe("auditContext：重复注入检测（白花的 token）", () => {
  it("同一区块内重复行 ≥3 次会被指出", () => {
    const line = "这是一段很长的技能说明文字，用于测试重复检测是否生效。";
    const a = auditContext([part("skills", "技能指令", [line, line, line, line].join("\n"))]);
    expect(a.duplicates.join()).toContain("4 行完全重复");
  });

  it("跨区块重复行会被指出（同一段内容被两处注入）", () => {
    const shared =
      "这里是一段至少四十个字符的共享说明文本，它同时出现在技能指令与系统提示里以免被忽略。";
    const a = auditContext([
      part("skills", "技能指令", `${shared}\n其它技能内容`),
      part("system", "系统提示", `${shared}\n其它系统内容`),
    ]);
    const dup = a.duplicates.find((d) => d.includes("同一段内容")) ?? "";
    expect(dup).toContain("技能指令");
    expect(dup).toContain("系统提示");
    expect(a.hints.join()).toContain("重复注入");
  });
});

describe("auditToMarkdown：可复制报告", () => {
  it("包含合计、表格行与建议", () => {
    const a = auditContext([part("tools", "工具定义", "t".repeat(100), { count: 3 })]);
    const md = auditToMarkdown(a);
    expect(md).toContain("## 上下文成本审计");
    expect(md).toContain("| 工具定义 | 3 |");
    expect(md).toContain("### 建议");
  });
});
