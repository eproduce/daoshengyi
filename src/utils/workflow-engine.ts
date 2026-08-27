// Phase 3 可视化工作流引擎（纯函数 + 注入式执行器，可测试）：
// 工作流 = 有向无环图（DAG），节点类型：text（字面量）/ llm（大模型）/ tool（内置工具）/
// condition（条件分支）/ code（代码）/ end（结束）。
// 引擎负责：拓扑排序（检测环）→ 逐节点执行（上游输出注入 {{nodeId}} 占位符）→ 收集终端节点输出。
// 条件节点按表达式真假把结果写为 "true"/"false"，其出边带 label（true/false）做分支路由；
// 未激活分支的节点直接跳过不执行。LLM / 工具的实际调用通过 WorkflowRuntime 注入。

export type WorkflowNodeType = "text" | "llm" | "tool" | "condition" | "code" | "end";

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
    expression?: string; // condition：布尔表达式（可用 节点id / {{id}} / 字符串 / 数字，支持 == != > < >= <= && || ! contains startsWith endsWith）
    code?: string; // code：JS 代码体，入参 input（上游文本）与 outputs（上游输出表），需 return 结果
  };
  x: number;
  y: number;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  label?: string; // condition 出边分支："" = 始终激活；"true"/"false" = 仅对应分支激活
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

// ---------- 条件表达式求值器（纯函数、安全、可测试） ----------
// 支持：{{id}} 占位符 / 节点id 裸引用（解析为上游输出）/ 字符串 / 数字 / true|false
// 运算符：== != > < >= <=  contains startsWith endsWith  && || !  (以及 and or not)

type CondTok =
  | { t: "ph"; v: string } // {{id}}
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "lp" }
  | { t: "rp" };

function condTokenize(expr: string): CondTok[] {
  const toks: CondTok[] = [];
  let i = 0;
  const n = expr.length;
  while (i < n) {
    const c = expr[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "{" && expr[i + 1] === "{") {
      const end = expr.indexOf("}}", i + 2);
      if (end === -1) break;
      toks.push({ t: "ph", v: expr.slice(i + 2, end).trim() });
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      let closed = false;
      while (j < n) {
        if (expr[j] === "\\" && j + 1 < n) { s += expr[j + 1]; j += 2; continue; }
        if (expr[j] === c) { closed = true; break; }
        s += expr[j]; j++;
      }
      toks.push({ t: "str", v: s });
      i = closed ? j + 1 : j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = expr.slice(i).match(/^[0-9]*\.?[0-9]+/);
      if (m) { toks.push({ t: "num", v: parseFloat(m[0]) }); i += m[0].length; continue; }
    }
    const two = expr.slice(i, i + 2);
    if (["==", "!=", ">=", "<=", "&&", "||"].includes(two)) { toks.push({ t: "op", v: two }); i += 2; continue; }
    if (c === "(") { toks.push({ t: "lp" }); i++; continue; }
    if (c === ")") { toks.push({ t: "rp" }); i++; continue; }
    if (["!", ">", "<"].includes(c)) { toks.push({ t: "op", v: c }); i++; continue; }
    if (/[A-Za-z0-9_\-]/.test(c)) {
      const m = expr.slice(i).match(/^[A-Za-z0-9_\-]+/);
      if (m) { toks.push({ t: "id", v: m[0] }); i += m[0].length; continue; }
    }
    i++; // 未知字符跳过
  }
  return toks;
}

type CondAst =
  | { k: "bool"; v: boolean }
  | { k: "str"; v: string }
  | { k: "num"; v: number }
  | { k: "ref"; id: string }
  | { k: "not"; e: CondAst }
  | { k: "or"; l: CondAst; r: CondAst }
  | { k: "and"; l: CondAst; r: CondAst }
  | { k: "cmp"; op: string; l: CondAst; r: CondAst }
  | { k: "rel"; op: string; l: CondAst; r: CondAst };

class CondParser {
  private pos = 0;
  private toks: CondTok[];
  constructor(toks: CondTok[]) {
    this.toks = toks;
  }
  parse(): CondAst | null {
    try { return this.parseOr(); } catch { return null; }
  }
  private peek(): CondTok | undefined { return this.toks[this.pos]; }
  private next(): CondTok | undefined { return this.toks[this.pos++]; }
  private isId(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === "id" && t.v.toLowerCase() === v;
  }
  private parseOr(): CondAst {
    let left = this.parseAnd();
    while (this.peek()?.t === "op" && (this.peek() as { v: string }).v === "||" || this.isId("or")) {
      this.next();
      left = { k: "or", l: left, r: this.parseAnd() };
    }
    return left;
  }
  private parseAnd(): CondAst {
    let left = this.parseRel();
    while (this.peek()?.t === "op" && (this.peek() as { v: string }).v === "&&" || this.isId("and")) {
      this.next();
      left = { k: "and", l: left, r: this.parseRel() };
    }
    return left;
  }
  private parseRel(): CondAst {
    const left = this.parseCmp();
    const t = this.peek();
    if (t && t.t === "id" && ["contains", "startswith", "endswith"].includes(t.v.toLowerCase())) {
      this.next();
      return { k: "rel", op: t.v.toLowerCase(), l: left, r: this.parseCmp() };
    }
    return left;
  }
  private parseCmp(): CondAst {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t && t.t === "op" && ["==", "!=", ">", "<", ">=", "<="].includes(t.v)) {
        this.next();
        left = { k: "cmp", op: t.v, l: left, r: this.parseUnary() };
      } else break;
    }
    return left;
  }
  private parseUnary(): CondAst {
    const t = this.peek();
    if (t && ((t.t === "op" && t.v === "!") || (t.t === "id" && t.v.toLowerCase() === "not"))) {
      this.next();
      return { k: "not", e: this.parseUnary() };
    }
    return this.parsePrimary();
  }
  private parsePrimary(): CondAst {
    const t = this.next();
    if (!t) throw new Error("表达式意外结束");
    if (t.t === "lp") {
      const inner = this.parseOr();
      const close = this.next();
      if (!close || close.t !== "rp") throw new Error("缺少右括号");
      return inner;
    }
    if (t.t === "ph") return { k: "ref", id: t.v };
    if (t.t === "str") return { k: "str", v: t.v };
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "id") {
      const v = t.v.toLowerCase();
      if (v === "true") return { k: "bool", v: true };
      if (v === "false") return { k: "bool", v: false };
      return { k: "ref", id: t.v };
    }
    throw new Error("无法解析的记号");
  }
}

type CondVal = { b?: boolean; s?: string; n?: number };
function strOf(v: CondVal): string {
  if (v.s !== undefined) return v.s;
  if (v.n !== undefined) return String(v.n);
  return String(v.b);
}
function numOf(v: CondVal): number {
  if (v.n !== undefined) return v.n;
  const x = parseFloat(strOf(v));
  return Number.isNaN(x) ? Number.NEGATIVE_INFINITY : x;
}
function truthy(v: CondVal): boolean {
  if (v.b !== undefined) return v.b;
  if (v.n !== undefined) return v.n !== 0;
  const s = (v.s ?? "").trim().toLowerCase();
  return s !== "" && s !== "false" && s !== "0";
}
function condEval(ast: CondAst, outputs: Record<string, string>): CondVal {
  switch (ast.k) {
    case "bool": return { b: ast.v };
    case "str": return { s: ast.v };
    case "num": return { n: ast.v };
    case "ref": return { s: outputs[ast.id] ?? "" };
    case "not": return { b: !truthy(condEval(ast.e, outputs)) };
    case "or": return { b: truthy(condEval(ast.l, outputs)) || truthy(condEval(ast.r, outputs)) };
    case "and": return { b: truthy(condEval(ast.l, outputs)) && truthy(condEval(ast.r, outputs)) };
    case "cmp": {
      const l = strOf(condEval(ast.l, outputs));
      const r = strOf(condEval(ast.r, outputs));
      switch (ast.op) {
        case "==": return { b: l === r };
        case "!=": return { b: l !== r };
        case ">": return { b: numOf({ s: l }) > numOf({ s: r }) };
        case "<": return { b: numOf({ s: l }) < numOf({ s: r }) };
        case ">=": return { b: numOf({ s: l }) >= numOf({ s: r }) };
        case "<=": return { b: numOf({ s: l }) <= numOf({ s: r }) };
      }
      return { b: false };
    }
    case "rel": {
      const l = strOf(condEval(ast.l, outputs));
      const r = strOf(condEval(ast.r, outputs));
      if (ast.op === "contains") return { b: l.includes(r) };
      if (ast.op === "startswith") return { b: l.startsWith(r) };
      if (ast.op === "endswith") return { b: l.endsWith(r) };
      return { b: false };
    }
  }
}

/** 求值条件表达式（以 outputs 为变量表，含 {{id}} 占位符 / 裸节点id 引用）。非法表达式返回 false。 */
export function evalCondition(expression: string, outputs: Record<string, string>): boolean {
  const ast = new CondParser(condTokenize(expression)).parse();
  if (!ast) return false;
  return truthy(condEval(ast, outputs));
}

/** 执行代码节点：body 为函数体，注入 input（上游文本）与 outputs（上游输出表），需 return 结果。异常被捕获为错误文案。 */
export function runCodeNode(code: string, input: string, outputs: Record<string, string>): string {
  try {
    const fn = new Function("input", "outputs", `"use strict";\n${code}`);
    const r = fn(input, outputs);
    if (r === undefined || r === null) return "";
    if (typeof r === "object") return JSON.stringify(r, null, 2);
    return String(r);
  } catch (e) {
    return `（代码执行失败：${e instanceof Error ? e.message : String(e)}）`;
  }
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

/** 某条入边是否激活：非条件源边始终激活；条件源边需 label 与条件输出（true/false）一致；无 label 视为始终激活。 */
function edgeActive(e: WorkflowEdge, outputs: Record<string, string>, byId: Map<string, WorkflowNode>): boolean {
  const src = byId.get(e.source);
  if (!src || src.type !== "condition") return true;
  if (!e.label) return true;
  return e.label === outputs[e.source];
}

/** 计算某节点的上游输入：只取激活入边，把上游节点输出按 {{id}} 注入到模板。 */
function resolveInputs(
  node: WorkflowNode,
  edges: WorkflowEdge[],
  outputs: Record<string, string>,
  external: Record<string, string>,
  byId: Map<string, WorkflowNode>,
): string {
  const upstream = edges.filter((e) => e.target === node.id && edgeActive(e, outputs, byId));
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
  const skippedIds = new Set<string>();

  for (const id of sorted.order) {
    const node = byId.get(id)!;
    // 分支跳过：有入边但无任何激活边 → 该节点在未激活分支上，直接跳过
    const incoming = graph.edges.filter((e) => e.target === id);
    if (incoming.length > 0 && !incoming.some((e) => edgeActive(e, outputs, byId))) {
      outputs[id] = "（分支未激活，跳过）";
      skippedIds.add(id);
      log.push(`⏭️ ${node.label}（${node.id}）条件分支未激活，跳过`);
      continue;
    }
    const input = resolveInputs(node, graph.edges, outputs, external, byId);
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
      } else if (node.type === "condition") {
        const expr = node.config.expression || "";
        if (!expr.trim()) throw new Error("条件节点未填写表达式");
        const val = evalCondition(expr, outputs);
        outputs[id] = val ? "true" : "false";
        log.push(`🔀 ${node.label}（${node.id}）→ ${val ? "true" : "false"}`);
        continue;
      } else if (node.type === "code") {
        const code = node.config.code || "";
        if (!code.trim()) throw new Error("代码节点未填写代码");
        outputs[id] = runCodeNode(code, input, outputs).trim();
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

  // 终端节点 = 无出边（含 end 节点）且未被分支跳过；作为最终输出
  const terminal = graph.nodes.filter(
    (n) => !skippedIds.has(n.id) && (n.type === "end" || !graph.edges.some((e) => e.source === n.id))
  );
  return {
    outputs: terminal.map((n) => ({ nodeId: n.id, label: n.label, value: outputs[n.id] ?? "" })),
    log,
  };
}
