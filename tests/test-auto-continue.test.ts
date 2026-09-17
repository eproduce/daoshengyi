import { describe, it, expect } from "vitest";
import {
  CONTINUE_RULES,
  MAX_AUTO_CONTINUES_PER_TURN,
  decideAutoContinue,
  detectStopReasons,
  nudgeContextFrom,
  planAutoContinue,
  ruleById,
  type TurnSignals,
} from "../src/utils/auto-continue";
import type { Goal } from "../src/utils/goals";

const goal = (p: Partial<Goal> = {}): Goal => ({
  objective: "把 P1-6 做完",
  status: "active",
  tokenBudget: null,
  tokensUsed: 0,
  note: "",
  createdAt: 0,
  updatedAt: 0,
  ...p,
});

const signals = (p: Partial<TurnSignals> = {}): TurnSignals => ({
  content: "已完成，测试通过。",
  toolSuccesses: 1,
  toolFailures: 0,
  ...p,
});

describe("P1-6 续跑 · 问题检测（优先级）", () => {
  it("工具全失败：有失败且零成功才算（部分成功不算）", () => {
    expect(detectStopReasons(signals({ toolSuccesses: 0, toolFailures: 2 }))).toContain(
      "all-tools-failed",
    );
    expect(detectStopReasons(signals({ toolSuccesses: 1, toolFailures: 2 }))).not.toContain(
      "all-tools-failed",
    );
    // 没调工具也不算「全失败」
    expect(detectStopReasons(signals({ toolSuccesses: 0, toolFailures: 0 }))).not.toContain(
      "all-tools-failed",
    );
  });

  it("验证凭据问题由上游（P0-5）传入", () => {
    expect(
      detectStopReasons(signals({ verificationIssue: { kind: "test", status: "missing" } })),
    ).toContain("verify-gap");
    expect(detectStopReasons(signals({ verificationIssue: null }))).not.toContain("verify-gap");
  });

  it("计划未完：pending / doing 都算；全 done 不算", () => {
    const withSteps = (statuses: string[]) =>
      detectStopReasons(signals({ plan: { steps: statuses.map((s) => ({ status: s })) } }));
    expect(withSteps(["done", "pending"])).toContain("plan-incomplete");
    expect(withSteps(["done", "doing"])).toContain("plan-incomplete");
    expect(withSteps(["done", "done"])).not.toContain("plan-incomplete");
    expect(withSteps([])).not.toContain("plan-incomplete");
    expect(detectStopReasons(signals({ plan: null }))).not.toContain("plan-incomplete");
  });

  it("目标未完成才算问题（complete/abandoned 不算）", () => {
    expect(detectStopReasons(signals({ goal: goal() }))).toContain("goal-unfinished");
    expect(detectStopReasons(signals({ goal: goal({ status: "complete" }) }))).not.toContain(
      "goal-unfinished",
    );
    expect(detectStopReasons(signals({ goal: goal({ status: "abandoned" }) }))).not.toContain(
      "goal-unfinished",
    );
    expect(detectStopReasons(signals({ goal: null }))).not.toContain("goal-unfinished");
  });

  it("空白正文算问题（含纯空格）", () => {
    expect(detectStopReasons(signals({ content: "" }))).toContain("empty-answer");
    expect(detectStopReasons(signals({ content: "   \n " }))).toContain("empty-answer");
    expect(detectStopReasons(signals({ content: "有内容" }))).not.toContain("empty-answer");
  });

  it("多问题同时命中时按固定优先级排序", () => {
    const reasons = detectStopReasons(
      signals({
        content: "",
        toolSuccesses: 0,
        toolFailures: 1,
        verificationIssue: { kind: "build", status: "stale" },
        plan: { steps: [{ status: "pending" }] },
        goal: goal(),
      }),
    );
    expect(reasons).toEqual([
      "all-tools-failed",
      "verify-gap",
      "plan-incomplete",
      "goal-unfinished",
      "empty-answer",
    ]);
  });

  it("一切正常 → 无问题（不打扰）", () => {
    expect(
      detectStopReasons(
        signals({
          content: "做完了，npm test 通过。",
          plan: { steps: [{ status: "done" }] },
          goal: goal({ status: "complete" }),
        }),
      ),
    ).toEqual([]);
  });
});

describe("P1-6 续跑 · 护栏顺序", () => {
  const reasons = ["verify-gap"] as const;

  it("用户停止优先于一切（停止按钮不能被纠偏绕过）", () => {
    const d = decideAutoContinue({ reasons: [...reasons], stopped: true });
    expect(d.action).toBe("stop");
    if (d.action === "stop") expect(d.why).toContain("用户已请求停止");
  });

  it("预算阻断 → 不自动续跑（不替用户烧钱）", () => {
    const d = decideAutoContinue({ reasons: [...reasons], budgetBlocked: true });
    expect(d.action).toBe("stop");
    if (d.action === "stop") expect(d.why).toContain("预算");
  });

  it("剩余轮数不足 → 不续", () => {
    const d = decideAutoContinue({ reasons: [...reasons], remainingRounds: 0 });
    expect(d.action).toBe("stop");
    if (d.action === "stop") expect(d.why).toContain("轮数");
    // 有余额则继续
    expect(decideAutoContinue({ reasons: [...reasons], remainingRounds: 5 }).action).toBe(
      "continue",
    );
  });

  it("本回合总次数上限", () => {
    const d = decideAutoContinue({
      reasons: [...reasons],
      totalContinues: MAX_AUTO_CONTINUES_PER_TURN,
    });
    expect(d.action).toBe("stop");
    if (d.action === "stop") expect(d.why).toContain("上限");
    expect(MAX_AUTO_CONTINUES_PER_TURN).toBe(3);
  });

  it("无问题 → stop 且说明原因", () => {
    const d = decideAutoContinue({ reasons: [] });
    expect(d.action).toBe("stop");
    if (d.action === "stop") expect(d.why).toContain("没有检测到");
  });
});

describe("P1-6 续跑 · 按规则限次（防死循环）", () => {
  it("同一规则默认只纠偏一次，之后换下一条", () => {
    const first = decideAutoContinue({
      reasons: ["verify-gap", "plan-incomplete"],
      attempts: {},
    });
    expect(first.action).toBe("continue");
    if (first.action === "continue") {
      expect(first.reason).toBe("verify-gap");
      expect(first.attempt).toBe(1);
    }
    const second = decideAutoContinue({
      reasons: ["verify-gap", "plan-incomplete"],
      attempts: { "verify-gap": 1 },
    });
    expect(second.action).toBe("continue");
    if (second.action === "continue") expect(second.reason).toBe("plan-incomplete");
  });

  it("所有命中规则次数用尽 → stop 并列出被跳过的规则", () => {
    const d = decideAutoContinue({
      reasons: ["verify-gap", "plan-incomplete"],
      attempts: { "verify-gap": 1, "plan-incomplete": 1 },
    });
    expect(d.action).toBe("stop");
    if (d.action === "stop") {
      expect(d.why).toContain("都已用尽");
      expect(d.why).toContain("验证");
    }
  });

  it("模拟连续收尾：自动续跑次数单调增长并最终停下（不会无限循环）", () => {
    let totalContinues = 0;
    const attempts: Record<string, number> = {};
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const d = decideAutoContinue({
        reasons: ["verify-gap", "plan-incomplete", "empty-answer"],
        attempts,
        totalContinues,
      });
      if (d.action === "stop") break;
      seen.push(d.reason);
      attempts[d.reason] = (attempts[d.reason] ?? 0) + 1;
      totalContinues++;
    }
    // 三条规则各一次 → 3 次后停
    expect(seen).toEqual(["verify-gap", "plan-incomplete", "empty-answer"]);
    expect(totalContinues).toBe(3);
  });

  it("规则表齐备：每个 StopReason 都有规则、都有可执行文本", () => {
    for (const id of [
      "all-tools-failed",
      "verify-gap",
      "plan-incomplete",
      "goal-unfinished",
      "empty-answer",
    ] as const) {
      const rule = ruleById(id);
      expect(rule, id).toBeTruthy();
      expect(rule!.maxAttempts).toBeGreaterThanOrEqual(1);
      const text = rule!.nudge({
        failedTools: ["run_tests"],
        verifyKind: "test",
        pendingSteps: ["第 2 步"],
        objective: "目标 X",
      });
      expect(text.length).toBeGreaterThan(20);
    }
    // 规则表内部 id 唯一
    expect(new Set(CONTINUE_RULES.map((r) => r.id)).size).toBe(CONTINUE_RULES.length);
  });
});

describe("P1-6 续跑 · nudge 文本可执行", () => {
  it("工具全失败：列出失败工具并要求换路径或如实说明阻塞", () => {
    const text = ruleById("all-tools-failed")!.nudge({ failedTools: ["run_tests", "run_command"] });
    expect(text).toContain("run_tests");
    expect(text).toContain("run_command");
    expect(text).toContain("阻塞");
  });

  it("验证凭据：要求真跑一次或删掉断言", () => {
    const text = ruleById("verify-gap")!.nudge({ verifyKind: "typecheck" });
    expect(text).toContain("typecheck");
    expect(text).toContain("真的跑一次");
    expect(text).toContain("删掉");
  });

  it("计划未完：列出未完成步骤并要求不要留半成品", () => {
    const text = ruleById("plan-incomplete")!.nudge({ pendingSteps: ["第 2 步", "第 3 步"] });
    expect(text).toContain("第 2 步");
    expect(text).toContain("半成品");
  });

  it("目标未达成：要求 update_goal 标 complete 或 blocked", () => {
    const text = ruleById("goal-unfinished")!.nudge({ objective: "把 P1-6 做完" });
    expect(text).toContain("把 P1-6 做完");
    expect(text).toContain("update_goal");
    expect(text).toContain("blocked");
  });

  it("nudgeContextFrom 只列未完成步骤、带上验证类别与目标", () => {
    const ctx = nudgeContextFrom(
      signals({
        verificationIssue: { kind: "lint", status: "missing" },
        plan: { steps: [{ status: "done" }, { status: "pending" }, { status: "doing" }] },
        goal: goal({ objective: "目标 Y" }),
      }),
      { failedTools: ["x"] },
    );
    expect(ctx.pendingSteps).toEqual(["第 2 步", "第 3 步"]);
    expect(ctx.verifyKind).toBe("lint");
    expect(ctx.verifyStatus).toBe("missing");
    expect(ctx.objective).toBe("目标 Y");
    expect(ctx.failedTools).toEqual(["x"]);
  });
});

describe("P1-6 续跑 · 一体化入口 planAutoContinue", () => {
  it("返回决策同时带上命中的问题列表（便于日志排查）", () => {
    const r = planAutoContinue(signals({ verificationIssue: { kind: "test", status: "stale" } }), {
      attempts: {},
      totalContinues: 0,
      remainingRounds: 5,
    });
    expect(r.action).toBe("continue");
    expect(r.reasons).toContain("verify-gap");
    if (r.action === "continue") {
      expect(r.ruleId).toBe("verify-gap");
      expect(r.nudge).toContain("验证");
    }
  });

  it("无问题时 action=stop 且 reasons 为空", () => {
    const r = planAutoContinue(signals({ content: "正常结论" }), { remainingRounds: 3 });
    expect(r.action).toBe("stop");
    expect(r.reasons).toEqual([]);
  });

  it("goal 为 null / 缺省字段时不崩（容错）", () => {
    const r = planAutoContinue({ content: "x" }, {});
    expect(r.reasons).toEqual([]);
    const r2 = planAutoContinue(
      { content: "", goal: null, plan: null, toolFailures: 1, toolSuccesses: 0 },
      { attempts: {} },
    );
    expect(r2.action).toBe("continue");
  });
});
