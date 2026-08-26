// P-A9 记忆复习：LLM 回顾记忆库，删除/合并过时、矛盾、重复的事实（纯函数，可测试）。

export interface ReviewAction {
  action: "delete" | "merge";
  id: string; // 要删除/合并掉的来源事实 id
  intoId?: string; // merge 时保留的目标 id
  reason?: string;
}

/** 构造记忆复习提示词：把事实列表（含 id）交给 LLM 找出过时/矛盾/重复项。 */
export function buildReviewPrompt(
  facts: { id: string; fact: string; fact_type: string; importance: number }[]
): string {
  const list = facts
    .map((f) => `- id=${f.id} | ${f.fact}（${f.fact_type}，重要度 ${f.importance}）`)
    .join("\n");
  return (
    "你是长期记忆库的整理员。下面是一批已保存的记忆事实。请找出：\n" +
    "1. **已过时/被推翻**的事实（删除）；\n" +
    "2. **互相矛盾**的事实（保留更可信/更新的那条，删除另一条）；\n" +
    "3. **内容重复**的事实（保留信息更全/重要度更高的那条，合并掉另一条）。\n" +
    "不要删除仍有价值或无法确定的事实；宁可少删、不要误删。\n\n" +
    `事实列表：\n${list}\n\n` +
    '只返回 JSON 数组，每项：{"action":"delete" 或 "merge", "id":"要删除的事实id", "into_id":"merge 时保留的目标id（可选）", "reason":"10字内理由"}。没有需要整理的返回 []。不要输出其它内容。'
  );
}

/** 解析 LLM 返回的复习动作 JSON（宽松容错：剥离代码块、跳过非法项）。 */
export function parseReviewActions(raw: string): ReviewAction[] {
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const arr = JSON.parse(cleaned) as Array<{
      action?: string; id?: string; from_id?: string; into_id?: string; reason?: string;
    }>;
    if (!Array.isArray(arr)) return [];
    const out: ReviewAction[] = [];
    for (const it of arr) {
      const action = it.action === "merge" ? "merge" : it.action === "delete" ? "delete" : null;
      const id = String(it.id ?? it.from_id ?? "").trim();
      if (!action || !id) continue;
      out.push({ action, id, intoId: it.into_id ? String(it.into_id).trim() : undefined, reason: it.reason });
    }
    return out;
  } catch {
    return [];
  }
}
