/**
 * write_stdin 的输入解码：把模型写的「控制字符转义」还原成真实控制码。
 *
 * ## 背景（2026-10-02 实战日志）
 * 本应用自己的提示里就写着「中断用 input="\u0003"（Ctrl-C）」（见 builtin-params /
 * chat.ts 工具说明）。但模型把 `\u0003` 当成**字面量六个字符**放进 JSON：
 * `{"input": "\\u0003"}` → 解析后就是 `\` `u` `0` `0` `0` `3`，PTY 收到的是**文本**。
 * 现象：发完之后进程照旧「仍在运行」，模型的 Ctrl-C 永远打不中，只能反复重发白烧轮次
 * （日志里 session 6 就是这么卡住的）。
 *
 * ## 解码范围（刻意保守）
 * 只还原「解出来是控制字符（0x00~0x1F、0x7F）」的转义：
 *   - `\u0003` / `\x03` → ETX（= Ctrl-C）
 *   - `\u001b` / `\x1b` → ESC（TUI 交互常用）
 *   - `\u{3}` / `\u{1b}` 这类带花括号的写法同样识别
 * 以下**一律保持原样**，避免把正常输入改坏：
 *   - `\n` / `\t`：交互式 REPL 里 `x = "a\nb"` 这种输入必须原样送进去，交给解释器自己解析
 *     （JSON 解出来的真实换行本来就是真字符，无需也不该再动）
 *   - 普通字符的转义（如 `\u4e2d`）：不是控制字符，解码没有收益、只有风险
 *   - 另外认「整串就是 caret 写法」的情况：`^C` / `^D` / `^Z` / `^[`（模型也常这么写中断）
 *
 * 纯函数、零依赖、可单测。
 */

/** caret 写法 → 控制码（只认整串精确匹配，避免把正文里的 "^C" 误当控制符） */
const CARET_TO_CODE: Record<string, number> = {
  "^@": 0x00,
  "^A": 0x01,
  "^B": 0x02,
  "^C": 0x03,
  "^D": 0x04,
  "^E": 0x05,
  "^F": 0x06,
  "^Z": 0x1a,
  "^\\": 0x1c,
  "^^": 0x1e,
  "^_": 0x1f,
  "^[": 0x1b,
  "^]": 0x1d,
};

/** 是否控制字符（C0 控制码 + DEL） */
function isControlCode(cp: number): boolean {
  return (cp >= 0x00 && cp <= 0x1f) || cp === 0x7f;
}

export function decodeTerminalInput(input: unknown): string {
  const s = input == null ? "" : String(input);
  if (!s) return "";

  // caret 写法：整串精确匹配才认（`^c` / `^C` 都接受）
  const caret = CARET_TO_CODE[s.trim().toUpperCase()];
  if (caret !== undefined) return String.fromCharCode(caret);

  return s
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (whole, hex: string) => {
      const cp = parseInt(hex, 16);
      return isControlCode(cp) ? String.fromCharCode(cp) : whole;
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (whole, hex: string) => {
      const cp = parseInt(hex, 16);
      return isControlCode(cp) ? String.fromCharCode(cp) : whole;
    })
    .replace(/\\x([0-9a-fA-F]{2})/g, (whole, hex: string) => {
      const cp = parseInt(hex, 16);
      return isControlCode(cp) ? String.fromCharCode(cp) : whole;
    });
}

/** 输入里是否含「非空白类」控制码（换行/回车/制表符不算）——
 *  用于判断这是不是一次「中断类」写入，好给模型更贴切的反馈。 */
export function hasControlChar(input: unknown): boolean {
  const s = input == null ? "" : String(input);
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? -1;
    if (!isControlCode(cp)) continue;
    if (cp === 0x0a || cp === 0x0d || cp === 0x09) continue; // 空白类控制符不算
    return true;
  }
  return false;
}
