// 任务计划的进度收敛（纯函数，便于单测）。
// 背景（2026-10-21 用户反馈）：模型只 `plan_update` 了第 2 步，实际工作已完成，
// 但第 3 步仍是 pending、第 2 步可能停在 doing → 卡片永远像「卡在第二步」。
import type { PlanStep, PlanStepStatus } from "@/types";

/** 终态：失败/终止的步骤不再被收尾逻辑改写（保留真实结果供复盘）。 */
const FINAL_STATES: PlanStepStatus[] = ["failed", "terminated"];

/**
 * 收尾收敛：把「未失败/未终止」的步骤统一标记为 done。
 * 只在**正常结束且已产出实质正文**时调用；轮次预算耗尽、停滞中止、用户停止都不调用。
 */
export function finalizePlanSteps(steps: PlanStep[]): {
  steps: PlanStep[];
  changed: boolean;
} {
  let changed = false;
  const out = steps.map((s) => {
    if (s.status === "done" || FINAL_STATES.includes(s.status)) return s;
    changed = true;
    return { ...s, status: "done" as const };
  });
  return { steps: out, changed };
}

/**
 * 自动开始下一步：当前没有 doing 步骤时，把第一个 pending 步骤标为 doing。
 * 用于「模型忘了 plan_update doing 但已经在调真实工具」的情况，让卡片进度跟得上实际执行。
 */
export function startNextPendingStep(steps: PlanStep[]): {
  steps: PlanStep[];
  changed: boolean;
  index: number;
} {
  if (steps.some((s) => s.status === "doing")) {
    return { steps, changed: false, index: -1 };
  }
  const index = steps.findIndex((s) => s.status === "pending");
  if (index < 0) return { steps, changed: false, index: -1 };
  const out = steps.slice();
  out[index] = { ...out[index], status: "doing" };
  return { steps: out, changed: true, index };
}

/** 已完成步数 / 总步数（供卡片与托盘一致展示）。 */
export function planProgress(steps: PlanStep[]): { done: number; total: number } {
  return {
    done: steps.filter((s) => s.status === "done").length,
    total: steps.length,
  };
}
