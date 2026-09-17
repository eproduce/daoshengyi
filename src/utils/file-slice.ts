// read_file 分段读取：把「按行取一段」这件事做成纯函数，方便单测与复用。
//
// 背景（真实使用暴露的缺陷）：`builtin-params.ts` 早就声明了 read_file 的
// `offset`/`length`，但 `chat.ts` 的分发实现只读 path，然后 `slice(0, 12000)`
// 一刀切 —— 模型按 schema 传的分段参数被**静默忽略**，只能改用 awk/sed 绕过，
// 白花一次工具调用和一大截上下文预算。这里补齐语义，并且把「被截断」明确说出来。
//
// 语义约定：offset 是 **1 基行号**，length 是 **行数**（不是字符数）。
// 之所以要写死这个约定：schema 原文写「行/字符」两种解释都成立，模型只能猜；
// 猜错时如果实现再静默处理，就变成「看起来读了其实没读」。

/** 单次返回的字符上限：超过时按**整行边界**截断，并明确告知续读位置 */
export const READ_FILE_MAX_CHARS = 12000;

export interface FileSliceOptions {
  /** 起始行号（1 基）。支持数字或数字字符串；非法/缺省 = 1 */
  offset?: unknown;
  /** 读取行数。非法/缺省/<=0 = 读到文件末尾 */
  length?: unknown;
  /** 单次返回字符上限，缺省 {@link READ_FILE_MAX_CHARS} */
  maxChars?: number;
}

export interface FileSliceResult {
  /** 实际返回的正文（可能因字符上限少几行） */
  text: string;
  /** 实际返回的第一行行号（1 基） */
  startLine: number;
  /** 实际返回的最后一行行号（1 基，含）；请求越界时 = startLine - 1 */
  endLine: number;
  /** 文件总行数 */
  totalLines: number;
  /** 请求的起始行号（归一化前），用于告知模型「你传的是什么」 */
  requestedStart: number;
  /** 请求起始行号超出文件范围（应直接报错，不要假装读到空文件） */
  outOfRange: boolean;
  /** offset 被夹到合法范围（<1 视作 1） */
  clampedStart: boolean;
  /** 因字符上限少返回了行 */
  charTruncated: boolean;
  /** 首行本身就超上限 → 该行按字符截断 */
  partialLine: boolean;
  /** 续读建议（charTruncated 时为下一段的 offset；否则 null） */
  nextOffset: number | null;
  /** 一句话说明（可直接拼进结果头）；无特殊情况时为空串 */
  note: string;
}

/** 宽松取整数：数字或纯数字字符串；其它一律 null（不猜） */
function toInt(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.floor(v) : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!/^-?\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? Math.floor(n) : null;
  }
  return null;
}

/**
 * 取文件的一段（按行）。越界/截断都**显式**表达，绝不静默返回别的内容。
 */
export function sliceFileLines(content: unknown, opts: FileSliceOptions = {}): FileSliceResult {
  const raw = typeof content === "string" ? content : "";
  // 保留末尾空行的语义（`a\n` 是 2 行，与编辑器行号一致）
  const lines = raw.split("\n");
  const totalLines = lines.length;

  const wantedOffset = toInt(opts.offset);
  const requestedStart = wantedOffset == null ? 1 : wantedOffset;
  let start = requestedStart;
  let clampedStart = false;
  if (start < 1) {
    start = 1;
    clampedStart = true;
  }
  const outOfRange = start > totalLines;

  const maxChars =
    Number.isFinite(Number(opts.maxChars)) && Number(opts.maxChars) > 0
      ? Math.floor(Number(opts.maxChars))
      : READ_FILE_MAX_CHARS;

  if (outOfRange) {
    return {
      text: "",
      startLine: start,
      endLine: start - 1,
      totalLines,
      requestedStart,
      outOfRange: true,
      clampedStart,
      charTruncated: false,
      partialLine: false,
      nextOffset: null,
      note: `⛔ 起始行 ${start} 超出文件范围（共 ${totalLines} 行）——请用 1~${totalLines} 之间的 offset，或先用 grep 定位目标行`,
    };
  }

  const wantedLen = toInt(opts.length);
  const requestedEnd =
    wantedLen == null || wantedLen <= 0 ? totalLines : Math.min(totalLines, start + wantedLen - 1);

  // 按字符上限收行：整行装不下就停（切在行中间会破坏行号/锚点的可读性）
  const picked: string[] = [];
  let chars = 0;
  let partialLine = false;
  for (let i = start - 1; i <= requestedEnd - 1; i++) {
    const line = lines[i] ?? "";
    const cost = line.length + (picked.length ? 1 : 0);
    if (chars + cost > maxChars) {
      if (!picked.length) {
        // 首行本身就超上限：只能截字符，并明确标记
        picked.push(line.slice(0, maxChars));
        partialLine = true;
      }
      break;
    }
    picked.push(line);
    chars += cost;
  }

  const endLine = start + picked.length - 1;
  const charTruncated = endLine < requestedEnd;
  const nextOffset = charTruncated ? endLine + 1 : null;

  const notes: string[] = [];
  if (clampedStart) notes.push(`offset ${requestedStart} 无效，已按第 1 行处理`);
  if (charTruncated) {
    notes.push(
      `⚠️ 单次返回上限 ${maxChars} 字符，本次只到第 ${endLine} 行${partialLine ? "（该行按字符截断）" : ""}——续读请用 offset=${nextOffset}${wantedLen != null && wantedLen > 0 ? `、length=${wantedLen}` : ""}`,
    );
  }

  return {
    text: picked.join("\n"),
    startLine: start,
    endLine,
    totalLines,
    requestedStart,
    outOfRange: false,
    clampedStart,
    charTruncated,
    partialLine,
    nextOffset,
    note: notes.join("\n"),
  };
}

/** 是否整文件一次读完（用于决定要不要在结果头写行号范围） */
export function isWholeFile(s: FileSliceResult): boolean {
  return s.startLine === 1 && s.endLine === s.totalLines && !s.charTruncated;
}
