// OCR 交叉验证提示单测：核心是「该提示时才提示、不该提示时安静」——
// 每次 OCR 都加一段废话会污染上下文，而漏提示则正是当初数错位数的原因。
import { describe, it, expect } from "vitest";
import {
  extractSerialCandidates,
  ocrCrossCheckHint,
  isSerialCandidate,
  SERIAL_MIN_CHARS,
} from "../src/utils/ocr-advice";

describe("extractSerialCandidates", () => {
  it("抓出足够长的数字串", () => {
    expect(extractSerialCandidates("证书编号 00219813")).toEqual(["00219813"]);
  });

  it("支持分组写法（- / .）与全角数字", () => {
    expect(extractSerialCandidates("单号 1234-5678")).toEqual(["1234-5678"]);
    expect(extractSerialCandidates("订单 １２３４５６７")).toEqual(["１２３４５６７"]);
  });

  it("空格不是分隔符：不得把无关数字粘成候选（真实踩到的误拼）", () => {
    // 若把空格当分隔符，这里会得到带垃圾前缀的 “1 10001”
    const got = extractSerialCandidates("A1 10001 B 10002 C 10003 D 10004 E 10001");
    expect(got).toEqual(["10001", "10002", "10003"]);
    expect(got.some((s) => s.includes(" "))).toBe(false);
    expect(extractSerialCandidates("共 123 条 456 项 78901")).toEqual(["78901"]);
  });

  it("4 位只在前导零时才算候选（零填充码是 OCR 软肋，年号不是编号）", () => {
    expect(extractSerialCandidates("编号 0002")).toEqual(["0002"]);
    expect(extractSerialCandidates("2026 年")).toEqual([]);
    expect(extractSerialCandidates("编号 1234")).toEqual([]);
    expect(SERIAL_MIN_CHARS).toBe(5);
    expect(isSerialCandidate("0002")).toBe(true);
    expect(isSerialCandidate("1234")).toBe(false);
    expect(isSerialCandidate("12345")).toBe(true);
    expect(isSerialCandidate("123")).toBe(false);
  });

  it("日期形状不当编号（避免每次读到日期都提示）", () => {
    expect(extractSerialCandidates("生成于 2026-09-17")).toEqual([]);
    expect(extractSerialCandidates("修订 2026.09.17 版")).toEqual([]);
  });

  it("去重且最多 3 条，顺序保持出现顺序", () => {
    expect(extractSerialCandidates("A 10001 B 10002 C 10003 D 10004 E 10001")).toEqual([
      "10001",
      "10002",
      "10003",
    ]);
  });

  it("空/非法输入安全", () => {
    expect(extractSerialCandidates("")).toEqual([]);
    expect(extractSerialCandidates(null)).toEqual([]);
    expect(extractSerialCandidates(undefined)).toEqual([]);
  });
});

describe("ocrCrossCheckHint", () => {
  it("有数字串 → 给出可执行的 image_inspect 建议并带上路径", () => {
    const h = ocrCrossCheckHint("像素编号 00219813", "/tmp/num.png");
    expect(h).toContain("00219813");
    expect(h).toContain("image_inspect");
    expect(h).toContain('path="/tmp/num.png"');
    expect(h).toContain("切出字符块数");
  });

  it("没有数字串 → 空串（纯文字/普通描述不加提示）", () => {
    expect(ocrCrossCheckHint("这是一张风景照片，有山和水", "/tmp/a.png")).toBe("");
    expect(ocrCrossCheckHint("共 12 项", "/tmp/a.png")).toBe("");
    expect(ocrCrossCheckHint("发布 2026 年 9 月", "/tmp/a.png")).toBe("");
    expect(ocrCrossCheckHint("", "/tmp/a.png")).toBe("");
  });

  it("只有数字串时才提示一次（多个数字串合并进同一条）", () => {
    const h = ocrCrossCheckHint("编号 00219813 与 87654321", "/tmp/a.png");
    expect(h.match(/image_inspect/g)?.length).toBe(1);
    expect(h).toContain("00219813");
    expect(h).toContain("87654321");
  });

  it("缺 path 时用占位说明，不编造路径", () => {
    const h = ocrCrossCheckHint("编号 00219813");
    expect(h).toContain("该图片路径");
    expect(h).not.toContain("/tmp");
  });
});
