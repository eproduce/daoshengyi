// S3 技能包渐进式披露路由（借鉴 Codex SKILL.md 渐进披露机制的道生一落地）：
// 主提示词只放「技能路由清单」（name + description + whenToUse，体积小、前缀稳定可缓存），
// 命中（matchSkillsForMessage）当前请求后才把该技能完整 prompt + references 注入本轮上下文。
// 纯函数、无 IO，便于单测；匹配启发式偏保守——宁可漏注入（路由清单仍可见）也不误注入无关技能。

import type { Skill } from "@/types";

export interface SkillRouteLike {
  name: string;
  description?: string;
  category?: string;
  whenToUse?: string;
  tags?: string[];
}

/** 中文低区分度停用词（出现频率高、无主题指向，不适合做命中词） */
const CN_STOP = new Set([
  "一位",
  "一个",
  "专家",
  "精通",
  "资深",
  "擅长",
  "提供",
  "给出",
  "帮助",
  "进行",
  "相关",
  "内容",
  "能力",
  "问题",
  "需要",
  "必须",
  "始终",
  "检查",
  "避免",
  "确保",
  "使用",
  "方法",
  "规范",
  "工作",
]);

/** 从中文文本提取 ≤maxLen 字的分隔短语（标点/空格已天然断句），去停用词 */
function cnPhrases(text: string | undefined, maxLen = 6): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const seg of text.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    if (seg.length <= maxLen && !CN_STOP.has(seg)) out.add(seg);
  }
  return [...out];
}

function enWords(text: string | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_-]{1,}/g)) out.add(m[0].toLowerCase());
  return [...out];
}

/**
 * 提取技能的路由关键词，分两档：
 * - strong：技能名（用户直呼技能名 = 强命中）；
 * - weak：tags + whenToUse 中文短语 + 英文词；无 tags 的自定义技能回退用 description 短语。
 */
export function skillKeywordsOf(s: SkillRouteLike): { strong: string[]; weak: string[] } {
  const strong: string[] = [];
  const weak: string[] = [];
  if (s.name) strong.push(s.name.toLowerCase());
  const tagText = (s.tags || []).filter(Boolean).join(" ");
  if (s.tags && s.tags.length > 0) {
    weak.push(...(s.tags.map((t) => t.trim().toLowerCase()).filter(Boolean) as string[]));
    weak.push(...enWords(tagText));
  }
  weak.push(...cnPhrases(s.whenToUse));
  weak.push(...enWords(s.whenToUse));
  if (!s.tags || s.tags.length === 0) {
    weak.push(...cnPhrases(s.description));
  }
  return { strong, weak };
}

/** 渐进披露路由清单：主提示词里每技能一行的轻量索引（不含 prompt 正文） */
export function buildSkillRoutingTable(skills: SkillRouteLike[]): string {
  if (!skills.length) return "";
  return skills
    .map((s) => {
      const scope =
        s.whenToUse ||
        (s.description || "").split(/[。;；]/)[0].trim();
      return `- ${s.name}${s.category ? `（${s.category}）` : ""}：${scope}`;
    })
    .join("\n");
}

/** 计算技能对某请求文本的命中分：name 直呼 +4；weak 词每中 +1 */
export function scoreSkillMatch(text: string, s: SkillRouteLike): number {
  const t = text.toLowerCase();
  if (!t.trim()) return 0;
  const { strong, weak } = skillKeywordsOf(s);
  let score = 0;
  for (const k of strong) if (k && t.includes(k)) score += 4;
  for (const k of weak) if (k && t.includes(k)) score += 1;
  return score;
}

/** 从启用技能里选出与当前请求最相关的前 maxHits 个（渐进披露正文注入目标） */
export function matchSkillsForMessage(
  text: string,
  skills: Skill[],
  maxHits = 2,
): Skill[] {
  const scored = skills
    .map((s) => ({ s, score: scoreSkillMatch(text, s) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, maxHits)).map((x) => x.s);
}
