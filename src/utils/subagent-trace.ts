/**
 * 子代理轨迹记录器（纯函数，可单测）。
 *
 * ## 为什么需要
 *
 * 子代理是**一次性函数调用**：跑完只剩一句结论，主对话里看不到它读过什么、调过什么工具、
 * 为什么停。出问题时只能靠猜——「它怎么得出这个结论的」是最难回答、也最该能回答的问题。
 *
 * 落库放在 Rust（SQLite），但**怎么裁剪/怎么组织**属于纯逻辑，所以放这里：
 * - 条数上限（默认 40）：探索型子代理能跑 20 轮 × 每轮多个工具，不封顶会把库撑爆；
 * - 每条的参数/结果只留预览（默认 240 字符）：轨迹是给人和模型「复盘」用的，
 *   不是把整份文件内容再存一遍；
 * - 丢弃量要计数（`dropped`）——静默截断会让人误以为「它只做了这些」。
 */

export type TraceEntryKind = "assistant" | "tool" | "note";

export interface TraceEntry {
  /** 第几轮（从 1 开始） */
  round: number;
  kind: TraceEntryKind;
  /** 工具名（kind=tool 时） */
  tool?: string;
  /** 参数预览 */
  args?: string;
  /** 结果/正文预览 */
  result?: string;
  /** ok / error */
  status?: "ok" | "error";
}

export interface SubagentTrace {
  rounds: number;
  entries: TraceEntry[];
  dropped: number;
}

export interface TraceOptions {
  /** 最多留几条（默认 40） */
  maxEntries?: number;
  /** 单条参数/结果预览上限（默认 240 字符） */
  maxPreview?: number;
}

export interface SubagentTraceRecorder {
  /** 记一轮（子代理每轮开始调用一次；取最大值作为总轮数） */
  round(n: number): void;
  /** 记一次工具调用 */
  tool(name: string, args: unknown, result: string, ok: boolean, round?: number): void;
  /** 记一条助手正文（通常是「它说了什么」的摘要） */
  assistant(text: string, round?: number): void;
  /** 记一条说明（拦截、被拒、超限等） */
  note(text: string, round?: number): void;
  snapshot(): SubagentTrace;
}

/** 把任意值压成单行预览（对象/数组走 JSON，空白折叠，超长截断） */
export function previewOf(value: unknown, max: number): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value === undefined || value === null) {
    text = "";
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  // 首尾都留一点：错误信息常在末尾（"…: permission denied"）
  const head = Math.ceil((max - 1) * 0.7);
  const tail = Math.max(0, max - 1 - head);
  return `${flat.slice(0, head)}…${tail > 0 ? flat.slice(-tail) : ""}`;
}

export function createSubagentTrace(opts: TraceOptions = {}): SubagentTraceRecorder {
  const maxEntries = Math.max(1, opts.maxEntries ?? 40);
  const maxPreview = Math.max(40, opts.maxPreview ?? 240);
  const entries: TraceEntry[] = [];
  let rounds = 0;
  let dropped = 0;

  const push = (e: TraceEntry) => {
    if (entries.length >= maxEntries) {
      // 满了以后不再增长，但**继续计数**：让人知道「后面还有，只是没存」
      dropped++;
      return;
    }
    entries.push(e);
  };
  const currentRound = () => rounds || 1;

  return {
    round(n) {
      if (Number.isFinite(n) && n > rounds) rounds = Math.floor(n);
    },
    tool(name, args, result, ok, round) {
      push({
        round: round ?? currentRound(),
        kind: "tool",
        tool: name,
        args: previewOf(args, maxPreview),
        result: previewOf(result, maxPreview),
        status: ok ? "ok" : "error",
      });
    },
    assistant(text, round) {
      push({
        round: round ?? currentRound(),
        kind: "assistant",
        result: previewOf(text, maxPreview),
      });
    },
    note(text, round) {
      push({ round: round ?? currentRound(), kind: "note", result: previewOf(text, maxPreview) });
    },
    snapshot() {
      return { rounds, entries: entries.map((e) => ({ ...e })), dropped };
    },
  };
}

/** 给模型看的紧凑文本（一次性读一条轨迹时用；不是 JSON，省 token） */
export function formatTrace(run: {
  id: string;
  goal: string;
  status: string;
  rounds: number;
  startedAt?: number;
  result?: string;
  trace: string;
}): string {
  let parsed: SubagentTrace | null = null;
  try {
    parsed = JSON.parse(run.trace) as SubagentTrace;
  } catch {
    parsed = null;
  }
  const lines: string[] = [
    `子代理轨迹 ${run.id}`,
    `目标：${run.goal}`,
    `状态：${run.status}｜轮次：${run.rounds}`,
  ];
  if (!parsed) {
    lines.push("（轨迹解析失败，原始内容可能不完整）");
  } else {
    for (const e of parsed.entries) {
      const tag =
        e.kind === "tool"
          ? `工具 ${e.tool}${e.status === "error" ? " ✗" : ""}`
          : e.kind === "note"
            ? "说明"
            : "输出";
      lines.push(`R${e.round} ${tag}：${e.result ?? ""}`);
    }
    if (parsed.dropped > 0) lines.push(`…另有 ${parsed.dropped} 条未存储（超出上限）`);
  }
  if (run.result) lines.push(`\n结论：${run.result.slice(0, 600)}`);
  return lines.join("\n");
}
