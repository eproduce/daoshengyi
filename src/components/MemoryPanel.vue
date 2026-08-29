<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getSettings, updateSettings } from "@/api/appSettings";
import { useChatStore } from "@/stores/chat";
import { useMemorySystem } from "@/stores/memory";
import { pickForgetCandidates } from "@/utils/memory-format";
import { Pencil, Trash2, RefreshCw, Sparkles, Brain, Search, BookOpen, History, Layers, X } from "lucide-vue-next";

interface FactRow {
  id: string; conversation_id?: string | null; fact: string; fact_type: string;
  importance: number; access_count: number; last_accessed?: number | null; created_at: number;
}
interface SummaryRow {
  id: string; conversation_id: string; summary: string;
  msg_range_start: number; msg_range_end: number; created_at: number;
}
interface EpisodicRow {
  id: string; title: string; summary: string;
  source_summary_ids: string; created_at: number; updated_at: number;
}

const FACT_TYPES = ["", "preference", "info", "decision", "todo"] as const;
const TYPE_LABEL: Record<string, string> = { preference: "偏好", info: "信息", decision: "决策", todo: "待办" };

const facts = ref<FactRow[]>([]);
const summaries = ref<SummaryRow[]>([]);
const episodic = ref<EpisodicRow[]>([]);
const filter = ref<string>("");
const searchKw = ref("");
const loading = ref(false);
const error = ref("");
const maintenanceMsg = ref("");
const reviewMsg = ref("");
const episodicMsg = ref("");
const chatStore = useChatStore();
const memorySystem = useMemorySystem();

async function load() {
  loading.value = true;
  error.value = "";
  try {
    facts.value = await invoke<FactRow[]>("list_facts", { factType: filter.value, limit: 200 });
    summaries.value = await invoke<SummaryRow[]>("list_all_summaries", { limit: 30 });
    episodic.value = await invoke<EpisodicRow[]>("list_episodic", { limit: 20 });
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

// 全文搜索：本地过滤（大小写不敏感、子串匹配事实内容）
const filteredFacts = computed(() => {
  const kw = searchKw.value.trim().toLowerCase();
  if (!kw) return facts.value;
  return facts.value.filter(f => f.fact.toLowerCase().includes(kw));
});

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

// P-A9 智能复习：LLM 回顾记忆库，删除/合并过时、矛盾、重复事实
async function runReview() {
  const config = chatStore.getAuxConfig();
  if (!config?.baseUrl || !config?.apiKey) {
    reviewMsg.value = "请先在 API 配置中填写地址和 Key（记忆复习需要调用模型）";
    return;
  }
  reviewMsg.value = "复习中…";
  reviewMsg.value = await memorySystem.reviewMemories(config);
  await load();
}

// 记忆分层 1.4：跨会话主题汇总（episodic 聚合层）
async function runAggregate() {
  const config = chatStore.getAuxConfig();
  if (!config?.baseUrl || !config?.apiKey) {
    episodicMsg.value = "请先在 API 配置中填写地址和 Key（跨会话汇总需要调用模型）";
    return;
  }
  episodicMsg.value = "汇总中…";
  episodicMsg.value = await memorySystem.aggregateEpisodic(config);
  await load();
}
async function deleteEpisodic(id: string) {
  await invoke("delete_episodic_cmd", { id }).catch(() => {});
  await load();
}

function fmtTime(ts?: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// §3.2 记忆配置：启用记忆注入 + 检索条数
const memoryEnabled = ref(getSettings().memoryEnabled !== false);
const memoryRecallLimit = ref(String(getSettings().memoryRecallLimit ?? 6));
function saveMemoryConfig() {
  const limit = Math.max(1, Math.min(20, Number(memoryRecallLimit.value) || 6));
  memoryRecallLimit.value = String(limit);
  updateSettings({ memoryEnabled: memoryEnabled.value, memoryRecallLimit: limit });
}

// §3.3 遗忘候选：低重要度（≤2）且 30 天以上未访问（偏好永久保护）
const forgetCandidates = computed(() => pickForgetCandidates(facts.value));

onMounted(load);
</script>

<template>
  <div class="memory-panel">
    <p class="memory-desc">
      长期记忆：对话自动提取 + 跨会话检索注入。系统每天自动做<strong>重要度衰减</strong>与<strong>低价值遗忘</strong>（偏好永久保留）。
      这里可查看、筛选、删除记忆，帮助验证「越用越聪明」。
    </p>

    <!-- §3.2 记忆配置 -->
    <div class="memory-config">
      <label class="memory-config__toggle">
        <input type="checkbox" v-model="memoryEnabled" @change="saveMemoryConfig" />
        <span>启用记忆注入</span>
      </label>
      <label class="memory-config__limit">
        相关记忆检索条数
        <input type="number" v-model="memoryRecallLimit" min="1" max="20" @change="saveMemoryConfig" />
      </label>
    </div>

    <div class="memory-toolbar">
      <select v-model="filter" class="memory-filter" @change="load">
        <option v-for="t in FACT_TYPES" :key="t" :value="t">
          {{ t === "" ? "全部类型" : TYPE_LABEL[t] }}
        </option>
      </select>
      <div class="memory-search">
        <Search :size="14" class="memory-search__icon" />
        <input v-model="searchKw" class="memory-search__input" placeholder="搜索记忆内容…" />
      </div>
      <button class="memory-btn" @click="load" :disabled="loading">
        <RefreshCw :size="14" :class="{ spinning: loading }" /> 刷新
      </button>
      <button class="memory-btn" @click="runMaintenance">
        <Sparkles :size="14" /> 执行维护
      </button>
      <button class="memory-btn" @click="runReview" :disabled="!!reviewMsg && reviewMsg === '复习中…'">
        <Brain :size="14" /> 智能复习
      </button>
      <button class="memory-btn" @click="runAggregate" :disabled="!!episodicMsg && episodicMsg === '汇总中…'">
        <Layers :size="14" /> 跨会话汇总
      </button>
      <span v-if="maintenanceMsg" class="memory-msg">{{ maintenanceMsg }}</span>
      <span v-if="reviewMsg" class="memory-msg">{{ reviewMsg }}</span>
      <span v-if="episodicMsg" class="memory-msg">{{ episodicMsg }}</span>
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

    <!-- §3.3 遗忘候选：低重要度 · 长期未访问（偏好保护），提示可删除 -->
    <div v-if="forgetCandidates.length > 0" class="memory-candidates">
      <h4><Trash2 :size="14" /> 遗忘候选（{{ forgetCandidates.length }}）— 低重要度且 30 天以上未访问</h4>
      <div v-for="f in forgetCandidates" :key="f.id" class="memory-candidate">
        <span class="memory-candidate__text">{{ f.fact }}</span>
        <button class="memory-candidate__del" title="删除" @click="deleteFact(f.id)">✕</button>
      </div>
    </div>

    <div class="memory-list">
      <div v-if="filteredFacts.length === 0 && !loading" class="memory-empty">{{ facts.length === 0 ? "暂无记忆（对话结束后自动提取）" : "没有匹配的搜索词" }}</div>
      <div v-for="f in filteredFacts" :key="f.id" class="memory-item" :class="`memory-item--${f.fact_type}`">
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

    <!-- 记忆分层 1.4：episodic 聚合层（跨会话主题汇总） -->
    <div class="memory-episodic">
      <h4><Layers :size="14" /> 跨会话主题（{{ episodic.length }}）— episodic 聚合层</h4>
      <p class="memory-episodic__hint">把多段会话摘要汇总成反复出现的主题/项目/持续关注点。点「跨会话汇总」用模型生成；语义层：事实=memory_facts、单会话摘要=memory_summaries、此处=跨会话聚合。</p>
      <div v-if="episodic.length === 0" class="memory-episodic__empty">尚未生成跨会话主题。先让多个对话生成会话摘要，再点上方「跨会话汇总」。</div>
      <div v-for="e in episodic" :key="e.id" class="memory-episodic__item">
        <div class="memory-episodic__head">
          <strong class="memory-episodic__title">{{ e.title }}</strong>
          <span class="memory-episodic__meta">更新 {{ fmtTime(e.updated_at) }}</span>
          <button class="memory-del" title="删除该主题" @click="deleteEpisodic(e.id)"><X :size="13" /></button>
        </div>
        <div class="memory-episodic__text">{{ e.summary }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.memory-panel { display: flex; flex-direction: column; gap: 12px; }
.memory-desc { color: var(--text-secondary, #888); font-size: 12px; line-height: 1.6; margin: 0; }
.memory-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.memory-filter { padding: 4px 28px 4px 8px; border-radius: 6px; border: 1px solid var(--border-color); background-color: var(--bg-secondary); color: var(--text-primary); font-size: 13px; }
.memory-search { position: relative; display: inline-flex; align-items: center; }
.memory-search__icon { position: absolute; left: 8px; color: #999; }
.memory-search__input { padding: 4px 8px 4px 26px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--bg-input, #fff); color: var(--text, #222); font-size: 13px; width: 160px; }
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
.memory-episodic { border-top: 1px solid var(--border, #eee); padding-top: 10px; }
.memory-episodic h4 { display: flex; align-items: center; gap: 6px; font-size: 13px; margin: 0 0 4px; color: #6a1b9a; }
.memory-episodic__hint { font-size: 11px; color: var(--text-secondary, #888); margin: 0 0 8px; line-height: 1.5; }
.memory-episodic__empty { font-size: 12px; color: var(--text-secondary, #888); padding: 6px 0; }
.memory-episodic__item { border: 1px solid #6a1b9a33; border-left: 3px solid #9c27b0; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; background: #6a1b9a06; }
.memory-episodic__head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.memory-episodic__title { font-size: 13px; color: #6a1b9a; }
.memory-episodic__meta { font-size: 11px; color: #999; flex: 1; }
.memory-episodic__text { font-size: 12px; color: var(--text-secondary, #555); line-height: 1.6; }
.memory-config { display: flex; align-items: center; gap: 16px; font-size: 12px; color: var(--text-secondary, #666); padding: 6px 10px; border-radius: 8px; background: var(--bg-soft, #f5f5f5); }
.memory-config__toggle { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.memory-config__limit { display: inline-flex; align-items: center; gap: 6px; }
.memory-config__limit input { width: 56px; padding: 3px 6px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--bg-input, #fff); font-size: 12px; color: var(--text, #222); }
.memory-candidates { border: 1px solid #c6282833; border-radius: 8px; padding: 10px 12px; background: #c6282808; }
.memory-candidates h4 { display: flex; align-items: center; gap: 6px; font-size: 13px; margin: 0 0 8px; color: #c62828; }
.memory-candidate { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 4px 0; color: var(--text-secondary, #666); }
.memory-candidate__text { flex: 1; }
.memory-candidate__del { border: none; background: none; cursor: pointer; color: #bbb; padding: 2px; }
.memory-candidate__del:hover { color: #c62828; }
</style>
