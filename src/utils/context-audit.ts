/**
 * 上下文成本审计（Context Doctor，吸收自 DSH 生态 Zhenyu98/dsh-context-doctor）。
 *
 * 要回答的问题：**「上下文的钱花在哪」**。我们已经有 token 估算与自动压缩，但一直没有地方
 * 解释「系统提示 / 技能指令 / 工具 schema / 历史消息」各占多少——于是每加一个技能、每挂一个
 * MCP 服务器，窗口就被悄悄吃掉，直到触发压缩才被发现。
 *
 * 本模块是纯函数：把各区块文本 + token 估算 → 排序后的占比表 + 可操作建议 + 重复检测。
 * 重复检测很有价值：同一段说明被多处注入（技能清单、工具描述、记忆块）等于白花 token。
 */

import { estimateTokens } from "./tokens";

export interface ContextPart {
  id: string;
  label: string;
  text: string;
  /** 可选的条数（如工具个数、技能个数、消息条数） */
  count?: number;
  /** 该区块是否属于「随轮增长」（历史消息）——用于给出不同建议 */
  growing?: boolean;
}

export interface ContextAuditRow {
  id: string;
  label: string;
  chars: number;
  tokens: number;
  /** 占合计的比例（0~1） */
  share: number;
  count?: number;
}

export interface ContextAudit {
  rows: ContextAuditRow[];
  totalChars: number;
  totalTokens: number;
  /** 占窗口比例（未提供 windowTokens 时为 null） */
  windowShare: number | null;
  duplicates: string[];
  hints: string[];
}

/** 阈值（占比）：超过则给出针对性建议 */
const TOOL_SHARE_HINT = 0.35;
const SKILL_SHARE_HINT = 0.3;
const HISTORY_SHARE_HINT = 0.6;

function splitNonTrivialLines(text: string, minLen: number): string[] {
  return String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= minLen);
}

/** 同一区块内重复行（近重复内容往往是复制粘贴残留） */
function findInnerDuplicates(part: ContextPart): string[] {
  const counter = new Map<string, number>();
  for (const line of splitNonTrivialLines(part.text, 20)) {
    counter.set(line, (counter.get(line) ?? 0) + 1);
  }
  const out: string[] = [];
  for (const [line, n] of counter) {
    if (n >= 3) out.push(`「${part.label}」内有 ${n} 行完全重复（如：${line.slice(0, 40)}…）`);
  }
  return out;
}

/** 跨区块重复行：同一段文本被多个区块注入 */
function findCrossDuplicates(parts: ContextPart[]): string[] {
  const owners = new Map<string, Set<string>>();
  for (const part of parts) {
    for (const line of splitNonTrivialLines(part.text, 40)) {
      const set = owners.get(line) ?? new Set<string>();
      set.add(part.label);
      owners.set(line, set);
    }
  }
  const out: string[] = [];
  for (const [line, labels] of owners) {
    if (labels.size >= 2) {
      out.push(`同一段内容出现在 ${[...labels].join(" 与 ")}（${line.slice(0, 40)}…）`);
    }
  }
  return out.slice(0, 5);
}

/** 主入口：审计各区块的 token 成本 */
export function auditContext(parts: ContextPart[], windowTokens?: number): ContextAudit {
  const rows: ContextAuditRow[] = parts.map((p) => {
    const text = String(p.text ?? "");
    return {
      id: p.id,
      label: p.label,
      chars: text.length,
      tokens: text ? estimateTokens(text) : 0,
      share: 0,
      count: p.count,
    };
  });
  const totalTokens = rows.reduce((n, r) => n + r.tokens, 0);
  const totalChars = rows.reduce((n, r) => n + r.chars, 0);
  for (const r of rows) r.share = totalTokens > 0 ? r.tokens / totalTokens : 0;
  rows.sort((a, b) => b.tokens - a.tokens);

  const duplicates = [...parts.flatMap(findInnerDuplicates), ...findCrossDuplicates(parts)];

  const hints: string[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const byId = (id: string) => rows.find((r) => r.id === id);
  const tools = byId("tools");
  const skills = byId("skills");
  const history = byId("history");
  const growingPart = parts.find((p) => p.growing);
  const growingRow = growingPart ? byId(growingPart.id) : undefined;

  if (tools && tools.share >= TOOL_SHARE_HINT) {
    hints.push(
      `工具定义占 ${pct(tools.share)}（${tools.count ?? "?"} 个，约 ${tools.tokens.toLocaleString()} tokens）：` +
        "可依赖 tool_search 延迟加载不常用的工具，或精简 MCP 服务器（未使用的服务器会一直占 schema 预算）。",
    );
  }
  if (skills && skills.share >= SKILL_SHARE_HINT) {
    hints.push(
      `技能指令占 ${pct(skills.share)}（${skills.count ?? "?"} 个，约 ${skills.tokens.toLocaleString()} tokens）：` +
        "启用技能过多时只有 ≤2 个直接注入、其余走路由清单；把长期不用的技能关掉可立即回收这部分。",
    );
  }
  if (history && history.share >= HISTORY_SHARE_HINT) {
    hints.push(
      `历史消息占 ${pct(history.share)}（${history.count ?? "?"} 条，约 ${history.tokens.toLocaleString()} tokens）：` +
        "它会随对话持续增长，接近窗口 82% 时会自动压缩；想立刻回收可用 new_context_window 或开新对话。",
    );
  }
  if (growingRow && growingRow.tokens > 0 && (!history || history.share < HISTORY_SHARE_HINT)) {
    hints.push(
      `「${growingRow.label}」随对话增长，是唯一会持续变大的区块，排查窗口吃紧时优先看它。`,
    );
  }
  if (duplicates.length > 0) {
    hints.push(
      `检测到 ${duplicates.length} 处重复注入：同样内容被反复塞进上下文，等于白花 token（见下方明细）。`,
    );
  }
  if (hints.length === 0) {
    hints.push("各区块占比均衡，没有明显浪费；继续观察「历史消息」随轮次的增长即可。");
  }

  const windowShare = windowTokens && windowTokens > 0 ? totalTokens / windowTokens : null;
  if (windowShare !== null) {
    hints.push(
      `当前上下文合计约 ${totalTokens.toLocaleString()} tokens，占模型窗口约 ${pct(windowShare)}` +
        `${windowShare >= 0.82 ? "（已超过自动压缩阈值 82%，下一轮会触发压缩）" : ""}。`,
    );
  }

  return { rows, totalChars, totalTokens, windowShare, duplicates, hints };
}

/** 渲染成可复制的 Markdown（面板「复制报告」用） */
export function auditToMarkdown(audit: ContextAudit): string {
  const lines = [
    "## 上下文成本审计",
    "",
    `合计约 ${audit.totalTokens.toLocaleString()} tokens / ${audit.totalChars.toLocaleString()} 字符` +
      (audit.windowShare !== null ? `（占窗口 ${Math.round(audit.windowShare * 100)}%）` : ""),
    "",
    "| 区块 | 条数 | 字符 | tokens | 占比 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const r of audit.rows) {
    lines.push(
      `| ${r.label} | ${r.count ?? "-"} | ${r.chars.toLocaleString()} | ${r.tokens.toLocaleString()} | ${Math.round(r.share * 100)}% |`,
    );
  }
  if (audit.duplicates.length) {
    lines.push("", "### 重复注入", "", ...audit.duplicates.map((d) => `- ${d}`));
  }
  lines.push("", "### 建议", "", ...audit.hints.map((h) => `- ${h}`));
  return lines.join("\n");
}
