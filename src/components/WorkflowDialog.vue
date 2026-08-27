<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { VueFlow } from "@vue-flow/core";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import { v4 as uuidv4 } from "@/stores/uuid";
import { useChatStore } from "@/stores/chat";
import { callMcpTool } from "@/stores/chat";
import { executeWorkflow, type WorkflowNode, type WorkflowEdge, type WorkflowNodeType } from "@/utils/workflow-engine";
import { WORKFLOW_TEMPLATES, materializeTemplate } from "@/data/workflow-templates";
import { invoke } from "@tauri-apps/api/core";
import { Play, Trash2, Download, Upload, Plus, X } from "lucide-vue-next";

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

const NODE_COLORS: Record<WorkflowNodeType, string> = {
  text: "#4caf50",
  llm: "#2196f3",
  tool: "#ff9800",
  condition: "#9c27b0",
  code: "#00bcd4",
  end: "#9e9e9e",
};
const TYPE_LABEL: Record<WorkflowNodeType, string> = { text: "文本", llm: "LLM", tool: "工具", condition: "条件", code: "代码", end: "结束" };

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

function addNode(type: WorkflowNodeType) {
  const id = uuidv4();
  const wf: WorkflowNode = {
    id, type, label: `${TYPE_LABEL[type]}节点`,
    config: type === "llm" ? { prompt: "请基于上方上下文回答：{{user}}" }
      : type === "tool" ? { tool: "web_search", toolArgs: { query: "{{user}}" } }
      : type === "text" ? { text: "输入内容" }
      : type === "condition" ? { expression: "{{user}} != \"\"" }
      : type === "code" ? { code: "return input.trim().toUpperCase();" }
      : {},
    x: 60 + nodes.value.length * 30,
    y: 60 + nodes.value.length * 30,
  };
  nodes.value.push({
    id, type: "default", position: { x: wf.x, y: wf.y },
    data: { label: `${wf.label}`, wf },
    style: { border: `1px solid ${NODE_COLORS[type]}`, borderLeft: `4px solid ${NODE_COLORS[type]}`, background: "#fff", color: "#222", borderRadius: 8, minWidth: 120 },
  });
  selectedId.value = id;
  selectedEdgeId.value = null;
}

function connectEdge(params: { source: string; target: string }) {
  if (params.source === params.target) return;
  if (edges.value.some((e) => e.source === params.source && e.target === params.target)) return;
  const edge: WorkflowEdge = { id: uuidv4(), source: params.source, target: params.target };
  edges.value.push({ id: edge.id, source: edge.source, target: edge.target, animated: true, data: { edge } });
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
    nodes: nodes.value.map((n) => ({ ...(n.data.wf as WorkflowNode), id: n.id })),
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
    });
    log.value = res.log;
    outputs.value = res.outputs;
  } catch (e) {
    log.value = [`❌ 执行异常：${e instanceof Error ? e.message : String(e)}`];
  } finally {
    running.value = false;
  }
}

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
        id: wf.id, type: "default", position: { x: wf.x ?? 0, y: wf.y ?? 0 },
        data: { label: wf.label, wf },
        style: { border: `1px solid ${NODE_COLORS[wf.type] || "#999"}`, borderLeft: `4px solid ${NODE_COLORS[wf.type] || "#999"}`, background: "#fff", color: "#222", borderRadius: 8, minWidth: 120 },
      }));
      edges.value = g.edges.map((e) => {
        const wfEdge: WorkflowEdge = { id: e.id || uuidv4(), source: e.source, target: e.target, label: e.label };
        return { id: wfEdge.id, source: wfEdge.source, target: wfEdge.target, animated: true, data: { edge: wfEdge } };
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
    id: wf.id, type: "default", position: { x: wf.x ?? 40, y: wf.y ?? 40 },
    data: { label: wf.label, wf },
    style: { border: `1px solid ${NODE_COLORS[wf.type] || "#999"}`, borderLeft: `4px solid ${NODE_COLORS[wf.type] || "#999"}`, background: "#fff", color: "#222", borderRadius: 8, minWidth: 120 },
  }));
  edges.value = g.edges.map((e) => {
    const wfEdge: WorkflowEdge = { id: e.id, source: e.source, target: e.target, label: e.label };
    return { id: wfEdge.id, source: wfEdge.source, target: wfEdge.target, animated: true, data: { edge: wfEdge } };
  });
  selectedId.value = null; selectedEdgeId.value = null;
  log.value = [`✅ 已载入模板「${tpl.name}」：${g.nodes.length} 节点 / ${g.edges.length} 连线`];
}
</script>

<template>
  <div class="wf-overlay">
    <div class="wf-dialog">
      <header class="wf-head">
        <span class="wf-title">⚙️ 可视化工作流</span>
        <div class="wf-head__actions">
          <button class="wf-btn" @click="run" :disabled="running">
            <Play :size="14" /> {{ running ? "运行中…" : "运行" }}
          </button>
          <button class="wf-btn" @click="clearAll"><Trash2 :size="14" /> 清空</button>
          <button class="wf-btn" @click="exportJson"><Download :size="14" /> 导出</button>
          <label class="wf-btn"><Upload :size="14" /> 导入<input type="file" accept="application/json" class="wf-hidden" @change="importJson" /></label>
          <button class="wf-btn wf-btn--close" @click="emit('close')"><X :size="14" /></button>
        </div>
      </header>

      <div class="wf-body">
        <!-- 节点面板 -->
        <div class="wf-palette">
          <button class="wf-palette__btn" @click="addNode('text')"><Plus :size="13" /> 文本</button>
          <button class="wf-palette__btn" @click="addNode('llm')"><Plus :size="13" /> LLM</button>
          <button class="wf-palette__btn" @click="addNode('tool')"><Plus :size="13" /> 工具</button>
          <button class="wf-palette__btn" @click="addNode('condition')"><Plus :size="13" /> 条件</button>
          <button class="wf-palette__btn" @click="addNode('code')"><Plus :size="13" /> 代码</button>
          <button class="wf-palette__btn" @click="addNode('end')"><Plus :size="13" /> 结束</button>
          <select class="wf-palette__select" @change="loadTemplate">
            <option value="" disabled selected>📦 载入模板…</option>
            <option v-for="t in WORKFLOW_TEMPLATES" :key="t.id" :value="t.id">{{ t.icon }} {{ t.name }}（{{ t.description }}）</option>
          </select>
          <div class="wf-palette__hint">外部输入用 <code>&#123;&#123;user&#125;&#125;</code>；上游输出用 <code>&#123;&#123;节点id&#125;&#125;</code> 引用。条件节点出边点选后设 true/false 分支；未激活分支自动跳过。</div>
        </div>

        <!-- 画布 -->
        <div class="wf-canvas">
          <VueFlow v-model:nodes="nodes" v-model:edges="edges" :default-edge-options="{ type: 'smoothstep' }"
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
      </div>
    </div>
  </div>
</template>


<style scoped>
.wf-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 1000; display: flex; align-items: center; justify-content: center; }
.wf-dialog { width: min(1100px, 94vw); height: min(760px, 92vh); background: var(--bg, #fff); color: var(--text, #222); border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; }
.wf-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--border, #eee); }
.wf-title { font-weight: 700; }
.wf-head__actions { display: flex; gap: 8px; align-items: center; }
.wf-btn { display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--bg-input, #fff); cursor: pointer; font-size: 13px; }
.wf-btn:hover { border-color: #4c8dff; color: #4c8dff; }
.wf-btn:disabled { opacity: .5; cursor: default; }
.wf-btn--close { border: none; }
.wf-btn--danger { color: #c62828; border-color: #c6282866; margin-top: 8px; }
.wf-hidden { display: none; }
.wf-body { display: flex; flex: 1; min-height: 0; }
.wf-palette { width: 130px; padding: 10px; border-right: 1px solid var(--border, #eee); display: flex; flex-direction: column; gap: 6px; overflow-y: auto; }
.wf-palette__btn { text-align: left; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--bg-input, #fff); cursor: pointer; font-size: 13px; display: inline-flex; align-items: center; gap: 5px; }
.wf-palette__btn:hover { border-color: #4c8dff; color: #4c8dff; }
.wf-palette__hint { font-size: 11px; color: var(--text-secondary, #888); line-height: 1.5; }
.wf-palette__select { font-size: 12px; padding: 5px 6px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--bg-input, #fff); color: var(--text, #222); max-width: 100%; }
.wf-canvas { flex: 1; min-width: 0; }
.wf-inspector { width: 260px; padding: 10px; border-left: 1px solid var(--border, #eee); overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.wf-inspector__empty { font-size: 12px; color: var(--text-secondary, #888); text-align: center; margin-top: 40px; line-height: 1.8; }
.wf-inspector__title { font-size: 12px; font-weight: 700; color: var(--text, #222); }
.wf-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-secondary, #666); }
.wf-field input, .wf-field textarea { padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--bg-input, #fff); color: var(--text, #222); font-size: 13px; font-family: inherit; }
.wf-run { border-top: 1px solid var(--border, #eee); padding: 10px 14px; display: flex; gap: 16px; height: 160px; min-height: 0; }
.wf-run__log { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.wf-run__out { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; overflow-y: auto; }
.wf-run__pre { font-size: 11px; white-space: pre-wrap; word-break: break-word; background: var(--bg-soft, #f5f5f5); border-radius: 6px; padding: 6px 8px; margin: 0; max-height: 110px; overflow-y: auto; color: var(--text, #222); }
.wf-run__empty { font-size: 12px; color: var(--text-secondary, #888); }
.wf-run__out-item { display: flex; flex-direction: column; gap: 2px; }
.wf-run__out-item b { font-size: 12px; }
</style>
