<script setup lang="ts">
// 撤销操作回放面板（§4.3 撤销待做项）：查看会话内所有可撤销的文件操作
// （编辑/新建/删除快照），一键回滚或导出。数据源：Rust undo_history 表。
import { ref, computed, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, Undo2, Download, ChevronRight } from "lucide-vue-next";
import { notify, askConfirm } from "@/utils/dialog";

// 写/删文件后会派发 undo-changed（chat.ts notifyUndoChanged）→ 面板实时刷新
function onUndoChanged() {
  void refresh();
  void refreshTrash();
}

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
  } catch {
    /* ignore */
  }
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
const ACTION_COLOR: Record<string, string> = {
  edit: "#2196f3",
  create: "#4caf50",
  delete: "#e53935",
};
function color(a: string): string {
  return ACTION_COLOR[a] || "#999";
}

const filtered = computed(() => {
  const kw = filter.value.trim().toLowerCase();
  if (!kw) return rows.value;
  return rows.value.filter(
    (r) => r.path.toLowerCase().includes(kw) || actionLabel(r.action).includes(kw),
  );
});

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
function exportJson() {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(rows.value, null, 2)], { type: "application/json" }),
  );
  a.download = "undo-history.json";
  a.click();
}

onMounted(() => {
  window.addEventListener("undo-changed", onUndoChanged);
  void refresh();
  void refreshTrash();
});
onUnmounted(() => window.removeEventListener("undo-changed", onUndoChanged));

// --- P0-4b 回收站：delete_file 不再永久抹除，这里列出并可逐个还原 ---
interface TrashRow {
  id: string;
  name: string;
  original: string;
  size: number;
  deleted_at: number;
}
const trash = ref<TrashRow[]>([]);
const trashOpen = ref(true);

async function refreshTrash() {
  try {
    trash.value = await invoke<TrashRow[]>("trash_list");
  } catch {
    trash.value = [];
  }
}
function fmtSize(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
async function restoreTrash(id: string, name: string) {
  try {
    const msg = await invoke<string>("trash_restore", { id });
    notify(`↩️ ${name} 已还原\n${msg}`);
    await Promise.all([refreshTrash(), refresh()]);
  } catch (e) {
    notify(`⚠️ 还原失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
async function emptyTrash() {
  if (!trash.value.length) return;
  const ok = await askConfirm(
    `⚠️ 清空回收站会**永久删除** ${trash.value.length} 个文件（无法恢复）。确定继续？`,
  );
  if (!ok) return;
  try {
    const n = await invoke<number>("trash_empty");
    notify(`已清空回收站（永久删除 ${n} 个文件）`);
    await refreshTrash();
  } catch (e) {
    notify(`⚠️ 清空失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
</script>

<template>
  <div class="up-panel">
    <h3 class="up-title">↩️ 撤销操作回放</h3>
    <p class="up-desc">
      会话内文件写/删操作的历史快照（写盘前自动记录）。点击「回滚」恢复该操作前的状态（编辑=恢复原内容
      / 新建=删除新文件 / 删除=还原文件），回滚后记录自动移除。
    </p>

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
          <span class="up-badge" :style="{ background: color(r.action), color: '#fff' }">{{
            actionLabel(r.action)
          }}</span>
          <span class="up-path">{{ r.path }}</span>
          <span v-if="!r.existed" class="up-gone">已不存在</span>
          <span class="up-time">{{ fmtTime(r.created_at) }}</span>
          <button class="up-undo" @click.stop="undo(r.id, r.path)">
            <Undo2 :size="12" /> 回滚
          </button>
        </div>
        <div v-if="expandedId === r.id" class="up-row__detail" @click.stop>
          <div class="up-detail-block">
            <b>原始内容快照（回滚将恢复/以此为据）</b>
            <pre class="up-pre">{{ r.backup || "（空）" }}</pre>
          </div>
        </div>
      </div>
      <div v-if="!filtered.length" class="up-empty">（暂无撤销记录——Agent 写/删文件后会出现）</div>
    </div>

    <!-- P0-4b 回收站：删除的可恢复副本 -->
    <div class="up-trash">
      <div class="up-trash__head" @click="trashOpen = !trashOpen">
        <ChevronRight :size="13" class="up-chev" :class="{ down: trashOpen }" />
        <b>🗑️ 回收站</b>
        <span class="up-trash__count">{{ trash.length }} 项</span>
        <span class="up-trash__hint">delete_file 的删除会先移到这里（保留 30 天）</span>
        <button class="up-btn" @click.stop="refreshTrash"><RefreshCw :size="12" /> 刷新</button>
        <button class="up-btn up-btn--danger" :disabled="!trash.length" @click.stop="emptyTrash">
          清空
        </button>
      </div>
      <div v-if="trashOpen" class="up-trash__list">
        <div v-for="t in trash" :key="t.id" class="up-trash__row">
          <span class="up-trash__name">{{ t.name }}</span>
          <span class="up-trash__size">{{ fmtSize(t.size) }}</span>
          <span class="up-trash__time">{{ fmtTime(t.deleted_at * 1000) }}</span>
          <span class="up-trash__orig" :title="t.original">{{
            t.original || "（原路径记录缺失）"
          }}</span>
          <button class="up-undo" @click="restoreTrash(t.id, t.name)">
            <Undo2 :size="12" /> 还原
          </button>
        </div>
        <div v-if="!trash.length" class="up-empty">（回收站为空）</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.up-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.up-title {
  font-size: 15px;
  font-weight: 700;
  margin: 0;
}
.up-desc {
  font-size: 12px;
  color: var(--text-secondary, #777);
  margin: 0;
  line-height: 1.6;
}
.up-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
}
.up-input {
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--border, #ddd);
  background: var(--bg-input, #fff);
  color: var(--text, #222);
  font-size: 13px;
  min-width: 200px;
}
.up-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--border, #ddd);
  background: var(--bg-input, #fff);
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
}
.up-btn:hover {
  border-color: #4c8dff;
  color: #4c8dff;
}
.up-count {
  font-size: 12px;
  color: var(--text-secondary, #888);
}
.up-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 46vh;
  overflow-y: auto;
}
.up-row {
  border: 1px solid var(--border, #eee);
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  background: var(--bg-soft, #fafafa);
}
.up-row.open {
  background: var(--bg-input, #fff);
}
.up-row__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.up-chev {
  transition: transform 0.15s;
  color: var(--text-secondary, #999);
}
.up-chev.down {
  transform: rotate(90deg);
}
.up-badge {
  padding: 1px 8px;
  border-radius: 8px;
  font-size: 11px;
  flex-shrink: 0;
}
.up-path {
  font-weight: 600;
  font-family: ui-monospace, Menlo, monospace;
  word-break: break-all;
  flex: 1;
}
.up-gone {
  font-size: 10px;
  color: #e53935;
  border: 1px solid #e5393566;
  border-radius: 8px;
  padding: 0 6px;
  flex-shrink: 0;
}
.up-time {
  color: var(--text-secondary, #999);
  flex-shrink: 0;
}
.up-undo {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid #4caf5066;
  background: #4caf5011;
  color: #2e7d32;
  cursor: pointer;
  font-size: 11px;
  flex-shrink: 0;
}
.up-undo:hover {
  background: #4caf5022;
}
.up-row__detail {
  margin-top: 6px;
  border-top: 1px dashed var(--border, #ddd);
  padding-top: 6px;
}
.up-detail-block b {
  font-size: 11px;
  color: var(--text-secondary, #888);
}
.up-pre {
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  background: #1e1e2e;
  color: #d8d8e0;
  border-radius: 6px;
  padding: 6px 8px;
  margin: 4px 0 0;
  max-height: 140px;
  overflow-y: auto;
}
.up-empty {
  font-size: 12px;
  color: var(--text-secondary, #888);
  padding: 16px;
  text-align: center;
}

/* P0-4b 回收站 */
.up-trash {
  border: 1px solid var(--border, #eee);
  border-radius: 8px;
  background: var(--bg-soft, #fafafa);
  padding: 8px 10px;
}
.up-trash__head {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 12px;
}
.up-trash__count {
  font-weight: 650;
  color: var(--text-secondary, #777);
}
.up-trash__hint {
  font-size: 11px;
  color: var(--text-secondary, #999);
  margin-left: auto;
}
.up-trash__list {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.up-trash__row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 6px;
  background: var(--bg-input, #fff);
}
.up-trash__name {
  font-weight: 650;
  flex-shrink: 0;
}
.up-trash__size,
.up-trash__time {
  color: var(--text-secondary, #999);
  font-size: 11px;
  flex-shrink: 0;
}
.up-trash__orig {
  color: var(--text-secondary, #777);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
</style>
