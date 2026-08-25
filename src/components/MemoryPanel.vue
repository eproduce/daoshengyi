<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { Pencil, Trash2, RefreshCw, Sparkles, BookOpen, History } from "lucide-vue-next";

interface FactRow {
  id: string; conversation_id?: string | null; fact: string; fact_type: string;
  importance: number; access_count: number; last_accessed?: number | null; created_at: number;
}
interface SummaryRow {
  id: string; conversation_id: string; summary: string;
  msg_range_start: number; msg_range_end: number; created_at: number;
}

const FACT_TYPES = ["", "preference", "info", "decision", "todo"] as const;
const TYPE_LABEL: Record<string, string> = { preference: "偏好", info: "信息", decision: "决策", todo: "待办" };

const facts = ref<FactRow[]>([]);
const summaries = ref<SummaryRow[]>([]);
const filter = ref<string>("");
const loading = ref(false);
const error = ref("");
const maintenanceMsg = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    facts.value = await invoke<FactRow[]>("list_facts", { factType: filter.value, limit: 200 });
    summaries.value = await invoke<SummaryRow[]>("list_all_summaries", { limit: 30 });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

const stats = computed(() => {
  const byType: Record<string, number> = {};
  let totalImportance = 0;
  for (const f of facts.value) {
    byType[f.fact_type] = (byType[f.fact_type] || 0) + 1;
    totalImportance += f.importance;
  }
  return { total: facts.value.length, avgImportance: facts.value.length ? (totalImportance / facts.value.length).toFixed(1) : "0", byType };
});

// 用户画像：偏好 + 高重要度（>=7）信息——每次对话稳定注入的「用户档案」
const profile = computed(() =>
  facts.value
    .filter(f => f.fact_type === "preference" || f.importance >= 7)
    .sort((a, b) => b.importance - a.importance)
);

async function deleteFact(id: string) {
  await invoke("delete_fact_cmd", { id }).catch(() => {});
  await load();
}

// --- 编辑记忆 ---
const editing = ref<{ id: string; fact: string; fact_type: string; importance: number } | null>(null);
function startEdit(f: FactRow) {
  editing.value = { id: f.id, fact: f.fact, fact_type: f.fact_type, importance: f.importance };
}
async function saveEdit() {
  if (!editing.value) return;
  const e = editing.value;
  if (!e.fact.trim()) return;
  await invoke("update_fact_cmd", { id: e.id, fact: e.fact.trim(), factType: e.fact_type, importance: e.importance }).catch(() => {});
  editing.value = null;
  await load();
}
function cancelEdit() { editing.value = null; }

async function runMaintenance() {
  maintenanceMsg.value = "维护中…";
  try {
    maintenanceMsg.value = await invoke<string>("maintain_facts");
    await load();
  } catch (e) {
    maintenanceMsg.value = e instanceof Error ? e.message : String(e);
  }
}

function fmtTime(ts?: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

onMounted(load);
</script>

<template>
  <div class="memory-panel">
    <p class="memory-desc">
      长期记忆：对话自动提取 + 跨会话检索注入。系统每天自动做<strong>重要度衰减</strong>与<strong>低价值遗忘</strong>（偏好永久保留）。
      这里可查看、筛选、删除记忆，帮助验证「越用越聪明」。
    </p>

    <div class="memory-toolbar">
      <select v-model="filter" class="memory-filter" @change="load">
        <option v-for="t in FACT_TYPES" :key="t" :value="t">
          {{ t === "" ? "全部类型" : TYPE_LABEL[t] }}
        </option>
      </select>
      <button class="memory-btn" @click="load" :disabled="loading">
        <RefreshCw :size="14" :class="{ spinning: loading }" /> 刷新
      </button>
      <button class="memory-btn" @click="runMaintenance">
        <Sparkles :size="14" /> 执行维护
      </button>
      <span v-if="maintenanceMsg" class="memory-msg">{{ maintenanceMsg }}</span>
      <span v-if="error" class="memory-error">{{ error }}</span>
    </div>

    <div class="memory-stats">
      <span><strong>{{ stats.total }}</strong> 条事实</span>
      <span>平均重要度 <strong>{{ stats.avgImportance }}</strong></span>
      <span v-for="(cnt, type) in stats.byType" :key="type" class="memory-stats__type">
        {{ TYPE_LABEL[type] || type }} <strong>{{ cnt }}</strong>
      </span>
    </div>

    <div v-if="profile.length > 0" class="memory-profile">
      <h4><BookOpen :size="14" /> 用户画像（每次对话自动注入）</h4>
      <div class="memory-profile__items">
        <span v-for="f in profile" :key="f.id" class="memory-profile__chip">
          {{ TYPE_LABEL[f.fact_type] || f.fact_type }}：{{ f.fact }}
        </span>
      </div>
    </div>

    <div class="memory-list">
      <div v-if="facts.length === 0 && !loading" class="memory-empty">暂无记忆（对话结束后自动提取）</div>
      <div v-for="f in facts" :key="f.id" class="memory-item" :class="`memory-item--${f.fact_type}`">
        <div class="memory-item__head">
          <span class="memory-badge">{{ TYPE_LABEL[f.fact_type] || f.fact_type }}</span>
          <span class="memory-importance" :title="`重要度 ${f.importance}/10`">
            {{ "★".repeat(Math.min(f.importance, 5)) }}<span class="dim">{{ f.importance > 5 ? "★".repeat(f.importance - 5) : "" }}</span>
          </span>
          <span class="memory-meta">访问 {{ f.access_count }} 次 · {{ fmtTime(f.last_accessed || f.created_at) }}</span>
          <button class="memory-del" title="编辑这条记忆" @click="startEdit(f)"><Pencil :size="13" /></button>
          <button class="memory-del" title="删除这条记忆" @click="deleteFact(f.id)"><Trash2 :size="13" /></button>
        </div>
        <div v-if="editing && editing.id === f.id" class="memory-edit">
          <input v-model="editing.fact" class="memory-edit__input" placeholder="记忆内容" />
          <div class="memory-edit__row">
            <select v-model="editing.fact_type" class="memory-filter">
              <option v-for="t in ['preference','info','decision','todo']" :key="t" :value="t">{{ TYPE_LABEL[t] }}</option>
            </select>
            <input v-model.number="editing.importance" type="number" min="1" max="10" class="memory-edit__imp" title="重要度 1-10" />
            <button class="memory-btn" @click="saveEdit">保存</button>
            <button class="memory-btn" @click="cancelEdit">取消</button>
          </div>
        </div>
        <div v-else class="memory-item__fact">{{ f.fact }}</div>
      </div>
    </div>

    <div v-if="summaries.length > 0" class="memory-summaries">
      <h4><History :size="14" /> 会话摘要（{{ summaries.length }}）</h4>
      <div v-for="s in summaries" :key="s.id" class="memory-summary">
        <span class="memory-summary__time">{{ fmtTime(s.created_at) }}</span>
        <span class="memory-summary__text">{{ s.summary }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.memory-panel { display: flex; flex-direction: column; gap: 12px; }
.memory-desc { color: var(--text-secondary, #888); font-size: 12px; line-height: 1.6; margin: 0; }
.memory-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.memory-filter { padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--bg-input, #fff); color: var(--text, #222); font-size: 13px; }
.memory-btn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--bg-input, #fff); cursor: pointer; font-size: 13px; }
.memory-btn:hover { border-color: #4c8dff; color: #4c8dff; }
.spinning { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.memory-msg { font-size: 12px; color: #2e7d32; }
.memory-error { font-size: 12px; color: #c62828; }
.memory-stats { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--text-secondary, #888); padding: 8px 10px; border-radius: 8px; background: var(--bg-soft, #f5f5f5); }
.memory-stats strong { color: var(--text, #222); }
.memory-stats__type { background: #fff; border-radius: 4px; padding: 0 6px; }
.memory-profile { border: 1px solid #e91e6333; border-radius: 8px; padding: 10px 12px; background: #e91e6308; }
.memory-profile h4 { display: flex; align-items: center; gap: 6px; font-size: 13px; margin: 0 0 8px; color: #e91e63; }
.memory-profile__items { display: flex; flex-wrap: wrap; gap: 6px; }
.memory-profile__chip { font-size: 12px; padding: 3px 8px; border-radius: 12px; background: #fff; border: 1px solid #e91e6326; color: #333; }
.memory-list { display: flex; flex-direction: column; gap: 8px; max-height: 380px; overflow-y: auto; }
.memory-empty { color: var(--text-secondary, #888); font-size: 13px; text-align: center; padding: 24px 0; }
.memory-item { border: 1px solid var(--border, #eee); border-left: 3px solid #999; border-radius: 8px; padding: 8px 10px; background: var(--bg-input, #fff); }
.memory-item--preference { border-left-color: #e91e63; }
.memory-item--info { border-left-color: #2196f3; }
.memory-item--decision { border-left-color: #ff9800; }
.memory-item--todo { border-left-color: #4caf50; }
.memory-item__head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.memory-badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #f0f0f0; color: #555; }
.memory-importance { font-size: 11px; color: #f9a825; letter-spacing: 1px; }
.memory-importance .dim { opacity: 0.4; }
.memory-meta { font-size: 11px; color: var(--text-secondary, #999); margin-left: auto; }
.memory-del { border: none; background: none; cursor: pointer; color: #bbb; padding: 2px; }
.memory-del:hover { color: #c62828; }
.memory-item__fact { font-size: 13px; line-height: 1.5; color: var(--text, #222); }
.memory-edit { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; padding-top: 8px; border-top: 1px dashed var(--border, #eee); }
.memory-edit__input { padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--bg-input, #fff); font-size: 13px; color: var(--text, #222); }
.memory-edit__row { display: flex; align-items: center; gap: 8px; }
.memory-edit__imp { width: 64px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--bg-input, #fff); font-size: 13px; color: var(--text, #222); }
.memory-summaries { border-top: 1px solid var(--border, #eee); padding-top: 10px; }
.memory-summaries h4 { display: flex; align-items: center; gap: 6px; font-size: 13px; margin: 0 0 8px; color: var(--text, #222); }
.memory-summary { display: flex; gap: 8px; font-size: 12px; padding: 4px 0; color: var(--text-secondary, #666); }
.memory-summary__time { white-space: nowrap; color: #999; font-size: 11px; padding-top: 1px; }
</style>
