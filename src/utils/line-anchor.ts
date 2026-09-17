// 行锚点（P1-2 哈希锚定编辑，吸收自 dsh-better-edit）：
//
// ## 解决什么问题
//
// 文件编辑最隐蔽的失败不是「找不到」，而是**改错位置**，以及**拿过期的记忆去改**：
// - `old_text` 在文件里出现多次 → 默认替换第一次，可能改在错误的同名段落上（静默错改）；
// - 模型按「我上次读到第 42 行是 XXX」去改，但文件在本轮已被别的工具改过 → 位置漂移；
//   此时若恰好还能匹配上相似文本，就会改出一个语法正确但语义错误的结果。
//
// ## 做法
//
// 读文件时可选输出**行锚点**（`42#a7f| 原行内容`）：行号 + 该行内容的 3 字符哈希。
// 编辑时带上锚点，写盘前校验：
// 1. **锚点行内容未变** → 通过，并且用锚点位置**消歧**（算出 old_text 是第几次出现）；
// 2. **内容变了但哈希仍能在附近找到** → **拒绝**并指出新行号（不猜、不自动改）；
// 3. **哈希整个文件都找不到** → **拒绝**，说明内容已被替换（要求重新读取）。
//
// 设计约束：纯函数、零依赖、可单测；哈希只覆盖**行首尾空白之外的正文**，
// 这样「只是重新缩进」不会让锚点失效，而真正的语义改动一定会失效。

/** 搜索哈希时默认的前后容差（行）：够覆盖「插入/删除几行」，又不至于撞到远处的巧合 */
export const ANCHOR_TOLERANCE = 30;

/** 3 字符哈希的字符表（36 进制，去掉易混淆的字符不做特殊处理，保持简单可复现） */
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/// FNV-1a（32 位）—— 稳定、无依赖、对短字符串分布良好
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // h *= 16777619（用移位避免 32 位溢出丢精度）
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/// 行哈希：3 字符（36^3 = 46656 种）。空行/纯空白行也参与（否则空行锚点没意义）
export function hashLine(line: string): string {
  const h = fnv1a(line.trim());
  let n = h % ALPHABET.length ** 3;
  let out = "";
  for (let i = 0; i < 3; i++) {
    out = ALPHABET[n % ALPHABET.length] + out;
    n = Math.floor(n / ALPHABET.length);
  }
  return out;
}

/// 带锚点的行：`42#a7f| 内容`（分隔符固定，便于模型照抄与解析）
export function formatAnchoredLine(lineNo: number, content: string): string {
  return `${lineNo}#${hashLine(content)}| ${content}`;
}

/// 给整段文本加锚点（`startLine` 用于只读了文件片段时对齐真实行号）
export function annotateLines(text: string, startLine = 1): string {
  const lines = text.split("\n");
  const from = Number.isFinite(startLine) && startLine > 0 ? Math.floor(startLine) : 1;
  return lines.map((l, i) => formatAnchoredLine(from + i, l)).join("\n");
}

/** 解析出的锚点 */
export interface LineAnchor {
  /** 1 起算的行号 */
  line: number;
  /** 3 字符哈希 */
  hash: string;
}

/// 解析锚点字符串：`42#a7f`、`42#a7f| 内容`（内容部分忽略）都支持；非法返回 null
export function parseAnchor(raw: unknown): LineAnchor | null {
  if (typeof raw !== "string") return null;
  const m = /^\s*(\d{1,7})\s*#\s*([0-9a-z]{3})\b/i.exec(raw);
  if (!m) return null;
  const line = Number(m[1]);
  if (!Number.isFinite(line) || line < 1) return null;
  return { line, hash: m[2].toLowerCase() };
}

/// 从带锚点的行里解析出 `(行号, 哈希, 内容)`；不是锚点行返回 null
export function parseAnchoredLine(
  line: string,
): { line: number; hash: string; content: string } | null {
  const m = /^\s*(\d{1,7})#([0-9a-z]{3})\|\s?([\s\S]*)$/i.exec(line);
  if (!m) return null;
  const lineNo = Number(m[1]);
  if (!Number.isFinite(lineNo) || lineNo < 1) return null;
  return { line: lineNo, hash: m[2].toLowerCase(), content: m[3] };
}

/// 文本 → 行数组（与 read_file 的分行口径一致：按 \n 切；\r\n 会留下 \r，哈希前 trim 掉）
export function toLines(text: string): string[] {
  return text.split("\n");
}

/// 某一行（1 起算）的哈希；越界返回 null
export function hashAt(lines: string[], line: number): string | null {
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return null;
  return hashLine(lines[line - 1]);
}

/**
 * 在文件中寻找哈希：优先锚点行本身，其次以锚点行**为起点向两侧扩散**（近者优先）。
 * 返回 `exact` 表示是否就在原行号上。
 */
export function findHash(
  lines: string[],
  hash: string,
  around: number,
  tolerance = ANCHOR_TOLERANCE,
): { line: number; exact: boolean } | null {
  const target = hash.toLowerCase();
  if (hashAt(lines, around) === target) return { line: around, exact: true };
  for (let d = 1; d <= tolerance; d++) {
    const up = around - d;
    if (up >= 1 && hashAt(lines, up) === target) return { line: up, exact: false };
    const down = around + d;
    if (down <= lines.length && hashAt(lines, down) === target) {
      return { line: down, exact: false };
    }
  }
  return null;
}

/** 校验结果 */
export type AnchorVerdict =
  | { ok: true; line: number; hash: string }
  | { ok: false; code: "stale" | "gone" | "out_of_range"; message: string; foundLine?: number };

/**
 * 校验锚点是否仍然有效。
 * - `stale`：锚点行内容变了，但该哈希能在附近找到 → 告诉模型新行号（**不自动改**）
 * - `gone`：整个文件都找不到该哈希 → 内容已被替换，要求重新读取
 * - `out_of_range`：行号超出文件范围（文件被截短）
 */
export function verifyAnchor(
  lines: string[],
  anchor: LineAnchor,
  tolerance = ANCHOR_TOLERANCE,
): AnchorVerdict {
  const { line, hash } = anchor;
  if (line > lines.length) {
    return {
      ok: false,
      code: "out_of_range",
      message: `锚点行 ${line} 超出文件范围（当前共 ${lines.length} 行）——文件已被截短，请重新 read_file 后再改。`,
    };
  }
  const current = hashAt(lines, line);
  if (current === hash) return { ok: true, line, hash };
  const near = findHash(lines, hash, line, tolerance);
  if (near) {
    const text = lines[near.line - 1].trim().slice(0, 80);
    return {
      ok: false,
      code: "stale",
      foundLine: near.line,
      message:
        `锚点已过期：第 ${line} 行现在是 \`${lines[line - 1].trim().slice(0, 80)}\`（#${current}），` +
        `而 #${hash} 现在位于第 ${near.line} 行 \`${text}\`。文件在本轮已被改动——` +
        `请按第 ${near.line} 行的最新内容重写 old_text/锚点后重试（不要沿用旧行号）。`,
    };
  }
  return {
    ok: false,
    code: "gone",
    message:
      `锚点内容已不存在：第 ${line} 行现在是 \`${lines[line - 1].trim().slice(0, 80)}\`（#${current}），` +
      `且附近 ${tolerance} 行内找不到 #${hash}。请重新 read_file 获取最新内容（可用 with_anchors 取新锚点）后再改。`,
  };
}

/**
 * 锚点位置 → `old_text` 的出现序号（1 起算）。
 * 用途：`old_text` 在文件里出现多次时，用「锚点所在行」决定该改哪一处，
 * 避免 `occurrence` 默认 1 的静默错改。
 * 规则：取「起始偏移 ≤ 锚点行起始偏移」的最后一次出现；锚点在所有出现之前则取第 1 次；
 * 一处都没有返回 null（交给原有文本匹配逻辑报错）。
 */
export function occurrenceForAnchor(
  lines: string[],
  index: number,
  oldText: string,
): number | null {
  if (!oldText) return null;
  const text = lines.join("\n");
  let offset = 0;
  for (let i = 0; i < Math.min(index, lines.length); i++) offset += lines[i].length + 1; // +1 补 '\n'
  const hits: number[] = [];
  for (let from = 0; ;) {
    const at = text.indexOf(oldText, from);
    if (at < 0) break;
    hits.push(at);
    from = at + Math.max(1, oldText.length);
  }
  if (!hits.length) return null;
  let occ = 0;
  for (let i = 0; i < hits.length; i++) {
    if (hits[i] <= offset) occ = i + 1;
  }
  return occ > 0 ? occ : 1;
}

/**
 * 一段带锚点的文本行是否被模型**原样照抄**（常见错误：把 `42#a7f| ` 前缀也写进了 old_text）。
 * 返回去掉前缀后的正文，便于在写盘前自动纠正。
 */
export function stripAnchorPrefix(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  const stripped = lines.map((l) => parseAnchoredLine(l)?.content ?? l);
  return stripped.join("\n");
}

/** 文本里是否包含锚点前缀（判定「模型把前缀抄进 old_text」） */
export function hasAnchorPrefix(text: string): boolean {
  return text.split("\n").some((l) => parseAnchoredLine(l) !== null);
}
