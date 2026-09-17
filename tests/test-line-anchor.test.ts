import { describe, it, expect } from "vitest";
import {
  ANCHOR_TOLERANCE,
  annotateLines,
  findHash,
  formatAnchoredLine,
  hasAnchorPrefix,
  hashAt,
  hashLine,
  occurrenceForAnchor,
  parseAnchor,
  parseAnchoredLine,
  stripAnchorPrefix,
  toLines,
  verifyAnchor,
} from "../src/utils/line-anchor";

const FILE = [
  'import { ref } from "vue";', // 1
  "", // 2
  "export function useThing() {", // 3
  "  const a = 1;", // 4
  "  return a;", // 5
  "}",
].join("\n");

describe("P1-2 行锚点 · 哈希", () => {
  it("3 字符、稳定可复现", () => {
    const h = hashLine("  const a = 1;");
    expect(h).toMatch(/^[0-9a-z]{3}$/);
    expect(hashLine("  const a = 1;")).toBe(h);
    // 相同输入必须相同（跨调用稳定）
    expect(new Set([h, hashLine("  const a = 1;")]).size).toBe(1);
  });

  it("只看正文：前后空白/缩进变化不失效，内容变化一定失效", () => {
    expect(hashLine("  foo  ")).toBe(hashLine("foo"));
    expect(hashLine("\tfoo")).toBe(hashLine("foo"));
    expect(hashLine("foo")).not.toBe(hashLine("foa"));
    expect(hashLine("foo")).not.toBe(hashLine("foo()"));
  });

  it("空行也有哈希（空行锚点同样可用）", () => {
    expect(hashLine("")).toBe(hashLine("   "));
    expect(hashLine("")).toMatch(/^[0-9a-z]{3}$/);
  });
});

describe("P1-2 行锚点 · 格式化与解析", () => {
  it("formatAnchoredLine 产出 `行号#哈希| 内容`", () => {
    // 注意：内容原样保留（含自身缩进），前缀后固定一个空格
    expect(formatAnchoredLine(42, "  const x = 1;")).toMatch(/^42#[0-9a-z]{3}\| {3}const x = 1;$/);
    expect(formatAnchoredLine(1, "")).toMatch(/^1#[0-9a-z]{3}\| $/);
  });

  it("annotateLines 从 startLine 起编号（片段读取也能对齐真实行号）", () => {
    const out = annotateLines("a\nb", 10).split("\n");
    expect(parseAnchoredLine(out[0])?.line).toBe(10);
    expect(parseAnchoredLine(out[1])?.line).toBe(11);
    expect(parseAnchoredLine(out[0])?.content).toBe("a");
    expect(annotateLines("x").startsWith("1#")).toBe(true);
    // 非法 startLine 退化到 1，不崩
    expect(annotateLines("x", -5).startsWith("1#")).toBe(true);
  });

  it("parseAnchor 接受锚点串与完整锚点行，拒绝垃圾输入", () => {
    expect(parseAnchor("42#a7f")).toEqual({ line: 42, hash: "a7f" });
    expect(parseAnchor(" 42 # A7F| 内容")).toEqual({ line: 42, hash: "a7f" });
    expect(parseAnchor("42")).toBeNull();
    expect(parseAnchor("0#abc")).toBeNull();
    expect(parseAnchor("42#ab")).toBeNull();
    expect(parseAnchor(undefined)).toBeNull();
    expect(parseAnchor({ line: 1 })).toBeNull();
  });

  it("parseAnchoredLine 往返一致；非锚点行返回 null", () => {
    const line = formatAnchoredLine(7, "");
    const parsed = parseAnchoredLine(line);
    expect(parsed).toEqual({ line: 7, hash: hashLine(""), content: "" });
    expect(parseAnchoredLine("普通一行")).toBeNull();
    expect(parseAnchoredLine("7#abc 缺竖线")).toBeNull();
    // 内容里再有竖线也要完整保留
    expect(parseAnchoredLine(formatAnchoredLine(3, "a | b | c"))?.content).toBe("a | b | c");
  });

  it("stripAnchorPrefix 去掉模型误抄的锚点前缀", () => {
    const copied = `${formatAnchoredLine(1, 'import { ref } from "vue";')}\n${formatAnchoredLine(2, "")}`;
    expect(hasAnchorPrefix(copied)).toBe(true);
    expect(stripAnchorPrefix(copied)).toBe('import { ref } from "vue";\n');
    // 没有前缀时原样返回
    expect(hasAnchorPrefix("plain")).toBe(false);
    expect(stripAnchorPrefix("plain")).toBe("plain");
    expect(stripAnchorPrefix("")).toBe("");
  });
});

describe("P1-2 行锚点 · 校验", () => {
  const lines = toLines(FILE);

  it("锚点行未变 → 通过", () => {
    const v = verifyAnchor(lines, { line: 4, hash: hashLine(lines[3]) });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.line).toBe(4);
      expect(v.hash).toBe(hashLine("  const a = 1;"));
    }
  });

  it("内容变了但哈希在附近 → 判为过期并给出新行号（不自动改）", () => {
    // 顶部插入两行 → 原来的第 4 行变成第 6 行
    const drifted = toLines(`// 新增注释 1\n// 新增注释 2\n${FILE}`);
    const v = verifyAnchor(drifted, { line: 4, hash: hashLine("  const a = 1;") });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("stale");
      expect(v.foundLine).toBe(6);
      expect(v.message).toContain("锚点已过期");
      expect(v.message).toContain("第 6 行");
    }
  });

  it("内容被替换（片段已不存在）→ 判为 gone，要求重新读取", () => {
    const changed = toLines(FILE.replace("  const a = 1;", "  const a = 42;"));
    const v = verifyAnchor(changed, { line: 4, hash: hashLine("  const a = 1;") });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("gone");
      expect(v.message).toContain("重新 read_file");
    }
  });

  it("行号超出文件范围 → out_of_range（文件被截短）", () => {
    const v = verifyAnchor(lines, { line: 999, hash: "abc" });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("out_of_range");
      expect(v.message).toContain("超出文件范围");
    }
  });

  it("findHash 由近及远搜索，超过容差就放弃", () => {
    // 第 100 行的锚点，哈希实际在第 3 行 → 距离 97 > 容差
    const long = toLines(
      [...Array(120)].map((_, i) => (i === 2 ? "target" : `line${i}`)).join("\n"),
    );
    expect(findHash(long, hashLine("target"), 100)).toBeNull();
    // 距离在容差内 → 找到且标注非 exact
    const near = toLines(
      [...Array(120)].map((_, i) => (i === 100 ? "target" : `line${i}`)).join("\n"),
    );
    const found = findHash(near, hashLine("target"), 110);
    expect(found).toEqual({ line: 101, exact: false });
    expect(ANCHOR_TOLERANCE).toBe(30);
    // 正好在锚点行 → exact
    expect(findHash(near, hashLine("target"), 101)).toEqual({ line: 101, exact: true });
  });

  it("hashAt 越界返回 null（不抛异常）", () => {
    expect(hashAt(lines, 1)).toBe(hashLine(lines[0]));
    expect(hashAt(lines, 0)).toBeNull();
    expect(hashAt(lines, lines.length + 1)).toBeNull();
  });
});

describe("P1-2 行锚点 · 用锚点消歧 old_text 的多处出现", () => {
  // `  const a = 1;` 出现两次（第 4 行与第 9 行）
  const dup = toLines(
    [
      "export function a() {", // 1
      "  const x = 0;", // 2
      "  // 段落一", // 3
      "  const a = 1;", // 4
      "  return a;", // 5
      "}", // 6
      "export function b() {", // 7
      "  // 段落二", // 8
      "  const a = 1;", // 9
      "  return a;", // 10
      "}",
    ].join("\n"),
  );
  const oldText = "  const a = 1;";

  it("锚点在第 4 行 → 第 1 次出现；锚点在第 9 行 → 第 2 次出现", () => {
    expect(occurrenceForAnchor(dup, 3, oldText)).toBe(1);
    expect(occurrenceForAnchor(dup, 8, oldText)).toBe(2);
  });

  it("锚点在某些出现之后 → 取「之前的最后一次」", () => {
    // 锚点在第 7 行（第 1 次出现之后、第 2 次之前）→ 仍是第 1 次
    expect(occurrenceForAnchor(dup, 6, oldText)).toBe(1);
    // 锚点在第 11 行（最后一次之后）→ 第 2 次
    expect(occurrenceForAnchor(dup, 10, oldText)).toBe(2);
  });

  it("old_text 一处都没有 → null（交回文本匹配报错）；空 old_text 也返回 null", () => {
    expect(occurrenceForAnchor(dup, 3, "  const zzz = 9;")).toBeNull();
    expect(occurrenceForAnchor(dup, 3, "")).toBeNull();
  });

  it("多行 old_text 也能定位（按起始偏移比较）", () => {
    const multi = "  const a = 1;\n  return a;";
    expect(occurrenceForAnchor(dup, 3, multi)).toBe(1);
    expect(occurrenceForAnchor(dup, 8, multi)).toBe(2);
  });

  it("锚点在所有出现之前 → 取第 1 次（最近的合理选择）", () => {
    expect(occurrenceForAnchor(dup, 0, oldText)).toBe(1);
  });
});
