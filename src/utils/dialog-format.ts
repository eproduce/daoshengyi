// 确认/提示弹窗的文案解析（纯函数，便于单测）
//
// 背景（2026-10-02 用户反馈）：原来的确认走 macOS 原生 Alert（Tauri dialog 插件），
// 而调用方传的是「多行 + 命令 + emoji」的长文案 —— 在系统 Alert 里就是一大坨等宽纯文本，
// 又长又割裂，看起来"很 low"。改成应用内自绘弹窗后，需要先把这种长文案拆成可排版的结构：
//   首行 → 标题 + 语气（⚠️=警告 / ⛔=拦截 / ❌=失败）
//   `$ 命令` 连续行 → 等宽命令块（可复制）
//   `- ` / `1. ` → 列表
//   `键：值` 连续行 → 键值行（如 IM 配对请求）
//   `**粗体**` / `` `代码` `` → 行内样式

export type DialogTone = "info" | "warning" | "error";

export interface Inline {
  text: string;
  bold?: boolean;
  code?: boolean;
}

export type DialogBlock =
  | { kind: "p"; parts: Inline[] }
  | { kind: "mono"; lines: string[] }
  | { kind: "list"; items: Inline[][] }
  | { kind: "kv"; rows: { k: string; v: string }[] };

export interface ParsedDialog {
  title: string;
  tone: DialogTone;
  blocks: DialogBlock[];
}

const TITLE_MAX = 60;

/** 首行 emoji → 语气 + 去掉 emoji 的标题 */
function readHead(line: string): { tone: DialogTone | null; text: string } {
  const m = /^([\s\uFE0F]*)(⛔|🚫|❌|⚠️|⚠|💡|ℹ️|ℹ|🔔|✅)([\s\uFE0F]*)(.*)$/.exec(line.trim());
  if (!m) return { tone: null, text: line.trim() };
  const emoji = m[2];
  const tone: DialogTone =
    emoji === "⛔" || emoji === "🚫" || emoji === "❌"
      ? "error"
      : emoji === "⚠️" || emoji === "⚠"
        ? "warning"
        : "info";
  return { tone, text: (m[4] ?? "").trim() };
}

/** 行内解析：`**粗体**` 与 `` `代码` `` */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push({ text: line.slice(last, m.index) });
    if (m[1] != null) out.push({ text: m[1], bold: true });
    else out.push({ text: m[2], code: true });
    last = re.lastIndex;
  }
  if (last < line.length) out.push({ text: line.slice(last) });
  return out.length ? out : [{ text: line }];
}

const CMD_LINE = /^\s*\$\s+(.+)$/;
const LIST_LINE = /^\s*(?:[-*·]|\d+[.)、])\s+(.+)$/;
const KV_LINE = /^\s*([^：:]{1,12})[：:]\s*(.+)$/;
const QUOTE_LINE = /^\s*>\s?(.*)$/;

/**
 * 把确认/提示文案解析成可排版结构。
 * `fallbackTone` 用于首行没有 emoji 时（调用方声明的 kind）。
 */
export function parseDialogText(raw: unknown, fallbackTone: DialogTone = "info"): ParsedDialog {
  const text = raw == null ? "" : String(raw).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const head = i < lines.length ? readHead(lines[i]) : { tone: null, text: "" };
  const tone = head.tone ?? fallbackTone;
  const title = (head.text.replace(/[：:]\s*$/, "").trim() || "请确认").slice(0, TITLE_MAX);
  i++;

  const blocks: DialogBlock[] = [];
  const pushP = (s: string) => {
    const t = s.trim();
    if (t) blocks.push({ kind: "p", parts: parseInline(t) });
  };

  let mono: string[] = [];
  const flushMono = () => {
    if (mono.length) blocks.push({ kind: "mono", lines: mono });
    mono = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      flushMono();
      i++;
      continue;
    }
    const cmd = CMD_LINE.exec(line);
    if (cmd) {
      mono.push(cmd[1].trimEnd());
      i++;
      continue;
    }
    flushMono();
    // 连续 `键：值` → 键值块（IM 配对请求这类）
    if (KV_LINE.test(line)) {
      const rows: { k: string; v: string }[] = [];
      while (i < lines.length && KV_LINE.test(lines[i])) {
        const kv = KV_LINE.exec(lines[i])!;
        rows.push({ k: kv[1].trim(), v: kv[2].trim() });
        i++;
      }
      if (rows.length >= 2) {
        blocks.push({ kind: "kv", rows });
        continue;
      }
      blocks.push({ kind: "p", parts: parseInline(rows[0].k + "：" + rows[0].v) });
      continue;
    }
    // 连续列表
    if (LIST_LINE.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && LIST_LINE.test(lines[i])) {
        const it = LIST_LINE.exec(lines[i])!;
        items.push(parseInline(it[1].trim()));
        i++;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    const q = QUOTE_LINE.exec(line);
    if (q) {
      pushP(q[1]);
      i++;
      continue;
    }
    pushP(line);
    i++;
  }
  flushMono();
  return { title, tone, blocks };
}

/**
 * 按文案推断按钮措辞与危险度（危险操作：红色主按钮 + 默认焦点落在「取消」）。
 * 只做保守判断：命中命令/删除/覆盖等不可逆动作才算危险。
 */
export function deriveDialogUi(
  raw: unknown,
  kind: DialogTone = "info",
): { tone: DialogTone; danger: boolean; confirmText: string } {
  const s = String(raw ?? "");
  const parsed = parseDialogText(raw, kind);
  const danger =
    /危险|不可逆|永久删除|删除|覆盖|清空|格式化|\brm\b|\bdd\b|mkfs|drop\s+table|truncate|sudo|拒绝|终止/i.test(
      s,
    );
  let confirmText = "确认";
  if (/命令/.test(s)) confirmText = "执行";
  if (/删除|清空|格式化/.test(s)) confirmText = "删除";
  if (/批准|白名单/.test(s)) confirmText = "批准";
  if (/回滚|还原/.test(s)) confirmText = "还原";
  if (/覆盖/.test(s)) confirmText = "覆盖";
  return { tone: parsed.tone, danger, confirmText };
}
