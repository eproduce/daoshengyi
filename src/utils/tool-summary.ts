// 工具调用展示的纯逻辑：分组摘要 + 剥离正文里机器生成的工具卡片
//
// 背景：`chat.ts` 在轮末会把工具卡片（`### 🔧 调用工具：\`x\`` + `<details>`）拼进消息正文，
// 供导出/复制保留完整过程；同时又把结构化结果挂在 `message.tools` 上渲染成卡片。
// 于是界面上同一次调用被显示两遍，且全部铺在回复正文里 —— 这里负责：
//   ① `stripToolCards`：**仅用于显示**地剥掉正文里机器生成的卡片（正文原样保留给导出/复制）
//   ② `summarizeTools`：给折叠后的分组头一行摘要（次数 / 工具名 / 耗时 / 成败）
//   ③ `parsePersistedTools`：把 DB 里存的工具卡（`messages.tools` 列）读回结构化数组

import type { ChatTool } from "@/types";

export interface ToolLike {
  name: string;
  server?: string;
  status: string;
  durationMs?: number;
}

/**
 * 显示层入口：**只在确实有结构化工具记录时**才剥正文里的卡片。
 *
 * 为什么不能无条件剥：正文里的卡片是导出/复制的唯一凭证，也是**旧数据里的唯一一份记录**
 * （`messages.tools` 列是后加的，旧行读回来是 undefined）。无条件剥就会把工具调用历史删干净
 * —— 真实回归，整段记录消失。没有结构化数据时宁可留着原始卡片（难看但信息不丢）。
 */
export function stripToolCardsForDisplay(
  content: string | undefined,
  tools: readonly unknown[] | undefined,
): string {
  const body = content || "";
  return tools && tools.length > 0 ? stripToolCards(body) : body;
}

export interface ToolSummary {
  count: number;
  /** 去重后的工具名，如 `web_search ×2、fetch_page、+1` */
  namesLabel: string;
  totalMs: number;
  failed: number;
  running: boolean;
  /** `运行中…` / `全部成功` / `3 成功 · 1 失败` */
  statusLabel: string;
}

const MAX_NAMES = 3;

export function summarizeTools(tools: readonly ToolLike[]): ToolSummary {
  const count = tools.length;
  // 按首次出现顺序去重计数（比按字典序更贴合「先搜后抓」的阅读顺序）
  const order: string[] = [];
  const seen = new Map<string, number>();
  for (const t of tools) {
    const n = t.name || "unknown";
    if (!seen.has(n)) order.push(n);
    seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  const shown = order
    .slice(0, MAX_NAMES)
    .map((n) => ((seen.get(n) ?? 1) > 1 ? `${n} ×${seen.get(n)}` : n))
    .join("、");
  const rest = order.length - MAX_NAMES;
  const namesLabel = rest > 0 ? `${shown}、+${rest}` : shown;

  const failed = tools.filter((t) => t.status === "error").length;
  const running = tools.some((t) => t.status === "running");
  const totalMs = tools.reduce((sum, t) => sum + (t.durationMs || 0), 0);
  const statusLabel = running
    ? "运行中…"
    : failed === 0
      ? "全部成功"
      : count - failed > 0
        ? `${count - failed} 成功 · ${failed} 失败`
        : `${failed} 次失败`;

  return { count, namesLabel, totalMs, failed, running, statusLabel };
}

/** 机器生成的卡片标题：`### 🔧 调用工具：\`x\`` / `### 🌐 联网搜索` / 失败行 `> ❌ 工具调用失败` */
const CARD_HEAD_RE = /^(?:###[ \t]*(?:🔧|🌐)|>[ \t]*❌[ \t]*工具调用失败)/;

/**
 * 剥掉正文**开头连续**的机器生成工具卡片（仅显示用）。
 *
 * 为什么只剥开头：这些卡片是 `chat.ts` 在轮末逐段 `join("\n\n")` 前置到正文的；
 * 只处理开头就不会误删正文里恰好同形的文字（例如模型在讲如何写卡片）。
 *
 * 卡片形状（两种都以 `</details>` 结尾，可连续出现多个 details 块）：
 * - `### 🔧 调用工具：`x`` + `<details>参数</details>` + `<details>✅ 工具结果</details>`
 * - `### 🌐 联网搜索` + `**查询**：` + `<details>共 N 条结果</details>`
 * - 失败：`> ❌ 工具调用失败: \`err\``（err 可能含换行 → 卡片可能跨多行）
 *
 * 任何一条形状对不上（没找到 `<details><summary>`）就**立即停止剥离**，保守优先。
 */
export interface LeadingCards {
  /** 从正文开头反解出的工具卡 */
  tools: ChatTool[];
  /** 剥掉这些卡片后剩下的正文（不变量：tools 里记的就是被剥掉的那些） */
  body: string;
}

/** 去掉 details 块的外壳与代码围栏，取出真正的正文 */
function detailsBody(block: string): string {
  // 注意：块边界是从 `<details><summary>` 到 `</details>`（含），所以这里要先把收尾标签去掉
  let inner = block.trim().replace(/<\/details>$/, "");
  const shell = /^<details><summary>[\s\S]*?<\/summary>([\s\S]*)$/.exec(inner);
  if (shell) inner = shell[1];
  inner = inner.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(inner);
  if (fenced) inner = fenced[1].trim();
  return inner;
}

function detailsLabel(block: string): string {
  const m = /^<details><summary>([\s\S]*?)<\/summary>/.exec(block.trim());
  return (m ? m[1] : "").trim();
}

function clip(s: string): string {
  return s.slice(0, 300);
}

/** 失败卡片：`> ❌ 工具调用失败: \`err\``（err 可能含换行 → 卡片可能跨多行） */
function failureCard(card: string): ChatTool {
  const inTicks = /`([\s\S]*)`/.exec(card)?.[1];
  const err = (inTicks ?? card.replace(/^>+\s*❌\s*工具调用失败[:：]?\s*/, "")).trim();
  // 这张卡本身不含工具名（格式如此），如实标出来而不是编一个
  return { name: "未知工具", server: "app", status: "error", error: clip(err) };
}

/**
 * 取出一张失败卡的完整文本（从 `>` 开头到卡片真正结束）。
 *
 * 为什么不能只取首行：失败卡由 `chat.ts` 以 `> ❌ 工具调用失败: \`${err}\`` 生成，`err` 原样
 * 嵌入 → **err 里的换行会把卡片撑成多行**（真实数据：失败台账说明含空行与内部反引号）。
 * 旧实现只 `slice(0, 第一个\n)`，剥掉首行后剩下的 `err` 残句不以 `>` 开头 → 循环在下一张卡
 * 前就 `break`，**后续所有卡片全部漏进正文**（用户看到的「有些调用记录没有折叠」）。
 *
 * 收尾判定：生成器保证卡片以「反引号」收尾，且其后只跟空白/换行（内部反引号后面还接着正文，
 * 不会误判）。找不到收尾反引号时退回「只取首行」的保守行为。
 */
function sliceFailureCard(s: string): string {
  const nl = s.indexOf("\n");
  const firstLineEnd = nl === -1 ? s.length : nl;
  const open = s.indexOf("`");
  if (open === -1) return s.slice(0, firstLineEnd);
  let close = s.indexOf("`", open + 1);
  while (close !== -1) {
    if (/^[ \t]*(?:\n|$)/.test(s.slice(close + 1))) return s.slice(0, close + 1);
    close = s.indexOf("`", close + 1);
  }
  return s.slice(0, firstLineEnd);
}

/** `### 🔧 调用工具：\`x\``（参数/结果块）或 `### 🌐 联网搜索`（查询行 + 结果块） */
function headingCard(head: string, between: string, blocks: string[]): ChatTool {
  const toolName = /`([^`]+)`/.exec(head)?.[1];
  if (toolName) {
    const args = blocks.find((b) => detailsLabel(b).includes("参数"));
    const result = blocks.find((b) => detailsLabel(b).includes("结果"));
    return {
      name: toolName,
      server: "app",
      status: "done",
      argsPreview: args ? clip(detailsBody(args)) : undefined,
      resultPreview: result ? clip(detailsBody(result)) : undefined,
    };
  }
  // 联网搜索卡：标题里没有反引号，查询在紧跟的一行
  const query = /\*\*查询\*\*[:：]\s*(.+)/.exec(between)?.[1]?.trim();
  return {
    name: "web_search",
    server: "app",
    status: "done",
    argsPreview: query ? clip(`{"query":${JSON.stringify(query)}}`) : undefined,
    resultPreview: blocks[0] ? clip(detailsBody(blocks[0])) : undefined,
  };
}

/**
 * 从正文**开头连续**的机器生成工具卡片里解析出结构化卡片，并返回剩余正文。
 *
 * 为什么需要「反解」：老的会话在 DB 里没有结构化 `tools`（列是后加的），只有正文卡片；
 * 反解一下就能让老会话同样以折叠组呈现，而不是退回一坨原始卡片。
 *
 * **与 `stripToolCards` 是同一个走法**（后者只是取 `.body`），因此不存在
 * 「剥掉了却没解析出来」的可能——不变量由结构保证，而不是靠两处代码保持同步。
 *
 * 卡片形状（两种都以 `</details>` 结尾，可连续出现多个 details 块）：
 * - `### 🔧 调用工具：`x`` + `<details>参数</details>` + `<details>✅ 工具结果</details>`
 * - `### 🌐 联网搜索` + `**查询**：` + `<details>共 N 条结果</details>`
 * - 失败：`> ❌ 工具调用失败: \`err\``（err 可能含换行 → 卡片可能跨多行，见 sliceFailureCard）
 *
 * 任何一条形状对不上（没找到 `<details><summary>`）就**立即停止**，保守优先——
 * 宁可少折叠几条，也不能误吃正文。
 */
export function splitLeadingToolCards(content: string | undefined): LeadingCards {
  const tools: ChatTool[] = [];
  const src = content || "";
  if (!src) return { tools, body: src };
  let s = src.replace(/^\s+/, "");
  for (;;) {
    if (!CARD_HEAD_RE.test(s)) break;
    const nl = s.indexOf("\n");
    if (nl === -1) {
      // 没有换行：只有整行失败卡能到这里（`###` 卡片必然带 details、必然多行）
      if (!s.startsWith(">")) break;
      tools.push(failureCard(s));
      return { tools, body: "" };
    }
    // 失败卡：解析整张卡（err 可能含换行 → 卡片跨多行）后剥掉
    if (s.startsWith(">")) {
      const card = sliceFailureCard(s);
      tools.push(failureCard(card));
      s = s.slice(card.length).replace(/^\s+/, "");
      continue;
    }
    // `###` 卡片：从标题后找到「紧随其后的连续 <details> 块」的结尾
    const headEnd = nl + 1;
    const first = s.indexOf("<details><summary>", headEnd);
    // 标题与首个 details 之间不得出现下一个标题（否则说明这不是机器卡片）
    if (first === -1 || /^###/m.test(s.slice(headEnd, first))) break;
    let end = -1;
    let cursor = first;
    const blocks: string[] = [];
    for (;;) {
      const close = s.indexOf("</details>", cursor);
      if (close === -1) break;
      blocks.push(s.slice(cursor, close + "</details>".length));
      end = close + "</details>".length;
      // 允许紧跟另一个 details 块（两者之间只有空白）
      const rest = s.slice(end);
      const next = /^[ \t]*\n?[ \t]*<details><summary>/.exec(rest);
      if (!next) break;
      cursor = end + next[0].length - "<details><summary>".length;
    }
    if (end === -1) break;
    tools.push(headingCard(s.slice(0, nl), s.slice(headEnd, first), blocks));
    s = s.slice(end).replace(/^\s+/, "");
  }
  return { tools, body: s };
}

/** 仅显示用：剥掉正文开头的机器生成工具卡片（实现与反解共用，见 `splitLeadingToolCards`） */
export function stripToolCards(content: string): string {
  return splitLeadingToolCards(content).body;
}

/**
 * 反序列化持久化在 DB `messages.tools` 列里的工具卡（**容错**：任何坏数据退化为 undefined）。
 *
 * 为什么需要它：工具卡原先只在内存，重载历史后整段记录会消失；落库后又不能信任库里的内容
 * （旧版本写过的、被外部改过的、半截写入的），所以逐个字段校验，宁可少显示也不要抛错拖垮整页。
 * 返回 `undefined`（而不是空数组）表示「没有结构化记录」，显示层据此保留正文里的原始卡片。
 */
export function parsePersistedTools(raw: string | null | undefined): ChatTool[] | undefined {
  if (!raw) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(data)) return undefined;
  const out: ChatTool[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name) continue; // 连工具名都没有的条目没有展示价值
    const status = o.status === "error" || o.status === "running" ? o.status : ("done" as const);
    out.push({
      name,
      server: typeof o.server === "string" && o.server ? o.server : "app",
      status,
      durationMs: typeof o.durationMs === "number" ? o.durationMs : undefined,
      argsPreview: typeof o.argsPreview === "string" ? o.argsPreview : undefined,
      resultPreview: typeof o.resultPreview === "string" ? o.resultPreview : undefined,
      error: typeof o.error === "string" ? o.error : undefined,
    });
  }
  return out.length > 0 ? out : undefined;
}
