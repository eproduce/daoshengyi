/**
 * Phase 3 收尾：会话轨迹 → 可复用工作流（把「本轮成功完成的工具序列」抽象成工作流候选）。
 *
 * 设计要点（纯函数，无 IO，便于离线单测）：
 * - **门控**由 shouldMineWorkflow 判定：必须是「实际工作类工具 ≥3 个 + 无失败 + 工具种类 ≥2」。
 *   单一工具重复调用（如批量读取多个文件）只是批量操作，没有复用价值，不该沉淀。
 * - **抽象**交给辅助模型（提示词由 buildMiningPrompt 生成），产出必须通过
 *   validateWorkflowGraph 校验才会写库——避免非法图污染工作流库。
 * - **解析**宽松：模型常带 markdown 代码块或前后解释，parseMinedGraph 负责剥壳、取第一个
 *   平衡的 JSON 对象，并补齐图编辑器需要的坐标/id/label/config。
 * - **命名**确定性：同名即覆盖（workflow_save 是 upsert），所以同一目标重复出现时是「细化」
 *   而不是堆积重复工作流。
 */
import type { WorkflowGraph, WorkflowNode } from "./workflow-engine";

/** 工具轨迹的一步（取自 ChatTool 的可见字段） */
export interface MinedToolStep {
  name: string;
  server?: string;
  argsPreview?: string;
  resultPreview?: string;
  status?: string;
}

/** 非「实际工作」工具：规划/记忆/工作流自身管理/会话管理/子代理编排，不计入复用价值 */
const NON_WORK_TOOLS =
  /^(plan_task|plan_update|memory_save|memory_recall|memory_forget|workflow_|session_|subagent_)/;

/** 沉淀所需的最少实际工作工具数 */
export const MIN_WORK_TOOLS = 3;

/** 门控：本轮轨迹是否值得沉淀为工作流（纯函数，返回原因便于排查/日志） */
export function shouldMineWorkflow(steps: MinedToolStep[]): { ok: boolean; reason: string } {
  const work = steps.filter((s) => !NON_WORK_TOOLS.test(s.name));
  if (work.length < MIN_WORK_TOOLS) {
    return { ok: false, reason: `实际工作工具仅 ${work.length} 个（需 ≥${MIN_WORK_TOOLS}）` };
  }
  const failed = steps.filter((s) => s.status === "error");
  if (failed.length > 0) {
    return { ok: false, reason: `存在失败工具（${failed.map((f) => f.name).join("、")}）` };
  }
  const kinds = new Set(work.map((s) => s.name));
  if (kinds.size < 2) {
    return { ok: false, reason: `仅单一工具 ${[...kinds][0] ?? ""} 重复调用，无复用价值` };
  }
  return { ok: true, reason: "" };
}

/** 工作流名（确定性：同一目标 → 同一名字 → workflow_save 覆盖更新而非堆积） */
export function minedWorkflowName(goal: string, maxLen = 24): string {
  const clean = (goal || "")
    .replace(/\s+/g, " ")
    .replace(/[「」【】"'`]/g, "")
    .trim();
  const short = clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean;
  return `自动沉淀：${short || "未命名流程"}`;
}

/** 构造抽取提示词：给目标 + 工具序列，要求输出合法工作流 JSON */
export function buildMiningPrompt(goal: string, steps: MinedToolStep[]): string {
  const lines = steps
    .map((s, i) => {
      const args = (s.argsPreview || "").replace(/\s+/g, " ").slice(0, 200);
      const res = (s.resultPreview || "").replace(/\s+/g, " ").slice(0, 160);
      return `${i + 1}. [${s.server || "app"}] ${s.name} 参数=${args || "(无)"} 结果=${res || "(无)"}`;
    })
    .join("\n");
  return (
    "你是「道生一」的工作流挖掘器。下面是刚刚**成功完成**的一次任务过程（用户目标 + 实际工具调用序列）。\n" +
    "请把它抽象成一个**可复用的工作流**（有向无环图），让同类任务下次能一键复用。\n\n" +
    `【用户目标】\n${goal}\n\n【工具调用序列】\n${lines}\n\n` +
    "要求：\n" +
    "1. 节点类型 text/llm/tool/condition/code/end；节点 id 用小写字母数字（n1、n2…）；每个节点必须有 label。\n" +
    '2. 上游输出用 {{节点id}} 引用；tool 节点 config={"tool":"工具名","toolArgs":{...}}；' +
    'llm 节点 config={"prompt":"提示词"}；condition 节点 config={"expression":"布尔表达式"} 且其出边带 label true/false。\n' +
    "3. 把**一次性的具体输入**（本次的文件名/关键词/日期等）抽象成占位符 {{user}}，不要写死本次的具体值。\n" +
    "4. 节点数量 3~8 个，只保留有复用价值的环节；**不要**包含规划/记忆类动作（plan_task、memory_*）。\n" +
    '5. **只输出工作流 JSON**（不要 markdown 代码块、不要解释、不要注释）：{"nodes":[...],"edges":[...]}'
  );
}

/** 补齐图编辑器需要的字段（模型通常只给 id/type/label/config） */
function normalizeGraph(graph: WorkflowGraph): WorkflowGraph {
  const nodes: WorkflowNode[] = graph.nodes.map((n, i) => ({
    ...n,
    id: n.id || `n${i + 1}`,
    label: n.label || n.id || `节点${i + 1}`,
    config: n.config && typeof n.config === "object" ? n.config : {},
    x: typeof n.x === "number" ? n.x : 60 + (i % 3) * 220,
    y: typeof n.y === "number" ? n.y : 60 + Math.floor(i / 3) * 140,
  }));
  const edges = graph.edges.map((e, i) => ({ ...e, id: e.id || `e${i + 1}` }));
  return { nodes, edges };
}

/** 宽松解析模型输出中的工作流 JSON：剥 markdown 代码块 → 取第一个平衡的 {...} → 结构校验 */
export function parseMinedGraph(raw: string): WorkflowGraph | null {
  if (!raw) return null;
  const text = raw.replace(/```[a-zA-Z]*\n?/g, "").trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  // 取第一个「括号平衡」的 JSON 对象：避免模型在 JSON 后附带解释导致整体 parse 失败
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as WorkflowGraph;
    if (!obj || !Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) return null;
    if (obj.nodes.length === 0) return null;
    return normalizeGraph(obj);
  } catch {
    return null;
  }
}
