import { describe, it, expect } from "vitest";
import {
  FACTS_MARKER,
  HARD_RATIO,
  INDEX_MARKER,
  LADDER,
  MAX_FACTS,
  MAX_INDEX_CHARS,
  currentStage,
  extractKeyFacts,
  extractTerms,
  mergeDigestIntoSummary,
  pendingStages,
  prepareDigest,
  renderKeyFacts,
  renderKeywordIndex,
  type StageId,
} from "../src/utils/compaction-ladder";

describe("P1-5 压缩阶梯 · 档位与单调性", () => {
  it("阶梯阈值升序且与既有硬压缩阈值一致（82%）", () => {
    expect(LADDER.map((s) => s.at)).toEqual([0.3, 0.5, 0.7, HARD_RATIO]);
    expect(HARD_RATIO).toBe(0.82);
    // 只有 hard 是有损的
    expect(LADDER.filter((s) => s.lossy).map((s) => s.id)).toEqual(["hard"]);
  });

  it("未达 30% 不触发任何档；边界含等号", () => {
    expect(pendingStages(0).map((s) => s.id)).toEqual([]);
    expect(pendingStages(0.299).map((s) => s.id)).toEqual([]);
    expect(pendingStages(0.3).map((s) => s.id)).toEqual(["note"]);
    expect(pendingStages(0.5).map((s) => s.id)).toEqual(["note", "index"]);
    expect(pendingStages(0.7).map((s) => s.id)).toEqual(["note", "index", "trim"]);
    expect(pendingStages(0.82).map((s) => s.id)).toEqual(["note", "index", "trim", "hard"]);
    expect(pendingStages(0.95).map((s) => s.id)).toEqual(["note", "index", "trim", "hard"]);
  });

  it("一次跨多档时按顺序返回全部未应用档（不会跳档）", () => {
    expect(pendingStages(0.85, ["note"]).map((s) => s.id)).toEqual(["index", "trim", "hard"]);
    expect(pendingStages(0.85, ["note", "index", "trim"]).map((s) => s.id)).toEqual(["hard"]);
  });

  it("已应用的档不会重复返回（单调、不回头）", () => {
    const applied: StageId[] = ["note", "index"];
    expect(pendingStages(0.6, applied).map((s) => s.id)).toEqual([]);
    // 即使比例回落也不再触发早档；0.81 未到 82%，所以 hard 还不该触发
    expect(pendingStages(0.81, applied).map((s) => s.id)).toEqual(["trim"]);
    expect(pendingStages(0.82, applied).map((s) => s.id)).toEqual(["trim", "hard"]);
  });

  it("非法比例（NaN/负数）不触发", () => {
    expect(pendingStages(Number.NaN)).toEqual([]);
    expect(pendingStages(-1)).toEqual([]);
  });

  it("currentStage 返回当前所处档（用于日志与 UI）", () => {
    expect(currentStage(0.1)).toBeNull();
    expect(currentStage(0.45)?.id).toBe("note");
    expect(currentStage(0.6)?.id).toBe("index");
    expect(currentStage(0.9)?.id).toBe("hard");
  });
});

describe("P1-5 压缩阶梯 · 关键词索引（确定性）", () => {
  const msgs = [
    { role: "user", content: "帮我把 tooltip.ts 里的 audit-tooltips 脚本改好" },
    { role: "assistant", content: "tooltip.ts 已修改，脚本 audit-tooltips 也一并更新" },
    { role: "user", content: "tooltip.ts 里的提示文案再检查一遍" },
  ];

  it("抽取重复出现的词，按次数降序且结果稳定", () => {
    const terms = extractTerms(msgs);
    expect(terms.length).toBeGreaterThan(0);
    const tooltip = terms.find((t) => t.term === "tooltip");
    expect(tooltip?.count).toBe(3);
    expect(tooltip?.firstAt).toBe(1);
    // 相同输入 → 相同输出（确定性）
    expect(extractTerms(msgs)).toEqual(terms);
  });

  it("过滤英文停用词与中文虚词 bigram，且丢弃只出现一次的词", () => {
    const terms = extractTerms([
      { content: "the and for with this that you are was will" },
      { content: "可以 我们 的是 如果 但是 已经" },
      { content: "unicorn" },
    ]);
    expect(terms).toEqual([]);
    const mixed = extractTerms([
      { content: "缓存 缓存 缓存 命中率 命中率" },
      { content: "缓存 命中率" },
    ]);
    expect(mixed.map((t) => t.term)).toContain("缓存");
    // 中文按 2-gram 切（不是整词），所以抽到的是「命中」而不是「命中率」
    expect(mixed.map((t) => t.term)).toContain("命中");
    // 虚词组合「可以」已被过滤
    expect(mixed.map((t) => t.term)).not.toContain("可以");
  });

  it("中文 2-gram：连写句子也能抽出可检索的词", () => {
    const terms = extractTerms([
      { content: "上下文压缩阶梯" },
      { content: "上下文压缩阶梯很重要" },
    ]);
    const set = new Set(terms.map((t) => t.term));
    expect(set.has("上下")).toBe(true);
    expect(set.has("压缩")).toBe(true);
  });

  it("渲染为单行紧凑格式并带首次出现位置；超长会裁剪", () => {
    const entries = [
      { term: "alpha", count: 9, firstAt: 2 },
      { term: "beta", count: 3, firstAt: 5 },
    ];
    const out = renderKeywordIndex(entries);
    expect(out).toContain(INDEX_MARKER);
    expect(out).toContain("alpha×9(#2)");
    expect(out).toContain("beta×3(#5)");
    // 空输入 → 空串（不写空段落）
    expect(renderKeywordIndex([])).toBe("");
    // 超长裁剪：字符上限内
    const many = Array.from({ length: 200 }, (_, i) => ({
      term: `term${i}`,
      count: 2,
      firstAt: i + 1,
    }));
    expect(renderKeywordIndex(many).length).toBeLessThanOrEqual(MAX_INDEX_CHARS + 160);
  });
});

describe("P1-5 压缩阶梯 · 关键事实（路径/命令）", () => {
  it("抽取绝对路径与 ~ 路径，去重保序、限量", () => {
    const facts = extractKeyFacts([
      { content: "改了 /Users/wanghuan/op/daoshengyi/src/utils/hooks.ts 和 ~/notes/x.md" },
      { content: "又改了 /Users/wanghuan/op/daoshengyi/src/utils/hooks.ts" },
    ]);
    expect(facts.paths).toContain("/Users/wanghuan/op/daoshengyi/src/utils/hooks.ts");
    expect(facts.paths).toContain("~/notes/x.md");
    expect(facts.paths.filter((p) => p.endsWith("hooks.ts"))).toHaveLength(1);
    // 限量
    const many = extractKeyFacts([
      { content: Array.from({ length: 40 }, (_, i) => `/a/b/file${i}.ts`).join(" ") },
    ]);
    expect(many.paths.length).toBeLessThanOrEqual(MAX_FACTS);
  });

  it("URL 里的路径不算「文件路径事实」", () => {
    const facts = extractKeyFacts([
      { content: "见 https://github.com/foo/bar/blob/main/src/index.ts 的说明" },
    ]);
    expect(facts.paths.some((p) => p.includes("github.com"))).toBe(false);
  });

  it("抽取 `$ 命令` 与反引号里的命令", () => {
    const facts = extractKeyFacts([
      { content: "跑 `npm test` 通过；然后执行\n$ npx vue-tsc --noEmit\n再看结果" },
    ]);
    expect(facts.commands).toContain("npm test");
    expect(facts.commands.some((c) => c.includes("vue-tsc"))).toBe(true);
  });

  it("渲染关键事实段带标记；空事实返回空串", () => {
    const out = renderKeyFacts({ paths: ["/a/b.ts"], commands: ["npm test"] });
    expect(out).toContain(FACTS_MARKER);
    expect(out).toContain("/a/b.ts");
    expect(out).toContain("`npm test`");
    expect(renderKeyFacts({ paths: [], commands: [] })).toBe("");
  });
});

describe("P1-5 压缩阶梯 · 产物准备与幂等合并", () => {
  const droppable = [
    { role: "user", content: "跑 `npm test` 检查 /Users/x/op/src/a.ts" },
    { role: "assistant", content: "改完 /Users/x/op/src/a.ts，npm test 通过，a.ts 相关内容也检查了" },
  ];

  it("prepareDigest 同时备好索引与事实（老消息为空则什么都不产生）", () => {
    const d = prepareDigest(droppable);
    expect(d.index).toContain(INDEX_MARKER);
    expect(d.facts).toContain(FACTS_MARKER);
    expect(prepareDigest([])).toEqual({});
  });

  it("mergeDigestIntoSummary：摘要 → 事实 → 索引，顺序固定", () => {
    const d = prepareDigest(droppable);
    const merged = mergeDigestIntoSummary("模型摘要正文", d);
    expect(merged.indexOf("模型摘要正文")).toBeLessThan(merged.indexOf(FACTS_MARKER));
    expect(merged.indexOf(FACTS_MARKER)).toBeLessThan(merged.indexOf(INDEX_MARKER));
  });

  it("幂等：重复压缩不会叠加第二份（已含标记则跳过）", () => {
    const d = prepareDigest(droppable);
    const once = mergeDigestIntoSummary("摘要", d);
    const twice = mergeDigestIntoSummary(once, d);
    expect(twice).toBe(once);
    expect(twice.split(FACTS_MARKER).length - 1).toBe(1);
    expect(twice.split(INDEX_MARKER).length - 1).toBe(1);
  });

  it("空摘要/空产物都不崩（边界）", () => {
    expect(mergeDigestIntoSummary("", {})).toBe("");
    expect(mergeDigestIntoSummary("", { facts: "F" })).toBe("F");
    expect(mergeDigestIntoSummary("摘要  ", {})).toBe("摘要");
  });
});
