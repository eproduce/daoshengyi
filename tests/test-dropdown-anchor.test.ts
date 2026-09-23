import { it, expect } from "vitest";
import {
  DROPDOWN_EDGE_MARGIN,
  DROPDOWN_MIN_HEIGHT,
  chooseDropdownAnchor,
  dropdownMaxHeight,
} from "../src/utils/dropdown-anchor.ts";

// 场景（用户实测）：输入栏最右的「工作区」pill，下拉面板左对齐 + 无高度上限 →
// 靠右时顶出窗口右边、窗口矮时顶出窗口顶部。这两个判定必须算出来，故钉成单测。

it("选方向：右边放得下就向右展开（靠左/居中的 pill 保持原行为）", () => {
  expect(
    chooseDropdownAnchor({ pillLeft: 100, pillRight: 200, viewportWidth: 1200, panelWidth: 360 }),
  ).toBe("left");
  // 刚好卡在边界（余量正好等于 margin）
  expect(
    chooseDropdownAnchor({
      pillLeft: 1200 - DROPDOWN_EDGE_MARGIN - 360,
      pillRight: 900,
      viewportWidth: 1200,
      panelWidth: 360,
    }),
  ).toBe("left");
});

it("选方向：右边放不下就改成向左展开（窗口右缘贴边的 pill）", () => {
  expect(
    chooseDropdownAnchor({ pillLeft: 900, pillRight: 1000, viewportWidth: 1200, panelWidth: 360 }),
  ).toBe("right");
  expect(
    chooseDropdownAnchor({ pillLeft: 1100, pillRight: 1190, viewportWidth: 1200, panelWidth: 360 }),
  ).toBe("right");
});

it("选方向：两边都放不下时取溢出更少的一侧", () => {
  // 极端情况：面板（480）比视口（500）还窄不了多少，怎么放都溢出 → 选溢出更少的一侧
  const extreme = { viewportWidth: 500, panelWidth: 480 };
  // pill 靠左：向右展开只溢出 8px，向左展开要溢出 308px → 仍是 left
  expect(chooseDropdownAnchor({ ...extreme, pillLeft: 20, pillRight: 180 })).toBe("left");
  // pill 靠右：向左展开只溢出 8px，向右展开溢出 288px → right
  expect(chooseDropdownAnchor({ ...extreme, pillLeft: 300, pillRight: 480 })).toBe("right");
});

it("选方向：面板宽度未知（未测量）时保守用 left", () => {
  expect(
    chooseDropdownAnchor({ pillLeft: 900, pillRight: 1000, viewportWidth: 1200, panelWidth: 0 }),
  ).toBe("left");
  expect(
    chooseDropdownAnchor({
      pillLeft: 900,
      pillRight: 1000,
      viewportWidth: 1200,
      panelWidth: Number.NaN,
    }),
  ).toBe("left");
});

it("最大高度：取 pill 顶部到视口顶部的距离，但不低于最小值", () => {
  // 窗口够高 → 用实际可用空间（顶到视口上方留 margin）
  expect(dropdownMaxHeight(900)).toBe(900 - DROPDOWN_EDGE_MARGIN);
  // 窗口矮（pill 离顶很近）→ 不低于最小值，宁可内部滚动也不能挤成一条
  expect(dropdownMaxHeight(120)).toBe(DROPDOWN_MIN_HEIGHT);
  expect(dropdownMaxHeight(0)).toBe(DROPDOWN_MIN_HEIGHT);
  // 异常输入不产生 NaN（会让内联 style 失效）
  expect(dropdownMaxHeight(Number.NaN)).toBe(DROPDOWN_MIN_HEIGHT);
  expect(Number.isFinite(dropdownMaxHeight(1234.56))).toBe(true);
});
