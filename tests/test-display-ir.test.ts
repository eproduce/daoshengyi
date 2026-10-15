/// <reference types="vite/client" />

// 展示 IR 的单测：容错解析 + 降级矩阵 + 呈现决策 + 收尾自动呈现。
//
// 这里最值钱的一条是「降级不变量」：任意 kind × 任意 surface，
// 降级之后的结果**必须**是该 surface 原生能渲染的 —— 否则就会出现
// 「换了个出口就渲染出错/一片空白」，而那种问题只在真机上偶然暴露。
import { describe, it, expect } from "vitest";
import {
  DISPLAY_KINDS,
  IMPLEMENTED_SURFACES,
  IR_LIMITS,
  PRESENT_PROTOCOL_VERSION,
  SPEAK_MAX_CHARS,
  SURFACE_CAPABILITIES,
  buildFinishIr,
  cleanForSpeech,
  degradeForSurface,
  effectiveIr,
  inQuietHours,
  parseClock,
  parseDisplayIr,
  parseRefs,
  planSurfaces,
  shouldSpeak,
  speechTextOf,
  supportsKind,
  type DisplayIr,
  type Surface,
} from "../src/utils/display-ir";

/// 源码本身也是被测对象：有些契约（有没有真的接线）只能从源码上看
const SOURCES = import.meta.glob("../src/**/*.{ts,vue}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/// Rust 侧的镜像表也要能读到（前后端能力表必须一致）
const RUST_SOURCES = import.meta.glob("../src-tauri/src/surface.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** 协议登记的全部出口（含尚未收编的 notify/tray/quicklook/im）—— 降级不变量要覆盖它们 */
const SURFACES: Surface[] = [
  "hud",
  "speech",
  "session",
  "page",
  "notify",
  "tray",
  "quicklook",
  "im",
];

function ir(partial: Partial<DisplayIr>): DisplayIr {
  return {
    v: PRESENT_PROTOCOL_VERSION,
    id: "ir_test",
    source: "model",
    kind: "card",
    priority: "primary",
    life: "auto",
    body: {},
    ...partial,
  };
}

/** 出口决策的默认上下文（全开），个别用例再覆写 */
function ctx(partial: Partial<Parameters<typeof planSurfaces>[1]> = {}) {
  return { silent: false, hudEnabled: true, speechEnabled: true, ...partial };
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

  it("priority 缺省 = primary（调用即呈现），显式 secondary 才只进会话", () => {
    // 旧行为是「不填就什么都不显示」，用户反馈“太傻”；现在调用本身就是呈现请求
    expect(parseDisplayIr({ kind: "card" }).ir.priority).toBe("primary");
    expect(parseDisplayIr({ kind: "card", priority: "secondary" }).ir.priority).toBe("secondary");
    // 写错的 priority 也不能让内容“静默消失”→ 按 primary 处理并记一笔
    expect(parseDisplayIr({ kind: "card", priority: "PRIMARY" }).ir.priority).toBe("primary");
    expect(parseDisplayIr({ kind: "card", priority: "PRIMARY" }).issues.join()).toContain(
      "priority",
    );
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
  };

  it("secondary 一律只进会话（显式说了“只想留痕”）", () => {
    const plan = planSurfaces(ir({ priority: "secondary" }), allOn);
    expect(plan.surfaces).toEqual(["session"]);
    expect(plan.reasons.join()).toContain("secondary");
  });

  it("静默模式：会话之外什么都没有", () => {
    const plan = planSurfaces(ir({ title: "x" }), { ...allOn, silent: true });
    expect(plan.surfaces).toEqual(["session"]);
    expect(plan.speechText).toBe("");
  });

  it("浮层不受“主窗口是否前台”影响（盯着屏幕时反而最该看到结果）", () => {
    // 早先用 windowFocused 当门禁 → 用户坐在应用前什么都看不到，那是错的
    const plan = planSurfaces(ir({ title: "x", body: { text: "一句话" } }), allOn);
    expect(plan.surfaces).toContain("hud");
    expect(plan.reasons.join()).toContain("桌面浮层");
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

  it("适合“看”的内容只上浮层、不念（表格/代码/图表/键值）", () => {
    for (const bad of [
      ir({ kind: "table", title: "对比", body: { rows: [["a", "1"]] } }),
      ir({ kind: "code", title: "改法", body: { code: "const a = 1" } }),
      ir({ kind: "chart", title: "分布", body: { series: [{ label: "一", value: 1 }] } }),
      ir({ kind: "kv", title: "明细", body: { items: [{ key: "a", value: "1" }] } }),
    ]) {
      const plan = planSurfaces(bad, allOn);
      expect(plan.surfaces, `${bad.kind} 不该念`).not.toContain("speech");
      expect(plan.surfaces).toContain("hud"); // 但浮层上照样看得到
      expect(plan.reasons.join()).toContain("不出声");
    }
  });

  it("kind=page 额外走产物页", () => {
    const plan = planSurfaces(ir({ kind: "page" }), allOn);
    expect(plan.surfaces).toContain("page");
  });

  it("每个决策都有人话解释（便于回答「为什么没弹出来」）", () => {
    for (const ctx of [
      allOn,
      { ...allOn, silent: true },
      { ...allOn, hudEnabled: false },
      { ...allOn, speechEnabled: false },
    ]) {
      expect(planSurfaces(ir({ title: "x" }), ctx).reasons.length).toBeGreaterThan(0);
    }
  });
});

describe("本轮收尾自动呈现：宿主兜底，但必须低打扰", () => {
  it("纯问答只进会话（secondary + auto）——每轮对话都冒出来就是骚扰", () => {
    const ir = buildFinishIr({ text: "天气不错", toolCount: 0 });
    expect(ir.priority).toBe("secondary");
    expect(ir.life).toBe("auto");
    expect(ir.kind).toBe("card");
  });

  it("真干活的那一轮才冒浮层（primary + sticky：用户不在时 auto 等于白推）", () => {
    const ir = buildFinishIr({ text: "已生成报告", toolCount: 3 });
    expect(ir.priority).toBe("primary");
    expect(ir.life).toBe("sticky");
    expect(ir.kind).toBe("callout");
  });

  it("计划全部完成时标题写「任务完成」并带上进度", () => {
    const ir = buildFinishIr({ text: "搞定", toolCount: 4, planDone: 3, planTotal: 3 });
    expect(ir.title).toContain("任务完成");
    expect(ir.body.text).toContain("3/3 步");
  });

  it("说「做得怎么样」而不是「结束」：只给「回复完成」", () => {
    const ir = buildFinishIr({ text: "好的", toolCount: 0, planDone: 1, planTotal: 3 });
    expect(ir.title).toContain("回复完成");
    expect(ir.body.text).toContain("1/3 步");
  });

  it("正文超长时截断（浮层只有 380×132）", () => {
    const ir = buildFinishIr({ text: "甲".repeat(500), toolCount: 1 });
    // 220 上限 + 截断省略号
    expect(ir.body.text!.length).toBeLessThanOrEqual(221);
  });

  it("要念的是首句而不是整段（语音不是念报告）", () => {
    const ir = buildFinishIr({ text: "三份邮件已回复。其余待办见正文。", toolCount: 2 });
    expect(ir.speech).toBe("三份邮件已回复。");
    expect(ir.speech!.length).toBeLessThanOrEqual(IR_LIMITS.speech);
  });

  it("收尾 IR 在每个出口都能渲染（沿用降级不变量）", () => {
    for (const toolCount of [0, 5]) {
      const ir = buildFinishIr({ text: "结论", toolCount });
      for (const surface of SURFACES) {
        expect(supportsKind(surface, degradeForSurface(ir, surface).kind)).toBe(true);
      }
    }
  });

  it("有内容时才会带 speech（避免空字符串把语音叫出来）", () => {
    expect(buildFinishIr({ text: "", toolCount: 1 }).speech).toBeUndefined();
  });
});

describe("接线契约：收尾呈现必须真的被调用", () => {
  const chatSrc = SOURCES["../src/stores/chat.ts"] ?? "";

  it("能读到源码（防止路径写错导致空跑）", () => {
    expect(chatSrc.length).toBeGreaterThan(100_000);
  });

  it("chat.ts 在本轮收尾处挂了自动呈现，且与系统通知同一处", () => {
    // 这条只能靠源码断言：模型调 present 是「显式」，而收尾兜底是「隐式」——
    // 将来重构只搬走通知却漏掉呈现时，功能会静默消失，很难发现。
    expect(chatSrc).toContain("function presentTurnFinished(");
    expect(chatSrc).toContain("presentTurnFinished(streamingContent.value, toolCards.length);");
    expect(chatSrc).toContain("notifyTurnFinished(streamingContent.value, toolCards.length);");
  });

  it("收尾呈现复用纯函数，而不是在 store 里另写一套判定", () => {
    expect(chatSrc).toContain("buildFinishIr({");
    expect(chatSrc).toContain("planSurfaces(ir,");
    // 两个调用点必须共用同一个上下文构造函数，否则会出现“两处各判一套”
    // （勿扰时段/静默/开关的判定一旦分叉，就会出现“设置页关了但不生效”这类怪事）
    expect(chatSrc).toContain("surfaceContext()");
    expect(chatSrc).toContain("quietHours");
  });
});

describe("该不该念：宿主判断，用户不用操心", () => {
  it("一句话结论 / 关键数字 → 念", () => {
    expect(shouldSpeak(ir({ kind: "callout", title: "三份邮件已回复" })).speak).toBe(true);
    expect(
      shouldSpeak(ir({ kind: "metric", title: "内存占用", body: { value: "1.2", unit: "GB" } }))
        .speak,
    ).toBe(true);
  });

  it("「看」的内容不念：表格/代码/图表/时间轴/键值/产物页", () => {
    for (const kind of ["table", "code", "chart", "timeline", "page", "kv"] as const) {
      const verdict = shouldSpeak(ir({ kind, title: "标题" }));
      expect(verdict.speak, `${kind} 不该念`).toBe(false);
      expect(verdict.reason).toContain("看");
    }
  });

  it("长正文只念「首句」而不是整段（长度控制靠取首句）", () => {
    const verdict = shouldSpeak(ir({ kind: "card", body: { text: "啊".repeat(300) } }));
    expect(verdict.speak).toBe(true);
    expect(verdict.text.length).toBeLessThanOrEqual(SPEAK_MAX_CHARS);
  });

  it("模型给的 speech 太长时也不念（自己写超了要拦）", () => {
    const verdict = shouldSpeak(
      ir({ kind: "card", title: "标题", speech: "啊".repeat(SPEAK_MAX_CHARS + 10) }),
    );
    expect(verdict.speak).toBe(false);
    expect(verdict.reason).toContain("太长");
  });

  it("标题很短时念标题（即使正文很长）——标题本来就是最好的念料", () => {
    const verdict = shouldSpeak(
      ir({ kind: "card", title: "本周提交分布", body: { text: "啊".repeat(300) } }),
    );
    expect(verdict.speak).toBe(true);
    expect(verdict.text).toBe("本周提交分布");
  });

  it("没有正文不念", () => {
    expect(shouldSpeak(ir({ kind: "card", body: {} })).speak).toBe(false);
  });

  it("模型指定了 speech 就念那一句", () => {
    expect(shouldSpeak(ir({ title: "标题", speech: "念这句" })).text).toBe("念这句");
  });
});

// ── 协议层（P-A1）：版本 / 身份 / 来源 / 引用 / 出口注册表 / 勿扰时段 ──────────
//
// 这些字段不影响“怎么画”，但决定“这条结果该怎么被对待”：
// 有没有被重复推、来自谁、要不要因为来源降打扰、深夜该不该出声。

describe("协议字段：v / id / source / refs", () => {
  it("缺省补齐 v=1、生成的 id、source=model", () => {
    const { ir: out } = parseDisplayIr({ kind: "card" });
    expect(out.v).toBe(PRESENT_PROTOCOL_VERSION);
    expect(out.id).toMatch(/^ir_/);
    expect(out.source).toBe("model");
  });

  it("报文自带的 id/source 必须沿用（HUD 重新解析不能换 id，否则去重失效）", () => {
    const { ir: out } = parseDisplayIr({ kind: "card", id: "ir_abc", source: "schedule" });
    expect(out.id).toBe("ir_abc");
    expect(out.source).toBe("schedule");
  });

  it("宿主可以指定来源（定时任务/子代理在调用时告诉我们）", () => {
    const { ir: out } = parseDisplayIr({ kind: "card" }, { source: "subagent" });
    expect(out.source).toBe("subagent");
    // 但报文自己写了就以报文为准
    const { ir: out2 } = parseDisplayIr({ kind: "card", source: "hook" }, { source: "subagent" });
    expect(out2.source).toBe("hook");
  });

  it("更高版本的报文按 v1 尽力解析并留下提示，而不是拒绝渲染", () => {
    const { ir: out, issues } = parseDisplayIr({ kind: "card", v: 7 });
    expect(out.v).toBe(7);
    expect(out.kind).toBe("card");
    expect(issues.join()).toContain("v7");
  });

  it("未知 source 退回 model 并记录（不猜）", () => {
    const { ir: out, issues } = parseDisplayIr({ kind: "card", source: "telepathy" });
    expect(out.source).toBe("model");
    expect(issues.join()).toContain("source");
  });

  it("refs：合法条目保留，未知 kind/空值丢弃，超量截断到 4 条", () => {
    const refs = parseRefs([
      { kind: "file", value: "~/op/a.ts" },
      { kind: "telepathy", value: "x" },
      { kind: "url", value: "" },
      { kind: "conversation", value: "abc" },
      { kind: "tool", value: "run_command" },
      { kind: "file", value: "~/op/b.ts" },
      { kind: "file", value: "~/op/c.ts" },
    ]);
    expect(refs?.length).toBe(4);
    expect(refs?.map((r) => r.value)).toEqual(["~/op/a.ts", "abc", "run_command", "~/op/b.ts"]);
    // 非数组/全脏 → undefined（不产生空数组，省得当“有引用”处理）
    expect(parseRefs("x")).toBeUndefined();
    expect(parseRefs([{ kind: "nope", value: "y" }])).toBeUndefined();
  });

  it("priorityExplicit 只在显式写了优先级时为真", () => {
    expect(parseDisplayIr({ kind: "card" }).ir.priorityExplicit).toBe(false);
    expect(parseDisplayIr({ kind: "card", priority: "primary" }).ir.priorityExplicit).toBe(true);
    expect(parseDisplayIr({ kind: "card", priority: "secondary" }).ir.priorityExplicit).toBe(true);
  });

  it("收尾 IR 自报来自宿主（source=host），不冒充模型调用", () => {
    const out = buildFinishIr({ text: "做完了", toolCount: 3 });
    expect(out.source).toBe("host");
    expect(out.v).toBe(PRESENT_PROTOCOL_VERSION);
    expect(out.id).toMatch(/^ir_/);
  });
});

describe("出口注册表（协议第②层）", () => {
  it("每个登记出口都有能力表，且 kind 表非空", () => {
    for (const s of SURFACES) {
      expect(SURFACE_CAPABILITIES[s], `${s} 未登记`).toBeTruthy();
      expect(SURFACE_CAPABILITIES[s].kinds.length, `${s} 的 kind 表是空的`).toBeGreaterThan(0);
    }
  });

  it("已接线的出口必须都在注册表里（新增出口不能绕过登记）", () => {
    for (const s of IMPLEMENTED_SURFACES) {
      expect(SURFACE_CAPABILITIES[s as Surface]).toBeTruthy();
    }
    expect(IMPLEMENTED_SURFACES.length).toBeLessThan(SURFACES.length); // 还有待收编的
  });

  it("登记表里的出口名与 Rust 侧镜像一致（防前后端各写一套）", () => {
    // Rust 源码不在 src/ 下，单独 glob 一份（契约必须能被机器校验，不能靠人记得同步）
    const rustSrc = RUST_SOURCES["../src-tauri/src/surface.rs"] ?? "";
    expect(rustSrc.length).toBeGreaterThan(0);
    const block = /pub const SURFACE_NAMES:[^=]*=\s*\[([\s\S]*?)\];/.exec(rustSrc);
    expect(block, "surface.rs 里没找到 SURFACE_NAMES").toBeTruthy();
    const names = [...block![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(names.sort()).toEqual([...SURFACES].sort());
  });

  it("出声与不打扰的默认值是“安静优先”：语音默认关", () => {
    expect(SURFACE_CAPABILITIES.speech.defaultEnabled).toBe(false);
    expect(SURFACE_CAPABILITIES.im.defaultEnabled).toBe(false);
    expect(SURFACE_CAPABILITIES.hud.defaultEnabled).toBe(true);
  });
});

describe("勿扰时段：深夜不乱响，但信息不丢", () => {
  it("parseClock 只认 HH:MM，非法一律 null（不猜）", () => {
    expect(parseClock("22:30")).toBe(1350);
    expect(parseClock("0:05")).toBe(5);
    for (const bad of ["", "24:00", "22:60", "2230", "22:3", "晚十点"]) {
      expect(parseClock(bad), bad).toBeNull();
    }
  });

  it("跨零点的区间判定正确（22:30–08:00）", () => {
    const quiet = { start: "22:30", end: "08:00" };
    const at = (hhmm: string) => {
      const [h, m] = hhmm.split(":").map(Number);
      return inQuietHours(quiet, new Date(2026, 9, 16, h, m));
    };
    expect(at("23:10")).toBe(true);
    expect(at("07:59")).toBe(true);
    expect(at("08:00")).toBe(false);
    expect(at("12:00")).toBe(false);
    expect(at("22:29")).toBe(false);
  });

  it("不跨零点的区间同样成立；起止相等或非法则整条不生效（宁可不禁声）", () => {
    const at = (quiet: { start: string; end: string } | null, hhmm: string) => {
      const [h, m] = hhmm.split(":").map(Number);
      return inQuietHours(quiet, new Date(2026, 9, 16, h, m));
    };
    expect(at({ start: "13:00", end: "14:00" }, "13:30")).toBe(true);
    expect(at({ start: "13:00", end: "14:00" }, "14:30")).toBe(false);
    expect(at({ start: "13:00", end: "13:00" }, "13:30")).toBe(false);
    expect(at({ start: "补", end: "14:00" }, "13:30")).toBe(false);
    expect(at(null, "23:00")).toBe(false);
  });

  it("处在勿扰时段：只留痕，不出声不冒层（会话永远写）", () => {
    const plan = planSurfaces(
      ir({ kind: "callout", speech: "构建通过" }),
      ctx({ quietHours: { start: "22:30", end: "08:00" }, now: new Date(2026, 9, 16, 23, 30) }),
    );
    expect(plan.surfaces).toEqual(["session"]);
    expect(plan.speechText).toBe("");
    expect(plan.reasons.join()).toContain("勿扰时段");
  });
});

describe("来源策略：后台产生的结果默认低打扰", () => {
  it("定时任务/钩子/子代理：不念、浮层自动淡出（不 sticky）", () => {
    for (const source of ["schedule", "hook", "subagent"] as const) {
      const base = ir({ kind: "callout", speech: "跑完了", life: "sticky", source });
      const plan = planSurfaces(base, ctx());
      expect(plan.surfaces, source).not.toContain("speech");
      expect(plan.ir.life, `${source} 不该长时间占屏`).toBe("auto");
      expect(plan.reasons.join()).toContain("后台");
    }
  });

  it("显式要 primary 的后台结果照办（显式意图优先于默认策略）", () => {
    const base = ir({
      kind: "callout",
      speech: "跑完了",
      life: "sticky",
      source: "schedule",
      priorityExplicit: true,
    });
    const plan = planSurfaces(base, ctx());
    expect(plan.surfaces).toContain("speech");
    expect(plan.ir.life).toBe("sticky");
  });

  it("模型自己调 present 不受这条策略影响", () => {
    const plan = planSurfaces(ir({ kind: "callout", speech: "好了", life: "sticky" }), ctx());
    expect(plan.surfaces).toContain("speech");
    expect(plan.ir.life).toBe("sticky");
  });

  it("effectiveIr 是幂等的（重复施加不会越改越离谱）", () => {
    const base = ir({ life: "pin", source: "hook" });
    const once = effectiveIr(base);
    expect(effectiveIr(once)).toEqual(once);
    expect(once.life).toBe("auto");
  });

  it("plan.ir 是**生效后的 IR**（调用方发给执行端的就是它）", () => {
    const plan = planSurfaces(ir({ life: "sticky", source: "hook" }), ctx());
    expect(plan.ir.life).toBe("auto");
  });
});
