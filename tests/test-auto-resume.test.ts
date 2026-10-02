// 任务模式自主续跑（auto-resume）单测：重点是「该续跑时必须续跑」「不该续跑时的每条护栏」
import { describe, it, expect } from "vitest";
import {
  planAutoResume,
  allowResumeAfterStall,
  AUTO_RESUME_MAX,
  AUTO_RESUME_TEXT,
  type AutoResumeSignals,
} from "../src/utils/auto-resume";

/** 默认「一切正常、还有活没干完」的信号，逐个用例覆盖需要翻转的字段 */
function sig(over: Partial<AutoResumeSignals> = {}): AutoResumeSignals {
  return {
    stoppedByUser: false,
    planTerminated: false,
    hasQueuedUserMessage: false,
    errorAborted: false,
    budgetBlocked: false,
    pendingSteps: 3,
    autoAttempts: 0,
    maxAttempts: AUTO_RESUME_MAX,
    repeatedFailure: false,
    madeProgress: true,
    planTouchedThisTurn: true,
    ...over,
  };
}

describe("planAutoResume", () => {
  it("任务没做完且本轮有进展 → 必须自动续跑（用户不该被要求敲「继续」）", () => {
    const v = planAutoResume(sig({ pendingSteps: 4, autoAttempts: 1 }));
    expect(v.resume).toBe(true);
    expect(v.note).toContain("自动继续");
    expect(v.note).toContain("4 步");
    expect(v.note).toContain(`第 2/${AUTO_RESUME_MAX} 次`);
    expect(v.note).toContain("不需要你回复");
  });

  it("任务已全部完成 → 不续跑", () => {
    expect(planAutoResume(sig({ pendingSteps: 0 })).resume).toBe(false);
  });

  it("护栏：用户停止 / 终止计划 / 有排队消息 / 异常中断 / 预算阻断", () => {
    for (const [k, why] of [
      ["stoppedByUser", "停止"],
      ["planTerminated", "终止"],
      ["hasQueuedUserMessage", "队列"],
      ["errorAborted", "异常"],
      ["budgetBlocked", "预算"],
    ] as const) {
      const v = planAutoResume(sig({ [k]: true } as Partial<AutoResumeSignals>));
      expect(v.resume, k).toBe(false);
      expect(v.why, k).toContain(why);
    }
  });

  it("护栏：自动续跑次数用尽", () => {
    const v = planAutoResume(sig({ autoAttempts: AUTO_RESUME_MAX }));
    expect(v.resume).toBe(false);
    expect(v.why).toContain("上限");
  });

  it("护栏：本轮没碰这个计划 → 不续跑（防旧计划误触发）", () => {
    const v = planAutoResume(sig({ planTouchedThisTurn: false }));
    expect(v.resume).toBe(false);
    expect(v.why).toContain("没有推进");
  });

  it("护栏：没有实质进展 → 不续跑（否则就是自动烧钱空转）", () => {
    const v = planAutoResume(sig({ madeProgress: false }));
    expect(v.resume).toBe(false);
    expect(v.why).toContain("空转");
  });

  it("护栏：同一失败原因再次出现 → 不续跑", () => {
    const v = planAutoResume(sig({ repeatedFailure: true }));
    expect(v.resume).toBe(false);
    expect(v.why).toContain("停滞");
  });
});

describe("allowResumeAfterStall", () => {
  it("停滞只给一次自动换方案的机会，第二次交回用户", () => {
    expect(allowResumeAfterStall(0)).toBe(true);
    expect(allowResumeAfterStall(1)).toBe(false);
    expect(allowResumeAfterStall(3)).toBe(false);
  });

  it("与 repeatedFailure 组合：首次停滞可续跑，再次停滞被拦下", () => {
    const first = planAutoResume(sig({ repeatedFailure: !allowResumeAfterStall(0) }));
    expect(first.resume).toBe(true);
    const second = planAutoResume(sig({ repeatedFailure: !allowResumeAfterStall(1) }));
    expect(second.resume).toBe(false);
  });
});

describe("AUTO_RESUME_TEXT", () => {
  it("明确标注是系统自动发起（用户看得懂、能找到「停止」）", () => {
    expect(AUTO_RESUME_TEXT).toContain("自动续跑");
    // 不是裸「继续」：裸指令由用户发起，自动续跑要走 auto 标记注入续跑指令
    expect(AUTO_RESUME_TEXT.trim()).not.toBe("继续");
  });
});
