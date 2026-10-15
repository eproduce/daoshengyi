// 音色列表的**分组与判定**（纯函数，便于单测）。
//
// 背景（真机反馈，2026-10-16）：用户说「除了 Tingting 这个音色，其他系统默认音色好像有点奇怪」。
// 实测原因：`say -v ?` 的中文组里 **19 个有 16 个是 Apple 的多语言趣味变体**
// （`Eddy (中文（中国大陆）)` / `Flo` / `Grandma` / `Rocko`…），真正的真人中文音色只有
// `Tingting`（zh_CN）/ `Meijia`（zh_TW）/ `Sinji`（zh_HK）三个。
// 而当时的排序是「中文优先 + 名字字典序」→ **`Eddy (中文（中国大陆）)` 排在第一位**，
// 用户点开设置第一个试听的就是最怪的那个。
//
// 教训：**列表排序也是产品决策**。变体音色必须自成一组、排在最后，并且说清为什么。

export interface SayVoice {
  name: string;
  locale: string;
  /** 后端（Rust）判定的「变体/趣味音色」标记 */
  variant?: boolean;
  example?: string;
}

export interface VoiceGroup {
  id: "zh-main" | "zh-other" | "other" | "variant";
  label: string;
  hint?: string;
  voices: SayVoice[];
}

/**
 * 是不是 Apple 的多语言变体/趣味音色。
 *
 * 后端已经给了 `variant`，这里再兜一层「名字带括号」—— 两侧任一更新都不会漏。
 * 名字带括号是可靠特征：变体音色在 `say -v ?` 里的形态就是 `Name (语言（地区）)`。
 */
export function isVariantVoice(voice: SayVoice): boolean {
  return voice.variant === true || voice.name.includes("(");
}

/** 中文普通话且不是变体 —— 这就是"能日常用"的那几个 */
export function isMainChineseVoice(voice: SayVoice): boolean {
  return !isVariantVoice(voice) && voice.locale === "zh_CN";
}

/**
 * 分组（顺序固定，空组不出现；**组内保持传入顺序** —— 排序是 Rust 侧的职责，避免两边各排一套）。
 */
export function groupVoices(voices: SayVoice[]): VoiceGroup[] {
  const zhMain: SayVoice[] = [];
  const zhOther: SayVoice[] = [];
  const other: SayVoice[] = [];
  const variant: SayVoice[] = [];
  for (const v of voices) {
    if (isVariantVoice(v)) variant.push(v);
    else if (isMainChineseVoice(v)) zhMain.push(v);
    else if (v.locale.startsWith("zh")) zhOther.push(v);
    else other.push(v);
  }
  const groups: VoiceGroup[] = [
    {
      id: "zh-main",
      label: "中文 · 普通话（推荐）",
      hint: "系统里能日常用的中文真人音色通常只有这几个",
      voices: zhMain,
    },
    {
      id: "zh-other",
      label: "中文 · 粤语 / 台湾",
      hint: "发音按当地习惯，念普通话会带口音",
      voices: zhOther,
    },
    { id: "other", label: "其它语言", voices: other },
    {
      id: "variant",
      label: "变体 / 趣味音色（不建议）",
      hint:
        "Apple 的多语言趣味音色（Eddy / Flo / Grandma / Rocko…）：念中文是明显的机器怪声。" +
        "想要更自然的音色，可在「系统设置 → 辅助功能 → 朗读内容 → 系统声音」里下载，然后点「重新扫描音色」",
      voices: variant,
    },
  ];
  return groups.filter((g) => g.voices.length > 0);
}

/** 当前选中的音色是不是变体（用于给一句"这个会怪"的提醒） */
export function describeSelection(voices: SayVoice[], name: string): string {
  if (!name) return "系统默认";
  const hit = voices.find((v) => v.name === name);
  if (!hit) return name;
  if (isVariantVoice(hit)) return `${hit.name}（变体音色，念中文会怪）`;
  return hit.locale ? `${hit.name}（${hit.locale}）` : hit.name;
}
