<script setup lang="ts">
// 审计可视化面板（§3.10 🟡）：工具调用全记录（tool_audit）——列表/筛选/回放/导出。
// 数据源：Rust tool_audit 表（command/git/test/内置工具每次调用自动记录）。
import { ref, computed, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, Trash2, Download, ChevronRight } from "lucide-vue-next";

interface AuditRow {
  id: number;
  tool_name: string;
  arguments: string;
  result: string;
  is_error: boolean;
  duration_ms: number;
  created_at: number;
}

const rows = ref<AuditRow[]>([]);
const filter = ref("");
const statusFilter = ref<"all" | "ok" | "err">("all");
const expandedId = ref<number | null>(null);
const limit = 300;

async function refresh() {
  try {
    rows.value = await invoke<AuditRow[]>("list_tool_audit", { limit });
  } catch { /* 后端暂不可用 */ }
}
async function clearAll() {
  try {
    await invoke("clear_tool_audit");
    rows.value = [];
  } catch { /* ignore */ }
}
function toggle(id: number) {
  expandedId.value = expandedId.value === id ? null : id;
}

const filtered = computed(() => {
  const kw = filter.value.trim().toLowerCase();
  return rows.value.filter((r) => {
    if (statusFilter.value === "ok" && r.is_error) return false;
    if (statusFilter.value === "err" && !r.is_error) return false;
    if (kw && !r.tool_name.toLowerCase().includes(kw) && !r.arguments.toLowerCase().includes(kw)) return false;
    return true;
  });
});

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function fmtDur(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
function prettyJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}
function download(name: string, content: string, mime = "application/json") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  a.click();
}
function exportJson() {
  download("tool-audit.json", JSON.stringify(filtered.value, null, 2));
}
function exportMd() {
  const lines = ["# 工具调用审计", "", "| # | 工具 | 时间 | 时长 | 状态 | 参数 | 结果 |", "|---|------|------|------|------|------|------|"];
  for (const r of filtered.value.slice(0, 500)) {
    lines.push(`| ${r.id} | ${r.tool_name} | ${fmtTime(r.created_at)} | ${fmtDur(r.duration_ms)} | ${r.is_error ? "❌失败" : "✅成功"} | ${escapeMd(r.arguments.slice(0, 80))} | ${escapeMd(r.result.slice(0, 80))} |`);
  }
  download("tool-audit.md", lines.join("\n"), "text/markdown");
}
function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
const toolCounts = computed(() => {
  const m = new Map<string, number>();
  for (const r of rows.value) m.set(r.tool_name, (m.get(r.tool_name) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
});
const okCount = computed(() => rows.value.filter((r) => !r.is_error).length);

onMounted(refresh);
</script>

<template>
  <div class="ap-panel">
    <h3 class="ap-title">🛡️ 工具调用审计</h3>
    <p class="ap-desc">Agent 每次调用工具（命令/git/测试/内置工具）自动记录，便于回溯「做了什么」。最近 {{ rows.length }} 条（{{ okCount }} 成功）。</p>

    <div class="ap-toolbar">
      <input v-model="filter" class="ap-input" placeholder="按工具名/参数筛选…" />
      <select v-model="statusFilter" class="ap-select">
        <option value="all">全部状态</option>
        <option value="ok">✅ 成功</option>
        <option value="err">❌ 失败</option>
      </select>
      <button class="ap-btn" @click="refresh"><RefreshCw :size="13" /> 刷新</button>
      <button class="ap-btn" @click="exportJson"><Download :size="13" /> 导出 JSON</button>
      <button class="ap-btn" @click="exportMd"><Download :size="13" /> 导出 MD</button>
      <button class="ap-btn ap-btn--danger" @click="clearAll"><Trash2 :size="13" /> 清空</button>
    </div>

    <div v-if="toolCounts.length" class="ap-stats">
      <span v-for="[t, c] in toolCounts.slice(0, 8)" :key="t" class="ap-stat" @click="filter = t">{{ t }} ×{{ c }}</span>
    </div>

    <div class="ap-list">
      <div v-for="r in filtered" :key="r.id" class="ap-row" :class="{ err: r.is_error, open: expandedId === r.id }" @click="toggle(r.id)">
        <div class="ap-row__head">
          <ChevronRight :size="13" class="ap-chev" :class="{ down: expandedId === r.id }" />
          <span class="ap-dot" :class="r.is_error ? 'err' : 'ok'"></span>
          <span class="ap-tool">{{ r.tool_name }}</span>
          <span class="ap-time">{{ fmtTime(r.created_at) }}</span>
          <span class="ap-dur">{{ fmtDur(r.duration_ms) }}</span>
        </div>
        <div class="ap-row__sum">{{ r.arguments.slice(0, 90) }}</div>
        <div v-if="expandedId === r.id" class="ap-row__detail" @click.stop>
          <div class="ap-detail-block"><b>参数</b><pre class="ap-pre">{{ prettyJson(r.arguments) }}</pre></div>
          <div class="ap-detail-block"><b>结果</b><pre class="ap-pre" :class="{ err: r.is_error }">{{ r.result }}</pre></div>
        </div>
      </div>
      <div v-if="!filtered.length" class="ap-empty">（无记录）</div>
    </div>
  </div>
</template>

<style scoped>
.ap-panel { display: flex; flex-direction: column; gap: 10px; }
.ap-title { font-size: 15px; font-weight: 700; margin: 0; }
.ap-desc { font-size: 12px; color: var(--text-secondary, #777); margin: 0; }
.ap-toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.ap-input { padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--bg-input, #fff); color: var(--text, #222); font-size: 13px; min-width: 180px; }
.ap-select { padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--bg-input, #fff); color: var(--text, #222); font-size: 13px; }
.ap-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--bg-input, #fff); cursor: pointer; font-size: 12px; }
.ap-btn:hover { border-color: #4c8dff; color: #4c8dff; }
.ap-btn--danger { color: #c62828; border-color: #c6282866; }
.ap-stats { display: flex; gap: 6px; flex-wrap: wrap; }
.ap-stat { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--bg-soft, #f0f0f0); color: var(--text-secondary, #666); cursor: pointer; }
.ap-stat:hover { background: #4c8dff22; color: #4c8dff; }
.ap-list { display: flex; flex-direction: column; gap: 4px; max-height: 46vh; overflow-y: auto; }
.ap-row { border: 1px solid var(--border, #eee); border-left: 3px solid #2e7d32; border-radius: 8px; padding: 6px 10px; cursor: pointer; background: var(--bg-soft, #fafafa); }
.ap-row.err { border-left-color: #c62828; }
.ap-row.open { background: var(--bg-input, #fff); }
.ap-row__head { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.ap-chev { transition: transform .15s; color: var(--text-secondary, #999); }
.ap-chev.down { transform: rotate(90deg); }
.ap-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.ap-dot.ok { background: #2e7d32; }
.ap-dot.err { background: #c62828; }
.ap-tool { font-weight: 700; font-family: ui-monospace, Menlo, monospace; }
.ap-time { color: var(--text-secondary, #999); margin-left: auto; }
.ap-dur { color: var(--text-secondary, #888); font-size: 11px; }
.ap-row__sum { font-size: 11px; color: var(--text-secondary, #777); margin-top: 2px; word-break: break-all; }
.ap-row__detail { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; border-top: 1px dashed var(--border, #ddd); padding-top: 6px; }
.ap-detail-block b { font-size: 11px; color: var(--text-secondary, #888); }
.ap-pre { font-size: 11px; white-space: pre-wrap; word-break: break-word; background: #1e1e2e; color: #d8d8e0; border-radius: 6px; padding: 6px 8px; margin: 0; max-height: 160px; overflow-y: auto; }
.ap-pre.err { color: #ffb4b4; }
.ap-empty { font-size: 12px; color: var(--text-secondary, #888); padding: 16px; text-align: center; }
</style>
