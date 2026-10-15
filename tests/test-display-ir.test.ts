// 展示 IR 的单测：容错解析 + 降级矩阵 + 呈现决策。
//
// 这里最值钱的一条是「降级不变量」：任意 kind × 任意 surface，
// 降级之后的结果**必须**是该 surface 原生能渲染的 —— 否则就会出现
// 「换了个出口就渲染出错/一片空白」，而那种问题只在真机上偶然暴露。
import { describe, it, expect } from "vitest";
import {
  DISPLAY_KINDS,
  IR_LIMITS,
  cleanForSpeech,
  degradeForSurface,
  parseDisplayIr,
  planSurfaces,
  speechTextOf,
  supportsKind,
  type DisplayIr,
  type Surface,
} from "../src/utils/display-ir";

const SURFACES: Surface[] = ["hud", "speech", "session", "page"];

function ir(partial: Partial<DisplayIr>): DisplayIr {
  return { kind: "card", priority: "primary", life: "auto", body: {}, ...partial };
}

describe("parseDisplayIr：模型输出一律当不可信输入", () => {
  it("非对象输入不抛错，降级为空白卡片", () => {
    for (const bad of [null, undefined, 42, "文本", []]) {
      const { ir: out, issues } = parseDisplayIr(bad);
      expect(out.kind).toBe("card");
      expect(issues.length).toBeGreaterThan(0);
    }
  });

  it("未知 kind 降级为 card 并记录原因", () => {
    const { ir: out, issues } = parseDisplayIr({ kind: "表格", title: "x" });
    expect(out.kind).toBe("card");
    expect(issues.join()).toContain("未知 kind");
  });

  it("priority 只认 primary，其余一律 secondary（不打扰是默认）", () => {
    expect(parseDisplayIr({ kind: "card", priority: "primary" }).ir.priority).toBe("primary");
    expect(parseDisplayIr({ kind: "card", priority: "PRIMARY" }).ir.priority).toBe("secondary");
    expect(parseDisplayIr({ kind: "card" }).ir.priority).toBe("secondary");
  });

  it("life 非法值退回 auto，并记录", () => {
    expect(parseDisplayIr({ kind: "card", life: "forever" }).ir.life).toBe("auto");
    expect(parseDisplayIr({ kind: "card", life: "forever" }).issues.join()).toContain("life");
    expect(parseDisplayIr({ kind: "card", life: "sticky" }).ir.life).toBe("sticky");
  });

  it("body 直接给字符串时当正文（模型最常见的写法）", () => {
    expect(parseDisplayIr({ kind: "card", body: "已完成" }).ir.body.text).toBe("已完成");
  });

  it("超长文本被截断到上限（浮层只有 380x132，不能塞长文）", () => {
    const long = "甲".repeat(1000);
    const { ir: out } = parseDisplayIr({ kind: "card", title: long, body: { text: long } });
    expect(out.title!.length).toBeLessThanOrEqual(IR_LIMITS.title);
    expect(out.body.text!.length).toBeLessThanOrEqual(IR_LIMITS.text);
  });

  it("数字/布尔型 value 会被转成字符串（metric 常这么传）", () => {
    expect(parseDisplayIr({ kind: "metric", body: { value: 1.2, unit: "GB" } }).ir.body.value).toBe(
      "1.2",
    );
    expect(parseDisplayIr({ kind: "metric", body: { value: true } }).ir.body.value).toBe("true");
  });

  it("series/items/steps 里的脏数据被丢弃而不是整条失败", () => {
    const { ir: out } = parseDisplayIr({
      kind: "chart",
      body: {
        series: [{ label: "一", value: "3" }, { label: "" }, null, { value: 5 }, { n: 1 }],
        items: [{ key: "a", value: "1" }, { key: "b" }, "x"],
        steps: [{ label: "抓取" }, { detail: "没有 label" }, { label: "汇总", status: "done" }],
      },
    });
    expect(out.body.series).toEqual([{ label: "一", value: 3 }]);
    expect(out.body.items).toEqual([{ key: "a", value: "1" }]);
    expect(out.body.steps).toEqual([{ label: "抓取" }, { label: "汇总", status: "done" }]);
  });

  it("条目数量超上限时截断（防止渲染器被长列表打爆）", () => {
    const series = Array.from({ length: 100 }, (_, i) => ({ label: `项${i}`, value: i }));
    const { ir: out } = parseDisplayIr({ kind: "chart", body: { series } });
    expect(out.body.series!.length).toBe(IR_LIMITS.series);
  });
});

describe("降级矩阵：换出口不出错", () => {
  it("降级不变量：任意 kind 在任意 surface 上降级后都被该 surface 原生支持", () => {
    for (const kind of DISPLAY_KINDS) {
      for (const surface of SURFACES) {
        const degraded = degradeForSurface(
          ir({ kind, title: "标题", body: { text: "正文", steps: [{ label: "a" }] } }),
          surface,
        );
        expect(
          supportsKind(surface, degraded.kind),
          `${kind} → ${surface} 降级成了 ${degraded.kind}，但该出口不支持它`,
        ).toBe(true);
      }
    }
  });

  it("原生支持的 kind 原样返回（不做无谓改动）", () => {
    const metric = ir({ kind: "metric", body: { value: "1.2", unit: "GB" } });
    expect(degradeForSurface(metric, "hud")).toBe(metric);
  });

  it("flow 在会话里退化成时间轴，在浮层里退化成多行", () => {
    const flow = ir({
      kind: "flow",
      body: { steps: [{ label: "取数" }, { label: "汇总", detail: "3 条" }] },
    });
    expect(degradeForSurface(flow, "session").kind).toBe("timeline");
    const hud = degradeForSurface(flow, "hud");
    expect(hud.kind).toBe("card");
    expect(hud.body.lines).toEqual(["1. 取数", "2. 汇总 — 3 条"]);
  });

  it("page 在浮层上退化成正文文本", () => {
    const page = ir({ kind: "page", title: "报告", body: { markdown: "# 大标题\n正文" } });
    const hud = degradeForSurface(page, "hud");
    expect(hud.kind).toBe("card");
    expect(hud.body.text).toContain("大标题");
  });

  it("table 落到浮层只留前几行并提示完整内容在会话", () => {
    const rows = Array.from({ length: 9 }, (_, i) => [`行${i}`, String(i)]);
    const table = ir({ kind: "table", body: { columns: ["a", "b"], rows } });
    const hud = degradeForSurface(table, "hud");
    expect(hud.kind).toBe("card");
    expect(hud.body.lines!.length).toBe(4);
    expect(hud.body.text).toContain("共 9 行");
    // 会话不受限：表格原样保留
    expect(degradeForSurface(table, "session").kind).toBe("table");
  });

  it("动画无法在文本出口表达时退化成标题", () => {
    const anim = ir({ kind: "animation", title: "演示动画" });
    expect(degradeForSurface(anim, "hud").body.text).toBe("演示动画");
  });
});

describe("语音文本：念出来要像人话", () => {
  it("优先用 speech，其次标题", () => {
    expect(speechTextOf(ir({ title: "标题", speech: "念这句" }))).toBe("念这句");
    expect(speechTextOf(ir({ title: "标题" }))).toBe("标题");
  });

  it("没有 speech/title 时取正文首句", () => {
    const out = speechTextOf(ir({ body: { text: "三份邮件已回复。其余待办如下。" } }));
    expect(out).toBe("三份邮件已回复。");
  });

  it("去掉 markdown 记号：say 会把 ** 念成「星号星号」", () => {
    expect(cleanForSpeech("**完成** 了 `npm run ci:local`")).toBe("完成 了 npm run ci:local");
    expect(cleanForSpeech("[标题](https://example.com)")).toBe("标题");
    expect(cleanForSpeech("```js\nconst a=1;\n```")).toBe("（代码略）");
  });

  it("换行与多余空白压成一句，并截断到上限", () => {
    expect(cleanForSpeech("一\n二   三")).toBe("一 二 三");
    expect(cleanForSpeech("啊".repeat(500)).length).toBe(IR_LIMITS.speech);
  });
});

describe("呈现决策：宿主规则为主", () => {
  const allOn = {
    silent: false,
    hudEnabled: true,
    speechEnabled: true,
    windowFocused: false,
  };

  it("secondary 一律只进会话（默认不打扰）", () => {
    const plan = planSurfaces(ir({ priority: "secondary" }), allOn);
    expect(plan.surfaces).toEqual(["session"]);
    expect(plan.reasons.join()).toContain("secondary");
  });

  it("静默模式：会话之外什么都没有", () => {
    const plan = planSurfaces(ir({ title: "x" }), { ...allOn, silent: true });
    expect(plan.surfaces).toEqual(["session"]);
    expect(plan.speechText).toBe("");
  });

  it("主窗口在前台时不冒浮层（用户正在看，别打扰）", () => {
    const plan = planSurfaces(ir({ title: "x" }), { ...allOn, windowFocused: true });
    expect(plan.surfaces).not.toContain("hud");
    expect(plan.reasons.join()).toContain("前台");
  });

  it("HUD 关闭时不出浮层，但仍钉回会话", () => {
    const plan = planSurfaces(ir({ title: "x" }), { ...allOn, hudEnabled: false });
    expect(plan.surfaces).toContain("session");
    expect(plan.surfaces).not.toContain("hud");
  });

  it("语音默认关；开启后带上要念的文本", () => {
    const off = planSurfaces(ir({ title: "完成" }), { ...allOn, speechEnabled: false });
    expect(off.surfaces).not.toContain("speech");
    const on = planSurfaces(ir({ title: "完成" }), allOn);
    expect(on.surfaces).toContain("speech");
    expect(on.speechText).toBe("完成");
  });

  it("没有任何可念文本时不选语音（而不是念一句空话）", () => {
    const plan = planSurfaces(ir({ kind: "speech", body: {} }), allOn);
    expect(plan.surfaces).not.toContain("speech");
    expect(plan.reasons.join()).toContain("没有可念的正文");
  });

  it("kind=page 额外走产物页", () => {
    const plan = planSurfaces(ir({ kind: "page" }), allOn);
    expect(plan.surfaces).toContain("page");
  });

  it("每个决策都有人话解释（便于回答「为什么没弹出来」）", () => {
    for (const ctx of [
      allOn,
      { ...allOn, silent: true },
      { ...allOn, windowFocused: true },
      { ...allOn, speechEnabled: false },
    ]) {
      expect(planSurfaces(ir({ title: "x" }), ctx).reasons.length).toBeGreaterThan(0);
    }
  });
});
