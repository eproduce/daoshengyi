// OCR 结果交叉验证提示：等宽数字串（编号/单号/序列号）是 OCR 最容易出错的地方 ——
// 前导零漏读、位数多读一位，都会让「几位数」这个结论直接错掉。
// 真实案例：证书编号 OCR 给出 00219813（8 位）与 002198813（9 位）两种读数，
// 靠像素级列投影切分才定下是 8 位。所以 OCR 一旦读到长数字串，就顺手提示去交叉验证。
//
// 纯函数、零依赖、可测试。

/** 数字串识别：半角/全角数字，允许用 - / . · 分组（如 1234-5678、0021.9813）。
 * **刻意不把空格当分隔符**：否则 `A1 1001` 会被粘成 `1 1001` 这种带垃圾前缀的候选
 * （真实踩到：空格分隔的「分组写法」收益低，误拼风险高）。 */
const SERIAL_RE = /[0-9０-９]+(?:[\-–—/·.][0-9０-９]+)*/g;

/** 日期形状（2026-09-17 / 2026.9.17）不是编号，不提示 */
const DATE_RE = /^[0-9０-９]{4}[\-–—/·.][0-9０-９]{1,2}[\-–—/·.][0-9０-９]{1,2}$/;

/** 最短长度：≥ 5 位必看；4 位仅在**前导零**时看（`0002` 这种零填充码正是 OCR 的软肋，
 * 而 `2026` 这种四位年号满地都是，不该制造噪声） */
export const SERIAL_MIN_CHARS = 5;

/** 单个数串是否值得核验 */
export function isSerialCandidate(digits: string): boolean {
  const d = digits.replace(/[^0-9０-９]/g, "");
  if (d.length >= SERIAL_MIN_CHARS) return true;
  return d.length === 4 && (d.startsWith("0") || d.startsWith("０"));
}

/** 抽取值得核验的数字串（去重、保持出现顺序、最多 3 条） */
export function extractSerialCandidates(text: unknown, limit = 3): string[] {
  const s = text == null ? "" : String(text);
  if (!s) return [];
  const out: string[] = [];
  for (const m of s.matchAll(SERIAL_RE)) {
    const raw = m[0].trim();
    if (!isSerialCandidate(raw)) continue;
    if (DATE_RE.test(raw)) continue;
    if (out.includes(raw)) continue;
    out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 生成交叉验证提示；没有长数字串时返回空串（调用方据此不加提示，避免噪声）。
 * `path` 用于把 image_inspect 的调用参数写全，让模型不用再猜。
 */
export function ocrCrossCheckHint(text: unknown, path?: string): string {
  const found = extractSerialCandidates(text);
  if (!found.length) return "";
  const list = found.map((s) => `\`${s}\``).join("、");
  const arg = path ? `path="${path}"` : "path=该图片路径";
  return (
    `⚠️ 核验提示：上面读到数字串 ${list}。等宽数字串是 OCR 最不可靠的地方（前导零漏读、位数多读一位都很常见），` +
    `**不要只用这段文本断定位数或单个数字**。请用 image_inspect（${arg}）交叉验证：` +
    `报告里的「切出字符块数」就是位数，宽度分布能看出哪些是同一族字形，` +
    `封闭空洞数可区分带斜杠的零（2 个）与普通零（1 个）、2（0 个）。`
  );
}
