<script setup lang="ts">
// 撤销操作回放面板（§4.3 撤销待做项）：查看会话内所有可撤销的文件操作
// （编辑/新建/删除快照），一键回滚或导出。数据源：Rust undo_history 表。
import { ref, computed, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, Undo2, Download, ChevronRight } from "lucide-vue-next";
import { notify } from "@/utils/dialog";

interface UndoRow {
  id: number;
  action: string; // edit / create / delete
  path: string;
  backup: string;
  existed: boolean;
  created_at: number;
}

const rows = ref<UndoRow[]>([]);
const filter = ref("");
const expandedId = ref<number | null>(null);

async function refresh() {
  try {
    rows.value = await invoke<UndoRow[]>("list_undo", { limit: 200 });
  } catch { /* ignore */ }
}
async function undo(id: number, path: string) {
  try {
    const msg = await invoke<string>("undo_by_id", { id });
    notify(`↩️ 已回滚：${path}\n${msg}`);
    await refresh();
  } catch (e) {
    notify(`⚠️ 回滚失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
function toggle(id: number) {
  expandedId.value = expandedId.value === id ? null : id;
}
function actionLabel(a: string): string {
  return a === "edit" ? "编辑" : a === "create" ? "新建" : a === "delete" ? "删除" : a;
}
const ACTION_COLOR: Record<string, string> = { edit: "#2196f3", create: "#4caf50", delete: "#e53935" };
function color(a: string): string { return ACTION_COLOR[a] || "#999"; }

const filtered = computed(() => {
  const kw = filter.value.trim().toLowerCase();
  if (!kw) return rows.value;
  return rows.value.filter((r) => r.path.toLowerCase().includes(kw) || actionLabel(r.action).includes(kw));
});

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function exportJson() {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(rows.value, null, 2)], { type: "application/json" }));
  a.download = "undo-history.json";
  a.click();
}

onMounted(refresh);
</script>

<template>
  <div class="up-panel">
    <h3 class="up-title">↩️ 撤销操作回放</h3>
    <p class="up-desc">会话内文件写/删操作的历史快照（写盘前自动记录）。点击「回滚」恢复该操作前的状态（编辑=恢复原内容 / 新建=删除新文件 / 删除=还原文件），回滚后记录自动移除。</p>

    <div class="up-toolbar">
      <input v-model="filter" class="up-input" placeholder="按路径/操作筛选…" />
      <button class="up-btn" @click="refresh"><RefreshCw :size="13" /> 刷新</button>
      <button class="up-btn" @click="exportJson"><Download :size="13" /> 导出 JSON</button>
      <span class="up-count">共 {{ rows.length }} 条</span>
    </div>

    <div class="up-list">
      <div v-for="r in filtered" :key="r.id" class="up-row" @click="toggle(r.id)">
        <div class="up-row__head">
          <ChevronRight :size="13" class="up-chev" :class="{ down: expandedId === r.id }" />
          <span class="up-badge" :style="{ background: color(r.action), color: '#fff' }">{{ actionLabel(r.action) }}</span>
          <span class="up-path">{{ r.path }}</span>
          <span v-if="!r.existed" class="up-gone">已不存在</span>
          <span class="up-time">{{ fmtTime(r.created_at) }}</span>
          <button class="up-undo" @click.stop="undo(r.id, r.path)"><Undo2 :size="12" /> 回滚</button>
        </div>
        <div v-if="expandedId === r.id" class="up-row__detail" @click.stop>
          <div class="up-detail-block"><b>原始内容快照（回滚将恢复/以此为据）</b><pre class="up-pre">{{ r.backup || "（空）" }}</pre></div>
        </div>
      </div>
      <div v-if="!filtered.length" class="up-empty">（暂无撤销记录——Agent 写/删文件后会出现）</div>
    </div>
  </div>
</template>

<style scoped>
.up-panel { display: flex; flex-direction: column; gap: 10px; }
.up-title { font-size: 15px; font-weight: 700; margin: 0; }
.up-desc { font-size: 12px; color: var(--text-secondary, #777); margin: 0; line-height: 1.6; }
.up-toolbar { display: flex; gap: 8px; align-items: center; }
.up-input { padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--bg-input, #fff); color: var(--text, #222); font-size: 13px; min-width: 200px; }
.up-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--bg-input, #fff); color: var(--text); cursor: pointer; font-size: 12px; }
.up-btn:hover { border-color: #4c8dff; color: #4c8dff; }
.up-count { font-size: 12px; color: var(--text-secondary, #888); }
.up-list { display: flex; flex-direction: column; gap: 4px; max-height: 46vh; overflow-y: auto; }
.up-row { border: 1px solid var(--border, #eee); border-radius: 8px; padding: 6px 10px; cursor: pointer; background: var(--bg-soft, #fafafa); }
.up-row.open { background: var(--bg-input, #fff); }
.up-row__head { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.up-chev { transition: transform .15s; color: var(--text-secondary, #999); }
.up-chev.down { transform: rotate(90deg); }
.up-badge { padding: 1px 8px; border-radius: 8px; font-size: 11px; flex-shrink: 0; }
.up-path { font-weight: 600; font-family: ui-monospace, Menlo, monospace; word-break: break-all; flex: 1; }
.up-gone { font-size: 10px; color: #e53935; border: 1px solid #e5393566; border-radius: 8px; padding: 0 6px; flex-shrink: 0; }
.up-time { color: var(--text-secondary, #999); flex-shrink: 0; }
.up-undo { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 6px; border: 1px solid #4caf5066; background: #4caf5011; color: #2e7d32; cursor: pointer; font-size: 11px; flex-shrink: 0; }
.up-undo:hover { background: #4caf5022; }
.up-row__detail { margin-top: 6px; border-top: 1px dashed var(--border, #ddd); padding-top: 6px; }
.up-detail-block b { font-size: 11px; color: var(--text-secondary, #888); }
.up-pre { font-size: 11px; white-space: pre-wrap; word-break: break-word; background: #1e1e2e; color: #d8d8e0; border-radius: 6px; padding: 6px 8px; margin: 4px 0 0; max-height: 140px; overflow-y: auto; }
.up-empty { font-size: 12px; color: var(--text-secondary, #888); padding: 16px; text-align: center; }
</style>
