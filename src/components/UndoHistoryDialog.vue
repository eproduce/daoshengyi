<script setup lang="ts">
// 撤销历史面板弹窗（替代常驻 UndoBubble）：集中展示所有可撤销的文件编辑/新建/删除，
// 逐条回滚。内容复用以既有的 UndoPanel（list_undo / undo_by_id）。
import { onMounted, onUnmounted } from "vue";
import { History, X } from "lucide-vue-next";
import UndoPanel from "./UndoPanel.vue";

const emit = defineEmits<{ (e: "close"): void }>();

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
onMounted(() => document.addEventListener("keydown", onKey));
onUnmounted(() => document.removeEventListener("keydown", onKey));
</script>

<template>
  <Teleport to="body">
    <div class="uhd-overlay" @click.self="emit('close')">
      <div class="uhd-card">
        <div class="uhd-head">
          <span class="uhd-title"><History :size="16" /> 撤销历史 · 文件编辑</span>
          <button class="uhd-close" title="关闭 (Esc)" @click="emit('close')">
            <X :size="16" />
          </button>
        </div>
        <div class="uhd-body">
          <UndoPanel />
        </div>
        <div class="uhd-foot">
          <span class="uhd-hint">撤销记录按文件保存（跨会话有效），回滚后自动移除。</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.uhd-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(2px);
  padding: 24px;
}
.uhd-card {
  display: flex;
  flex-direction: column;
  width: min(760px, 96vw);
  height: min(560px, 86vh);
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
.uhd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}
.uhd-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
}
.uhd-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.uhd-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.uhd-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
}
.uhd-foot {
  padding: 8px 16px;
  border-top: 1px solid var(--border-color);
  color: var(--text-muted);
  font-size: 11px;
}
</style>
