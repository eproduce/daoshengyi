// 长期记忆 1.4 记忆分层：episodic（会话摘要）→ 跨会话主题汇总（纯函数，可测试）。
// semantic = memory_facts（具体事实）；episodic = memory_summaries（单会话摘要）；
// 这里再往上聚合一层 memory_episodic（跨会话反复出现的主题/项目/持续关注点）。

export interface EpisodicItem {
  title: string; // 主题名（≤12 字）
  summary: string; // 该主题跨会话的要点汇总
}

/** 构造跨会话汇总提示词：把会话摘要列表交给 LLM，提炼跨会话共同主题。 */
export function buildEpisodicPrompt(
  summaries: { summary: string; created_at?: number }[]
): string {
  const list = summaries.map((s, i) => `${i + 1}. ${s.summary}`).join("\n");
  return (
    "你是长期记忆库的分层整理员。下面是一批**单次会话摘要**（episodic 层）。\n" +
    "请找出**跨多个会话反复出现**的共同主题/项目/持续关注点（如长期进行的项目、反复讨论的话题、持续的目标或习惯），" +
    "把属于同一主题的内容归并成一条高层主题条目（episodic 聚合层）。\n" +
    "要求：\n" +
    "1. 只聚合**跨多个摘要**反复出现的主题；单次出现的孤立话题跳过；\n" +
    "2. 每个主题的 summary 汇总该主题在各会话中的要点（150 字以内），要具体、可追溯；\n" +
    "3. title 为主题名（12 字以内）；\n" +
    "4. 没有跨会话主题时返回空数组。\n\n" +
    `会话摘要列表：\n${list}\n\n` +
    '只返回 JSON 数组，每项：{"title":"主题名","summary":"跨会话要点汇总"}。不要输出其它内容。'
  );
}

/** 解析 LLM 返回的跨会话主题 JSON（宽松容错：剥离代码块、跳过非法项、截断长度）。 */
export function parseEpisodic(raw: string): EpisodicItem[] {
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const arr = JSON.parse(cleaned) as Array<{ title?: string; summary?: string }>;
    if (!Array.isArray(arr)) return [];
    const out: EpisodicItem[] = [];
    for (const it of arr) {
      const title = String(it.title ?? "").trim().slice(0, 12);
      const summary = String(it.summary ?? "").trim().slice(0, 600);
      if (!title || !summary) continue;
      out.push({ title, summary });
    }
    return out;
  } catch {
    return [];
  }
}
