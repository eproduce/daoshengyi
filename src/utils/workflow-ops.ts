// 工作流（workflow_* 工具）的**查找与解析**：同一段逻辑原先复制在 `workflow_run` 与
// `workflow_improve` 里，且连错误话术都分叉了（一处提示「可先 workflow_list 查看」，
// 另一处只丢一句「未找到」）。模型看到两种说法，就会挑“更省事”的那条去试 —— 这正是
// 「同一件事两种口径」的典型代价。这里收敛成一份，纯函数部分可单测。

export interface WorkflowRow {
  id: number;
  name: string;
  graph: string;
}

export interface WorkflowListRow {
  id: number;
  name: string;
}

/**
 * 按「名称或 id」选出目标工作流的 id。
 *
 * 规则（与面板一致）：**纯数字一律当 id**（允许用户/模型直接引用 id）；
 * 否则按名称**精确匹配**（不做模糊/前缀匹配 —— 工作流名相似时模糊匹配会选错，
 * 而执行错工作流的代价是白跑一轮 LLM）。
 */
export function pickWorkflowId(nameOrId: string, list: readonly WorkflowListRow[]): number | null {
  const raw = (nameOrId || "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  return list.find((w) => w.name === raw)?.id ?? null;
}

/** 未找到时的统一话术（带下一步提示，模型才知道该干什么） */
export function workflowNotFoundMessage(nameOrId: string): string {
  return `未找到工作流「${nameOrId}」——可先 workflow_list 查看已有工作流，或 workflow_create 新建。`;
}

/** 解析图并做结构校验；坏数据给出可读错误（而不是把 JSON 异常抛给用户） */
export function parseWorkflowGraph(
  graphJson: string,
  validate: (g: unknown) => string | null,
): { ok: true; graph: unknown } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(graphJson || "");
  } catch {
    return { ok: false, error: "工作流数据损坏（JSON 无法解析），请在「可视化工作流」中重新保存" };
  }
  const err = validate(parsed);
  if (err) return { ok: false, error: `工作流不合法：${err}` };
  return { ok: true, graph: parsed };
}

export interface ResolveDeps {
  get(id: number): Promise<WorkflowRow | null>;
  list(): Promise<WorkflowListRow[]>;
  validate(graph: unknown): string | null;
}

export type ResolveResult =
  { ok: true; wf: WorkflowRow; graph: unknown } | { ok: false; error: string };

/**
 * 解析目标工作流：id/名称 → 行 → 图（含校验）。
 * **不抛异常**：把「找不到 / 数据坏了」都变成 `{ok:false,error}`，调用方按工具错误返回给模型
 * （抛出去会被外层当成「工具崩溃」，模型拿不到可执行的下一步）。
 */
export async function resolveWorkflow(nameOrId: string, deps: ResolveDeps): Promise<ResolveResult> {
  const raw = (nameOrId || "").trim();
  if (!raw) return { ok: false, error: "需要 name 参数（工作流名称或 id）" };

  let wf: WorkflowRow | null = null;
  if (/^\d+$/.test(raw)) {
    wf = await deps.get(Number(raw));
  } else {
    const list = await deps.list();
    const id = list.find((w) => w.name === raw)?.id ?? null;
    wf = id === null ? null : await deps.get(id);
  }
  if (!wf) return { ok: false, error: workflowNotFoundMessage(raw) };

  const parsed = parseWorkflowGraph(wf.graph, deps.validate);
  if (!parsed.ok) return { ok: false, error: `${parsed.error}（工作流「${wf.name}」）` };
  return { ok: true, wf, graph: parsed.graph };
}
