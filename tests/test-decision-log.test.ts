import { describe, it, expect } from "vitest";
import {
  DECISION_FILE,
  DECISION_HEADER,
  MAX_ALTERNATIVES,
  MAX_FILES,
  asParagraph,
  countDecisions,
  decisionPath,
  mergeDecision,
  normalizeTitle,
  oneLine,
  parseDecisions,
  renderEntry,
  splitSections,
  stamp,
  type DecisionEntry,
} from "../src/utils/decision-log";

const AT = new Date(2026, 8, 17, 22, 50).getTime(); // 本地 2026-09-17 22:50

const entry = (p: Partial<DecisionEntry> = {}): DecisionEntry => ({
  at: AT,
  title: "本地视觉后端从 Ollama 换成 llama.cpp",
  decision: "新增 llama-server 后端，默认 auto，Ollama 作为回退",
  rationale: "实测 Ollama 会常驻 4.5GB；裸 llama.cpp 进程退出即归还内存。速度基本一致。",
  alternatives: ["继续用 Ollama 只调 keep_alive", "改用 MLX"],
  files: ["src-tauri/src/local_runtime.rs", "src/stores/chat.ts"],
  ...p,
});

describe("P1-7 决策日志 · 清洗与渲染", () => {
  it("oneLine 压成单行并截断（标题里的换行不会破坏小节结构）", () => {
    expect(oneLine("a\nb")).toBe("a b");
    expect(oneLine("  x   y  ")).toBe("x y");
    expect(oneLine("t".repeat(200)).length).toBeLessThanOrEqual(121);
    expect(oneLine("带\u0007控制字符")).toBe("带控制字符");
  });

  it("asParagraph 保留换行但压掉多余空行", () => {
    expect(asParagraph("第一句。\n\n\n\n第二句。")).toBe("第一句。\n\n第二句。");
    expect(asParagraph("x".repeat(900)).length).toBeLessThanOrEqual(801);
  });

  it("stamp 用本地时区，非法时间返回空串", () => {
    expect(stamp(AT)).toBe("2026-09-17 22:50");
    expect(stamp(Number.NaN)).toBe("");
  });

  it("renderEntry 固定字段顺序，含排除方案与相关文件（文件带反引号）", () => {
    const text = renderEntry(entry());
    const lines = text.split("\n");
    expect(lines[0]).toBe("## 2026-09-17 22:50 · 本地视觉后端从 Ollama 换成 llama.cpp");
    expect(lines[1]).toContain("**决策**：");
    expect(lines[2]).toContain("**理由**：");
    expect(lines[3]).toContain("**排除的方案**：");
    expect(lines[4]).toContain("`src-tauri/src/local_runtime.rs`");
    expect(lines[4]).toContain("`src/stores/chat.ts`");
  });

  it("可选字段缺省时不留空行/空字段；超量内容被裁剪", () => {
    const bare = renderEntry(entry({ alternatives: [], files: [], session: undefined }));
    expect(bare).not.toContain("排除的方案");
    expect(bare).not.toContain("相关文件");
    const many = renderEntry(
      entry({
        alternatives: Array.from({ length: 9 }, (_, i) => `方案${i}`),
        files: Array.from({ length: 20 }, (_, i) => `f${i}.ts`),
      }),
    );
    // 只在对应字段行内计数（理由正文里也可能出现「；」，不能全局 split）
    const altLine = many.split("\n").find((l) => l.includes("排除的方案")) ?? "";
    const fileLine = many.split("\n").find((l) => l.includes("相关文件")) ?? "";
    expect(altLine.split("；").length - 1).toBeLessThanOrEqual(MAX_ALTERNATIVES - 1);
    expect(fileLine.split("、").length - 1).toBeLessThanOrEqual(MAX_FILES - 1);
    expect(altLine).toContain("方案0");
    expect(altLine).not.toContain("方案8");
  });

  it("session 存在时追加会话行", () => {
    expect(renderEntry(entry({ session: "abc-123" }))).toContain("**会话**：abc-123");
  });
});

describe("P1-7 决策日志 · 幂等合并", () => {
  it("空文件 → 带说明头 + 第一条决策", () => {
    const out = mergeDecision("", entry());
    expect(out).toContain(DECISION_HEADER.split("\n")[0]);
    expect(out).toContain("## 2026-09-17 22:50 · 本地视觉后端从 Ollama 换成 llama.cpp");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("不同标题 → 追加（保序，旧的在前）", () => {
    const first = mergeDecision("", entry());
    const second = mergeDecision(first, entry({ title: "第二条决策", decision: "B" }));
    const titles = splitSections(second).sections.map((s) => s.title);
    expect(titles).toEqual(["本地视觉后端从 Ollama 换成 llama.cpp", "第二条决策"]);
    expect(countDecisions(second)).toBe(2);
  });

  it("同一标题 → **原地更新**，不重复追加（忽略大小写与空白差异）", () => {
    const first = mergeDecision("", entry());
    const again = mergeDecision(
      first,
      entry({ title: "本地视觉后端从 Ollama 换成 llama.cpp ", decision: "更新后的结论" }),
    );
    expect(countDecisions(again)).toBe(1);
    expect(again).toContain("更新后的结论");
    expect(again).not.toContain("新增 llama-server 后端，默认 auto，Ollama 作为回退");
    // 顺序不变（原地）
    const second = mergeDecision(first, entry({ title: "别的决策", decision: "C" }));
    const merged = mergeDecision(second, entry({ decision: "更新后的结论" }));
    expect(splitSections(merged).sections.map((s) => s.title)).toEqual([
      "本地视觉后端从 Ollama 换成 llama.cpp",
      "别的决策",
    ]);
  });

  it("重复合并同一内容 → 稳定（再次合并不改变结构）", () => {
    const once = mergeDecision("", entry());
    const twice = mergeDecision(once, entry());
    expect(countDecisions(twice)).toBe(1);
    expect(twice).toBe(once.replace(/\s+$/, "\n").replace(/\n$/, "\n"));
  });

  it("已有文件但无固定头（用户手写的）也保留前言", () => {
    const custom =
      "# 我的决策记录\n\n随手写的说明。\n\n## 2026-01-01 09:00 · 老决策\n- **决策**：老做法\n";
    const out = mergeDecision(custom, entry());
    expect(out).toContain("我的决策记录");
    expect(out).toContain("随手写的说明。");
    expect(countDecisions(out)).toBe(2);
  });

  it("normalizeTitle 让「同一条决策」判定不受大小写/空格影响", () => {
    expect(normalizeTitle("Use Llama.cpp")).toBe(normalizeTitle("use llama.cpp"));
    expect(normalizeTitle("a  b")).toBe(normalizeTitle("ab"));
    expect(normalizeTitle("完全不同")).not.toBe(normalizeTitle("另一条"));
  });
});

describe("P1-7 决策日志 · 解析与路径", () => {
  it("splitSections 分出前言与小节，且小节正文不含尾随空行", () => {
    const text = mergeDecision(mergeDecision("", entry()), entry({ title: "第二", decision: "D" }));
    const { preamble, sections } = splitSections(text);
    expect(preamble).toContain("# 决策日志");
    expect(sections).toHaveLength(2);
    expect(sections[0].body.endsWith("\n")).toBe(false);
  });

  it("parseDecisions 读回标题/时间/决策/理由；坏条目跳过不抛错", () => {
    const text = mergeDecision("", entry());
    const parsed = parseDecisions(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe("本地视觉后端从 Ollama 换成 llama.cpp");
    expect(parsed[0].decision).toContain("llama-server");
    expect(parsed[0].rationale).toContain("4.5GB");
    expect(stamp(parsed[0].at)).toBe("2026-09-17 22:50");
    // 垃圾输入
    expect(parseDecisions("")).toEqual([]);
    expect(parseDecisions("没有小节的文本")).toEqual([]);
    // 缺字段的小节 → 字段为空串，但仍能列出
    const partial = parseDecisions("## 2026-09-17 10:00 · 只有标题\n");
    expect(partial).toHaveLength(1);
    expect(partial[0].decision).toBe("");
  });

  it("decisionPath 拼出目标文件；空目录退回相对文件名", () => {
    expect(decisionPath("/Users/x/op/daoshengyi")).toBe(`/Users/x/op/daoshengyi/${DECISION_FILE}`);
    expect(decisionPath("/Users/x/op/daoshengyi/")).toBe(`/Users/x/op/daoshengyi/${DECISION_FILE}`);
    expect(decisionPath("")).toBe(DECISION_FILE);
  });

  it("长会话里反复记录（10 条）仍保持幂等与稳定结构", () => {
    let doc = "";
    for (let i = 0; i < 10; i++)
      doc = mergeDecision(doc, entry({ title: `决策 ${i}`, decision: `D${i}` }));
    expect(countDecisions(doc)).toBe(10);
    // 再更新第 3 条
    doc = mergeDecision(doc, entry({ title: "决策 3", decision: "D3-updated" }));
    expect(countDecisions(doc)).toBe(10);
    expect(doc).toContain("D3-updated");
    expect(parseDecisions(doc).map((d) => d.title)).toEqual(
      Array.from({ length: 10 }, (_, i) => `决策 ${i}`),
    );
  });
});
