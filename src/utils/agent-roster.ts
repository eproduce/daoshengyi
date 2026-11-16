/**
 * Agent roster（花名册）的纯逻辑：状态机 + 名字校验 + 预算判定。
 *
 * ## 为什么要单独抽出来
 *
 * 「成员」最容易写坏的地方不是存表，而是**状态迁移**：允许了不该允许的迁移，
 * 就会出现「已经 cancelled 的成员又被派活」「重启后 interrupted 被当成 idle 自动跑起来」
 * 这类难查的问题。状态机是纯函数，能钉死；UI / 工具层只负责调用它。
 *
 * ## 状态语义（与 docs/AGENT_TEAM_DESIGN.md §3.2 一致）
 *
 * ```
 *   (none) ─spawn─▶ idle ─派活─▶ running ─完成─▶ idle
 *                                  │  └─失败─▶ failed ─派新活─▶ running
 *                                  ├─等待输入─▶ waiting ─收到消息─▶ running
 *                                  └─用户停止─▶ cancelled
 *   进程重启：running → interrupted（**不自动重跑**）
 * ```
 */

export const AGENT_STATUSES = [
  "idle",
  "running",
  "waiting",
  "done",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** 合法迁移表（from → 允许的 to）。不在这里的迁移一律拒绝。 */
const TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
  idle: ["running", "cancelled"],
  running: ["idle", "done", "failed", "waiting", "cancelled", "interrupted"],
  waiting: ["running", "cancelled", "interrupted"],
  done: ["running", "cancelled"],
  failed: ["running", "cancelled"],
  // 终态：只能重新派活（=重启一个已归档的成员，语义上等价于重新激活）
  cancelled: ["running"],
  // 重启遗留态：只能显式 resume（→ running）或归档
  interrupted: ["running", "cancelled"],
};

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** 终态（不会再自己变化） */
export function isTerminal(status: AgentStatus): boolean {
  return status === "cancelled";
}

/** 重启后一律把「当时在跑」的成员标成 interrupted —— 不自动重跑写了一半的任务 */
export function statusAfterRestart(status: AgentStatus): AgentStatus {
  return status === "running" || status === "waiting" ? "interrupted" : status;
}

export const MAX_NAME_CHARS = 24;
/** 保留名：主代理在信箱/归属里就用这几个字，成员不能占用 */
const RESERVED = new Set(["main", "system", "user", "owner", "主代理", "系统"]);

/**
 * 规范化并校验成员名。
 *
 * 为什么名字要限制：它是**寻址键**（同一会话内唯一）。带空格/斜杠/超长的名字会让
 * 「agent_status {name}` 这种调用难以稳定复现，也让 UI 里挤成一团。
 */
export function normalizeAgentName(
  raw: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const name = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, error: "成员名不能为空（建议用职责命名，如「调研员」）" };
  if (name.length > MAX_NAME_CHARS) {
    return { ok: false, error: `成员名最多 ${MAX_NAME_CHARS} 个字符（收到 ${name.length} 个）` };
  }
  if (RESERVED.has(name.toLowerCase())) {
    return { ok: false, error: `「${name}」是保留名，请换一个（如「${name}2」「助理」）` };
  }
  if (/[/\\:*?"<>|]/.test(name)) {
    return { ok: false, error: '成员名不能包含 / \\ : * ? " < > | 等字符' };
  }
  return { ok: true, name };
}

/** 同一会话内重名检查（大小写不敏感：`调研员` 与 `调研员 ` 已由 normalize 处理，这里再防大小写差异） */
export function isNameTaken(existing: readonly string[], candidate: string): boolean {
  const c = candidate.trim().toLowerCase();
  return existing.some((n) => n.trim().toLowerCase() === c);
}

/** 预算判定：返回 null = 未超；否则给可读原因 */
export function budgetExceeded(
  used: { tokens: number; cost?: number },
  limits: { maxTokens: number; maxCost?: number },
): string | null {
  if (limits.maxTokens > 0 && used.tokens >= limits.maxTokens) {
    return `该成员已用 ${used.tokens} tokens，达到上限 ${limits.maxTokens}；先让它收敛或换新成员`;
  }
  if (limits.maxCost && limits.maxCost > 0 && (used.cost ?? 0) >= limits.maxCost) {
    return `该成员已花 $${(used.cost ?? 0).toFixed(4)}，达到上限 $${limits.maxCost.toFixed(4)}`;
  }
  return null;
}

/** 给模型看的一行状态（列表用） */
export function describeAgent(a: {
  name: string;
  roleId?: string | null;
  status: AgentStatus | string;
  turns: number;
  tokens: number;
  brief?: string;
}): string {
  const role = a.roleId ? `（${a.roleId}）` : "";
  const budget = a.tokens >= 300_000 ? `｜⚠️ 已用 ${Math.round(a.tokens / 1000)}k tokens` : "";
  return `- ${a.name}${role} ｜ ${a.status} ｜ ${a.turns} 回合${budget}${a.brief ? ` ｜ ${a.brief}` : ""}`;
}
