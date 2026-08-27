// 可视化工作流：内置模板库（本地，为「工作流市场」打基础）。
// 模板使用可读的短 id（如 user/llm1/tool1/end），节点间用 {{id}} 占位符引用。
// 载入编辑器时用 materializeTemplate 重新生成唯一 id 并同步替换引用，避免多次载入冲突。
// 所有模板必须可通过 topoSort 校验（无环、节点 id 齐全）。

import type { WorkflowNode, WorkflowEdge, WorkflowGraph } from "@/utils/workflow-engine";

export interface WorkflowTemplate {
  id: string;
  name: string;
  icon: string;
  description: string;
  graph: WorkflowGraph;
}

let uidCounter = 0;
function freshId(prefix: string): string {
  uidCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${uidCounter.toString(36)}`;
}

/** 把模板的节点/边 id 重新生成为唯一 id，并把配置里 {{旧id}} 引用同步替换为新 id。 */
export function materializeTemplate(t: WorkflowTemplate): WorkflowGraph {
  const map = new Map<string, string>();
  for (const n of t.graph.nodes) map.set(n.id, freshId("wf"));
  const remapStr = (s: string): string =>
    s.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (m, id: string) => (map.has(id) ? `{{${map.get(id)}}}` : m));
  const remapVal = (v: unknown): unknown => {
    if (typeof v === "string") return remapStr(v);
    if (Array.isArray(v)) return v.map(remapVal);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = remapVal(val);
      return o;
    }
    return v;
  };
  const nodes: WorkflowNode[] = t.graph.nodes.map((n) => ({
    ...n,
    id: map.get(n.id)!,
    config: remapVal(n.config) as WorkflowNode["config"],
  }));
  const edges: WorkflowEdge[] = t.graph.edges.map((e) => ({
    ...e,
    id: freshId("e"),
    source: map.get(e.source)!,
    target: map.get(e.target)!,
  }));
  return { nodes, edges };
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "research",
    name: "研究助手",
    icon: "🔍",
    description: "用户提问 → LLM 规划 → 联网搜索 → LLM 综合 → 输出",
    graph: {
      nodes: [
        { id: "user", type: "text", label: "用户问题", config: { text: "{{user}}" }, x: 40, y: 40 },
        { id: "llm1", type: "llm", label: "规划搜索词", config: { prompt: "基于问题提炼 2-3 个搜索关键词，只输出关键词，逗号分隔。问题：{{user}}" }, x: 220, y: 40 },
        { id: "tool1", type: "tool", label: "联网搜索", config: { tool: "web_search", toolArgs: { query: "{{llm1}}" } }, x: 400, y: 40 },
        { id: "llm2", type: "llm", label: "综合回答", config: { prompt: "基于以下搜索结果回答用户问题，引用关键信息并给出结论。\n用户问题：{{user}}\n搜索结果：{{tool1}}\n请用结构化 Markdown 输出。" }, x: 580, y: 40 },
        { id: "end", type: "end", label: "输出", config: {}, x: 760, y: 40 },
      ],
      edges: [
        { id: "e1", source: "user", target: "llm1" },
        { id: "e2", source: "llm1", target: "tool1" },
        { id: "e3", source: "tool1", target: "llm2" },
        { id: "e4", source: "llm2", target: "end" },
      ],
    },
  },
  {
    id: "polish",
    name: "文案润色",
    icon: "✒️",
    description: "输入 → LLM 润色 → 可选继续翻译 → 输出",
    graph: {
      nodes: [
        { id: "user", type: "text", label: "原文", config: { text: "{{user}}" }, x: 40, y: 40 },
        { id: "llm1", type: "llm", label: "润色", config: { prompt: "润色以下文案：优化表达、修正语法、保持原意，输出润色后结果并附简短说明。\n原文：{{user}}" }, x: 220, y: 40 },
        { id: "end", type: "end", label: "输出", config: {}, x: 420, y: 40 },
      ],
      edges: [
        { id: "e1", source: "user", target: "llm1" },
        { id: "e2", source: "llm1", target: "end" },
      ],
    },
  },
  {
    id: "daily-report",
    name: "日报生成",
    icon: "📋",
    description: "用户输入工作要点 → LLM 生成日报 → 输出",
    graph: {
      nodes: [
        { id: "user", type: "text", label: "工作要点", config: { text: "{{user}}" }, x: 40, y: 40 },
        { id: "llm1", type: "llm", label: "生成日报", config: { prompt: "根据以下工作要点生成结构化日报（今日完成/明日计划/风险与求助）。\n工作要点：{{user}}\n输出 Markdown。" }, x: 240, y: 40 },
        { id: "end", type: "end", label: "输出", config: {}, x: 460, y: 40 },
      ],
      edges: [
        { id: "e1", source: "user", target: "llm1" },
        { id: "e2", source: "llm1", target: "end" },
      ],
    },
  },
  {
    id: "bug-triage",
    name: "Bug 分流",
    icon: "🐞",
    description: "输入错误信息 → LLM 判断严重级别 → 条件分支给处理建议",
    graph: {
      nodes: [
        { id: "user", type: "text", label: "错误信息", config: { text: "{{user}}" }, x: 40, y: 80 },
        { id: "llm1", type: "llm", label: "严重级别", config: { prompt: "判断以下错误信息的严重级别，只输出「严重」或「轻微」：\n{{user}}" }, x: 220, y: 80 },
        { id: "cond", type: "condition", label: "是否严重", config: { expression: "llm1 contains \"严重\"" }, x: 420, y: 80 },
        { id: "serious", type: "llm", label: "严重处理", config: { prompt: "错误很严重，请给出紧急处理步骤与排查建议。\n错误：{{user}}" }, x: 620, y: 20 },
        { id: "minor", type: "llm", label: "轻微处理", config: { prompt: "错误较轻微，请给出简单排查建议。\n错误：{{user}}" }, x: 620, y: 160 },
        { id: "end", type: "end", label: "输出", config: {}, x: 840, y: 90 },
      ],
      edges: [
        { id: "e1", source: "user", target: "llm1" },
        { id: "e2", source: "llm1", target: "cond" },
        { id: "e3", source: "cond", target: "serious", label: "true" },
        { id: "e4", source: "cond", target: "minor", label: "false" },
        { id: "e5", source: "serious", target: "end" },
        { id: "e6", source: "minor", target: "end" },
      ],
    },
  },
];
