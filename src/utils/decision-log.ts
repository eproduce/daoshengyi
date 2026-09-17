// P1-7 决策日志（DECISIONS.md，吸收自 DSH 生态「决策必须留痕」的做法）。
//
// ## 为什么需要
//
// 会话摘要（压缩阶梯里的 handoff summary）是**会话级、易失**的；项目级「当初为什么这么做」
// 一旦没写下来，下次会话（或换个人/换模型接手）就会重新论证一遍，甚至推翻已有结论。
// 代码注释里写不下「排除了哪些方案、为什么不选」，所以单独落一个项目文件。
//
// ## 设计
//
// - 纯函数负责：渲染条目、幂等合并（**同一标题视为同一条决策 → 原地更新，不重复追加**）、
//   宽容解析（把已有的 DECISIONS.md 读回来做列表/UI）。
// - IO 与落盘在 chat.ts 里走 `write_file_agent`（应用自身写盘 + 路径校验 + 可撤销）。
// - 文件格式刻意保持「人可读、机器可解析」：`## 日期 · 标题` 小节 + 固定字段的列表。

/** 决策条目 */
export interface DecisionEntry {
  /** 记录时间（毫秒） */
  at: number;
  /** 一句话标题（同一标题 = 同一条决策，重复记录会原地更新） */
  title: string;
  /** 决定了什么 */
  decision: string;
  /** 为什么（约束/取舍/依据） */
  rationale: string;
  /** 排除掉的方案（含原因），最多 5 条 */
  alternatives?: string[];
  /** 相关文件（便于接手者定位） */
  files?: string[];
  /** 归属会话（可选，便于回溯原对话） */
  session?: string;
}

export const DECISION_FILE = "DECISIONS.md";
export const DECISION_HEADER =
  "# 决策日志\n\n" +
  "> 由道生一在会话中记录：**做了什么决定、为什么、排除了什么**。\n" +
  "> 新会话开始时应先读本文件，避免重复论证或推翻已有结论。\n" +
  "> 同一标题 = 同一条决策（再次记录会原地更新，不会重复追加）。\n";

export const MAX_TITLE = 120;
export const MAX_RATIONALE = 800;
export const MAX_DECISION = 400;
export const MAX_ALTERNATIVES = 5;
export const MAX_FILES = 10;

/// 单行化：去换行与控制字符、压缩空白、按上限截断（标题/字段用）
export function oneLine(text: string, max = MAX_TITLE): string {
  const s = (text ?? "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/// 段落化：保留换行但去掉多余空行（理由可能不止一句）
export function asParagraph(text: string, max = MAX_RATIONALE): string {
  const s = (text ?? "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/// 标题归一化：用于「同一条决策」判定（忽略大小写/空白差异）
export function normalizeTitle(title: string): string {
  return oneLine(title, 400).toLowerCase().replace(/\s+/g, "");
}

/// 日期（本地时区）`YYYY-MM-DD HH:mm`
export function stamp(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/// 小节的标题行（`## 2026-09-17 22:50 · 标题`），解析靠它
export const SECTION_RE = /^##\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+·\s+(.+)$/;

/// 渲染一条决策（确定性）
export function renderEntry(entry: DecisionEntry): string {
  const title = oneLine(entry.title);
  const lines: string[] = [`## ${stamp(entry.at)} · ${title}`];
  lines.push(`- **决策**：${oneLine(entry.decision, MAX_DECISION)}`);
  lines.push(`- **理由**：${asParagraph(entry.rationale)}`);
  const alts = (entry.alternatives ?? []).map((a) => oneLine(a, 200)).filter(Boolean);
  if (alts.length) lines.push(`- **排除的方案**：${alts.slice(0, MAX_ALTERNATIVES).join("；")}`);
  const files = (entry.files ?? []).map((f) => `\`${oneLine(f, 200)}\``).filter((f) => f !== "``");
  if (files.length) lines.push(`- **相关文件**：${files.slice(0, MAX_FILES).join("、")}`);
  if (entry.session) lines.push(`- **会话**：${oneLine(entry.session, 80)}`);
  return lines.join("\n");
}

/** 已存在文件 → 小节数组 */
export interface DecisionSection {
  /** 小节标题（原始，未归一化） */
  title: string;
  /** 小节全文（不含尾随空行） */
  body: string;
}

/**
 * 把 DECISIONS.md 切成「前言 + 小节」。
 * 前言 = 第一个 `## 日期 · 标题` 之前的全部内容（含文件标题与说明）。
 */
export function splitSections(text: string): { preamble: string; sections: DecisionSection[] } {
  const lines = (text ?? "").split("\n");
  const sections: DecisionSection[] = [];
  const preambleLines: string[] = [];
  let cur: DecisionSection | null = null;
  for (const line of lines) {
    const m = SECTION_RE.exec(line);
    if (m) {
      if (cur) sections.push(cur);
      cur = { title: m[2], body: line };
      continue;
    }
    if (cur) cur.body += `\n${line}`;
    else preambleLines.push(line);
  }
  if (cur) sections.push(cur);
  return {
    preamble: preambleLines.join("\n").replace(/\s+$/, ""),
    sections: sections.map((s) => ({ ...s, body: s.body.replace(/\s+$/, "") })),
  };
}

/**
 * 幂等合并：同标题（归一化后相同）→ **原地替换**该小节；否则追加到末尾。
 * 返回完整文件内容（可直接落盘）。
 */
export function mergeDecision(existing: string, entry: DecisionEntry): string {
  const entryText = renderEntry(entry);
  const { preamble, sections } = splitSections(existing ?? "");
  const key = normalizeTitle(entry.title);
  let replaced = false;
  const out = sections.map((s) => {
    if (!replaced && normalizeTitle(s.title) === key) {
      replaced = true;
      return entryText;
    }
    return s.body;
  });
  if (!replaced) out.push(entryText);
  const head = preamble.trim() ? preamble.replace(/\s+$/, "") : DECISION_HEADER.replace(/\s+$/, "");
  return `${head}\n\n${out.join("\n\n")}\n`;
}

/** 宽容解析（供列表/UI）：读不出字段的条目跳过，不抛错 */
export function parseDecisions(text: string): DecisionEntry[] {
  const { sections } = splitSections(text ?? "");
  const out: DecisionEntry[] = [];
  for (const s of sections) {
    const m = SECTION_RE.exec(s.body.split("\n")[0] ?? "");
    const at = m ? Date.parse(m[1].replace(" ", "T") + ":00") : Date.now();
    const field = (name: string): string => {
      const re = new RegExp(
        `^-\\s*\\*\\*${name}\\*\\*\\s*：\\s*([\\s\\S]*?)(?=\\n-\\s*\\*\\*|$)`,
        "m",
      );
      const mm = re.exec(s.body);
      return mm ? mm[1].trim() : "";
    };
    out.push({
      at: Number.isFinite(at) ? at : Date.now(),
      title: s.title,
      decision: field("决策"),
      rationale: field("理由"),
    });
  }
  return out;
}

/** 已记录条数（供 UI 显示） */
export function countDecisions(text: string): number {
  return splitSections(text ?? "").sections.length;
}

/** 目标文件路径：优先给定目录，否则工作区，否则主目录下的产物目录 */
export function decisionPath(dir: string): string {
  const base = (dir || "").replace(/\/+$/, "");
  return base ? `${base}/${DECISION_FILE}` : DECISION_FILE;
}
