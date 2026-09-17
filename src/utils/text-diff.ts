/**
 * 文本 diff（吸收自 DSH 生态的 dsh-toolkit 的 diff 工具）。
 * 纯函数、零依赖：给两段文本产出 unified diff（带 @@ hunk 头），用于
 * ①让模型自己核对「改前/改后」是否如预期；②给用户展示精确改动。
 * 大输入降级为「公共前后缀 + 中段整体替换」，并如实标注 truncated。
 */

export interface DiffResult {
  diff: string;
  added: number;
  removed: number;
  /** 是否因规模过大而降级（降级时 diff 仍可用，但粒度可能粗） */
  truncated: boolean;
}

/** LCS DP 的规模上限（行数乘积）；超过则走降级路径，避免爆内存/卡顿 */
const DP_LIMIT = 1_000_000;
/** 单个 hunk 之外的上下文行数（unified diff 惯例为 3） */
const DEFAULT_CONTEXT = 3;

type Op = { type: "eq" | "del" | "add"; line: string };

function splitLines(text: string): string[] {
  const s = String(text ?? "").replace(/\r\n?/g, "\n");
  return s.split("\n");
}

/** 公共前缀长度 */
function commonPrefix(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** 公共后缀长度（不超过各自去掉前缀后的长度） */
function commonSuffix(a: string[], b: string[], skipA: number, skipB: number): number {
  let n = 0;
  while (
    n < a.length - skipA &&
    n < b.length - skipB &&
    a[a.length - 1 - n] === b[b.length - 1 - n]
  ) {
    n++;
  }
  return n;
}

/** 基于 LCS 的操作序列（仅用于规模可控的输入） */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = a[0..i) 与 b[0..j) 的最长公共子序列长度（用一维滚动数组回溯需要完整表）
  const table: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) table.push(new Uint32Array(m + 1));
  for (let i = 1; i <= n; i++) {
    const row = table[i];
    const prev = table[i - 1];
    for (let j = 1; j <= m; j++) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    }
  }
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: "eq", line: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      ops.push({ type: "add", line: b[j - 1] });
      j--;
    } else {
      ops.push({ type: "del", line: a[i - 1] });
      i--;
    }
  }
  return ops.reverse();
}

/** 降级：公共前后缀 + 中段整体替换 */
function fallbackOps(a: string[], b: string[]): { ops: Op[]; truncated: boolean } {
  const p = commonPrefix(a, b);
  const s = commonSuffix(a, b, p, p);
  const ops: Op[] = [];
  for (let i = 0; i < p; i++) ops.push({ type: "eq", line: a[i] });
  for (let i = p; i < a.length - s; i++) ops.push({ type: "del", line: a[i] });
  for (let i = p; i < b.length - s; i++) ops.push({ type: "add", line: b[i] });
  for (let i = a.length - s; i < a.length; i++) ops.push({ type: "eq", line: a[i] });
  return { ops, truncated: true };
}

/** 产出 unified diff 文本 */
export function unifiedDiff(
  a: string,
  b: string,
  aLabel = "a",
  bLabel = "b",
  context = DEFAULT_CONTEXT,
): DiffResult {
  const la = splitLines(a);
  const lb = splitLines(b);
  const ctx = Math.max(0, Math.floor(context));
  let ops: Op[];
  let truncated = false;
  if (la.length * lb.length <= DP_LIMIT) {
    ops = lcsOps(la, lb);
  } else {
    const fb = fallbackOps(la, lb);
    ops = fb.ops;
    truncated = fb.truncated;
  }

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "add") added++;
    else if (op.type === "del") removed++;
  }

  // 找出需要输出的区间（变更处 ±ctx 行）
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.type === "eq") return;
    for (let k = Math.max(0, idx - ctx); k <= Math.min(ops.length - 1, idx + ctx); k++)
      keep[k] = true;
  });

  const lines: string[] = [`--- ${aLabel}`, `+++ ${bLabel}`];
  let i = 0;
  // 行号跟踪（指向原文/新文的 1-based 行号）
  let aLine = 1;
  let bLine = 1;
  const headerCounts = new Map<number, { a: number; b: number }>();
  while (i < ops.length) {
    if (!keep[i]) {
      if (ops[i].type !== "add") aLine++;
      if (ops[i].type !== "del") bLine++;
      i++;
      continue;
    }
    const startA = aLine;
    const startB = bLine;
    const body: string[] = [];
    let countA = 0;
    let countB = 0;
    while (i < ops.length && keep[i]) {
      const op = ops[i];
      if (op.type === "eq") {
        body.push(` ${op.line}`);
        countA++;
        countB++;
        aLine++;
        bLine++;
      } else if (op.type === "del") {
        body.push(`-${op.line}`);
        countA++;
        aLine++;
      } else {
        body.push(`+${op.line}`);
        countB++;
        bLine++;
      }
      i++;
    }
    headerCounts.set(startA, { a: countA, b: countB });
    lines.push(`@@ -${startA},${countA} +${startB},${countB} @@`);
    lines.push(...body);
  }

  if (added === 0 && removed === 0) {
    return { diff: "（两段文本完全一致，无差异）", added: 0, removed: 0, truncated };
  }
  if (truncated) {
    lines.push("…[文本过大已降级为「公共前后缀 + 中段整体替换」，粒度可能较粗]");
  }
  return { diff: lines.join("\n"), added, removed, truncated };
}
