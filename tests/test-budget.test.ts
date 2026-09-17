import { describe, it, expect } from "vitest";
import {
  BUDGET_WARN_RATIO,
  budgetNoticeKey,
  buildSpend,
  dayKey,
  evaluateBudget,
  formatBudget,
  levelOf,
  monthKey,
  normalizeDayKey,
  normalizeLimits,
  SCOPE_LABEL,
  spendFromDaily,
  type BudgetLimits,
  type BudgetSpend,
} from "../src/utils/budget";

const L = (p: Partial<BudgetLimits> = {}): BudgetLimits => ({
  session: 0,
  daily: 0,
  monthly: 0,
  ...p,
});
const S = (p: Partial<BudgetSpend> = {}): BudgetSpend => ({
  session: 0,
  daily: 0,
  monthly: 0,
  ...p,
});

describe("P0-6 预算护栏 · 阈值判定", () => {
  it("未设任何预算 → ok / 空 items / 空 notice（不打扰）", () => {
    const v = evaluateBudget(S({ session: 999, daily: 999, monthly: 999 }), L());
    expect(v.level).toBe("ok");
    expect(v.items).toEqual([]);
    expect(v.worst).toBeNull();
    expect(v.notice).toBe("");
  });

  it("缺少配置（null/undefined/NaN/负数）一律按不限处理", () => {
    const v = evaluateBudget(S({ daily: 5 }), null);
    expect(v.level).toBe("ok");
    expect(v.items.length).toBe(0);
    expect(normalizeLimits({ daily: Number.NaN }).daily).toBe(0);
    expect(normalizeLimits({ daily: -3 }).daily).toBe(0);
    expect(normalizeLimits(undefined).monthly).toBe(0);
    // 花费为负数/NaN 时按 0 处理（不会因为脏数据误报超支）
    const v2 = evaluateBudget({ daily: -100 } as BudgetSpend, L({ daily: 10 }));
    expect(v2.level).toBe("ok");
    expect(v2.items[0].spent).toBe(0);
  });

  it("低于预警线 → ok，且不产生文案", () => {
    const v = evaluateBudget(S({ daily: 7.99 }), L({ daily: 10 }));
    expect(v.level).toBe("ok");
    expect(v.items).toHaveLength(1);
    expect(v.items[0].level).toBe("ok");
    expect(v.items[0].message).toBe("");
    expect(v.notice).toBe("");
  });

  it("恰好 80% → warn（边界含等号）", () => {
    expect(BUDGET_WARN_RATIO).toBe(0.8);
    expect(levelOf(8, 10)).toBe("warn");
    expect(evaluateBudget(S({ daily: 8 }), L({ daily: 10 })).level).toBe("warn");
  });

  it("99% → warn；100% 与超支 → blocked（边界含等号）", () => {
    expect(evaluateBudget(S({ daily: 9.9 }), L({ daily: 10 })).level).toBe("warn");
    expect(levelOf(10, 10)).toBe("blocked");
    const v = evaluateBudget(S({ daily: 12.5 }), L({ daily: 10 }));
    expect(v.level).toBe("blocked");
    expect(v.items[0].ratio).toBeCloseTo(1.25, 6); // 超支保留真实比例
    expect(v.items[0].message).toContain("预算已用尽");
    expect(v.notice).toContain("超支");
  });

  it("多档同时命中：blocked 优先于 warn，worst 指向 blocked 那档", () => {
    const v = evaluateBudget(
      S({ session: 9, daily: 10.5, monthly: 100 }), // 会话 warn，今日 blocked
      L({ session: 10, daily: 10, monthly: 1000 }),
    );
    expect(v.level).toBe("blocked");
    expect(v.worst?.scope).toBe("daily");
    expect(v.items.map((i) => i.scope)).toEqual(["session", "daily", "monthly"]);
    expect(v.notice).toContain("今日");
    expect(v.notice).toContain("本次会话");
    expect(v.notice).not.toContain("本月"); // ok 档不进文案
  });

  it("同级多档命中时 worst 取比例更大者", () => {
    const v = evaluateBudget(S({ session: 8.5, daily: 9 }), L({ session: 10, daily: 10 }));
    expect(v.level).toBe("warn");
    expect(v.worst?.scope).toBe("daily");
  });

  it("预算档位有中文标签，未设置的档位不出现", () => {
    expect(SCOPE_LABEL.session).toBe("本次会话");
    const v = evaluateBudget(S({ session: 1, monthly: 1 }), L({ monthly: 2 }));
    expect(v.items).toHaveLength(1);
    expect(v.items[0].label).toBe("本月");
    expect(v.items[0].spent).toBe(1);
  });

  it("warnRatio 可自定义，非法值回落到 0.8", () => {
    expect(evaluateBudget(S({ daily: 5 }), L({ daily: 10 }), { warnRatio: 0.5 }).level).toBe(
      "warn",
    );
    // 0 / 1 / 越界值都不可用 → 回落默认 0.8
    expect(evaluateBudget(S({ daily: 5 }), L({ daily: 10 }), { warnRatio: 0 }).level).toBe("ok");
    expect(evaluateBudget(S({ daily: 5 }), L({ daily: 10 }), { warnRatio: 2 }).level).toBe("ok");
  });

  it("金额格式化统一两位小数（不用科学计数法）", () => {
    expect(formatBudget(0)).toBe("¥0.00");
    expect(formatBudget(0.00002)).toBe("¥0.00");
    expect(formatBudget(12.3456)).toBe("¥12.35");
    expect(formatBudget(-5)).toBe("¥0.00");
  });
});

describe("P0-6 预算护栏 · 跨日/跨月重置", () => {
  const daily = [
    { date: "2026-08-31", cost: 30 },
    { date: "2026-09-16", cost: 4 },
    { date: "2026-09-17", cost: 6 },
    { date: "2026-09-17", cost: 1.5 },
    { date: "2026-10-01", cost: 99 },
  ];
  const now = new Date(2026, 8, 17, 10, 0, 0).getTime(); // 本地 2026-09-17

  it("今日只累计今天，本月只累计当月（昨天/上月/下月都不算）", () => {
    const s = spendFromDaily(daily, now);
    expect(s.daily).toBe(7.5); // 6 + 1.5
    expect(s.monthly).toBe(11.5); // 4 + 7.5（8 月与 10 月不计入）
  });

  it("跨日重置：次日同一批数据里昨天的不再计入今日", () => {
    const next = new Date(2026, 8, 18, 0, 5, 0).getTime();
    const s = spendFromDaily(daily, next);
    expect(s.daily).toBe(0);
    expect(s.monthly).toBe(11.5);
  });

  it("跨月重置：进入次月后本月重新累计", () => {
    const nextMonth = new Date(2026, 9, 1, 0, 5, 0).getTime();
    const s = spendFromDaily(daily, nextMonth);
    expect(s.daily).toBe(99);
    expect(s.monthly).toBe(99);
  });

  it("日期口径容错：2026-9-7 / 带时间的 ISO 串 / 脏数据", () => {
    const s = spendFromDaily(
      [
        { date: "2026-9-7", cost: 2 },
        { date: "2026-09-07T23:00:00Z", cost: 3 },
        { date: "not-a-date", cost: 100 },
        { cost: 100 },
        { date: "2026-09-07", cost: Number.NaN },
      ],
      new Date(2026, 8, 7, 12).getTime(),
    );
    expect(s.daily).toBe(5);
    expect(normalizeDayKey("2026-9-7")).toBe("2026-09-07");
    expect(normalizeDayKey("garbage")).toBe("");
  });

  it("dayKey / monthKey 用本地时区（跨月边界：8/31 23:59 仍算 8 月）", () => {
    const end = new Date(2026, 7, 31, 23, 59, 30).getTime();
    expect(dayKey(end)).toBe("2026-08-31");
    expect(monthKey(end)).toBe("2026-08");
    const start = new Date(2026, 8, 1, 0, 0, 1).getTime();
    expect(dayKey(start)).toBe("2026-09-01");
    expect(monthKey(start)).toBe("2026-09");
    expect(dayKey(new Date("invalid"))).toBe("");
  });

  it("buildSpend 组装三档：会话档来自当前对话，日/月来自按天累计", () => {
    const s = buildSpend({ sessionCost: 2.5, daily, now });
    expect(s).toEqual({ session: 2.5, daily: 7.5, monthly: 11.5 });
    // 无按天数据（旧库）也不崩
    expect(buildSpend({ sessionCost: 1, daily: null, now })).toEqual({
      session: 1,
      daily: 0,
      monthly: 0,
    });
  });
});

describe("P0-6 预算护栏 · 提醒去重", () => {
  const now = new Date(2026, 8, 17, 12).getTime();

  it("ok 不产生提醒键", () => {
    const v = evaluateBudget(S({ daily: 1 }), L({ daily: 10 }));
    expect(budgetNoticeKey(v, now)).toBeNull();
    expect(budgetNoticeKey(evaluateBudget(S(), L()), now)).toBeNull();
  });

  it("同档同等级同一天只提醒一次（跨档/跨等级/跨天各自独立）", () => {
    const warn = evaluateBudget(S({ daily: 9 }), L({ daily: 10 }));
    expect(budgetNoticeKey(warn, now)).toBe("daily:warn:2026-09-17");
    const blocked = evaluateBudget(S({ daily: 11 }), L({ daily: 10 }));
    expect(budgetNoticeKey(blocked, now)).toBe("daily:blocked:2026-09-17");
    const tomorrow = new Date(2026, 8, 18, 9).getTime();
    expect(budgetNoticeKey(warn, tomorrow)).toBe("daily:warn:2026-09-18");
    const other = evaluateBudget(S({ monthly: 81 }), L({ monthly: 100 }));
    expect(budgetNoticeKey(other, now)).toBe("monthly:warn:2026-09-17");
  });
});
