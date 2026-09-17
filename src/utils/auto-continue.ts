// P1-6 自动续跑规则表（吸收自 DSH 生态的「按失败类型路由」思路）。
//
// ## 问题
//
// 模型收尾时「不该收尾」的原因有**好几种**（验证凭据缺失、计划没做完、目标未达成、
// 工具全军覆没、正文空白），而每种该说什么、能不能再给一轮，诉求都不一样。
// 之前只有针对「验证凭据」的一次性纠偏，其余情况要么硬编码一句、要么完全不管。
//
// ## 做法
//
// 把「检测到哪类问题」与「怎么处置」拆开：
// - `detectStopReasons(signals)`：从本轮信号里**按优先级**列出问题类型（纯函数）
// - `CONTINUE_RULES`：规则表 —— 每种类型 → 处置（continue/stop）+ 最多触发几次 + 注入文本
// - `decideAutoContinue()`：加上**全局护栏**后给出决定
//
// ## 护栏（顺序即优先级，全部有单测）
//
// 1. 用户点了停止 → **永不自动续跑**（否则「停止」按钮形同虚设）
// 2. 预算被拦（P0-6）→ 不自动续跑（没钱了不能替用户烧）
// 3. 剩余轮数不足 → 不续（避免把轮数耗在纠偏上）
// 4. 本回合自动续跑总次数达上限（`MAX_AUTO_CONTINUES_PER_TURN`）→ 停
// 5. 同一规则触发次数达其 `maxAttempts`（默认 1）→ 换下一条规则，用完则停
//
// 设计原则：**宁可放过，不可死循环**。所有上限都是「同一轮内」的，下一轮重新计数。

import { isUnfinished, type Goal } from "./goals";

/** 收尾时检测到的问题类型 */
export type StopReason =
  | "all-tools-failed"
  | "verify-gap"
  | "plan-incomplete"
  | "goal-unfinished"
  | "empty-answer";

/** 本轮可用的信号（由 chat.ts 从实际状态拼装） */
export interface TurnSignals {
  /** 模型本次正文 */
  content: string;
  /** P0-5：验证凭据问题（null = 无问题） */
  verificationIssue?: { kind: string; status: string } | null;
  /** 任务计划（steps 状态数组）；无计划传 null */
  plan?: { steps: { status: string }[] } | null;
  /** 当前目标（未完成才算问题） */
  goal?: Goal | null;
  /** 本轮真实工作工具的成功/失败数 */
  toolSuccesses?: number;
  toolFailures?: number;
}

/** 注入纠偏文本时可用的上下文 */
export interface NudgeContext {
  /** 失败的工具名（all-tools-failed 用） */
  failedTools?: string[];
  /** 验证类别与状态（verify-gap 用） */
  verifyKind?: string;
  verifyStatus?: string;
  /** 未完成的步骤文案 */
  pendingSteps?: string[];
  /** 目标描述 */
  objective?: string;
}

export interface ContinueRule {
  id: StopReason;
  /** 本轮最多触发次数（同一轮内不重复同一句，避免原地打转） */
  maxAttempts: number;
  /** 该问题类型的人读说明（日志/文档用） */
  label: string;
  /** 注入给模型的纠偏文本（纯函数渲染） */
  nudge: (ctx: NudgeContext) => string;
}

/** 本回合自动续跑总次数上限（跨规则） */
export const MAX_AUTO_CONTINUES_PER_TURN = 3;

/** 规则表：顺序即「先处理哪类问题」的默认优先级 */
export const CONTINUE_RULES: ContinueRule[] = [
  {
    id: "all-tools-failed",
    maxAttempts: 1,
    label: "本轮工具全部失败（不能就此收尾）",
    nudge: (c) =>
      `⚠️ 本轮你调用的工具**全部失败**（${(c.failedTools ?? []).slice(0, 5).join(" / ") || "若干工具"}），` +
      "没有任何一步真正成功。**不能在这种情况下给出「已完成」的结论**。\n请二选一：\n" +
      "1) 换一条可行路径重试（读错误信息、核对路径/参数、换等价工具），真正跑通一步再收尾；\n" +
      "2) 如实说明阻塞：哪一步失败了、报错是什么、你判断的原因与建议用户怎么做。",
  },
  {
    id: "verify-gap",
    maxAttempts: 1,
    label: "声称验证通过但没有新鲜凭据",
    nudge: (c) =>
      `⚠️ 你的回复里声称「验证通过」（${c.verifyKind ?? "测试/类型检查/Lint/构建"}），` +
      "但本回合**没有**对应的新鲜凭据（要么没跑、要么跑完之后又改过文件）。\n" +
      "请二选一：\n1) 现在真的跑一次（例如 `npm test` / `npx vue-tsc --noEmit`）并把结果如实写进结论；\n" +
      "2) 删掉这些「已验证」的表述，明确说明「尚未运行验证」。",
  },
  {
    id: "plan-incomplete",
    maxAttempts: 1,
    label: "计划还有未完成步骤",
    nudge: (c) =>
      `⚠️ 你的任务计划里仍有未完成的步骤：${(c.pendingSteps ?? []).slice(0, 5).join("；") || "（见进度卡片）"}。\n` +
      "**不要留下半成品就收尾**：要么继续把它做完（并跑一次验证），要么明确说明为何停下、" +
      "剩余部分需要用户提供什么。",
  },
  {
    id: "goal-unfinished",
    maxAttempts: 1,
    label: "当前目标尚未达成",
    nudge: (c) =>
      `⚠️ 当前目标「${(c.objective ?? "").slice(0, 120)}」在系统里**仍标记为未完成**。\n` +
      "若目标确实已达成，请调用 update_goal 把它标为 complete 并给出证据；" +
      "若因缺信息/受阻无法继续，请把状态标为 blocked 并说明原因与所需输入。",
  },
  {
    id: "empty-answer",
    maxAttempts: 1,
    label: "正文为空（没有给用户任何结论）",
    nudge: () =>
      "⚠️ 你的上一轮**没有产出任何正文**（只有工具调用或空内容）。请给出面向用户的结论：" +
      "已经做了什么、结果是什么、产物路径/关键数据、还有什么没做完。",
  },
];

/// 规则表按 id 索引（便于按规则查上限）
export function ruleById(id: StopReason): ContinueRule | undefined {
  return CONTINUE_RULES.find((r) => r.id === id);
}

/**
 * 检测本轮「不该收尾」的原因（**按优先级排序**，返回全部命中项）。
 * 优先级：工具全失败 > 验证凭据 > 计划未完 > 目标未达成 > 正文为空。
 */
export function detectStopReasons(s: TurnSignals): StopReason[] {
  const out: StopReason[] = [];
  const successes = s.toolSuccesses ?? 0;
  const failures = s.toolFailures ?? 0;
  if (failures > 0 && successes === 0) out.push("all-tools-failed");
  if (s.verificationIssue) out.push("verify-gap");
  const steps = s.plan?.steps ?? null;
  if (steps && steps.some((st) => st.status === "pending" || st.status === "doing")) {
    out.push("plan-incomplete");
  }
  if (s.goal && isUnfinished(s.goal)) out.push("goal-unfinished");
  if (!s.content || !s.content.trim()) out.push("empty-answer");
  return out;
}

/** 从信号里抽出渲染 nudge 需要的上下文 */
export function nudgeContextFrom(
  s: TurnSignals,
  extra: { failedTools?: string[] } = {},
): NudgeContext {
  const steps = s.plan?.steps ?? [];
  return {
    failedTools: extra.failedTools,
    verifyKind: s.verificationIssue?.kind,
    verifyStatus: s.verificationIssue?.status,
    pendingSteps: steps
      .map((st, i) => (st.status === "done" ? null : `第 ${i + 1} 步`))
      .filter((x): x is string => !!x),
    objective: s.goal?.objective,
  };
}

export interface DecideInput {
  /** 命中问题（已按优先级排序；直接来自 detectStopReasons） */
  reasons: StopReason[];
  /** 本回合各规则已触发次数 */
  attempts?: Record<string, number>;
  /** 本回合已自动续跑总次数 */
  totalContinues?: number;
  /** 用户是否已请求停止 */
  stopped?: boolean;
  /** P0-6 预算是否已阻断 */
  budgetBlocked?: boolean;
  /** 剩余可用的工具轮数 */
  remainingRounds?: number;
  /** 渲染 nudge 用的上下文 */
  ctx?: NudgeContext;
}

export type Decision =
  | { action: "continue"; reason: StopReason; ruleId: string; nudge: string; attempt: number }
  | { action: "stop"; why: string };

/**
 * 决定是否自动续跑一轮。
 * 返回 `continue` 时，调用方应把 `nudge` 作为 user 消息注入并进入下一轮。
 */
export function decideAutoContinue(input: DecideInput): Decision {
  const reasons = input.reasons ?? [];
  if (!reasons.length) return { action: "stop", why: "本轮没有检测到需要纠偏的问题" };
  // 护栏 1：用户停止优先
  if (input.stopped) return { action: "stop", why: "用户已请求停止，不自动续跑" };
  // 护栏 2：预算被拦
  if (input.budgetBlocked) return { action: "stop", why: "预算已阻断，不自动续跑" };
  // 护栏 3：轮数不足
  if (typeof input.remainingRounds === "number" && input.remainingRounds <= 0) {
    return { action: "stop", why: "剩余轮数不足，不自动续跑" };
  }
  // 护栏 4：本回合总次数上限
  const total = input.totalContinues ?? 0;
  if (total >= MAX_AUTO_CONTINUES_PER_TURN) {
    return {
      action: "stop",
      why: `本回合自动续跑已达上限（${MAX_AUTO_CONTINUES_PER_TURN} 次）`,
    };
  }
  // 护栏 5：按优先级挑一条「还有次数」的规则
  const attempts = input.attempts ?? {};
  const skipped: string[] = [];
  for (const reason of reasons) {
    const rule = ruleById(reason);
    if (!rule) continue;
    const used = attempts[reason] ?? 0;
    if (used >= rule.maxAttempts) {
      skipped.push(`${rule.label}（已纠偏 ${used} 次）`);
      continue;
    }
    return {
      action: "continue",
      reason,
      ruleId: rule.id,
      nudge: rule.nudge(input.ctx ?? {}),
      attempt: used + 1,
    };
  }
  return {
    action: "stop",
    why: skipped.length ? `所有命中规则的纠偏次数都已用尽：${skipped.join("；")}` : "无可用的纠偏规则",
  };
}

/// 便捷入口：检测 + 决策（chat.ts 只需调用这一个）
export function planAutoContinue(
  s: TurnSignals,
  state: Omit<DecideInput, "reasons" | "ctx"> & { failedTools?: string[] },
): Decision & { reasons: StopReason[] } {
  const reasons = detectStopReasons(s);
  const decision = decideAutoContinue({
    ...state,
    reasons,
    ctx: nudgeContextFrom(s, { failedTools: state.failedTools }),
  });
  return { ...decision, reasons };
}
