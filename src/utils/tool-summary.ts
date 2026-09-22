// 工具调用展示的纯逻辑：分组摘要 + 剥离正文里机器生成的工具卡片
//
// 背景：`chat.ts` 在轮末会把工具卡片（`### 🔧 调用工具：\`x\`` + `<details>`）拼进消息正文，
// 供导出/复制保留完整过程；同时又把结构化结果挂在 `message.tools` 上渲染成卡片。
// 于是界面上同一次调用被显示两遍，且全部铺在回复正文里 —— 这里负责：
//   ① `stripToolCards`：**仅用于显示**地剥掉正文里机器生成的卡片（正文原样保留给导出/复制）
//   ② `summarizeTools`：给折叠后的分组头一行摘要（次数 / 工具名 / 耗时 / 成败）

export interface ToolLike {
  name: string;
  server?: string;
  status: string;
  durationMs?: number;
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
 * - 失败：单行 `> ❌ 工具调用失败: ...`
 *
 * 任何一条形状对不上（没找到 `<details><summary>`）就**立即停止剥离**，保守优先。
 */
export function stripToolCards(content: string): string {
  if (!content) return content;
  let s = content.replace(/^\s+/, "");
  for (;;) {
    if (!CARD_HEAD_RE.test(s)) break;
    const nl = s.indexOf("\n");
    if (nl === -1) {
      // 整段就是一行失败卡片 → 剥完即空
      return "";
    }
    // 失败行：剥掉这一行即可
    if (s.startsWith(">")) {
      s = s.slice(nl + 1).replace(/^\s+/, "");
      continue;
    }
    // `###` 卡片：从标题后找到「紧随其后的连续 <details> 块」的结尾
    const headEnd = nl + 1;
    const first = s.indexOf("<details><summary>", headEnd);
    // 标题与首个 details 之间不得出现下一个标题（否则说明这不是机器卡片）
    if (first === -1 || /^###/m.test(s.slice(headEnd, first))) break;
    let end = -1;
    let cursor = first;
    for (;;) {
      const close = s.indexOf("</details>", cursor);
      if (close === -1) break;
      end = close + "</details>".length;
      // 允许紧跟另一个 details 块（两者之间只有空白）
      const rest = s.slice(end);
      const next = /^[ \t]*\n?[ \t]*<details><summary>/.exec(rest);
      if (!next) break;
      cursor = end + next[0].length - "<details><summary>".length;
    }
    if (end === -1) break;
    s = s.slice(end).replace(/^\s+/, "");
  }
  return s;
}
