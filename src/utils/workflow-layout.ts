// 工作流画布自动布局（纯函数，可单测）
//
// 为什么需要：手搭/导入的图节点位置是「拖到哪算哪」，很容易挤成一团或叠在一起；
// 模板作者手写的坐标也只在最初那版好看。这里给一个**确定性**的分层布局：
//   ① 按拓扑层级分列（从左到右）：层号 = 从入口节点到它的最长路径长度
//   ② 同层内按「前驱重心」排一趟（减少连线交叉；上一层已排定，故只需一趟）
//   ③ 各列纵向居中（列内节点少的整体下移），列间/行间留固定间距
// 环与断链都不会挂：Kahn 排不进去的节点（环内节点）统一退到末列之后，仍拿到坐标。
// 同一张图必得同一结果（不依赖随机数/时间），所以可以放心做自动应用与回归测试。

export interface LayoutOptions {
  /** 列间距（层与层之间，像素） */
  colGap?: number;
  /** 同层节点纵向间距（像素） */
  rowGap?: number;
  /** 首个层级的左上角起点 */
  originX?: number;
  originY?: number;
}

/** 默认间距：节点宽约 160-200px、高约 60px（WorkflowNodeView），留足空隙不重叠。 */
export const DEFAULT_LAYOUT: Required<LayoutOptions> = {
  colGap: 300,
  rowGap: 150,
  originX: 80,
  originY: 80,
};

/**
 * 计算每个节点的新坐标（`id → {x, y}`）。
 * @param nodes 只用到 `id`（传 WorkflowNode[] 或 `{id}[]` 均可）
 * @param edges 只用到 `source`/`target`
 */
export function layoutWorkflow(
  nodes: readonly { id: string }[],
  edges: readonly { source: string; target: string }[],
  opts: LayoutOptions = {},
): Record<string, { x: number; y: number }> {
  const { colGap, rowGap, originX, originY } = { ...DEFAULT_LAYOUT, ...opts };
  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  // 忽略悬空边与自环（自环在布局上没有意义，但会让入度永远减不到 0）
  const valid = edges.filter(
    (e) => known.has(e.source) && known.has(e.target) && e.source !== e.target,
  );

  const preds = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const id of ids) {
    preds.set(id, []);
    indeg.set(id, 0);
  }
  for (const e of valid) {
    preds.get(e.target)!.push(e.source);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }

  // ① Kahn 求最长路径层级：按输入顺序处理入度为 0 的节点 ⇒ 结果稳定可复现
  const level = new Map<string, number>();
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const placed = new Set<string>();
  // 整图都是环（没有任何入度为 0 的节点）时用第一个节点强行破环：
  // 否则排不进队列 → 全部节点会挤到同一列，看起来像「没排」。
  if (queue.length === 0 && ids.length > 0) queue.push(ids[0]);
  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi];
    // 破环种子没走「入度减到 0」的路径，可能被再次入队 → 跳过重复处理，
    // 否则它的层号会被自己抬高一次，前后次序就颠倒了。
    if (placed.has(id)) continue;
    placed.add(id);
    for (const e of valid) {
      if (e.source !== id) continue;
      level.set(e.target, Math.max(level.get(e.target) ?? 0, (level.get(id) ?? 0) + 1));
      indeg.set(e.target, (indeg.get(e.target) ?? 1) - 1);
      if (indeg.get(e.target) === 0) queue.push(e.target);
    }
  }
  // 环内节点：Kahn 排不进去 → 统一放末列之后（按输入顺序纵向排列），保证不死循环
  const maxLevel = Math.max(0, ...ids.map((id) => level.get(id) ?? 0));
  const tailLevel = maxLevel + 1;
  for (const id of ids) {
    if (!placed.has(id)) level.set(id, tailLevel);
  }

  // ② 分层 + 前驱重心排序（减少交叉）
  const byLevel = new Map<number, string[]>();
  for (const id of ids) {
    const l = level.get(id) ?? 0;
    if (!byLevel.has(l)) byLevel.set(l, []);
    byLevel.get(l)!.push(id);
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  const inputIndex = new Map(ids.map((id, i) => [id, i]));
  const indexInLevel = new Map<string, number>();
  for (const l of levels) {
    const at = byLevel.get(l)!;
    if (l !== levels[0]) {
      const bary = new Map<string, number>();
      at.forEach((id, i) => {
        const ps = preds
          .get(id)!
          .map((p) => indexInLevel.get(p))
          .filter((v): v is number => v !== undefined);
        bary.set(id, ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : i);
      });
      at.sort((a, b) => bary.get(a)! - bary.get(b)! || inputIndex.get(a)! - inputIndex.get(b)!);
    }
    at.forEach((id, i) => indexInLevel.set(id, i));
  }

  // ③ 落坐标：各列纵向居中
  const maxCount = Math.max(1, ...levels.map((l) => byLevel.get(l)!.length));
  const out: Record<string, { x: number; y: number }> = {};
  levels.forEach((l, li) => {
    const at = byLevel.get(l)!;
    const offset = ((maxCount - at.length) * rowGap) / 2;
    at.forEach((id, i) => {
      out[id] = { x: originX + li * colGap, y: originY + offset + i * rowGap };
    });
  });
  return out;
}
