// 记忆 §3 补全（2.2 注入剪裁/来源标注 + 3.3 遗忘候选）：纯函数，可测试。

export interface MemoryFact {
  id: string;
  fact: string;
  fact_type: string;
  importance: number;
  last_accessed?: number | null;
  created_at: number;
}

const TYPE_LABEL: Record<string, string> = { preference: "偏好", info: "信息", decision: "决策", todo: "待办" };
export function factTypeLabel(t: string): string {
  return TYPE_LABEL[t] || t;
}

/** 相对时间（天/月/年），无时间戳显示「很久前」。 */
export function relTime(ts?: number | null): string {
  if (!ts) return "很久前";
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return "今天";
  if (days < 30) return `${days}天前`;
  if (days < 365) return `${Math.floor(days / 30)}月前`;
  return `${Math.floor(days / 365)}年前`;
}

/** 单条记忆的带来源标注行：事实（类型 · 重要度 · 时间）。 */
export function formatFactLine(f: MemoryFact): string {
  return `- ${f.fact}（${factTypeLabel(f.fact_type)} · 重要度 ${f.importance} · ${relTime(f.created_at)}）`;
}

/**
 * 2.2 注入剪裁：把记忆列表格式化成注入块，超长按相关度保留开头并明确提示截断，
 * 避免污染上下文（保持短、有来源标注）。
 */
export function formatMemoriesBlock(title: string, facts: MemoryFact[], maxChars = 1200): string {
  if (!facts.length) return "";
  let block = `## ${title}\n` + facts.map(formatFactLine).join("\n");
  if (block.length > maxChars) {
    block = block.slice(0, maxChars) + `\n…（记忆过多已按相关度截断：共 ${facts.length} 条，仅保留前 ${maxChars} 字符）`;
  }
  return block;
}

/**
 * 3.3 遗忘候选：重要度低（≤2）、非偏好、且 30 天以上未访问（或从未访问）的事实，
 * 提示可删除。偏好永久保护不进入候选。
 */
export function pickForgetCandidates(facts: MemoryFact[], now = Date.now()): MemoryFact[] {
  const cutoff = now - 30 * 86400000;
  return facts.filter(
    (f) =>
      f.fact_type !== "preference" &&
      f.importance <= 2 &&
      (f.last_accessed == null || f.last_accessed < cutoff)
  );
}
