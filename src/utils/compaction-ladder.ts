// P1-5 压缩阶梯（吸收自 `savageops/dsh-rich-indexing` 的 30/50/70/90 分档思路）。
//
// ## 为什么要分档
//
// 现在只有一个阈值：占用 ≥ 82% 就做一次**有损**的摘要压缩。问题有两个：
// ① 压缩前的整段区间里其实有大量**零成本、无损**的事可以做（写索引、抽关键事实）；
// ② 压缩是「一次性把所有老消息换成一段 LLM 摘要」——摘要会丢细节，且丢的是**路径/命令**这类
//    最要命的细节（模型最爱在摘要里把 `/Users/x/op/tooltip.ts` 写成「某个文件」）。
//
// ## 做法
//
// 分档、单调、越早的档越便宜：
//
// | 档位 | 触发（占窗口） | 动作 | 代价 |
// | --- | --- | --- | --- |
// | `note` | 30% | 记一条日志（可观测「本会话已进入长对话」） | 0 |
// | `index` | 50% | **预生成**确定性关键词索引（在内存里备好，不占上下文） | 0 |
// | `trim` | 70% | **预抽取**关键事实（绝对路径 / 命令，去重限量） | 0 |
// | `hard` | 82% | 交接摘要压缩；**并把上面两份确定性产物拼进摘要** | 有损 |
//
// 关键点：`index` / `trim` 两档**不往上下文里塞任何东西**，只在内存里把「确定性索引」准备好；
// 真到压缩时再一起写进摘要。于是摘要 = 模型摘要（语义）+ 确定性索引（字面事实），
// 既省 token 又不丢路径/命令。
//
// 阈值说明：计划里写的是 30/50/70/**90**，这里实装 30/50/70/**82**——82% 是既有实测阈值
// （`AUTO_COMPACT_RATIO`），把硬压缩推迟到 90% 会让长会话撞上窗口上限的风险变大。
// 阶梯的价值本来就是「让 82% 时压力更小」，所以保留 82% 更稳（改动最小、风险最低）。

/** 阶梯档位 */
export type StageId = "note" | "index" | "trim" | "hard";

export interface Stage {
  id: StageId;
  /** 触发阈值（占上下文窗口的比例） */
  at: number;
  label: string;
  /** true = 会产生损失（写 checkpoint 覆盖老消息） */
  lossy: boolean;
}

/** 阶梯定义（阈值升序） */
export const LADDER: Stage[] = [
  { id: "note", at: 0.3, label: "记录长会话占用（无损）", lossy: false },
  { id: "index", at: 0.5, label: "预生成关键词索引（无损，不占上下文）", lossy: false },
  { id: "trim", at: 0.7, label: "预抽取关键事实：路径/命令（无损，不占上下文）", lossy: false },
  { id: "hard", at: 0.82, label: "交接摘要压缩（有损，写 checkpoint）", lossy: true },
];

/** 硬压缩阈值（与既有 AUTO_COMPACT_RATIO 保持一致） */
export const HARD_RATIO = 0.82;

/** 关键词索引最多保留的词条数 */
export const MAX_INDEX_TERMS = 24;
/** 索引文本长度上限（写进摘要，必须克制） */
export const MAX_INDEX_CHARS = 1200;
/** 关键事实（路径/命令）各自最多保留条数 */
export const MAX_FACTS = 12;
/** 关键事实文本长度上限 */
export const MAX_FACTS_CHARS = 1500;

/** 索引段落标记：用于幂等合并（重复压缩时不会叠第二份） */
export const INDEX_MARKER = "## 关键词索引（确定性生成 · 非模型摘要）";
export const FACTS_MARKER = "## 关键事实（确定性抽取 · 原样保留）";

/**
 * 依据占用比例与**已应用**的档位，算出本次应执行的档位（升序、单调）。
 * - 未达 30% → 空数组
 * - 一次从 29% 跳到 85% → 返回 [note, index, trim, hard]（按顺序执行）
 * - 已应用过的档位不会重复返回（`hard` 例外：它每轮都可能再触发，由冷却时间控制）
 */
export function pendingStages(ratio: number, applied: StageId[] = []): Stage[] {
  if (!Number.isFinite(ratio) || ratio < 0) return [];
  const done = new Set(applied);
  return LADDER.filter((s) => ratio >= s.at && !done.has(s.id));
}

/// 当前占用比例对应的档位（仅用于展示/日志；未达 30% 返回 null）
export function currentStage(ratio: number): Stage | null {
  let cur: Stage | null = null;
  for (const s of LADDER) if (ratio >= s.at) cur = s;
  return cur;
}

// --- 关键词索引（确定性） ---

export interface IndexEntry {
  term: string;
  count: number;
  /** 首次出现的消息序号（1 起算） */
  firstAt: number;
}

/** 英文停用词（只挡自然语言噪声；代码标识符一律保留——对开发型 agent 它们才是关键词） */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "you",
  "your",
  "are",
  "was",
  "were",
  "will",
  "would",
  "can",
  "could",
  "should",
  "have",
  "has",
  "had",
  "not",
  "but",
  "from",
  "into",
  "then",
  "than",
  "there",
  "here",
  "what",
  "when",
  "which",
  "while",
  "about",
  "also",
  "just",
  "only",
  "some",
  "such",
  "more",
  "most",
  "other",
  "very",
  "been",
  "being",
  "does",
  "did",
  "doing",
  "use",
  "using",
  "used",
  "get",
  "got",
  "make",
  "made",
  "new",
  "now",
  "see",
  "let",
  "may",
  "its",
  "it's",
  "all",
  "any",
  "each",
  "how",
  "who",
  "why",
  "yes",
  "ok",
  "okay",
  "done",
  "true",
  "false",
  "null",
]);

/// 中文停用/虚词（两字组合里出现这些的 bigram 直接丢弃，避免「的是」「可以」霸榜）
const CJK_STOP_BI = new Set([
  "的是",
  "可以",
  "我们",
  "你们",
  "他们",
  "这个",
  "那个",
  "已经",
  "因为",
  "所以",
  "如果",
  "但是",
  "而且",
  "然后",
  "还是",
  "就是",
  "一个",
  "一些",
  "什么",
  "怎么",
  "为什",
  "没有",
  "不会",
  "不能",
  "可能",
  "需要",
  "应该",
  "现在",
  "目前",
  "这次",
  "所以",
]);

/**
 * 抽取词条（确定性：同样的输入永远得到同样的排序）。
 * 规则：英文/数字标识符（≥3 字符，排除停用词）+ 中文 2-gram（排除虚词组合）。
 * 排序：出现次数降序 → 首次出现位置升序 → 字典序（保证结果稳定可测）。
 */
export function extractTerms(
  items: { role?: string; content?: string }[],
  max = MAX_INDEX_TERMS,
): IndexEntry[] {
  const hits = new Map<string, { count: number; firstAt: number }>();
  const bump = (term: string, at: number) => {
    const cur = hits.get(term);
    if (cur) cur.count++;
    else hits.set(term, { count: 1, firstAt: at });
  };
  items.forEach((item, i) => {
    const at = i + 1;
    const text = item?.content ?? "";
    const latin = text.match(/[A-Za-z][A-Za-z0-9_]{2,}/g) ?? [];
    for (const w of latin) {
      const lw = w.toLowerCase();
      if (STOPWORDS.has(lw)) continue;
      bump(lw, at);
    }
    const cjkRuns = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
    for (const run of cjkRuns) {
      for (let k = 0; k + 2 <= run.length; k++) {
        const bi = run.slice(k, k + 2);
        if (CJK_STOP_BI.has(bi)) continue;
        bump(bi, at);
      }
    }
  });
  return [...hits.entries()]
    .map(([term, v]) => ({ term, count: v.count, firstAt: v.firstAt }))
    .filter((e) => e.count > 1) // 只保留「重复出现」的词，单次出现噪声太大
    .sort((a, b) => b.count - a.count || a.firstAt - b.firstAt || a.term.localeCompare(b.term))
    .slice(0, max);
}

/// 渲染索引段（单行紧凑格式，控制在 MAX_INDEX_CHARS 内）
export function renderKeywordIndex(entries: IndexEntry[], maxChars = MAX_INDEX_CHARS): string {
  if (!entries.length) return "";
  const parts: string[] = [];
  let len = 0;
  for (const e of entries) {
    const piece = `${e.term}×${e.count}(#${e.firstAt})`;
    if (len + piece.length + 3 > maxChars) break;
    parts.push(piece);
    len += piece.length + 3;
  }
  if (!parts.length) return "";
  return `${INDEX_MARKER}\n以下为确定性抽取的高频词（含首次出现位置 #序号），用于在老消息被摘要覆盖后仍能定位：\n${parts.join(" · ")}`;
}

// --- 关键事实（确定性） ---

export interface KeyFacts {
  paths: string[];
  commands: string[];
}

/**
 * 形如 `/abs/path/file.ts` 或 `~/path/file.ts` 的路径。
 * 注意：`~` 必须与后续路径写在**同一个分支**里——早期写成 `(?:~|\/)` 时，
 * 引擎在 `~` 处匹配失败后会从后面的 `/` 重新开始，把 `~/notes/x.md` 误抽成 `/notes/x.md`。
 */
const PATH_RE = /~\/[\w.@+-]+(?:\/[\w.@+-]+)*|\/[\w.@+-]+(?:\/[\w.@+-]+)+/g;
/** 反引号或 `$ ` 开头的命令 */
const CMD_RE = /(?:^|\n)\s*\$\s+([^\n]{2,120})|`([^`\n]{2,120})`/g;

/// 判断是否像 URL（避免把 https://x/y/z 的 path 部分抽成「路径事实」）
function looksLikeUrlContext(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 8), index);
  return /(?:https?:|wss?:|git@)/.test(before);
}

/**
 * 抽取确定性关键事实：绝对路径 + 命令（去重、保序、限量）。
 * 压缩摘要最容易丢的就是这两类字面信息，所以单独抽出来原样保留。
 */
export function extractKeyFacts(items: { role?: string; content?: string }[]): KeyFacts {
  const paths: string[] = [];
  const commands: string[] = [];
  const seenPaths = new Set<string>();
  const seenCmds = new Set<string>();
  const pushPath = (p: string) => {
    const v = p.replace(/[.,;:)\]]+$/, "");
    if (v.length < 3 || seenPaths.has(v)) return;
    if (/^\/\//.test(v) || /^\/(?:tmp|dev|proc|sys|private)\b/.test(v) === false && v === "/") return;
    seenPaths.add(v);
    paths.push(v);
  };
  const pushCmd = (c: string) => {
    const v = c.trim();
    if (v.length < 2 || seenCmds.has(v)) return;
    seenCmds.add(v);
    commands.push(v);
  };
  for (const item of items) {
    const text = item?.content ?? "";
    for (const m of text.matchAll(PATH_RE)) {
      const at = m.index ?? 0;
      if (looksLikeUrlContext(text, at)) continue;
      const raw = m[0];
      // 至少含一个目录分隔（单段 `/foo` 太像普通词）
      if (!raw.includes("/", raw.startsWith("~") ? 2 : 1)) continue;
      pushPath(raw);
    }
    for (const m of text.matchAll(CMD_RE)) {
      const cmd = m[1] ?? m[2] ?? "";
      if (!cmd.trim()) continue;
      pushCmd(cmd);
      if (commands.length >= MAX_FACTS) break;
    }
    if (paths.length >= MAX_FACTS && commands.length >= MAX_FACTS) break;
  }
  return {
    paths: paths.slice(0, MAX_FACTS),
    commands: commands.slice(0, MAX_FACTS),
  };
}

/// 渲染关键事实段
export function renderKeyFacts(facts: KeyFacts, maxChars = MAX_FACTS_CHARS): string {
  const lines: string[] = [];
  if (facts.paths.length) lines.push(`路径：${facts.paths.slice(0, MAX_FACTS).join(" · ")}`);
  if (facts.commands.length) {
    lines.push(`命令：${facts.commands.slice(0, MAX_FACTS).map((c) => `\`${c}\``).join(" · ")}`);
  }
  if (!lines.length) return "";
  const body = `${FACTS_MARKER}\n${lines.join("\n")}`;
  return body.length > maxChars ? `${body.slice(0, maxChars)}…（已截断）` : body;
}

/** 压缩前备好的确定性产物（放内存，不占上下文） */
export interface PreparedDigest {
  index?: string;
  facts?: string;
}

/// 生成本次压缩要附带的确定性产物（老消息 = 即将被摘要覆盖的那些）
export function prepareDigest(
  droppable: { role?: string; content?: string }[],
): PreparedDigest {
  const out: PreparedDigest = {};
  const index = renderKeywordIndex(extractTerms(droppable));
  if (index) out.index = index;
  const facts = renderKeyFacts(extractKeyFacts(droppable));
  if (facts) out.facts = facts;
  return out;
}

/**
 * 把确定性产物合并进交接摘要（**幂等**：已含标记则不重复追加）。
 * 顺序：模型摘要（语义）→ 关键事实（字面）→ 关键词索引（可检索）。
 */
export function mergeDigestIntoSummary(summary: string, digest: PreparedDigest): string {
  const base = (summary ?? "").trimEnd();
  const parts = [base];
  if (digest.facts && !base.includes(FACTS_MARKER)) parts.push(digest.facts);
  if (digest.index && !base.includes(INDEX_MARKER)) parts.push(digest.index);
  return parts.filter(Boolean).join("\n\n");
}
