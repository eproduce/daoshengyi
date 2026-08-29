<script setup lang="ts">
import { ref, computed, watch, onMounted, markRaw } from "vue";
import { VueFlow, useVueFlow } from "@vue-flow/core";
import WorkflowNodeView from "./WorkflowNodeView.vue";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import { v4 as uuidv4 } from "@/stores/uuid";
import { useChatStore } from "@/stores/chat";
import { callMcpTool } from "@/stores/chat";
import { executeWorkflow, type WorkflowNode, type WorkflowEdge, type WorkflowNodeType } from "@/utils/workflow-engine";
import { WORKFLOW_TEMPLATES, materializeTemplate } from "@/data/workflow-templates";
import { WORKFLOW_NODE_COLORS } from "@/data/workflow-colors";
import { invoke } from "@tauri-apps/api/core";
import { Play, Trash2, Download, Upload, X, Save, RotateCw, Workflow, FileText, Bot, Wrench, GitBranch, Code2, Flag } from "lucide-vue-next";

const emit = defineEmits<{ close: [] }>();
const chatStore = useChatStore();

// vue-flow 1.x 的 Node/Edge 类型泛型极深，直接引用会让 ref 操作触发 TS2589 深度实例化；
// 内部用 any[] 承载，交给 VueFlow 组件校验。
const nodes = ref<any[]>([]);
const edges = ref<any[]>([]);
const selectedId = ref<string | null>(null);
const selectedEdgeId = ref<string | null>(null);
const running = ref(false);
const log = ref<string[]>([]);
const outputs = ref<{ nodeId: string; label: string; value: string }[]>([]);
const externalInput = ref("");
// 持久化：我的工作流 + 运行历史
const wfName = ref("");
const myWorkflows = ref<{ id: number; name: string; updated_at: number }[]>([]);
const loadedWfId = ref<number | null>(null);
const runs = ref<{ id: number; wf_name: string; status: string; started_at: number; summary: string }[]>([]);
const loadedWfName = ref("");

const TYPE_LABEL: Record<WorkflowNodeType, string> = { text: "文本", llm: "LLM", tool: "工具", condition: "条件", code: "代码", end: "结束" };
// 拖拽影像用的节点类型图标（与左侧节点库按钮一致）
const NODE_ICONS: Record<WorkflowNodeType, any> = { text: FileText, llm: Bot, tool: Wrench, condition: GitBranch, code: Code2, end: Flag };

// 自定义节点：显式渲染可拖拽连线 Handle（条件节点 T/F 双出点自动带分支标签）
// vue-flow 1.x 的 NodeTypesObject 与 SFC 组件 props 类型不兼容，用宽松断言
const nodeTypes = { wf: markRaw(WorkflowNodeView) } as any;

// vue-flow 1.x 的 Node 类型泛型极深会触发 TS2589，selected 用 any 承载
const selected = computed<any>(() => {
  if (!selectedId.value) return undefined;
  return (nodes.value as { id: string }[]).find((n) => n.id === selectedId.value);
});
const selectedWf = computed<WorkflowNode | undefined>(
  () => (selected.value as { data?: { wf?: WorkflowNode } } | undefined)?.data?.wf
);
const selectedEdge = computed<any>(() =>
  selectedEdgeId.value ? (edges.value as { id: string }[]).find((e) => e.id === selectedEdgeId.value) : undefined
);
const selectedEdgeWf = computed<WorkflowEdge | undefined>(
  () => (selectedEdge.value as { data?: { edge?: WorkflowEdge } } | undefined)?.data?.edge
);
// 选中边源节点是否为条件节点（只有条件出边需要分支标签）
const selectedEdgeIsCondition = computed(() => {
  const e = selectedEdge.value;
  if (!e) return false;
  const src = (nodes.value as { id: string }[]).find((n) => n.id === e.source);
  return (src as { data?: { wf?: WorkflowNode } } | undefined)?.data?.wf?.type === "condition";
});

function addNode(type: WorkflowNodeType, pos?: { x: number; y: number }) {
  const id = uuidv4();
  const wf: WorkflowNode = {
    id, type, label: `${TYPE_LABEL[type]}节点`,
    config: type === "llm" ? { prompt: "请基于上方上下文回答：{{user}}" }
      : type === "tool" ? { tool: "web_search", toolArgs: { query: "{{user}}" } }
      : type === "text" ? { text: "输入内容" }
      : type === "condition" ? { expression: "{{user}} != \"\"" }
      : type === "code" ? { code: "return input.trim().toUpperCase();" }
      : {},
    x: pos?.x ?? 60 + nodes.value.length * 30,
    y: pos?.y ?? 60 + nodes.value.length * 30,
  };
  // 用 vue-flow 的 addNodes 标准 API 而不是直接 push：确保与画布 store 同步、
  // 事件通知与默认属性处理都走正规流程（直接 push 外部 ref 无法保证 store 一致性）
  addNodes([{
    id, type: "wf", position: { x: wf.x, y: wf.y },
    data: { label: `${wf.label}`, wf },
  }]);
  selectedId.value = id;
  selectedEdgeId.value = null;
}

// ── 拖拽新增节点（mouse 事件实现，WKWebView 兼容）────────────────────
// 背景：Tauri 的 macOS 运行时是 WKWebView，其 HTML5 拖放（draggable + 自定义
// DataTransfer MIME + drop）存在兼容性问题——dragstart 能触发、节点能"拖起来"，
// 但 drop 经常不派发，表现为「放手就失效」。因此这里改用 mouse 事件自建拖拽：
//   mousedown 记录类型 → mousemove 判断是否真的拖动了 → mouseup 若落在画布内建节点。
// 仍保留 useVueFlow("workflow") 共享 store：screenToFlowCoordinate 依赖真实挂载的
// viewport 才能把屏幕坐标转成画布坐标（顶层裸调 useVueFlow 会建一个独立的空 store）。
const canvasRef = ref<HTMLElement | null>(null);
const { screenToFlowCoordinate, addNodes } = useVueFlow("workflow");
const dragState = ref<{ type: WorkflowNodeType } | null>(null);
// 拖拽过程中的视觉反馈：跟随鼠标的半透明节点影像 + 画布是否可放置
const dragPreview = ref<{ type: WorkflowNodeType; x: number; y: number } | null>(null);
const overCanvas = ref(false);
// 拖拽结束在画布内建过节点后，抑制随后的 click，避免重复添加
let suppressClick = false;

function onPaletteMouseDown(type: WorkflowNodeType, ev: MouseEvent) {
  if (ev.button !== 0) return;
  // 注意：这里不能 preventDefault——它会阻止随后的 click 事件，导致"点击添加"失效。
  // 按钮文字选中问题交给 .wf-palette__btn { user-select: none } 处理。
  dragState.value = { type };
  const startX = ev.clientX, startY = ev.clientY;
  let moved = false;
  const onMove = (e: MouseEvent) => {
    if (!moved && (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4)) moved = true;
    if (moved) {
      // 更新拖拽影像位置，并判断当前是否落在画布内（用于画布高亮提示）
      dragPreview.value = { type, x: e.clientX + 12, y: e.clientY + 10 };
      const el = canvasRef.value;
      overCanvas.value = !!el && e.clientX >= el.getBoundingClientRect().left && e.clientX <= el.getBoundingClientRect().right
        && e.clientY >= el.getBoundingClientRect().top && e.clientY <= el.getBoundingClientRect().bottom;
    }
  };
  const onUp = (e: MouseEvent) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    dragPreview.value = null;
    overCanvas.value = false;
    const st = dragState.value;
    if (!st) return;
    if (moved) {
      const el = canvasRef.value;
      if (el) {
        const r = el.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          const { x, y } = screenToFlowCoordinate({ x: e.clientX, y: e.clientY });
          addNode(st.type, { x, y });
          suppressClick = true;
        }
      }
    }
    dragState.value = null;
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
function onPaletteClick(type: WorkflowNodeType) {
  if (suppressClick) { suppressClick = false; return; }
  addNode(type);
}

function connectEdge(params: { source: string; target: string; sourceHandle?: string | null }) {
  if (params.source === params.target) return;
  if (edges.value.some((e) => e.source === params.source && e.target === params.target)) return;
  // 从条件节点 T/F 连接点拖出时自动带分支标签，无需手动填写
  const src = nodes.value.find((n) => n.id === params.source);
  const isCond = (src?.data?.wf as WorkflowNode | undefined)?.type === "condition";
  let label: string | undefined;
  if (isCond && params.sourceHandle) {
    label = params.sourceHandle === "true" ? "true" : params.sourceHandle === "false" ? "false" : undefined;
  }
  const edge: WorkflowEdge = { id: uuidv4(), source: params.source, target: params.target, ...(label ? { label } : {}) };
  edges.value.push({ id: edge.id, source: edge.source, target: edge.target, animated: true, data: { edge }, ...(edge.label ? { label: edge.label } : {}) });
  selectedEdgeId.value = edge.id;
  selectedId.value = null;
}

function removeNode(id: string) {
  nodes.value = nodes.value.filter((n) => n.id !== id);
  edges.value = edges.value.filter((e) => e.source !== id && e.target !== id);
  if (selectedId.value === id) selectedId.value = null;
  selectedEdgeId.value = null;
}

function updateToolArgs(obj: Record<string, unknown>) {
  if (!selectedWf.value) return;
  selectedWf.value.config.toolArgs = obj;
}
// 节点名变更同步到画布显示的 label
watch(() => selectedWf.value?.label, (l) => {
  const n = selected.value;
  if (n && l) n.data.label = l;
});

function buildGraph(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    // 序列化时剥离运行期状态（runStatus/runOutput），只保留可持久化的定义
    nodes: nodes.value.map((n) => {
      const wf = { ...(n.data.wf as WorkflowNode), id: n.id };
      delete wf.runStatus;
      delete wf.runOutput;
      return wf;
    }),
    edges: edges.value.map((e) => {
      const wfEdge = (e.data as { edge?: WorkflowEdge } | undefined)?.edge;
      return { id: e.id, source: e.source, target: e.target, label: wfEdge?.label };
    }),
  };
}

async function run() {
  const graph = buildGraph();
  if (graph.nodes.length === 0) { log.value = ["请先添加节点"]; return; }
  running.value = true;
  log.value = [];
  outputs.value = [];
  // 重置所有节点运行状态为 waiting
  for (const n of nodes.value) { (n.data as any).wf.runStatus = "waiting"; (n.data as any).wf.runOutput = ""; }
  const startedAt = Date.now();
  const runName = loadedWfName.value || wfName.value.trim() || "未命名工作流";
  const external: Record<string, string> = {};
  if (externalInput.value.trim()) external["user"] = externalInput.value.trim();
  try {
    const res = await executeWorkflow(graph, external, {
      llmCall: async (prompt, opts) => {
        const cfg = chatStore.getAuxConfig();
        if (!cfg.baseUrl || !cfg.apiKey) throw new Error("未配置 API 地址/Key");
        const data = await invoke<{ content?: string }>("chat_once", {
          config: {
            base_url: cfg.baseUrl, api_key: cfg.apiKey, model: opts?.model || cfg.model,
            max_tokens: cfg.maxTokens, temperature: 0.3,
            thinking_enabled: cfg.thinkingEnabled ?? false, reasoning_effort: cfg.reasoningEffort ?? "low",
            system_prompt: "你是道生一工作流中的一个处理节点，根据输入上下文给出结果。", enable_web_search: false,
          },
          messages: [{ role: "user", content: prompt }],
        });
        return data?.content || "（模型未返回内容）";
      },
      toolCall: async (tool, args) => callMcpTool("app", tool, args),
    }, (ev) => {
      // 实时刷新节点运行状态（供画布徽标 + 点击查看该步输出）
      const n = nodes.value.find((x) => x.id === ev.nodeId);
      if (n) {
        (n.data as any).wf.runStatus = ev.status;
        (n.data as any).wf.runOutput = ev.output || "";
      }
    });
    log.value = res.log;
    outputs.value = res.outputs;
    // 记录运行历史
    const summary = (res.outputs.length
      ? res.outputs.slice(0, 2).map((o) => `[${o.label}] ${o.value.slice(0, 80)}`).join("；")
      : (res.log[0] || "").slice(0, 160)) || "（无输出）";
    await recordRun(runName, "success", startedAt, Date.now(), summary);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.value = [`❌ 执行异常：${msg}`];
    await recordRun(runName, "failed", startedAt, Date.now(), msg.slice(0, 160));
  } finally {
    running.value = false;
  }
}

// --- 持久化：我的工作流 + 运行历史 ---

async function refreshWorkflows() {
  try {
    myWorkflows.value = await invoke<{ id: number; name: string; updated_at: number }[]>("workflow_list");
    runs.value = await invoke<{ id: number; wf_name: string; status: string; started_at: number; summary: string }[]>("workflow_runs", { limit: 10 });
  } catch { /* 后端暂不可用 */ }
}
async function saveWorkflow() {
  const name = wfName.value.trim();
  if (!name) { log.value = ["请先在名称框输入工作流名称再保存"]; return; }
  const graph = buildGraph();
  try {
    loadedWfId.value = await invoke<number>("workflow_save", { name, graph: JSON.stringify(graph) });
    loadedWfName.value = name;
    await refreshWorkflows();
    log.value = [`✅ 已保存「${name}」：${graph.nodes.length} 节点 / ${graph.edges.length} 连线`];
  } catch (e) {
    log.value = [`❌ 保存失败：${e instanceof Error ? e.message : String(e)}`];
  }
}
async function loadWorkflow(id: number) {
  try {
    const w = await invoke<{ id: number; name: string; graph: string } | null>("workflow_get", { id });
    if (!w) return;
    const g = JSON.parse(w.graph) as { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
    nodes.value = (g.nodes || []).map((wf) => ({
      id: wf.id, type: "wf", position: { x: wf.x ?? 40, y: wf.y ?? 40 },
      data: { label: wf.label, wf },
    }));
    edges.value = (g.edges || []).map((e) => {
      const wfEdge: WorkflowEdge = { id: e.id, source: e.source, target: e.target, label: e.label };
      return { id: wfEdge.id, source: wfEdge.source, target: wfEdge.target, animated: true, data: { edge: wfEdge }, ...(wfEdge.label ? { label: wfEdge.label } : {}) };
    });
    loadedWfId.value = w.id;
    loadedWfName.value = w.name;
    wfName.value = w.name;
    selectedId.value = null; selectedEdgeId.value = null;
    log.value = [`✅ 已载入工作流「${w.name}」：${g.nodes.length} 节点 / ${g.edges.length} 连线`];
  } catch (e) {
    log.value = [`❌ 载入失败：${e instanceof Error ? e.message : String(e)}`];
  }
}
async function deleteCurrentWf() {
  if (!loadedWfId.value) { log.value = ["当前未载入可删除的工作流"]; return; }
  try {
    await invoke("workflow_delete", { id: loadedWfId.value });
    await refreshWorkflows();
    loadedWfId.value = null; loadedWfName.value = "";
    log.value = ["🗑 已删除该工作流"];
  } catch (e) {
    log.value = [`❌ 删除失败：${e instanceof Error ? e.message : String(e)}`];
  }
}
async function recordRun(wfName: string, status: string, startedAt: number, finishedAt: number, summary: string) {
  try {
    await invoke("workflow_run_add", { wfId: loadedWfId.value, wfName, status, startedAt, finishedAt, summary });
    await refreshWorkflows();
  } catch { /* 历史记录失败不影响运行结果展示 */ }
}
function fmtTime(ms: number) {
  return new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
onMounted(refreshWorkflows);

function exportJson() {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(buildGraph(), null, 2)], { type: "application/json" }));
  a.download = "workflow.json"; a.click();
}
function importJson(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  file.text().then((t) => {
    try {
      const g = JSON.parse(t) as { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
      nodes.value = g.nodes.map((wf) => ({
        id: wf.id, type: "wf", position: { x: wf.x ?? 0, y: wf.y ?? 0 },
        data: { label: wf.label, wf },
      }));
      edges.value = g.edges.map((e) => {
        const wfEdge: WorkflowEdge = { id: e.id || uuidv4(), source: e.source, target: e.target, label: e.label };
        return { id: wfEdge.id, source: wfEdge.source, target: wfEdge.target, animated: true, data: { edge: wfEdge }, ...(wfEdge.label ? { label: wfEdge.label } : {}) };
      });
    } catch { log.value = ["❌ JSON 解析失败"]; }
  });
}
function clearAll() {
  nodes.value = []; edges.value = []; selectedId.value = null; selectedEdgeId.value = null; outputs.value = []; log.value = [];
}
function loadTemplate(ev: Event) {
  const id = (ev.target as HTMLSelectElement).value;
  (ev.target as HTMLSelectElement).value = "";
  const tpl = WORKFLOW_TEMPLATES.find((t) => t.id === id);
  if (!tpl) return;
  const g = materializeTemplate(tpl);
  nodes.value = g.nodes.map((wf) => ({
    id: wf.id, type: "wf", position: { x: wf.x ?? 40, y: wf.y ?? 40 },
    data: { label: wf.label, wf },
  }));
  edges.value = g.edges.map((e) => {
    const wfEdge: WorkflowEdge = { id: e.id, source: e.source, target: e.target, label: e.label };
    return { id: wfEdge.id, source: wfEdge.source, target: wfEdge.target, animated: true, data: { edge: wfEdge }, ...(wfEdge.label ? { label: wfEdge.label } : {}) };
  });
  selectedId.value = null; selectedEdgeId.value = null;
  log.value = [`✅ 已载入模板「${tpl.name}」：${g.nodes.length} 节点 / ${g.edges.length} 连线`];
}
</script>

<template>
  <div class="wf-overlay">
    <!-- 拖拽过程中的节点影像：跟随鼠标，提示落点；颜色跟随节点类型色 -->
    <div v-if="dragPreview" class="wf-drag-preview" :style="{ '--t': WORKFLOW_NODE_COLORS[dragPreview.type], left: dragPreview.x + 'px', top: dragPreview.y + 'px' }">
      <component :is="NODE_ICONS[dragPreview.type]" :size="14" />
      <span>{{ TYPE_LABEL[dragPreview.type] }}节点</span>
    </div>
    <div class="wf-dialog">
      <header class="wf-head">
        <span class="wf-title"><Workflow :size="16" /> 可视化工作流</span>
        <div class="wf-head__actions">
          <button class="wf-btn wf-btn--run" @click="run" :disabled="running">
            <Play :size="14" /> {{ running ? "运行中…" : "运行" }}
          </button>
          <button class="wf-btn" @click="clearAll"><Trash2 :size="14" /> 清空</button>
          <button class="wf-btn" @click="exportJson"><Download :size="14" /> 导出</button>
          <label class="wf-btn"><Upload :size="14" /> 导入<input type="file" accept="application/json" class="wf-hidden" @change="importJson" /></label>
          <button class="wf-btn wf-btn--close" @click="emit('close')"><X :size="14" /></button>
        </div>
      </header>

      <div class="wf-toolbar">
        <input v-model="wfName" class="wf-toolbar__name" placeholder="工作流名称（保存用）" @keydown.enter="saveWorkflow" />
        <button class="wf-btn" @click="saveWorkflow"><Save :size="13" /> 保存</button>
        <select class="wf-palette__select" @change="(e: any) => { const id = Number(e.target.value); e.target.value = ''; if (id) loadWorkflow(id); }">
          <option value="" disabled selected>📂 我的工作流…</option>
          <option v-for="w in myWorkflows" :key="w.id" :value="w.id">{{ w.name }}（{{ w.updated_at ? new Date(w.updated_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '' }}）</option>
        </select>
        <button class="wf-btn" @click="deleteCurrentWf"><Trash2 :size="13" /> 删除当前</button>
        <button class="wf-btn" @click="refreshWorkflows" title="刷新我的工作流与运行历史"><RotateCw :size="13" /></button>
        <span v-if="loadedWfName" class="wf-toolbar__loaded">已载入：{{ loadedWfName }}</span>
      </div>

      <div class="wf-external">
        <span class="wf-external__label">外部输入（供 <code>&#123;&#123;user&#125;&#125;</code> 占位符引用）：</span>
        <input v-model="externalInput" class="wf-external__input" placeholder="例：帮我分析这个项目的技术栈" />
        <span class="wf-external__hint">运行前填写，节点配置里写 &#123;&#123;user&#125;&#125; 即可引用此输入。</span>
      </div>

      <div class="wf-body">
        <!-- 节点面板（支持拖拽到画布或点击添加） -->
        <div class="wf-palette">
          <div class="wf-palette__cap">节点库</div>
          <button class="wf-palette__btn" :style="{ '--t': WORKFLOW_NODE_COLORS.text }" @mousedown="onPaletteMouseDown('text', $event)" @click="onPaletteClick('text')"><FileText :size="14" /> 文本</button>
          <button class="wf-palette__btn" :style="{ '--t': WORKFLOW_NODE_COLORS.llm }" @mousedown="onPaletteMouseDown('llm', $event)" @click="onPaletteClick('llm')"><Bot :size="14" /> LLM</button>
          <button class="wf-palette__btn" :style="{ '--t': WORKFLOW_NODE_COLORS.tool }" @mousedown="onPaletteMouseDown('tool', $event)" @click="onPaletteClick('tool')"><Wrench :size="14" /> 工具</button>
          <button class="wf-palette__btn" :style="{ '--t': WORKFLOW_NODE_COLORS.condition }" @mousedown="onPaletteMouseDown('condition', $event)" @click="onPaletteClick('condition')"><GitBranch :size="14" /> 条件</button>
          <button class="wf-palette__btn" :style="{ '--t': WORKFLOW_NODE_COLORS.code }" @mousedown="onPaletteMouseDown('code', $event)" @click="onPaletteClick('code')"><Code2 :size="14" /> 代码</button>
          <button class="wf-palette__btn" :style="{ '--t': WORKFLOW_NODE_COLORS.end }" @mousedown="onPaletteMouseDown('end', $event)" @click="onPaletteClick('end')"><Flag :size="14" /> 结束</button>
          <select class="wf-palette__select" @change="loadTemplate">
            <option value="" disabled selected>📦 载入模板…</option>
            <option v-for="t in WORKFLOW_TEMPLATES" :key="t.id" :value="t.id">{{ t.icon }} {{ t.name }}（{{ t.description }}）</option>
          </select>
          <div class="wf-palette__hint">
            <b>添加节点</b>：拖拽左侧按钮到画布（或直接点击，落在空白处）。<br />
            <b>连线</b>：从节点底部圆点拖到下一个节点顶部。<br />
            <b>外部输入</b>：顶部输入框填内容，节点里用 <code>&#123;&#123;user&#125;&#125;</code> 引用；上游输出用 <code>&#123;&#123;节点id&#125;&#125;</code>。<br />
            <b>运行</b>：点右上角「运行」，过程见底部日志、结果见底部输出。
          </div>
        </div>

        <!-- 画布：mouse 事件拖拽新增，drop 判定在 mouseup 时按画布矩形命中 -->
        <div class="wf-canvas" ref="canvasRef" :class="{ 'wf-canvas--dragover': overCanvas }">
          <VueFlow id="workflow" v-model:nodes="nodes" v-model:edges="edges" :default-edge-options="{ type: 'smoothstep' }" :node-types="nodeTypes" fit-view-on-init :min-zoom="0.1"
            @connect="connectEdge" @node-click="(e: any) => { selectedId = e.node.id; selectedEdgeId = null; }"
            @edge-click="(e: any) => { selectedEdgeId = e.edge.id; selectedId = null; }"
            @pane-click="selectedId = null; selectedEdgeId = null;">
          </VueFlow>
        </div>

        <!-- 配置面板 -->
        <div class="wf-inspector">
          <template v-if="selectedEdgeWf && selectedEdgeIsCondition">
            <div class="wf-inspector__title">连线（条件分支）</div>
            <label class="wf-field"><span>分支（true / false / 留空=始终）</span>
              <input :value="selectedEdgeWf?.label || ''" placeholder="true 或 false"
                @change="(e: any) => { if (selectedEdgeWf) selectedEdgeWf.label = e.target.value || undefined; }" />
            </label>
            <div class="wf-palette__hint">该边从条件节点出发：填 true 表示条件成立时走此分支，填 false 相反。留空=始终激活。</div>
          </template>
          <template v-else-if="selectedWf">
            <label class="wf-field"><span>名称</span><input v-model="selectedWf.label" /></label>
            <template v-if="selectedWf.type === 'llm'">
              <label class="wf-field"><span>提示词（支持 <code>&#123;&#123;id&#125;&#125;</code> 引用上游）</span><textarea v-model="selectedWf.config.prompt" rows="4" /></label>
              <label class="wf-field"><span>模型（可选，留空=默认）</span><input v-model="selectedWf.config.model" /></label>
            </template>
            <template v-else-if="selectedWf.type === 'tool'">
              <label class="wf-field"><span>内置工具名</span><input v-model="selectedWf.config.tool" /></label>
              <div class="wf-field"><span>参数（JSON 对象，值可用占位符）</span>
                <textarea :value="JSON.stringify(selectedWf.config.toolArgs || {}, null, 2)" rows="5"
                  @change="(e: any) => { try { updateToolArgs(JSON.parse(e.target.value)); } catch { /* ignore */ } }" />
              </div>
            </template>
            <template v-else-if="selectedWf.type === 'condition'">
              <div class="wf-field"><span>表达式（true/false 路由）</span>
                <textarea v-model="selectedWf.config.expression" rows="5" />
              </div>
              <div class="wf-palette__hint">支持 <code>&#123;&#123;id&#125;&#125;</code> 或裸节点 id 引用上游输出；运算符 == != &gt; &lt; &gt;= &lt;= contains startsWith endsWith &amp;&amp; || ! （及 and or not）。例：<code>&#123;&#123;a&#125;&#125; contains "成功"</code>、<code>score &gt; 80</code>。</div>
            </template>
            <template v-else-if="selectedWf.type === 'code'">
              <div class="wf-field"><span>JS 代码（入参 input/outputs，需 return）</span>
                <textarea v-model="selectedWf.config.code" rows="6" spellcheck="false" />
              </div>
              <div class="wf-palette__hint">函数体写法：<code>return input.trim().toUpperCase();</code>；也可 <code>return outputs.a + outputs.b;</code>。对象自动 JSON 序列化。</div>
            </template>
            <template v-else-if="selectedWf.type === 'text'">
              <label class="wf-field"><span>内容</span><textarea v-model="selectedWf.config.text" rows="4" /></label>
            </template>
            <button class="wf-btn wf-btn--danger" @click="removeNode(selectedWf.id)"><Trash2 :size="13" /> 删除节点</button>
            <!-- 运行状态 + 该步输出（节点级运行可视化） -->
            <template v-if="selectedWf.runStatus && selectedWf.runStatus !== 'waiting'">
              <div class="wf-field">
                <span>运行状态：
                  <b :class="'wf-status-' + selectedWf.runStatus">
                    {{ selectedWf.runStatus === "running" ? "⏳ 执行中" : selectedWf.runStatus === "done" ? "✅ 成功" : selectedWf.runStatus === "error" ? "❌ 失败" : "⏭️ 跳过" }}
                  </b>
                </span>
              </div>
              <div class="wf-field" v-if="selectedWf.runOutput">
                <span>本步输出</span>
                <pre class="wf-run__pre wf-run__pre--node">{{ selectedWf.runOutput }}</pre>
              </div>
            </template>
          </template>
          <div v-else class="wf-inspector__empty">点击节点/连线编辑配置<br />拖拽连线连接上下游</div>
        </div>
      </div>

      <div class="wf-run">
        <div class="wf-run__log">
          <strong>运行日志</strong>
          <pre class="wf-run__pre">{{ log.join("\n") || "（尚未运行）" }}</pre>
        </div>
        <div class="wf-run__out">
          <strong>输出</strong>
          <div v-if="!outputs.length" class="wf-run__empty">运行后在此显示终端节点输出</div>
          <div v-for="o in outputs" :key="o.nodeId" class="wf-run__out-item">
            <b>{{ o.label }}</b>
            <pre class="wf-run__pre">{{ o.value }}</pre>
          </div>
        </div>
        <div class="wf-run__hist">
          <strong>运行历史</strong>
          <div v-if="!runs.length" class="wf-run__empty">暂无历史记录</div>
          <div v-for="r in runs" :key="r.id" class="wf-run__hist-item" :title="r.summary">
            <span class="wf-run__hist-status" :class="r.status === 'success' ? 'ok' : 'fail'">{{ r.status === "success" ? "✓" : "✗" }}</span>
            <div class="wf-run__hist-body">
              <b>{{ r.wf_name }}</b>
              <span class="wf-run__hist-meta">{{ fmtTime(r.started_at) }}</span>
              <span class="wf-run__hist-sum">{{ r.summary }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>


<style scoped>
/* ── 遮罩与容器 ─────────────────────────────── */
.wf-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(8, 8, 18, 0.55);
  backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
}
.wf-dialog {
  width: min(1180px, 94vw); height: min(780px, 92vh);
  background: var(--bg-elevated); color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xl);
  display: flex; flex-direction: column; overflow: hidden;
  animation: wf-pop .16s ease-out;
}
@keyframes wf-pop { from { transform: scale(.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }

/* ── 拖拽影像（跟随鼠标的节点预览，颜色跟随节点类型色 --t） ─────────── */
.wf-drag-preview {
  position: fixed; z-index: 1001; pointer-events: none;
  display: inline-flex; align-items: center; gap: 7px;
  padding: 7px 12px; border-radius: var(--radius-sm);
  background: var(--bg-elevated); color: var(--text-primary);
  border: 1px solid var(--t, var(--accent-color)); border-left: 3px solid var(--t, var(--accent-color));
  box-shadow: var(--shadow-lg); font-size: 13px; font-weight: 600;
  transform: translate(-50%, -50%);
  opacity: .92; white-space: nowrap;
}
.wf-drag-preview svg { color: var(--t, var(--accent-color)); }
.wf-canvas--dragover {
  border-color: var(--accent-color);
  box-shadow: inset 0 0 0 2px var(--accent-bg), 0 0 0 3px var(--accent-bg);
}

/* ── 头部 ───────────────────────────────────── */
.wf-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px;
  background: linear-gradient(135deg, var(--accent-bg), transparent 65%);
  border-bottom: 1px solid var(--border-color);
}
.wf-title { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; color: var(--text-primary); }
.wf-title svg { color: var(--accent-color); }
.wf-head__actions { display: flex; gap: 8px; align-items: center; }
.wf-head__actions .wf-btn--run { background: var(--accent-color); border-color: var(--accent-color); color: #fff; }
.wf-head__actions .wf-btn--run:hover { background: var(--accent-hover); border-color: var(--accent-hover); color: #fff; }
.wf-head__actions .wf-btn--run:disabled { opacity: .6; }

/* ── 工具栏 ─────────────────────────────────── */
.wf-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--border-color); flex-wrap: wrap; background: var(--bg-secondary); }
.wf-toolbar__name { padding: 6px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); background: var(--bg-elevated); color: var(--text-primary); font-size: 13px; width: 180px; transition: border-color .15s, box-shadow .15s; }
.wf-toolbar__name:focus { outline: none; border-color: var(--accent-color); box-shadow: 0 0 0 3px var(--accent-bg); }
.wf-toolbar__loaded { font-size: 12px; color: var(--accent-color); font-weight: 600; background: var(--accent-bg); padding: 3px 8px; border-radius: 999px; }

/* ── 通用按钮 ───────────────────────────────── */
.wf-btn {
  display: inline-flex; align-items: center; gap: 5px; padding: 6px 11px;
  border-radius: var(--radius-sm); border: 1px solid var(--border-color);
  background: var(--bg-elevated); color: var(--text-primary); cursor: pointer; font-size: 13px;
  transition: border-color .15s, color .15s, background .15s, box-shadow .15s, transform .05s;
}
.wf-btn:hover { border-color: var(--accent-color); color: var(--accent-color); background: var(--accent-bg); }
.wf-btn:active { transform: scale(.97); }
.wf-btn:disabled { opacity: .5; cursor: default; }
.wf-btn--close { border: none; background: transparent; }
.wf-btn--danger { color: var(--danger-color); border-color: var(--danger-color); }
.wf-btn--danger:hover { background: var(--danger-bg); color: var(--danger-color); border-color: var(--danger-color); }
.wf-hidden { display: none; }

/* ── 外部输入 ───────────────────────────────── */
.wf-external { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--border-color); background: var(--accent-bg); }
.wf-external__label { font-size: 12px; color: var(--text-secondary); white-space: nowrap; font-weight: 600; }
.wf-external__input { flex: 1; padding: 6px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); background: var(--bg-elevated); color: var(--text-primary); font-size: 13px; transition: border-color .15s, box-shadow .15s; }
.wf-external__input:focus { outline: none; border-color: var(--accent-color); box-shadow: 0 0 0 3px var(--accent-bg); }
.wf-external__hint { font-size: 11px; color: var(--text-muted); white-space: nowrap; }

/* ── 主体三栏 ───────────────────────────────── */
.wf-body { display: flex; flex: 1; min-height: 0; }

/* 节点面板 */
.wf-palette { width: 150px; padding: 12px 10px; border-right: 1px solid var(--border-color); background: var(--bg-secondary); display: flex; flex-direction: column; gap: 6px; overflow-y: auto; }
.wf-palette__cap { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--text-muted); padding: 2px 4px 4px; }
.wf-palette__btn {
  text-align: left; padding: 8px 10px; border-radius: var(--radius-sm);
  border: 1px solid var(--border-color); border-left: 3px solid var(--t, var(--border-strong));
  background: var(--bg-elevated); color: var(--text-primary); cursor: grab;
  font-size: 13px; display: inline-flex; align-items: center; gap: 7px;
  user-select: none; -webkit-user-select: none;
  box-shadow: var(--shadow-sm);
  transition: transform .12s, box-shadow .12s, border-color .12s, background .12s;
}
.wf-palette__btn:active { cursor: grabbing; }
.wf-palette__btn:hover { transform: translateY(-1px); box-shadow: var(--shadow-md); border-color: var(--t, var(--border-strong)); color: var(--t, var(--text-primary)); background: var(--bg-hover); }
.wf-palette__btn svg { flex-shrink: 0; color: var(--t, var(--text-secondary)); }
.wf-palette__hint { font-size: 11px; color: var(--text-muted); line-height: 1.6; margin-top: 4px; }
.wf-palette__select {
  font-size: 12px; padding: 6px 26px 6px 10px; border-radius: var(--radius-sm);
  border: 1px solid var(--border-color); background-color: var(--bg-elevated); color: var(--text-primary);
  max-width: 100%; cursor: pointer;
}

/* 画布：点阵背景 + 内边框，视觉上更像专业画布 */
.wf-canvas {
  flex: 1; min-width: 0; margin: 10px; border-radius: var(--radius-md);
  border: 1px solid var(--border-color); overflow: hidden; position: relative;
  background-color: var(--bg-primary);
  background-image: radial-gradient(var(--border-color) 1px, transparent 1px);
  background-size: 22px 22px;
}
.wf-canvas :deep(.vue-flow) { background: transparent; }

/* 配置面板 */
.wf-inspector { width: 270px; padding: 12px; border-left: 1px solid var(--border-color); background: var(--bg-secondary); overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.wf-inspector__empty { font-size: 12px; color: var(--text-muted); text-align: center; margin-top: 48px; line-height: 2; }
.wf-inspector__title { font-size: 12px; font-weight: 700; color: var(--text-primary); letter-spacing: .03em; }
.wf-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-secondary); }
.wf-field > span { font-weight: 600; }
.wf-field input, .wf-field textarea {
  padding: 7px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-color);
  background: var(--bg-elevated); color: var(--text-primary); font-size: 13px; font-family: inherit;
  transition: border-color .15s, box-shadow .15s;
}
.wf-field input:focus, .wf-field textarea:focus { outline: none; border-color: var(--accent-color); box-shadow: 0 0 0 3px var(--accent-bg); }

/* ── 运行区 ─────────────────────────────────── */
.wf-run { border-top: 1px solid var(--border-color); padding: 10px 16px; display: flex; gap: 16px; height: 190px; min-height: 0; background: var(--bg-elevated); }
.wf-run__log { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.wf-run__out { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; overflow-y: auto; }
.wf-run__hist { width: 250px; display: flex; flex-direction: column; gap: 6px; min-width: 0; overflow-y: auto; border-left: 1px solid var(--border-color); padding-left: 14px; }
.wf-run__log > strong, .wf-run__out > strong, .wf-run__hist > strong { font-size: 12px; color: var(--text-secondary); }
.wf-run__hist-item { display: flex; gap: 8px; align-items: flex-start; font-size: 11px; padding: 6px 8px; border-radius: var(--radius-sm); transition: background .15s; }
.wf-run__hist-item:hover { background: var(--bg-hover); }
.wf-run__hist-status { width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: 10px; flex-shrink: 0; margin-top: 1px; }
.wf-run__hist-status.ok { background: #22c55e; }
.wf-run__hist-status.fail { background: var(--danger-color); }
.wf-run__hist-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.wf-run__hist-body b { font-size: 11px; }
.wf-run__hist-meta { color: var(--text-muted); font-size: 10px; }
.wf-run__hist-sum { color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
.wf-run__pre { font-size: 11px; white-space: pre-wrap; word-break: break-word; background: var(--bg-secondary); border-radius: var(--radius-sm); padding: 8px 10px; margin: 0; max-height: 120px; overflow-y: auto; color: var(--text-primary); }
.wf-run__empty { font-size: 12px; color: var(--text-muted); }
.wf-run__out-item { display: flex; flex-direction: column; gap: 2px; }
.wf-run__out-item b { font-size: 12px; }
.wf-status-running { color: var(--accent-color); }
.wf-status-done { color: #22c55e; }
.wf-status-error { color: var(--danger-color); }
.wf-status-skipped { color: var(--text-muted); }
.wf-run__pre--node { max-height: 200px; }
</style>
