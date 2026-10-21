import { describe, expect, it } from "vitest";
import { finalizePlanSteps, planProgress, startNextPendingStep } from "../src/utils/task-plan.ts";
import type { PlanStep } from "../src/types/index.ts";

const step = (text: string, status: PlanStep["status"]): PlanStep => ({ text, status });

describe("任务计划进度收敛", () => {
  it("正常收尾：pending/doing 统一标 done，failed/terminated 保留", () => {
    const r = finalizePlanSteps([
      step("一", "done"),
      step("二", "doing"),
      step("三", "pending"),
      step("四", "failed"),
      step("五", "terminated"),
    ]);
    expect(r.changed).toBe(true);
    expect(r.steps.map((s) => s.status)).toEqual(["done", "done", "done", "failed", "terminated"]);
  });

  it("全部已是终态时不产生变更（避免无意义的响应式更新）", () => {
    const r = finalizePlanSteps([step("一", "done"), step("二", "failed")]);
    expect(r.changed).toBe(false);
    expect(r.steps.map((s) => s.status)).toEqual(["done", "failed"]);
  });

  it("实际工具开始执行时自动把第一个 pending 标 doing", () => {
    const r = startNextPendingStep([
      step("一", "done"),
      step("二", "pending"),
      step("三", "pending"),
    ]);
    expect(r.changed).toBe(true);
    expect(r.index).toBe(1);
    expect(r.steps.map((s) => s.status)).toEqual(["done", "doing", "pending"]);
  });

  it("已有 doing 或没有 pending 时不再自动推进", () => {
    const doing = startNextPendingStep([step("一", "doing"), step("二", "pending")]);
    expect(doing.changed).toBe(false);
    const done = startNextPendingStep([step("一", "done")]);
    expect(done.changed).toBe(false);
    expect(done.index).toBe(-1);
  });

  it("进度计数与卡片展示一致", () => {
    expect(planProgress([step("一", "done"), step("二", "doing"), step("三", "done")])).toEqual({
      done: 2,
      total: 3,
    });
  });
});
