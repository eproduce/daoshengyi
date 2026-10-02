// 断点续跑提示（2026-10-02）
//
// 背景：轮次预算耗尽 / 反复失败停滞时，收尾正文会追加「回复『继续』我会从断点接着做」。
// 但模型接到一个孤零零的「继续」时，很容易**从头重来**（重新规划、重新抓取、重新生成），
// 白白烧掉一轮预算。这里把「续跑」变成确定性指令：识别裸续跑意图 → 注入明确的续做清单。
//
// 只认**裸指令**（继续 / 接着做 / continue…），带新要求的消息（如「继续优化 X」）不算 ——
// 那是新任务，注入「别重来」反而会误导。

/** 裸续跑指令：整条消息就是一个“继续”的意思（可带标点/空白） */
const BARE_CONTINUE =
  /^(?:请)?\s*(?:继续|接着(?:做|干|来)?|往下(?:做|继续)?|go\s*on|continue|resume)[\s!！。,.，、~～]*$/i;

/** 用户这条消息是不是「从断点继续」的裸指令 */
export function isBareContinue(text: unknown): boolean {
  const s = text == null ? "" : String(text).trim();
  if (!s || s.length > 16) return false; // 过长一定带了新要求
  return BARE_CONTINUE.test(s);
}

export interface ResumeStep {
  text: string;
  /** 任务计划里的原始状态（doing/todo/done/failed…） */
  status?: string;
}

/**
 * 断点续跑指令。`steps` 传当前任务计划的步骤（可含已完成项）；
 * 未完成项会列成清单，模型据此从第一条接着做。
 */
export function resumePrompt(steps: ResumeStep[] = []): string {
  const pending = (steps ?? []).filter((s) => s && s.status !== "done");
  const head =
    "【断点续跑】用户只说了「继续」——请**从断点接着做，不要从头重来**（不要重新规划、不要重新采集已完成的数据、不要重新生成已存在的产物）。";
  if (!pending.length) {
    return (
      head +
      "\n当前没有未完成的任务计划步骤：请先核对已有产物/上文结论，直接补齐缺口；" +
      "若确实已经完成，请给出简洁结论并说明「已完成」，不要凭空新增工作。"
    );
  }
  const list = pending
    .slice(0, 12)
    .map((s, i) => `${i + 1}. ${String(s.text ?? "").slice(0, 160)}`)
    .join("\n");
  const doing = pending.some((s) => s.status === "doing");
  return (
    head +
    `\n未完成步骤（共 ${pending.length} 项${doing ? "，其中含正在进行的" : ""}）：\n${list}\n` +
    "请从第 1 条未完成项继续，并把每一步的真实结果用 plan_update 标掉。" +
    "\n若上一步卡在某个失败原因上（见上文最近一次报错），**先换方案或先解决前置条件**，" +
    "不要原样重发上一次的调用；如果确实无法继续，就直接说明卡在哪、需要用户提供什么。"
  );
}
