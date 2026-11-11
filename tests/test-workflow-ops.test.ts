import { describe, it, expect } from "vitest";
import {
  buildEditConfirmRequest,
  deleteRefusalMessage,
  editRefusalMessage,
} from "../src/utils/edit-confirm.ts";
import {
  parseWorkflowGraph,
  pickWorkflowId,
  resolveWorkflow,
  workflowNotFoundMessage,
} from "../src/utils/workflow-ops.ts";

/**
 * 两处「同一件事两份实现」的收敛，各配一组契约测试：
 *  - 文件编辑确认（原先 4 份拷贝，八个字段手抄；漏一个只表现为弹窗少一块内容）
 *  - 工作流查找（原先 2 份，连「找不到」的话术都分叉）
 */

describe("buildEditConfirmRequest：编辑确认载荷", () => {
  const edits = [{ op: "replace", old_text: "a", new_text: "b" }];

  it("有预览 = 编辑：带上 diff/summary/edits（edits 必须原样带上，用户点应用后 Rust 用的就是它）", () => {
    const req = buildEditConfirmRequest({
      tool: "replace_string",
      path: "/tmp/a.md",
      args: { path: "/tmp/a.md" },
      rememberLabel: "本会话不再确认 replace_string",
      preview: { diff: "-a\n+b", summary: "+1 −1" },
      edits,
    });
    expect(req.kind).toBe("edit");
    expect(req.diff).toBe("-a\n+b");
    expect(req.summary).toBe("+1 −1");
    expect(req.edits).toBe(edits);
    expect(req.rememberLabel).toContain("replace_string");
  });

  it("预览里带了 path（Rust 可能展开 ~）→ 以预览为准", () => {
    const req = buildEditConfirmRequest({
      tool: "insert_string",
      path: "~/a.md",
      args: {},
      preview: { path: "/Users/me/a.md", diff: "", summary: "" },
      edits,
    });
    expect(req.path).toBe("/Users/me/a.md");
  });

  it("没有预览 = 删除：不带 diff/edits（弹窗只显示路径）", () => {
    const req = buildEditConfirmRequest({
      tool: "delete_file",
      path: "/tmp/b.md",
      args: { path: "/tmp/b.md" },
    });
    expect(req.kind).toBe("delete");
    expect(req.diff).toBeUndefined();
    expect(req.edits).toBeUndefined();
  });

  it("预览字段缺失时给空串而不是 undefined（弹窗不用处处判空）", () => {
    const req = buildEditConfirmRequest({
      tool: "apply_patch",
      path: "/tmp/c.md",
      args: {},
      preview: {},
      edits,
    });
    expect(req.diff).toBe("");
    expect(req.summary).toBe("");
  });

  it("拒绝话术区分「编辑」与「删除」（模型据此决定下一步）", () => {
    expect(editRefusalMessage("/tmp/a.md")).toContain("文件未改动");
    expect(editRefusalMessage("/tmp/a.md")).toContain("请与用户确认后");
    expect(deleteRefusalMessage("/tmp/a.md")).toContain("文件未删除");
  });
});

describe("pickWorkflowId：名称或 id", () => {
  const list = [
    { id: 3, name: "行业晚报" },
    { id: 7, name: "周报" },
  ];

  it("纯数字一律当 id（可直接引用 id=）", () => {
    expect(pickWorkflowId("7", list)).toBe(7);
    expect(pickWorkflowId("999", list)).toBe(999); // 交给后端判定是否存在
  });

  it("名称精确匹配（不做模糊：执行错工作流的代价是白跑一轮）", () => {
    expect(pickWorkflowId("周报", list)).toBe(7);
    expect(pickWorkflowId("周", list)).toBeNull();
    expect(pickWorkflowId("行业晚报v2", list)).toBeNull();
  });

  it("空串 → null", () => {
    expect(pickWorkflowId("  ", list)).toBeNull();
  });

  it("找不到的话术带下一步提示（模型才知道该干什么）", () => {
    const msg = workflowNotFoundMessage("不存在");
    expect(msg).toContain("workflow_list");
    expect(msg).toContain("workflow_create");
  });
});

describe("parseWorkflowGraph：坏数据给可读错误", () => {
  it("JSON 坏 → 提示去可视化编辑器重存", () => {
    const out = parseWorkflowGraph("{bad", () => null);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain("重新保存");
  });

  it("结构非法 → 把校验器的原因带回", () => {
    const out = parseWorkflowGraph("{}", () => "缺少 start 节点");
    expect(out.ok === false && out.error).toContain("缺少 start 节点");
  });

  it("合法 → 返回解析后的对象（不是字符串）", () => {
    const out = parseWorkflowGraph('{"nodes":[]}', () => null);
    expect(out.ok).toBe(true);
    expect(out.ok && out.graph).toEqual({ nodes: [] });
  });
});

describe("resolveWorkflow：查找 + 解析 + 校验（不抛异常）", () => {
  const rows = new Map([
    [3, { id: 3, name: "行业晚报", graph: '{"nodes":[]}' }],
    [7, { id: 7, name: "坏图", graph: "not json" }],
  ]);
  const deps = {
    get: async (id: number) => rows.get(id) ?? null,
    list: async () => [...rows.values()].map((r) => ({ id: r.id, name: r.name })),
    validate: () => null,
  };

  it("按名称找到并解析成功", async () => {
    const out = await resolveWorkflow("行业晚报", deps);
    expect(out.ok).toBe(true);
    expect(out.ok && out.wf.id).toBe(3);
    expect(out.ok && out.graph).toEqual({ nodes: [] });
  });

  it("按 id 找到", async () => {
    const out = await resolveWorkflow("3", deps);
    expect(out.ok && out.wf.name).toBe("行业晚报");
  });

  it("找不到 → ok:false（不抛异常，调用方才能把它当工具错误回给模型）", async () => {
    const out = await resolveWorkflow("不存在", deps);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain("workflow_list");
  });

  it("图坏了 → ok:false，且错误里带工作流名（知道是哪个坏了）", async () => {
    const out = await resolveWorkflow("坏图", deps);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain("坏图");
  });

  it("空参数 → ok:false", async () => {
    const out = await resolveWorkflow("", deps);
    expect(out.ok).toBe(false);
  });
});
