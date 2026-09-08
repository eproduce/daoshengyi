import { it, expect } from "vitest";
import {
  tipText,
  parseTipDelay,
  computeTipRect,
  DEFAULT_TOOLTIP_DELAY,
} from "../src/utils/tooltip.ts";

it("tipText：优先 title，其次 data-orig-title，去首尾空白", () => {
  expect(tipText("提示A", null)).toBe("提示A");
  expect(tipText(null, "原备份B")).toBe("原备份B");
  expect(tipText("titleC", "origC")).toBe("titleC"); // title 优先
  expect(tipText("  带空格  ", null)).toBe("带空格");
  expect(tipText(null, null)).toBe("");
  expect(tipText("", "")).toBe("");
});

it("parseTipDelay：合法非负数字生效，非法/空回退默认", () => {
  expect(parseTipDelay("120", DEFAULT_TOOLTIP_DELAY)).toBe(120);
  expect(parseTipDelay("0", DEFAULT_TOOLTIP_DELAY)).toBe(0);
  expect(parseTipDelay(null, DEFAULT_TOOLTIP_DELAY)).toBe(DEFAULT_TOOLTIP_DELAY);
  expect(parseTipDelay(undefined, DEFAULT_TOOLTIP_DELAY)).toBe(DEFAULT_TOOLTIP_DELAY);
  expect(parseTipDelay("abc", DEFAULT_TOOLTIP_DELAY)).toBe(DEFAULT_TOOLTIP_DELAY);
  expect(parseTipDelay("-5", DEFAULT_TOOLTIP_DELAY)).toBe(DEFAULT_TOOLTIP_DELAY);
  expect(parseTipDelay("1.5", DEFAULT_TOOLTIP_DELAY)).toBe(2); // 四舍五入
});

it("computeTipRect：空间足够时放元素下方居中", () => {
  // 元素：x 100..200，y 200..260；视口 1000x800；浮层 200x40
  const p = computeTipRect(
    { left: 100, top: 200, right: 200, bottom: 260 },
    1000,
    800,
    200,
    40,
  );
  expect(p.above).toBe(false);
  expect(p.top).toBe(260 + 8); // bottom + gap
  expect(p.left).toBe(150); // 中心锚点（translateX(-50%) 后居中）
});

it("computeTipRect：底部空间不足翻到上方", () => {
  // 元素贴近视口底部（bottom=790，剩余 < 浮层高）
  const p = computeTipRect({ left: 100, top: 700, right: 200, bottom: 790 }, 1000, 800, 200, 40);
  expect(p.above).toBe(true);
  expect(p.top).toBe(700 - 8 - 40); // top - gap - estH
});

it("computeTipRect：下方不够翻上方、上方也不够时贴顶（不越界）", () => {
  // 元素上下都不剩空间（近满高）→ 翻上且 top 贴 8 边距
  const p = computeTipRect({ left: 100, top: 2, right: 200, bottom: 790 }, 1000, 800, 200, 40);
  expect(p.above).toBe(true);
  expect(p.top).toBeGreaterThanOrEqual(8);
});

it("computeTipRect：左右夹紧不溢出视口", () => {
  // 元素贴右边缘：中心会超出 → 夹到 (vw - margin - w/2)
  const p = computeTipRect({ left: 900, top: 100, right: 1000, bottom: 160 }, 1000, 800, 200, 40);
  expect(p.left).toBeLessThanOrEqual(1000 - 8 - 200 / 2);
  // 元素贴左边缘：夹到左边界
  const p2 = computeTipRect({ left: 0, top: 100, right: 100, bottom: 160 }, 1000, 800, 200, 40);
  expect(p2.left).toBeGreaterThanOrEqual(8 + 200 / 2);
});
