import { it, expect, describe, beforeEach, beforeAll } from "vitest";
import {
  loadGoals,
  saveGoal,
  getGoal,
  clearGoal,
  isUnfinished,
  budgetExceeded,
  budgetLine,
  addGoalUsage,
  goalPrompt,
  type Goal,
} from "../src/utils/goals.ts";

function makeGoal(p: Partial<Goal> = {}): Goal {
  const now = Date.now();
  return {
    objective: "把 X 做完",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    createdAt: now,
    updatedAt: now,
    ...p,
  };
}

describe("goals（目标 + token 预算，吸收自 Codex ext/goal）", () => {
  // vitest 默认 node 环境没有 localStorage → 用最小内存实现（与真实 API 同形），
  // 这样 goals.ts 的读写分支都能被真实覆盖。
  class MemStorage {
    private m = new Map<string, string>();
    get length(): number {
      return this.m.size;
    }
    clear(): void {
      this.m.clear();
    }
    getItem(k: string): string | null {
      return this.m.has(k) ? this.m.get(k)! : null;
    }
    setItem(k: string, v: string): void {
      this.m.set(k, String(v));
    }
    removeItem(k: string): void {
      this.m.delete(k);
    }
    key(i: number): string | null {
      return [...this.m.keys()][i] ?? null;
    }
  }
  beforeAll(() => {
    (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
  });

  beforeEach(() => {
    localStorage.clear();
  });

  it("存取/删除：按会话维度持久化，坏数据忽略", () => {
    saveGoal("c1", makeGoal({ objective: "目标一" }));
    expect(getGoal("c1")?.objective).toBe("目标一");
    expect(getGoal("c2")).toBeNull();
    localStorage.setItem("daoshengyi_goals", "not-json");
    expect(loadGoals()).toEqual({});
    saveGoal("c3", makeGoal());
    clearGoal("c3");
    expect(getGoal("c3")).toBeNull();
  });

  it("isUnfinished：active/blocked 算未完成，complete/abandoned 不算", () => {
    expect(isUnfinished(makeGoal({ status: "active" }))).toBe(true);
    expect(isUnfinished(makeGoal({ status: "blocked" }))).toBe(true);
    expect(isUnfinished(makeGoal({ status: "complete" }))).toBe(false);
    expect(isUnfinished(makeGoal({ status: "abandoned" }))).toBe(false);
    expect(isUnfinished(null)).toBe(false);
  });

  it("预算判定与文案：无预算不超；有预算按百分比；超支有警示", () => {
    const noBudget = makeGoal({ tokenBudget: null, tokensUsed: 999_999 });
    expect(budgetExceeded(noBudget)).toBe(false);
    expect(budgetLine(noBudget)).toContain("未设预算");

    const half = makeGoal({ tokenBudget: 1000, tokensUsed: 500 });
    expect(budgetExceeded(half)).toBe(false);
    expect(budgetLine(half)).toContain("50%");

    const over = makeGoal({ tokenBudget: 1000, tokensUsed: 1200 });
    expect(budgetExceeded(over)).toBe(true);
    expect(budgetLine(over)).toContain("已超出预算");
  });

  it("addGoalUsage：纯函数累加（不改原对象），非法/非正数不动", () => {
    const g = makeGoal({ tokensUsed: 100 });
    const g2 = addGoalUsage(g, 250);
    expect(g2.tokensUsed).toBe(350);
    expect(g.tokensUsed).toBe(100); // 原对象未被改
    expect(addGoalUsage(g, 0).tokensUsed).toBe(100);
    expect(addGoalUsage(g, -5).tokensUsed).toBe(100);
    expect(addGoalUsage(g, Number.NaN).tokensUsed).toBe(100);
  });

  it("goalPrompt：注入文案含目标与预算；超预算时要求立即收尾", () => {
    const active = goalPrompt(
      makeGoal({ objective: "生成季度报告", tokenBudget: 1000, tokensUsed: 100 }),
    );
    expect(active).toContain("生成季度报告");
    expect(active).toContain("进行中");

    const over = goalPrompt(
      makeGoal({ objective: "生成季度报告", tokenBudget: 1000, tokensUsed: 1500 }),
    );
    expect(over).toContain("立即收尾");

    const blocked = goalPrompt(makeGoal({ status: "blocked", note: "缺 API Key" }));
    expect(blocked).toContain("受阻");
    expect(blocked).toContain("缺 API Key");
  });
});
