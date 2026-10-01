import { describe, it, expect } from "vitest";
import { decodeTerminalInput, hasControlChar } from "../src/utils/pty-input.ts";

describe("decodeTerminalInput：write_stdin 控制字符解码", () => {
  // 回归：日志里模型发的就是字面量 "\u0003"（6 个字符），PTY 收到文本 → 进程停不下来
  it("字面量转义 → 真控制码", () => {
    expect(decodeTerminalInput("\\u0003")).toBe("\u0003");
    expect(decodeTerminalInput("\\x03")).toBe("\x03");
    expect(decodeTerminalInput("\\u{3}")).toBe("\u0003");
    expect(decodeTerminalInput("\\u001b")).toBe("\u001b");
  });

  it("caret 写法（整串精确匹配）→ 控制码", () => {
    expect(decodeTerminalInput("^C")).toBe("\u0003");
    expect(decodeTerminalInput("^c")).toBe("\u0003");
    expect(decodeTerminalInput("  ^D  ")).toBe("\u0004");
    expect(decodeTerminalInput("^[")).toBe("\u001b");
  });

  it("普通输入原样保留：真实回车、字面量 \\n、非控制字符转义", () => {
    expect(decodeTerminalInput("ls -la\n")).toBe("ls -la\n");
    // 交互式 REPL 里 `x = "a\nb"` 必须原样送进去，交给解释器自己解析
    expect(decodeTerminalInput('x = "a\\nb"')).toBe('x = "a\\nb"');
    expect(decodeTerminalInput("\\u4e2d")).toBe("\\u4e2d");
    expect(decodeTerminalInput("hello")).toBe("hello");
    expect(decodeTerminalInput("")).toBe("");
    expect(decodeTerminalInput(undefined)).toBe("");
    expect(decodeTerminalInput(null)).toBe("");
  });

  it("混在文本中的控制码逐个还原，不吞掉其它字符", () => {
    expect(decodeTerminalInput("a\\u0003b")).toBe("a\u0003b");
    expect(decodeTerminalInput("\\u0003\\u0003\\u0003")).toBe("\u0003\u0003\u0003");
  });
});

describe("hasControlChar：判断是否「中断类」写入", () => {
  it("认 Ctrl-C / ESC，不认换行、制表符与普通文本", () => {
    expect(hasControlChar("\u0003")).toBe(true);
    expect(hasControlChar("\u001b[A")).toBe(true);
    expect(hasControlChar("ls\n")).toBe(false);
    expect(hasControlChar("echo hi\t")).toBe(false);
    expect(hasControlChar("")).toBe(false);
    expect(hasControlChar(undefined)).toBe(false);
  });
});
