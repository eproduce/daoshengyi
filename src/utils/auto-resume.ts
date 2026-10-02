// 任务模式自主续跑（P1-10，2026-10-02）
//
// 用户反馈：「任务模式下应该自主执行完成任务，而不是每次都做一半，留着我让它继续」。
//
// 此前：单回合工具轮次预算（MAX_TOOL_ROUNDS=48）用尽 / 停滞中止后，只做到「如实告知 + 等用户
// 敲继续」。现在改为：**自动开下一轮接着做**，直到任务完成或触发护栏。
//
// 护栏（纯函数判定，逐条可测）：
//   用户停止 / 用户终止了计划 / 队列里有用户新消息 / 本轮异常中断 / 用量预算已阻断 /
//   计划已无未完成步骤 / 自动续跑次数用尽 / 同一失败原因再次出现（停滞） / 本轮没有实质进展。
// 最后两条是关键：没有它们，自动续跑会变成「自动烧钱」。

/** 单次任务最多自动续跑几轮（每轮各自享有完整的工具轮次预算） */
export const AUTO_RESUME_MAX = 5;

/** 自动续跑写入对话的用户消息文案（明确标注是系统自动发起，用户可随时点停止） */
export const AUTO_RESUME_TEXT = "🔁 自动续跑：从断点继续完成剩余步骤";

export interface AutoResumeSignals {
  /** 用户点了「停止」 */
  stoppedByUser: boolean;
  /** 任务计划已被用户终止（含 doing 被标 terminated） */
  planTerminated: boolean;
  /** 还有用户排队消息没处理（用户的事优先） */
  hasQueuedUserMessage: boolean;
  /** 本轮以异常中断 */
  errorAborted: boolean;
  /** 用量预算已到阻断档 */
  budgetBlocked: boolean;
  /** 任务计划里未完成的步骤数 */
  pendingSteps: number;
  /**
   * 本轮确实在推进这个计划（调过 plan_task/plan_update）**或**本轮是被系统中断的。
   * 两个作用：① 排除「旧计划 + 另开一个会话」的误续跑；② 让「模型根本不碰计划」时不自动跑。
   */
  planTouchedThisTurn: boolean;
  /** 已经自动续跑了几次（本次判定之前） */
  autoAttempts: number;
  maxAttempts: number;
  /** 本轮再次出现同一失败原因（判定为停滞） */
  repeatedFailure: boolean;
  /** 本轮有实质进展（成功执行过实际工作工具，或新完成了计划步骤） */
  madeProgress: boolean;
}

export interface AutoResumeVerdict {
  resume: boolean;
  /** 不续跑时的原因（写日志）/ 续跑时的摘要 */
  why: string;
  /** 续跑时追加到助手正文的可见说明 */
  note: string;
}

export function planAutoResume(s: AutoResumeSignals): AutoResumeVerdict {
  const mk = (resume: boolean, why: string, note = ""): AutoResumeVerdict => ({
    resume,
    why,
    note,
  });
  const nth = s.autoAttempts + 1;

  if (s.stoppedByUser) return mk(false, "用户已点击停止");
  if (s.planTerminated) return mk(false, "任务计划已被用户终止");
  if (s.hasQueuedUserMessage) return mk(false, "队列里有用户的新消息，优先处理");
  if (s.errorAborted) return mk(false, "本轮以异常中断（避免反复撞同一个错）");
  if (s.budgetBlocked) return mk(false, "用量预算已阻断（护栏优先）");
  if (s.pendingSteps <= 0) return mk(false, "任务计划已无未完成步骤");
  if (!s.planTouchedThisTurn) return mk(false, "本轮没有推进这个任务计划（避免拿旧计划误续跑）");
  if (s.autoAttempts >= s.maxAttempts)
    return mk(false, `已达自动续跑上限（${s.maxAttempts} 次），请确认后手动继续`);
  if (s.repeatedFailure) return mk(false, "再次出现同一失败原因（停滞，交给用户决定）");
  if (!s.madeProgress) return mk(false, "本轮没有实质进展（再跑只会空转）");

  return mk(
    true,
    `任务还有 ${s.pendingSteps} 步未完成`,
    `🔁 **自动继续**（第 ${nth}/${s.maxAttempts} 次）：任务计划还有 ${s.pendingSteps} 步未完成，` +
      `正在从断点接着做，不需要你回复「继续」。若不想让它继续，点「停止」即可。`,
  );
}

/**
 * 停滞后的特殊续跑判定：同一失败原因反复出现时，先**自动换方案再试一次**，
 * 第二次仍停滞才交回用户。单独的 `repeatedFailure` 会一律拦住，这里给它一次机会。
 */
export function allowResumeAfterStall(autoAttempts: number): boolean {
  return autoAttempts === 0;
}
