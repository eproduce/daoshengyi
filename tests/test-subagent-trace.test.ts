import { describe, it, expect } from "vitest";
import { createSubagentTrace, formatTrace, previewOf } from "../src/utils/subagent-trace.ts";

/**
 * 子代理轨迹：这个东西存在的唯一理由是「事后能复盘」。
 * 所以测试重点不是「能存」，而是**不能骗人**：截断了要说、轮次要说、错误要标出来。
 */
describe("previewOf：压成单行且首尾都留", () => {
  it("折叠空白、对象走 JSON", () => {
    expect(previewOf("a\n\n  b", 100)).toBe("a b");
    expect(previewOf({ path: "/tmp/x" }, 100)).toBe('{"path":"/tmp/x"}');
    expect(previewOf(undefined, 100)).toBe("");
  });

  it("超长时截断并保留尾部（错误原因常在末尾）", () => {
    const long = "前".repeat(300) + "末尾：permission denied";
    const out = previewOf(long, 60);
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out).toContain("…");
    expect(out).toContain("permission denied");
  });

  it("环状对象不会抛（JSON 失败退化为 String）", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => previewOf(a, 50)).not.toThrow();
  });
});

describe("createSubagentTrace：记录与上限", () => {
  it("工具调用带参数/结果/成败，轮次跟着走", () => {
    const t = createSubagentTrace();
    t.round(1);
    t.tool("read_file", { path: "/a.ts" }, "…内容…", true);
    t.round(2);
    t.tool("run_command", { command: "npm test" }, "exit 1", false);
    const s = t.snapshot();
    expect(s.rounds).toBe(2);
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0]).toMatchObject({ round: 1, tool: "read_file", status: "ok" });
    expect(s.entries[1]).toMatchObject({ round: 2, status: "error" });
    expect(s.dropped).toBe(0);
  });

  it("轮次只增不减（模型回退轮次时不能把总数改小）", () => {
    const t = createSubagentTrace();
    t.round(5);
    t.round(3);
    expect(t.snapshot().rounds).toBe(5);
  });

  it("超过上限后继续计数 dropped（静默截断会让人误以为它只做了这些）", () => {
    const t = createSubagentTrace({ maxEntries: 3 });
    for (let i = 0; i < 10; i++) t.note(`步骤 ${i}`);
    const s = t.snapshot();
    expect(s.entries).toHaveLength(3);
    expect(s.dropped).toBe(7);
  });

  it("没有显式轮次时落在第 1 轮（不能让 round 是 0/NaN）", () => {
    const t = createSubagentTrace();
    t.note("开场");
    expect(t.snapshot().entries[0].round).toBe(1);
  });

  it("snapshot 是快照，改它不影响记录器", () => {
    const t = createSubagentTrace();
    t.note("一");
    const s = t.snapshot();
    s.entries[0].result = "被改了";
    expect(t.snapshot().entries[0].result).toBe("一");
  });
});

describe("formatTrace：给人/模型看的一份紧凑复盘", () => {
  const run = {
    id: "r1",
    goal: "分析这个仓库的构建链路",
    status: "done",
    rounds: 3,
    result: "构建是 Vite + Tauri，产物在 dist/",
    trace: JSON.stringify({
      rounds: 3,
      dropped: 2,
      entries: [
        { round: 1, kind: "tool", tool: "code_stats", result: "1200 行", status: "ok" },
        { round: 2, kind: "tool", tool: "run_command", result: "exit 1", status: "error" },
        { round: 3, kind: "assistant", result: "结论如下" },
      ],
    }),
  };

  it("含目标/状态/每轮动作/失败标记/丢弃数与结论", () => {
    const out = formatTrace(run);
    expect(out).toContain("目标：分析这个仓库的构建链路");
    expect(out).toContain("状态：done｜轮次：3");
    expect(out).toContain("工具 code_stats");
    expect(out).toContain("run_command ✗");
    expect(out).toContain("另有 2 条未存储");
    expect(out).toContain("结论：构建是 Vite");
  });

  it("轨迹坏掉时不抛，明确说「解析失败」", () => {
    const out = formatTrace({ ...run, trace: "{坏 JSON" });
    expect(out).toContain("轨迹解析失败");
  });
});
