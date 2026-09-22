import { it, expect, describe } from "vitest";
import { layoutWorkflow, DEFAULT_LAYOUT } from "../src/utils/workflow-layout.ts";

// 自动布局是「画布看起来整齐」的唯一保障，且是纯函数 ⇒ 用回归测试钉住几何性质
// （逐层向右、同层不重叠、合流回中线、环/孤岛不丢节点、结果确定可复现）。
describe("工作流自动布局 layoutWorkflow", () => {
  it("链式：逐层向右、同层对齐、间距等于 colGap", () => {
    const pos = layoutWorkflow(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    );
    expect(pos.a.x).toBeLessThan(pos.b.x);
    expect(pos.b.x).toBeLessThan(pos.c.x);
    expect(pos.b.x - pos.a.x).toBe(DEFAULT_LAYOUT.colGap);
    expect(pos.a.y).toBe(pos.b.y);
    expect(pos.b.y).toBe(pos.c.y);
  });

  it("分叉再合流：同层纵向分开、合流节点回到中线", () => {
    const pos = layoutWorkflow(
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
        { source: "b", target: "d" },
        { source: "c", target: "d" },
      ],
    );
    expect(pos.b.x).toBe(pos.c.x); // 同一层 = 同一列
    expect(Math.abs(pos.b.y - pos.c.y)).toBe(DEFAULT_LAYOUT.rowGap); // 纵向不重叠
    expect(pos.d.x).toBeGreaterThan(pos.b.x);
    expect(pos.d.y).toBe(pos.a.y); // 两侧夹一列 → 中线对齐，看起来是「菱形」
  });

  it("同层顺序跟随前驱次序（减少连线交叉）", () => {
    const pos = layoutWorkflow(
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "e" }, { id: "f" }],
      [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
        { source: "b", target: "e" },
        { source: "c", target: "f" },
      ],
    );
    // b 在 c 之前 ⇒ e 在 f 之前（否则两条线必然交叉）
    expect(pos.b.y).toBeLessThan(pos.c.y);
    expect(pos.e.y).toBeLessThan(pos.f.y);
  });

  it("孤岛节点也拿到坐标（同列纵排、互不重叠）", () => {
    const pos = layoutWorkflow([{ id: "x" }, { id: "y" }, { id: "z" }], []);
    expect(pos.x.x).toBe(pos.y.x);
    expect(pos.y.x).toBe(pos.z.x);
    expect(new Set([pos.x.y, pos.y.y, pos.z.y]).size).toBe(3);
  });

  it("有环：不死循环、坐标齐全，环内节点退到末列", () => {
    const pos = layoutWorkflow(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        { source: "a", target: "b" },
        { source: "b", target: "a" }, // 互指成环
        { source: "a", target: "c" },
      ],
    );
    for (const id of ["a", "b", "c"]) {
      expect(Number.isFinite(pos[id].x)).toBe(true);
      expect(Number.isFinite(pos[id].y)).toBe(true);
    }
    expect(pos.b.x).toBe(pos.c.x); // b/c 同层
    expect(pos.b.y).not.toBe(pos.c.y);
    expect(pos.a.x).toBeGreaterThan(pos.b.x); // a 被推到末列，而不是挤在一起
  });

  it("纯环（没有入口节点）也能排出多列，不会全挤在一列", () => {
    const pos = layoutWorkflow(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
        { source: "c", target: "a" },
      ],
    );
    expect(new Set([pos.a.x, pos.b.x, pos.c.x]).size).toBe(3);
  });

  it("忽略悬空边与自环（不产生幽灵节点、不影响层号）", () => {
    const pos = layoutWorkflow(
      [{ id: "a" }, { id: "b" }],
      [
        { source: "a", target: "b" },
        { source: "b", target: "ghost" }, // 目标不存在
        { source: "a", target: "a" }, // 自环
      ],
    );
    expect(Object.keys(pos).sort()).toEqual(["a", "b"]);
    expect(pos.b.x - pos.a.x).toBe(DEFAULT_LAYOUT.colGap);
  });

  it("确定性：同一张图两次布局结果完全一致", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const edges = [
      { source: "a", target: "b" },
      { source: "a", target: "c" },
      { source: "b", target: "d" },
    ];
    expect(layoutWorkflow(nodes, edges)).toEqual(layoutWorkflow(nodes, edges));
  });

  it("可自定义间距与原点", () => {
    const pos = layoutWorkflow([{ id: "a" }, { id: "b" }], [{ source: "a", target: "b" }], {
      colGap: 500,
      rowGap: 200,
      originX: 10,
      originY: 20,
    });
    expect(pos.a).toEqual({ x: 10, y: 20 });
    expect(pos.b).toEqual({ x: 510, y: 20 });
  });

  it("空图不报错", () => {
    expect(layoutWorkflow([], [])).toEqual({});
  });
});
