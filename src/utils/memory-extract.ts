// 长期记忆 2.3 写入触发优化（纯函数，可测试）：
// 判断一段对话是否值得触发记忆提取。对话太短 / 内容太少（纯寒暄、过程性问答）时
// 跳过提取，避免每次对话都调 LLM 生成低价值事实、导致记忆库堆积。

export interface ExtractGateOptions {
  /** 最少消息条数（含 user/assistant），默认 6 */
  minMessages?: number;
  /** 最少有效正文字符数（去空白后），默认 120 */
  minChars?: number;
}

/** 对话是否值得提取记忆：达到消息条数与正文字符门槛才返回 true。 */
export function shouldExtractMessages(
  messages: { role: string; content: unknown }[],
  opts?: ExtractGateOptions,
): boolean {
  const minMessages = opts?.minMessages ?? 6;
  const minChars = opts?.minChars ?? 120;
  if (messages.length < minMessages) return false;
  // 只统计 user/assistant 的字符串正文长度（工具卡片/参数等非正文不参与）
  let chars = 0;
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (typeof m.content === "string") chars += m.content.replace(/\s/g, "").length;
  }
  return chars >= minChars;
}

/** 返回未达门槛的具体原因（用于诊断/提示）；达到门槛返回空串。 */
export function extractGateReason(
  messages: { role: string; content: unknown }[],
  opts?: ExtractGateOptions,
): string {
  const minMessages = opts?.minMessages ?? 6;
  const minChars = opts?.minChars ?? 120;
  if (messages.length < minMessages) {
    return `对话过短（${messages.length} 条 < ${minMessages} 条），跳过记忆提取`;
  }
  let chars = 0;
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (typeof m.content === "string") chars += m.content.replace(/\s/g, "").length;
  }
  if (chars < minChars) {
    return `对话内容过少（有效 ${chars} 字符 < ${minChars}），跳过记忆提取`;
  }
  return "";
}
