// read_file 分段读取单测：越界/截断/行号对齐必须是**显式**的，
// 因为这些正是真实使用里被静默忽略、导致模型改用 awk 绕过的地方。
import { describe, it, expect } from "vitest";
import { sliceFileLines, isWholeFile, READ_FILE_MAX_CHARS } from "../src/utils/file-slice";

const mkLines = (n: number, prefix = "行") =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join("\n");

describe("sliceFileLines 基本分段", () => {
  const file = mkLines(100);

  it("不给 offset/length → 整文件（行号 1~N）", () => {
    const r = sliceFileLines(file);
    expect(r.startLine).toBe(1);
    expect(r.endLine).toBe(100);
    expect(r.totalLines).toBe(100);
    expect(r.text.split("\n")).toHaveLength(100);
    expect(r.note).toBe("");
    expect(isWholeFile(r)).toBe(true);
  });

  it("offset 是 1 基行号，length 是行数（不是字符数）", () => {
    const r = sliceFileLines(file, { offset: 60, length: 75 });
    expect(r.startLine).toBe(60);
    // 60 起 75 行 → 但文件只有 100 行，夹到尾
    expect(r.endLine).toBe(100);
    expect(r.text.split("\n")[0]).toBe("行60");
    expect(r.text.split("\n")).toHaveLength(41);
    expect(r.charTruncated).toBe(false);
  });

  it("中间一段：首尾行内容对应真实行号", () => {
    const r = sliceFileLines(file, { offset: 10, length: 3 });
    expect(r.text).toBe("行10\n行11\n行12");
    expect(r.startLine).toBe(10);
    expect(r.endLine).toBe(12);
    expect(isWholeFile(r)).toBe(false);
  });

  it("只给 offset（无 length）→ 读到文件末尾", () => {
    const r = sliceFileLines(file, { offset: 98 });
    expect(r.text).toBe("行98\n行99\n行100");
    expect(r.endLine).toBe(100);
  });

  it("length 为 0/负数/非法 → 视作读到末尾（不返回空）", () => {
    for (const bad of [0, -5, "abc", null, undefined, {}]) {
      const r = sliceFileLines(file, { offset: 99, length: bad });
      expect(r.text).toBe("行99\n行100");
    }
  });

  it("数字字符串也能用（模型常传 \"60\"）", () => {
    const r = sliceFileLines(file, { offset: "60", length: "2" });
    expect(r.text).toBe("行60\n行61");
  });

  it("小数/ Infinity 不猜：Infinity 视作缺省，小数向下取整", () => {
    expect(sliceFileLines(file, { offset: 5.9, length: 1 }).startLine).toBe(5);
    const r = sliceFileLines(file, { offset: Infinity, length: 2 });
    expect(r.startLine).toBe(1);
    expect(r.endLine).toBe(2);
  });
});

describe("sliceFileLines 越界与夹取", () => {
  const file = mkLines(10);

  it("offset 超出文件 → outOfRange 且不返回内容（不许假装读到了）", () => {
    const r = sliceFileLines(file, { offset: 11 });
    expect(r.outOfRange).toBe(true);
    expect(r.text).toBe("");
    expect(r.totalLines).toBe(10);
    // 提示里必须给出文件真实行数，模型才知道能取到哪
    expect(r.note).toContain("超出文件范围");
    expect(r.note).toContain("共 10 行");
  });

  it("offset 恰好等于总行数 → 合法（最后一行）", () => {
    const r = sliceFileLines(file, { offset: 10 });
    expect(r.outOfRange).toBe(false);
    expect(r.text).toBe("行10");
  });

  it("offset <1 夹到第 1 行并明确说明", () => {
    const r = sliceFileLines(file, { offset: 0 });
    expect(r.startLine).toBe(1);
    expect(r.clampedStart).toBe(true);
    expect(r.note).toContain("已按第 1 行处理");
    const r2 = sliceFileLines(file, { offset: -3 });
    expect(r2.startLine).toBe(1);
    expect(r2.clampedStart).toBe(true);
  });

  it("总行数按 split 算（末尾换行算一行，与编辑器行号一致）", () => {
    expect(sliceFileLines("a\n").totalLines).toBe(2);
    expect(sliceFileLines("a").totalLines).toBe(1);
  });

  it("空内容仍可用（不抛异常）", () => {
    const r = sliceFileLines("");
    expect(r.totalLines).toBe(1);
    expect(r.text).toBe("");
    expect(r.outOfRange).toBe(false);
  });

  it("非字符串输入当作空内容（不抛异常）", () => {
    expect(sliceFileLines(null).totalLines).toBe(1);
    expect(sliceFileLines(123 as unknown).text).toBe("");
  });
});

describe("sliceFileLines 字符上限（按整行截断）", () => {
  const file = mkLines(50);

  it("超上限时只收整行，并告知续读 offset", () => {
    const r = sliceFileLines(file, { maxChars: 20 });
    // 每行 3 字符（"行1" 是 2 字符 + 换行，按 length 计）
    expect(r.charTruncated).toBe(true);
    expect(r.nextOffset).toBe(r.endLine + 1);
    expect(r.note).toContain("单次返回上限 20 字符");
    expect(r.note).toContain(`offset=${r.nextOffset}`);
    // 返回内容绝不超过上限
    expect(r.text.length).toBeLessThanOrEqual(20);
  });

  it("续读接得上：offset=nextOffset 拿到的首行就是上次的下一个行", () => {
    const first = sliceFileLines(file, { maxChars: 20 });
    const next = sliceFileLines(file, { offset: first.nextOffset!, maxChars: 20 });
    expect(next.text.split("\n")[0]).toBe(`行${first.endLine + 1}`);
  });

  it("首行本身就超上限 → 该行按字符截断并标记 partialLine", () => {
    const r = sliceFileLines(`x${"y".repeat(100)}\n第二行`, { maxChars: 10 });
    expect(r.partialLine).toBe(true);
    expect(r.endLine).toBe(1);
    expect(r.text).toBe("xyyyyyyyyy");
    expect(r.note).toContain("按字符截断");
  });

  it("刚好装满不算截断（边界不误报）", () => {
    // 两行刚好 4 字符： "a"+"\n"+"b" = 3 <= 3
    const r = sliceFileLines("a\nb", { maxChars: 3 });
    expect(r.charTruncated).toBe(false);
    expect(r.text).toBe("a\nb");
    expect(r.note).toBe("");
  });

  it("默认上限是 READ_FILE_MAX_CHARS（12000）", () => {
    expect(READ_FILE_MAX_CHARS).toBe(12000);
    const big = Array.from({ length: 100 }, () => "z".repeat(1000)).join("\n");
    const r = sliceFileLines(big);
    expect(r.charTruncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(READ_FILE_MAX_CHARS);
  });

  it("越界时即使给了 maxChars 也不返回内容", () => {
    const r = sliceFileLines(mkLines(3), { offset: 99, maxChars: 10 });
    expect(r.outOfRange).toBe(true);
    expect(r.text).toBe("");
    expect(r.nextOffset).toBeNull();
  });
});

describe("isWholeFile", () => {
  it("整文件一次读完才为 true", () => {
    expect(isWholeFile(sliceFileLines("a\nb\nc"))).toBe(true);
    expect(isWholeFile(sliceFileLines("a\nb\nc", { offset: 2 }))).toBe(false);
    expect(isWholeFile(sliceFileLines("a\nb\nc", { length: 2 }))).toBe(false);
    expect(isWholeFile(sliceFileLines("a\nb\nc", { maxChars: 2 }))).toBe(false);
  });
});
