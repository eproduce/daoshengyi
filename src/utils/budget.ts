// P0-6 预算护栏（Budget Guard）
// 吸收自 DSH 生态：dsh-budget / dsh-save-money / dsh-rate-limiter。
//
// 动机：`UsageStats` 只能「看」不能「拦」——长任务可能一次烧掉整周额度，用户只能事后发现。
// 这里补上三档预算（本次会话 / 今日 / 本月）+ 80% 预警 + 100% 阻断。
//
// 设计约束：
// - **纯函数、零依赖**，全部可单测（不做 IO、不读 store）
// - 单位 = 人民币元，与 `utils/tokens.ts` 的 `estimateCost` 口径一致
// - `limit <= 0` = 不限：既不参与判定、也不出现在结果里 → 满足「无预算不打扰」
// - 阈值用 `>=`：恰好 80% 即预警、恰好 100% 即阻断，避免浮点边界歧义

export type BudgetScope = "session" | "daily" | "monthly";
export type BudgetLevel = "ok" | "warn" | "blocked";

export interface BudgetLimits {
  /** 本次会话预算（元）；<=0 或缺失 = 不限 */
  session: number;
  /** 今日预算（元，本地时区，00:00 重置） */
  daily: number;
  /** 本月预算（元，本地时区，1 号 00:00 重置） */
  monthly: number;
}

export interface BudgetSpend {
  session: number;
  daily: number;
  monthly: number;
}

export interface BudgetItem {
  scope: BudgetScope;
  label: string;
  spent: number;
  limit: number;
  /** spent / limit，可能 > 1（超支时保留真实比例，便于 UI 显示） */
  ratio: number;
  level: BudgetLevel;
  /** 预警/阻断文案；level=ok 时为空串 */
  message: string;
}

export interface BudgetVerdict {
  level: BudgetLevel;
  /** 只包含**已设置预算**的档位（不限的档位不会出现，避免干扰） */
  items: BudgetItem[];
  /** 最紧张的一档（已经历档位**优先**，其次按比例）；无预算配置时为 null */
  worst: BudgetItem | null;
  /** 可直接展示的提示文案；level=ok 时为空串 */
  notice: string;
}

/** 预警阈值：达到限额的 80% 提醒 */
export const BUDGET_WARN_RATIO = 0.8;

/** 判定顺序即展示顺序：会话 → 今日 → 本月 */
export const BUDGET_SCOPES: BudgetScope[] = ["session", "daily", "monthly"];

export const SCOPE_LABEL: Record<BudgetScope, string> = {
  session: "本次会话",
  daily: "今日",
  monthly: "本月",
};

/// 限额：非正数 / NaN / 非数字 → 0（不限）
function asLimit(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/// 花费：负数 / NaN → 0（花掉的钱只可能 >= 0）
function asSpend(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/// 归一化限额：把 null / undefined / 负数 / NaN 一律收敛成「不限(0)」
export function normalizeLimits(
  raw?: Partial<Record<BudgetScope, number>> | null,
): BudgetLimits {
  return {
    session: asLimit(raw?.session),
    daily: asLimit(raw?.daily),
    monthly: asLimit(raw?.monthly),
  };
}

/// 归一化花费
export function normalizeSpend(
  raw?: Partial<Record<BudgetScope, number>> | null,
): BudgetSpend {
  return {
    session: asSpend(raw?.session),
    daily: asSpend(raw?.daily),
    monthly: asSpend(raw?.monthly),
  };
}

/// 单档判定
export function levelOf(
  spent: number,
  limit: number,
  warnRatio: number = BUDGET_WARN_RATIO,
): BudgetLevel {
  if (!(limit > 0)) return "ok"; // 不限 → 永远 ok
  const ratio = asSpend(spent) / limit;
  if (ratio >= 1) return "blocked";
  if (ratio >= warnRatio) return "warn";
  return "ok";
}

/// 金额展示：预算一律两位小数（不用科学计数法，钱要看得懂）
export function formatBudget(n: number): string {
  const v = asSpend(n);
  return `¥${v.toFixed(2)}`;
}

/// 核心判定：给花费与限额，返回档位判定 + 最紧张的一档 + 提示文案
export function evaluateBudget(
  spendRaw?: Partial<Record<BudgetScope, number>> | null,
  limitsRaw?: Partial<Record<BudgetScope, number>> | null,
  opts?: { warnRatio?: number },
): BudgetVerdict {
  const spend = normalizeSpend(spendRaw);
  const limits = normalizeLimits(limitsRaw);
  const warnRatio =
    opts?.warnRatio != null && opts.warnRatio > 0 && opts.warnRatio < 1
      ? opts.warnRatio
      : BUDGET_WARN_RATIO;

  const items: BudgetItem[] = [];
  for (const scope of BUDGET_SCOPES) {
    const limit = limits[scope];
    if (limit <= 0) continue; // 未设预算 → 完全不出现在结果里（不打扰）
    const spent = spend[scope];
    const ratio = spent / limit;
    const level = levelOf(spent, limit, warnRatio);
    const label = SCOPE_LABEL[scope];
    const pct = Math.round(ratio * 100);
    let message = "";
    if (level === "blocked") {
      message = `⛔ ${label}预算已用尽（${formatBudget(spent)} / ${formatBudget(limit)}，${pct}%）`;
    } else if (level === "warn") {
      message = `⚠️ ${label}预算已用 ${pct}%（${formatBudget(spent)} / ${formatBudget(limit)}）`;
    }
    items.push({ scope, label, spent, limit, ratio, level, message });
  }

  const rank: Record<BudgetLevel, number> = { ok: 0, warn: 1, blocked: 2 };
  let worst: BudgetItem | null = null;
  for (const it of items) {
    if (
      !worst ||
      rank[it.level] > rank[worst.level] ||
      (rank[it.level] === rank[worst.level] && it.ratio > worst.ratio)
    ) {
      worst = it;
    }
  }

  const level: BudgetLevel = items.some((i) => i.level === "blocked")
    ? "blocked"
    : items.some((i) => i.level === "warn")
      ? "warn"
      : "ok";

  const lines = items.filter((i) => i.level !== "ok").map((i) => i.message);
  if (level === "blocked") {
    lines.push(
      "继续对话会超支：可调高「用量统计 → 预算上限」，或切换到更便宜的模型后再继续。",
    );
  }
  return { level, items, worst, notice: lines.join("\n") };
}

// --- 时间窗口（跨日 / 跨月重置） ---

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/// 本地时区日期键 `YYYY-MM-DD`（**必须用本地时区**：用户感知的「今天」不是 UTC 今天）
export function dayKey(ts: number | Date = Date.now()): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/// 本地时区月份键 `YYYY-MM`
export function monthKey(ts: number | Date = Date.now()): string {
  return dayKey(ts).slice(0, 7);
}

/// 把后端可能返回的 `2026-9-7` / `2026-09-07T12:00:00Z` 统一成 `YYYY-MM-DD`
export function normalizeDayKey(raw: unknown): string {
  const s = String(raw ?? "");
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (!m) return "";
  return `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`;
}

/// 从「按天累计」的行里取今日 / 本月花费：跨日、跨月的旧行**自动不计入**（即自动重置）
export function spendFromDaily(
  daily: { date?: string; cost?: number }[] | null | undefined,
  now: number | Date = Date.now(),
): { daily: number; monthly: number } {
  const dk = dayKey(now);
  const mk = monthKey(now);
  let daySum = 0;
  let monthSum = 0;
  for (const row of daily ?? []) {
    const key = normalizeDayKey(row?.date);
    if (!key) continue;
    const cost = asSpend(row?.cost);
    if (key === dk) daySum += cost;
    if (key.slice(0, 7) === mk) monthSum += cost;
  }
  return { daily: daySum, monthly: monthSum };
}

/// 组装三档花费：会话档 = 当前对话累计，日/月档 = 后端按天累计表
export function buildSpend(input: {
  sessionCost?: number;
  daily?: { date?: string; cost?: number }[] | null;
  now?: number | Date;
}): BudgetSpend {
  const now = input.now ?? Date.now();
  const { daily, monthly } = spendFromDaily(input.daily, now);
  return { session: asSpend(input.sessionCost), daily, monthly };
}

/// 预警去重键：同一档位 + 同一等级 + 同一天 只提醒一次（否则每轮都弹 = 变成噪音）；
/// 返回 null 表示无需提醒
export function budgetNoticeKey(
  verdict: BudgetVerdict,
  now: number | Date = Date.now(),
): string | null {
  if (verdict.level === "ok" || !verdict.worst) return null;
  return `${verdict.worst.scope}:${verdict.worst.level}:${dayKey(now)}`;
}
