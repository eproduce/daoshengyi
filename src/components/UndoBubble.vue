<script setup lang="ts">
// 会话内撤销气泡：agent 有可撤销的文件操作（编辑/新建/删除）时，右下角悬浮显示
// 最近一条摘要，点击一键回滚到操作前状态（后端 undo_history 快照）。
import { ref, computed, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { notify } from "@/utils/dialog";
import { Undo2, Loader2 } from "lucide-vue-next";

interface UndoItem {
  id: number; action: string; path: string; backup: string;
  existed: boolean; created_at: number;
}
const items = ref<UndoItem[]>([]);
const loading = ref(false);

async function refresh() {
  try {
    items.value = await invoke<UndoItem[]>("list_undo", { limit: 3 });
  } catch {
    items.value = [];
  }
}

async function undo() {
  if (!items.value.length || loading.value) return;
  loading.value = true;
  try {
    const msg = await invoke<string>("undo_by_id", { id: items.value[0].id });
    await notify(msg, "info");
  } catch (e) {
    await notify(e instanceof Error ? e.message : String(e), "warning");
  } finally {
    loading.value = false;
    await refresh();
  }
}

function onChanged() { refresh(); }
onMounted(() => { refresh(); window.addEventListener("undo-changed", onChanged); });
onUnmounted(() => window.removeEventListener("undo-changed", onChanged));

const label = computed(() => {
  const it = items.value[0];
  if (!it) return "";
  const name = it.path.split("/").pop() || it.path;
  const act = it.action === "edit" ? "编辑" : it.action === "create" ? "新建" : "删除";
  return `${act} ${name}`;
});
</script>

<template>
  <Teleport to="body">
    <button v-if="items.length && label" class="undo-bubble" :disabled="loading" title="撤销最近一次文件操作（恢复操作前状态）" @click="undo">
      <Loader2 v-if="loading" :size="14" class="undo-spin" />
      <Undo2 v-else :size="14" />
      撤销：{{ label }}
    </button>
  </Teleport>
</template>

<style scoped>
.undo-bubble {
  position: fixed;
  right: 18px;
  bottom: 96px; /* 上移到输入条上方，避免遮挡右下角「技能库」按钮 */
  z-index: 1500;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px solid var(--accent-color, #4c8dff);
  border-radius: 999px;
  background: var(--bg-elevated, #fff);
  color: var(--accent-color, #4c8dff);
  font-size: 13px;
  font-weight: 600;
  box-shadow: 0 4px 16px rgba(0, 0, 0, .18);
  cursor: pointer;
  transition: all .15s;
}
.undo-bubble:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(0, 0, 0, .22); }
.undo-bubble:disabled { opacity: .6; cursor: default; }
.undo-spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
