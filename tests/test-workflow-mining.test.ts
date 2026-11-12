import { it, expect, describe } from "vitest";
import {
  shouldMineWorkflow,
  buildMiningPrompt,
  parseMinedGraph,
  minedWorkflowName,
  repairModelGraph,
  MIN_WORK_TOOLS,
  type MinedToolStep,
} from "../src/utils/workflow-mining.ts";
import { validateWorkflowGraph } from "../src/utils/workflow-engine.ts";

const step = (name: string, status = "done"): MinedToolStep => ({ name, status });

describe("工作流沉淀门控 shouldMineWorkflow", () => {
  it("实际工作工具 ≥3 且无失败时才沉淀", () => {
    expect(
      shouldMineWorkflow([step("read_file"), step("replace_string"), step("run_tests")]).ok,
    ).toBe(true);
  });

  it("不足 3 个实际工作工具 → 不沉淀", () => {
    const r = shouldMineWorkflow([step("read_file"), step("replace_string")]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(`≥${MIN_WORK_TOOLS}`);
  });

  it("规划/记忆/工作流自身管理不计入实际工作", () => {
    const r = shouldMineWorkflow([
      step("plan_task"),
      step("plan_update"),
      step("memory_save"),
      step("workflow_list"),
      step("read_file"),
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("实际工作工具仅 1 个");
  });

  it("存在失败工具 → 不沉淀（失败流程没有复用价值）", () => {
    const r = shouldMineWorkflow([
      step("read_file"),
      step("replace_string", "error"),
      step("run_tests"),
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("replace_string");
  });

  it("同一工具重复调用（批量操作）→ 不沉淀", () => {
    const r = shouldMineWorkflow([step("read_file"), step("read_file"), step("read_file")]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("单一工具");
  });
});

describe("工作流命名 minedWorkflowName", () => {
  it("确定性：同一目标得到同名（workflow_save 会覆盖更新而非堆积）", () => {
    expect(minedWorkflowName("修复报告的响应式适配")).toBe(
      minedWorkflowName("修复报告的响应式适配"),
    );
  });

  it("压平空白、去掉引号类字符并限长", () => {
    const n = minedWorkflowName("  生成「月度  简报」  ");
    expect(n).toBe("自动沉淀：生成月度 简报");
    const long = minedWorkflowName("一".repeat(60));
    expect(long.length).toBeLessThan(40);
    expect(long.endsWith("…")).toBe(true);
  });

  it("空目标有兜底名", () => {
    expect(minedWorkflowName("")).toBe("自动沉淀：未命名流程");
  });
});

describe("抽取提示词 buildMiningPrompt", () => {
  const prompt = buildMiningPrompt("把附件表格整理成日报", [
    { name: "read_file", server: "app", argsPreview: '{"path":"/tmp/a.xlsx"}' },
    { name: "write_file", server: "app", argsPreview: '{"path":"/tmp/r.md"}' },
    { name: "web_search", server: "app", argsPreview: '{"query":"行业数据"}' },
  ]);

  it("带上目标与工具序列（含参数）", () => {
    expect(prompt).toContain("把附件表格整理成日报");
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("web_search");
    expect(prompt).toContain("/tmp/a.xlsx");
  });

  it("明确节点类型、占位符与「只输出 JSON」约束", () => {
    expect(prompt).toContain("text/llm/tool/condition/code/end");
    expect(prompt).toContain("{{user}}");
    expect(prompt).toContain("只输出工作流 JSON");
    // 明确排除规划/记忆类动作，避免沉淀出无复用价值的节点
    expect(prompt).toContain("plan_task");
  });
});

describe("模型输出解析 parseMinedGraph", () => {
  it("解析裸 JSON 并补齐坐标/id/label/config", () => {
    const g = parseMinedGraph('{"nodes":[{"id":"n1","type":"tool","label":"抓取"}],"edges":[]}');
    expect(g).not.toBeNull();
    expect(g!.nodes[0].x).toBeTypeOf("number");
    expect(g!.nodes[0].y).toBeTypeOf("number");
    expect(g!.nodes[0].config).toEqual({});
  });

  it("容忍 markdown 代码块与前后解释文本", () => {
    const raw =
      "好的，这是抽象出的工作流：\n```json\n" +
      '{"nodes":[{"id":"a","type":"llm","label":"规划","config":{"prompt":"x"}}],"edges":[]}\n' +
      "```\n以上。";
    const g = parseMinedGraph(raw);
    expect(g).not.toBeNull();
    expect(g!.nodes[0].label).toBe("规划");
  });

  it("JSON 后附带的解释里含花括号也不会截断（按括号平衡取对象）", () => {
    const raw =
      '{"nodes":[{"id":"a","type":"end","label":"结束"}],"edges":[]}\n注意 {这里} 是说明文字';
    const g = parseMinedGraph(raw);
    expect(g).not.toBeNull();
    expect(g!.nodes.length).toBe(1);
  });

  it("非法输入返回 null（未解析出对象 / 结构不对 / 空节点）", () => {
    expect(parseMinedGraph("")).toBeNull();
    expect(parseMinedGraph("没有 JSON")).toBeNull();
    expect(parseMinedGraph('{"foo":1}')).toBeNull();
    expect(parseMinedGraph('{"nodes":[],"edges":[]}')).toBeNull();
    expect(parseMinedGraph('{"nodes":[{"id":"a"}')).toBeNull();
  });

  it("连线端点能按节点 label 引用（模型常这么写）", () => {
    // 这正是 2026-11-12 日志里的失败形态：节点/语义都对，只是连线没写成节点 id
    const g = parseMinedGraph(
      JSON.stringify({
        nodes: [
          { id: "n1", type: "text", label: "取输入" },
          { id: "n2", type: "llm", label: "总结", config: { prompt: "总结 {{n1}}" } },
        ],
        edges: [{ source: "取输入", target: "总结" }],
      }),
    );
    expect(validateWorkflowGraph(g)).toBeNull();
    expect(g!.edges[0]).toMatchObject({ source: "n1", target: "n2" });
  });

  it("连线用 from/to 或下标也能修复（不再报「源节点 undefined 不存在」）", () => {
    const g = parseMinedGraph(
      JSON.stringify({
        nodes: [
          { type: "text", label: "取输入" },
          { type: "llm", label: "总结", config: { prompt: "总结 {{n1}}" } },
          { type: "end", label: "结束" },
        ],
        edges: [
          { from: 0, to: 1 },
          { source: "总结", target: "结束" },
        ],
      }),
    );
    expect(validateWorkflowGraph(g)).toBeNull();
    expect(g!.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    // 出现 0 → 整张图按 0 基解读：0→1 修成 n1→n2；按 label 引用的那条修成 n2→n3
    expect(g!.edges.map((e) => [e.source, e.target])).toEqual([
      ["n1", "n2"],
      ["n2", "n3"],
    ]);
  });

  it("悬空边只丢这一条，不牵连整张图（节点仍然可用）", () => {
    const g = parseMinedGraph(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", label: "取输入" },
          { id: "b", type: "end", label: "结束" },
        ],
        edges: [
          { source: "a", target: "ghost" },
          { source: "a", target: "a" }, // 自环
          { source: "a", target: "b" },
          { source: "a", target: "b" }, // 重复
        ],
      }),
    );
    expect(validateWorkflowGraph(g)).toBeNull();
    expect(g!.edges).toHaveLength(1);
    expect(g!.edges[0]).toMatchObject({ source: "a", target: "b" });
  });

  it("规范化不制造重复 id（显式 id 与兜底 id 相撞时）", () => {
    const g = parseMinedGraph(
      JSON.stringify({
        nodes: [
          { type: "text", label: "一" },
          { id: "n1", type: "end", label: "二" },
        ],
        edges: [],
      }),
    );
    expect(validateWorkflowGraph(g)).toBeNull();
    const ids = g!.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("缺失 id/label 时自动补，保证图编辑器可用", () => {
    const g = parseMinedGraph('{"nodes":[{"type":"end"}],"edges":[]}');
    expect(g!.nodes[0].id).toBe("n1");
    expect(g!.nodes[0].label).toBe("节点1");
    expect(g!.nodes[0].config).toEqual({});
    expect(typeof g!.nodes[0].x).toBe("number");
    expect(typeof g!.nodes[0].y).toBe("number");
  });

  it("已有 id 但没有 label 时用 id 兜底（保持与图编辑器一致）", () => {
    const g = parseMinedGraph('{"nodes":[{"id":"fetch","type":"tool"}],"edges":[]}');
    expect(g!.nodes[0].id).toBe("fetch");
    expect(g!.nodes[0].label).toBe("fetch");
  });
});

describe("repairModelGraph：模型产出的图统一修复后再校验", () => {
  it("workflow_improve 与沉淀共用同一修复（缺 id + 连线按 label）", () => {
    const g = repairModelGraph({
      nodes: [
        { type: "text", label: "取输入" },
        { type: "llm", label: "总结", config: { prompt: "总结 {{n1}}" } },
      ],
      edges: [{ id: "e1", source: "取输入", target: "总结" }],
    } as never);
    expect(validateWorkflowGraph(g)).toBeNull();
    expect(g.edges[0]).toMatchObject({ id: "e1", source: "n1", target: "n2" });
  });

  it("显式 id 原样保留（不因修复而改名，避免历史运行记录的引用失效）", () => {
    const g = repairModelGraph({
      nodes: [
        { id: "fetch", type: "text", label: "取输入" },
        { id: "sum", type: "end", label: "结束" },
      ],
      edges: [{ id: "e1", source: "fetch", target: "sum" }],
    } as never);
    expect(g.nodes.map((n) => n.id)).toEqual(["fetch", "sum"]);
    expect(g.edges[0]).toMatchObject({ source: "fetch", target: "sum" });
  });
});
