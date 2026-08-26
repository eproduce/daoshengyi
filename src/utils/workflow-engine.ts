// Phase 3 可视化工作流引擎（纯函数 + 注入式执行器，可测试）：
// 工作流 = 有向无环图（DAG），节点类型：text（字面量）/ llm（大模型）/ tool（内置工具）/ end（结束）。
// 引擎负责：拓扑排序（检测环）→ 逐节点执行（上游输出注入 {{nodeId}} 占位符）→ 收集终端节点输出。
// LLM / 工具的实际调用通过 WorkflowRuntime 注入，便于测试与 UI 复用。

export type WorkflowNodeType = "text" | "llm" | "tool" | "end";

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  config: {
    prompt?: string; // llm：提示词（可含 {{上游nodeId}}）
    model?: string; // llm：可选，指定模型
    tool?: string; // tool：内置工具名
    toolArgs?: Record<string, unknown>; // tool：参数模板（值可含 {{上游nodeId}}）
    text?: string; // text：字面量内容
  };
  x: number;
  y: number;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowRuntime {
  llmCall: (prompt: string, opts?: { model?: string }) => Promise<string>;
  toolCall: (tool: string, args: Record<string, unknown>) => Promise<string>;
}

export interface WorkflowResult {
  outputs: { nodeId: string; label: string; value: string }[];
  log: string[];
}

/** 把模板中的 {{nodeId}} 占位符替换为对应节点输出（未产生输出则替换为空串）。 */
export function renderTemplate(template: string, outputs: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, id: string) => outputs[id] ?? "");
}

/**
 * 拓扑排序：返回可执行的 node id 顺序；存在环时返回 { error }。
 * 纯函数，供引擎与测试使用。
 */
export function topoSort(graph: WorkflowGraph): { order: string[] } | { error: string } {
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) {
    indegree.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of graph.edges) {
    if (!indegree.has(e.source) || !indegree.has(e.target)) continue; // 忽略悬空边
    indegree.set(e.target, (indegree.get(e.target) || 0) + 1);
    adj.get(e.source)!.push(e.target);
  }
  const queue: string[] = [];
  for (const [id, d] of indegree) if (d === 0) queue.push(id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const t of adj.get(id) || []) {
      const d = (indegree.get(t) || 1) - 1;
      indegree.set(t, d);
      if (d === 0) queue.push(t);
    }
  }
  if (order.length !== graph.nodes.length) {
    return { error: "工作流存在循环依赖，无法执行" };
  }
  return { order };
}

/** 计算某节点的上游输入：把上游节点输出按 {{id}} 注入到模板。 */
function resolveInputs(
  node: WorkflowNode,
  edges: WorkflowEdge[],
  outputs: Record<string, string>,
  external: Record<string, string>,
): string {
  const upstream = edges.filter((e) => e.target === node.id);
  const ctx = upstream
    .map((e) => `[${e.source}]\n${outputs[e.source] ?? ""}`)
    .join("\n\n");
  const base = node.config.prompt ?? node.config.text ?? "";
  // 外部输入（用户提供）也参与占位符替换
  const withExternal = renderTemplate(base, { ...outputs, ...external });
  return ctx ? `${ctx}\n\n${withExternal}` : withExternal;
}

/** 深拷贝参数模板并对所有字符串值做占位符替换。 */
function renderArgs(args: Record<string, unknown>, outputs: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") out[k] = renderTemplate(v, outputs);
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" ? renderTemplate(x, outputs) : x));
    else if (v && typeof v === "object") out[k] = renderArgs(v as Record<string, unknown>, outputs);
    else out[k] = v;
  }
  return out;
}

/**
 * 执行工作流（拓扑顺序）。LLM/工具调用走注入的 runtime，便于测试与 UI。
 * external 为用户提供的输入（键名可在提示词/参数中用 {{key}} 引用）。
 */
export async function executeWorkflow(
  graph: WorkflowGraph,
  external: Record<string, string>,
  rt: WorkflowRuntime,
): Promise<WorkflowResult> {
  const sorted = topoSort(graph);
  if ("error" in sorted) {
    return { outputs: [], log: [`❌ ${sorted.error}`] };
  }
  const outputs: Record<string, string> = { ...external };
  const log: string[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  for (const id of sorted.order) {
    const node = byId.get(id)!;
    const input = resolveInputs(node, graph.edges, outputs, external);
    try {
      if (node.type === "text") {
        outputs[id] = input.trim();
      } else if (node.type === "llm") {
        if (!input.trim()) throw new Error("LLM 节点提示词为空");
        outputs[id] = (await rt.llmCall(input, { model: node.config.model })).trim();
      } else if (node.type === "tool") {
        const tool = node.config.tool || "";
        if (!tool) throw new Error("工具节点未指定工具名");
        const args = renderArgs(node.config.toolArgs || {}, outputs);
        outputs[id] = (await rt.toolCall(tool, args)).trim();
      } else if (node.type === "end") {
        outputs[id] = input.trim();
      }
      log.push(`✅ ${node.label}（${node.id}）→ ${(outputs[id] || "").slice(0, 120)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.push(`❌ ${node.label}（${node.id}）：${msg}`);
      outputs[id] = `（节点执行失败：${msg}）`;
    }
  }

  // 终端节点 = 无出边（含 end 节点）；作为最终输出
  const terminal = graph.nodes.filter(
    (n) => n.type === "end" || !graph.edges.some((e) => e.source === n.id)
  );
  return {
    outputs: terminal.map((n) => ({ nodeId: n.id, label: n.label, value: outputs[n.id] ?? "" })),
    log,
  };
}
