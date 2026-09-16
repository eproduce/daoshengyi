// 目标（吸收自 Codex 的 `ext/goal`：get_goal / create_goal / update_goal + token_budget）：
// Codex 把「当前目标」作为**跨回合**的一等状态——目标未完成前不跑题、预算耗尽时收尾。
// 我们按会话维度保存（一个会话一个目标），持久化到 localStorage（与设置同层，重启不丢）。
//
// 纯函数 + 极薄存储，便于单测与替换存储实现。

export type GoalStatus = "active" | "complete" | "blocked" | "abandoned";

export interface Goal {
  /** 达成标准式的目标描述（Codex 要求：由用户/系统显式提出，不从普通任务臆测） */
  objective: string;
  status: GoalStatus;
  /** token 预算（null = 不限额；Codex 亦仅在显式要求时设置） */
  tokenBudget: number | null;
  /** 已消耗 tokens（按轮累加） */
  tokensUsed: number;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = "daoshengyi_goals";

/** 读取全部会话的目标（坏数据一律忽略，绝不让存储问题打断主流程） */
export function loadGoals(): Record<string, Goal> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, Goal> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const g = v as Goal;
      if (g && typeof g.objective === "string" && typeof g.status === "string") out[k] = g;
    }
    return out;
  } catch {
    return {};
  }
}

export function getGoal(convId: string): Goal | null {
  return loadGoals()[convId] ?? null;
}

export function saveGoal(convId: string, goal: Goal): void {
  try {
    const all = loadGoals();
    all[convId] = goal;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* 存储不可用（隐私模式等）→ 目标仅在内存中生效，不影响对话 */
  }
}

export function clearGoal(convId: string): void {
  try {
    const all = loadGoals();
    delete all[convId];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* 忽略 */
  }
}

/** 未完成的目标（active / blocked）：Codex 的规则是「已有未完成目标时不能再 create_goal」 */
export function isUnfinished(goal: Goal | null): boolean {
  return !!goal && (goal.status === "active" || goal.status === "blocked");
}

/** 预算是否已超（无预算 = 永不超；纯函数） */
export function budgetExceeded(goal: Goal): boolean {
  return goal.tokenBudget !== null && goal.tokenBudget > 0 && goal.tokensUsed >= goal.tokenBudget;
}

/** 预算使用文案（纯函数）：无预算时只报已用量 */
export function budgetLine(goal: Goal): string {
  if (goal.tokenBudget === null || goal.tokenBudget <= 0) {
    return `已消耗约 ${goal.tokensUsed.toLocaleString()} tokens（未设预算）`;
  }
  const pct = Math.min(999, Math.round((goal.tokensUsed / goal.tokenBudget) * 100));
  const over = budgetExceeded(goal) ? "（⚠️ 已超出预算）" : "";
  return `已消耗约 ${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()} tokens（${pct}%）${over}`;
}

/** 累加用量并返回**新对象**（纯函数，不改原对象） */
export function addGoalUsage(goal: Goal, tokens: number): Goal {
  if (!Number.isFinite(tokens) || tokens <= 0) return goal;
  return { ...goal, tokensUsed: goal.tokensUsed + Math.round(tokens), updatedAt: Date.now() };
}

/** 目标提示语（注入上下文用，纯函数）：目标未完成前不该跑题，预算不足要先收尾 */
export function goalPrompt(goal: Goal): string {
  const state = goal.status === "blocked" ? "受阻" : "进行中";
  const tail = budgetExceeded(goal)
    ? "\n⚠️ 目标 token 预算已用尽：请**立即收尾**——给出当前阶段的结论与产物路径，剩余工作写进文件/待办，并说明未完成部分。"
    : "";
  return `【当前目标（${state}）】${goal.objective}\n${budgetLine(goal)}${goal.note ? `\n备注：${goal.note}` : ""}${tail}`;
}
