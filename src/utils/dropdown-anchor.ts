// 下拉面板贴在工具栏 pill 上时的**边界处理**（纯计算，便于单测）。
//
// 起因（用户实测）：输入栏最右那个「工作区」pill 的下拉面板用的是 `left: 0` 左对齐，
// 又没有高度上限——pill 靠窗口右侧时面板直接顶出窗口右边；窗口矮时面板上沿也会跑出窗口顶部。
// 这类「贴着触发元素展开、但不能越过视口」的判定应该算出来，而不是写死一个方向。

/** 面板展开方向：left = 从 pill 左缘向右展开；right = 从 pill 右缘向左展开 */
export type DropdownAnchor = "left" | "right";

/** 与视口边缘至少留出的空隙（px） */
export const DROPDOWN_EDGE_MARGIN = 8;

/** 面板最小可用高度（px）：再挤也别低于这个值，否则内容没法看 */
export const DROPDOWN_MIN_HEIGHT = 220;

/**
 * 选展开方向：默认向右（left），右边放不下就往左展开（right）。
 * 两边都放不下时（面板比视口还宽）取**溢出更少**的那一侧；相等则用 left。
 */
export function chooseDropdownAnchor(opts: {
  pillLeft: number;
  pillRight: number;
  viewportWidth: number;
  panelWidth: number;
}): DropdownAnchor {
  const { pillLeft, pillRight, viewportWidth, panelWidth } = opts;
  if (!Number.isFinite(panelWidth) || panelWidth <= 0) return "left";
  const limit = viewportWidth - DROPDOWN_EDGE_MARGIN;
  const overflowLeft = Math.max(0, pillLeft + panelWidth - limit); // 向右展开时会超出多少
  const overflowRight = Math.max(0, DROPDOWN_EDGE_MARGIN - (pillRight - panelWidth)); // 向左展开时会超出多少
  if (overflowLeft === 0) return "left";
  if (overflowRight === 0) return "right";
  return overflowRight < overflowLeft ? "right" : "left";
}

/**
 * 面板的最大高度：它从 pill **上方**展开（`bottom: 100%`），所以可用空间 = pill 顶部到视口顶部的距离。
 * 不给上限时，窗口一矮面板就顶出窗口（用户实测的第二个症状）。
 */
export function dropdownMaxHeight(
  pillTop: number,
  minHeight: number = DROPDOWN_MIN_HEIGHT,
  margin: number = DROPDOWN_EDGE_MARGIN,
): number {
  if (!Number.isFinite(pillTop)) return minHeight;
  return Math.max(Math.floor(minHeight), Math.floor(pillTop - margin));
}
