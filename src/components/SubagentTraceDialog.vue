<script setup lang="ts">
import { ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { X, RefreshCw } from "lucide-vue-next";
import type { TraceEntry } from "@/utils/subagent-trace";

/**
 * 子代理复盘：把落库的轨迹展示出来（「它读过什么、调过什么、为什么停」）。
 *
 * 为什么不直接在列表里渲染：一条轨迹可达 40 条 × 240 字符，塞进面板会把主界面挤变形；
 * 而且它是**出问题时才看**的东西，默认收起才合理。
 */
const props = defineProps<{ traceId: string | null }>();
const emit = defineEmits<{ close: [] }>();

interface RunRow {
  id: string;
  goal: string;
  role_id: string | null;
  status: string;
  rounds: number;
  started_at: number;
  finished_at: number | null;
  entries: number;
  dropped: number;
  result: string;
  trace: string;
}

const run = ref<RunRow | null>(null);
const entries = ref<TraceEntry[]>([]);
const loading = ref(false);
const error = ref("");

const statusText: Record<string, string> = {
  done: "已完成",
  failed: "失败",
  stopped: "已停止",
  round_limit: "撞轮次上限",
};

async function load() {
  const id = props.traceId;
  if (!id) return;
  loading.value = true;
  error.value = "";
  try {
    const row = await invoke<RunRow | null>("subagent_run_get", { id });
    if (!row) {
      error.value = "这条轨迹已不存在（可能被清理）";
      run.value = null;
      entries.value = [];
      return;
    }
    run.value = row;
    try {
      const parsed = JSON.parse(row.trace) as { entries?: TraceEntry[] };
      entries.value = parsed.entries ?? [];
    } catch {
      entries.value = [];
      error.value = "轨迹内容损坏，只显示结论";
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

watch(() => props.traceId, load, { immediate: true });

function timeStr(ms: number | null) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
</script>

<template>
  <div class="trace-mask" @click.self="emit('close')">
    <div class="trace-dialog" role="dialog" aria-label="子代理轨迹">
      <header class="trace-head">
        <span class="trace-title">子代理轨迹</span>
        <span v-if="run" class="trace-meta">
          {{ statusText[run.status] || run.status }} · {{ run.rounds }} 轮 ·
          {{ run.entries }} 条<span v-if="run.dropped > 0"> （另 {{ run.dropped }} 条未存）</span> ·
          {{ timeStr(run.started_at) }}
        </span>
        <span style="flex: 1"></span>
        <button class="trace-icon-btn" title="重新读取" @click="load">
          <RefreshCw :size="14" :class="{ spin: loading }" />
        </button>
        <button class="trace-icon-btn" title="关闭" @click="emit('close')"><X :size="15" /></button>
      </header>

      <p v-if="run" class="trace-goal">{{ run.goal }}</p>
      <p v-if="error" class="trace-error">{{ error }}</p>
      <p v-if="loading" class="trace-dim">正在读取…</p>

      <ol v-if="entries.length" class="trace-list">
        <li
          v-for="(e, i) in entries"
          :key="i"
          class="trace-row"
          :class="{ err: e.status === 'error' }"
        >
          <span class="trace-round">R{{ e.round }}</span>
          <span class="trace-kind">
            <template v-if="e.kind === 'tool'"
              >{{ e.tool }}{{ e.status === "error" ? " ✗" : "" }}</template
            >
            <template v-else-if="e.kind === 'note'">说明</template>
            <template v-else>输出</template>
          </span>
          <div class="trace-text">
            <div v-if="e.args" class="trace-args">{{ e.args }}</div>
            <div class="trace-result">{{ e.result }}</div>
          </div>
        </li>
      </ol>
      <p v-else-if="!loading && !error" class="trace-dim">（这次运行没有记录任何步骤）</p>

      <div v-if="run?.result" class="trace-result-box">
        <div class="trace-result-label">最终结论</div>
        <div class="trace-result-body">{{ run.result }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trace-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3000;
}
.trace-dialog {
  width: min(760px, 92vw);
  max-height: 78vh;
  overflow-y: auto;
  background: var(--panel, #1b1d21);
  color: var(--text, #e6e6e6);
  border: 1px solid var(--border, #33363c);
  border-radius: 10px;
  padding: 14px 16px 18px;
}
.trace-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.trace-title {
  font-weight: 600;
}
.trace-meta,
.trace-dim {
  font-size: 12px;
  color: var(--dim, #9096a0);
}
.trace-icon-btn {
  background: transparent;
  border: 1px solid var(--border, #33363c);
  border-radius: 6px;
  color: inherit;
  cursor: pointer;
  padding: 3px 5px;
  display: inline-flex;
}
.trace-goal {
  margin: 4px 0 10px;
  font-size: 13px;
  color: var(--text, #e6e6e6);
  opacity: 0.9;
}
.trace-error {
  color: #e06c60;
  font-size: 12px;
}
.trace-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.trace-row {
  display: grid;
  grid-template-columns: 34px 96px 1fr;
  gap: 8px;
  align-items: start;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  font-size: 12px;
}
.trace-row.err {
  background: rgba(224, 108, 96, 0.1);
}
.trace-round {
  color: var(--dim, #9096a0);
  font-variant-numeric: tabular-nums;
}
.trace-kind {
  font-weight: 500;
  word-break: break-all;
}
.trace-args {
  color: var(--dim, #9096a0);
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11px;
  margin-bottom: 2px;
}
.trace-result {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.45;
}
.trace-result-box {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--border, #33363c);
}
.trace-result-label {
  font-size: 12px;
  color: var(--dim, #9096a0);
  margin-bottom: 4px;
}
.trace-result-body {
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
