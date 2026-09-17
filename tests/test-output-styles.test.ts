import { describe, it, expect } from "vitest";
import {
  DEFAULT_STYLE_ID,
  OUTPUT_STYLES,
  STYLE_MARKER,
  applyOutputStyle,
  getOutputStyle,
  needsStyleInjection,
  stripStyleSection,
  styleSection,
} from "../src/utils/output-styles";

const BASE = "# 你是道生一\n\n- 用中文回答。\n- 不要编造路径。";

describe("P1-8 输出风格 · 基础行为", () => {
  it("默认风格不加任何约束（原样返回，但会剥掉残留风格段）", () => {
    expect(applyOutputStyle(BASE, DEFAULT_STYLE_ID)).toBe(BASE);
    expect(applyOutputStyle(BASE, undefined)).toBe(BASE);
    expect(applyOutputStyle(BASE, "")).toBe(BASE);
    // 之前设成过「简洁」，再切回默认 → 一定要真的去掉
    const withConcise = applyOutputStyle(BASE, "concise");
    expect(applyOutputStyle(withConcise, "default")).toBe(BASE);
  });

  it("未知风格 id → 原样返回（配置写错不破坏系统提示）", () => {
    expect(applyOutputStyle(BASE, "no-such-style")).toBe(BASE);
    expect(getOutputStyle("no-such-style")).toBeNull();
    expect(needsStyleInjection("no-such-style")).toBe(false);
  });

  it("非默认风格：在末尾追加一段，且带固定标记", () => {
    const out = applyOutputStyle(BASE, "detailed");
    expect(out.startsWith(BASE)).toBe(true);
    expect(out).toContain(STYLE_MARKER);
    expect(out.indexOf(STYLE_MARKER)).toBeGreaterThan(out.indexOf("不要编造路径"));
  });

  it("空基础提示也能工作（只留风格段）", () => {
    const out = applyOutputStyle("", "concise");
    expect(out).toContain(STYLE_MARKER);
    expect(out).not.toMatch(/^\n/);
  });
});

describe("P1-8 输出风格 · 幂等与切换", () => {
  it("重复应用同一风格 → 只有一段（不堆叠）", () => {
    const once = applyOutputStyle(BASE, "concise");
    const twice = applyOutputStyle(once, "concise");
    expect(twice).toBe(once);
    expect(twice.split(STYLE_MARKER).length - 1).toBe(1);
  });

  it("切换风格 → **替换**而不是叠加（不会「既简短又详细」）", () => {
    const a = applyOutputStyle(BASE, "concise");
    const b = applyOutputStyle(a, "detailed");
    expect(b).toContain("**结论** → **依据**");
    expect(b).not.toContain("不要「好的，我来帮你…」这类铺垫");
    expect(b.split(STYLE_MARKER).length - 1).toBe(1);
    // 基础提示始终只出现一次
    expect(b.split("# 你是道生一").length - 1).toBe(1);
  });

  it("切换后再切回 → 内容与第一次一致", () => {
    const first = applyOutputStyle(BASE, "teaching");
    const round = applyOutputStyle(applyOutputStyle(first, "review"), "teaching");
    expect(round).toBe(first);
  });

  it("stripStyleSection：去掉风格段但保留风格段之后的其它内容", () => {
    const prompt = `${BASE}\n\n${STYLE_MARKER}\n- 要点化\n\n## 安全约束\n- 不执行破坏性命令`;
    const stripped = stripStyleSection(prompt);
    expect(stripped).not.toContain(STYLE_MARKER);
    expect(stripped).toContain("## 安全约束");
    expect(stripped).toContain("不执行破坏性命令");
    expect(stripped).toContain("# 你是道生一");
    // 无标记 → 原样
    expect(stripStyleSection(BASE)).toBe(BASE);
    expect(stripStyleSection("")).toBe("");
  });
});

describe("P1-8 输出风格 · 风格表完整性", () => {
  it("风格表 id 唯一、都有名字与说明", () => {
    const ids = OUTPUT_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of OUTPUT_STYLES) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.hint.length).toBeGreaterThan(0);
    }
    expect(ids).toContain(DEFAULT_STYLE_ID);
  });

  it("每种风格的关键约束都在文案里（避免设了等于没设）", () => {
    expect(getOutputStyle("concise")!.body).toContain("结论先行");
    expect(getOutputStyle("concise")!.body).toContain("文件路径");
    expect(getOutputStyle("detailed")!.body).toContain("权衡");
    expect(getOutputStyle("detailed")!.body).toContain("推测");
    expect(getOutputStyle("teaching")!.body).toContain("最小可运行例子");
    expect(getOutputStyle("teaching")!.body).toContain("常见坑");
    expect(getOutputStyle("review")!.body).toContain("问题与风险");
    expect(getOutputStyle("review")!.body).toContain("默认不动手改");
  });

  it("只有默认风格的注入为空；其余都非空且各不相同", () => {
    const nonDefault = OUTPUT_STYLES.filter((s) => s.id !== DEFAULT_STYLE_ID);
    expect(OUTPUT_STYLES.find((s) => s.id === DEFAULT_STYLE_ID)!.body).toBe("");
    for (const s of nonDefault) {
      expect(styleSection(s).length).toBeGreaterThan(30);
      expect(needsStyleInjection(s.id)).toBe(true);
    }
    const bodies = new Set(nonDefault.map((s) => s.body));
    expect(bodies.size).toBe(nonDefault.length);
  });

  it("风格段作用域写清楚了「优先于上面的通用要求」", () => {
    expect(STYLE_MARKER).toContain("优先于上面的通用要求");
  });
});
