<script setup lang="ts">
import { useChatStore, type SubagentRecord } from "@/stores/chat";

const store = useChatStore();

function statusMeta(r: SubagentRecord) {
  switch (r.status) {
    case "running": return { icon: "🔄", label: "运行中", cls: "run" };
    case "completed": return { icon: "✅", label: "已完成", cls: "ok" };
    case "failed": return { icon: "❌", label: "失败", cls: "err" };
    default: return { icon: "⏳", label: "排队中", cls: "run" };
  }
}
function timeStr(ms: number) {
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}
</script>

<template>
  <div v-if="store.subagents.length" class="subagent-panel">
    <div class="subagent-head">
      <span class="subagent-title">🧵 子代理</span>
      <span class="subagent-count">{{ store.subagents.length }} 个</span>
      <button
        v-if="store.subagents.some((s) => s.status !== 'running')"
        class="subagent-clear"
        title="清空已结束的子代理"
        @click="store.clearFinishedSubagents()"
      >✕ 清空已结束</button>
    </div>
    <div class="subagent-list">
      <div
        v-for="r in store.subagents"
        :key="r.id"
        class="subagent-row"
        :class="statusMeta(r).cls"
      >
        <span class="subagent-status" :title="statusMeta(r).label">
          {{ statusMeta(r).icon }}
        </span>
        <div class="subagent-body">
          <div class="subagent-goal">{{ r.goal }}</div>
          <div v-if="r.status === 'completed' && r.resultPreview" class="subagent-preview">{{ r.resultPreview }}</div>
          <div v-else-if="r.status === 'failed' && r.error" class="subagent-preview subagent-preview--err">{{ r.error }}</div>
          <div v-else-if="r.status === 'running'" class="subagent-preview subagent-preview--dim">正在独立执行子任务…</div>
        </div>
        <div class="subagent-meta">
          <span class="subagent-time">{{ timeStr(r.startedAt) }}</span>
          <span v-if="r.durationSec !== undefined" class="subagent-dur">{{ r.durationSec }}s</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.subagent-panel {
  margin: 8px 12px 4px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-secondary) 80%, transparent);
}
.subagent-head {
  display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
}
.subagent-title { font-size: 12px; font-weight: 700; color: var(--text-primary); }
.subagent-count { font-size: 11px; color: var(--text-muted); }
.subagent-clear {
  margin-left: auto; background: none; border: 1px solid var(--border-color);
  color: var(--text-muted); font-size: 11px; border-radius: 6px; padding: 2px 8px; cursor: pointer;
}
.subagent-clear:hover { color: var(--text-primary); border-color: var(--text-muted); }
.subagent-list { display: flex; flex-direction: column; gap: 6px; }
.subagent-row {
  display: flex; gap: 8px; align-items: flex-start;
  padding: 6px 8px; border: 1px solid var(--border-color); border-radius: 8px;
}
.subagent-row.ok { border-color: rgba(34,197,94,.35); }
.subagent-row.err { border-color: rgba(248,113,113,.4); }
.subagent-status { font-size: 13px; line-height: 1.4; flex-shrink: 0; }
.subagent-body { flex: 1; min-width: 0; }
.subagent-goal {
  font-size: 12px; font-weight: 600; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.subagent-preview {
  font-size: 11px; color: var(--text-muted); margin-top: 2px;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  white-space: pre-wrap;
}
.subagent-preview--err { color: #f87171; }
.subagent-preview--dim { color: var(--text-muted); font-style: italic; }
.subagent-meta {
  display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex-shrink: 0;
}
.subagent-time { font-size: 10px; color: var(--text-muted); }
.subagent-dur { font-size: 10px; color: var(--text-muted); }
</style>
