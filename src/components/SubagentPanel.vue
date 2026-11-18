<script setup lang="ts">
import { useChatStore, type SubagentRecord } from "@/stores/chat";
import {
  Network,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Hourglass,
  History,
  Users,
} from "lucide-vue-next";
import { onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import SubagentTraceDialog from "./SubagentTraceDialog.vue";

const store = useChatStore();
// 复盘弹窗：只在用户点开时读库（轨迹可达 40 条，没必要预加载）
const traceId = ref<string | null>(null);

// ── 花名册（成员 = 子会话 + 角色/状态/预算）──
//
// 为什么不和子代理列表合并：子代理是一次性调用（跑完就没），成员是长期存在、能反复派活的。
// 混在一起会让人以为「成员跑完就消失了」。
interface RosterRow {
  id: string;
  name: string;
  role_id: string | null;
  brief: string;
  status: string;
  turns: number;
  tokens: number;
}
const roster = ref<RosterRow[]>([]);
const rosterOpen = ref(false);

const ROSTER_LABEL: Record<string, string> = {
  idle: "空闲",
  running: "运行中",
  waiting: "等待",
  done: "已完成",
  failed: "失败",
  cancelled: "已归档",
  interrupted: "被中断",
};

async function loadRoster() {
  const cid = store.activeConversationId;
  if (!cid) {
    roster.value = [];
    return;
  }
  try {
    roster.value = await invoke<RosterRow[]>("agent_list", { conversationId: cid });
  } catch {
    roster.value = [];
  }
}

async function toggleRoster() {
  rosterOpen.value = !rosterOpen.value;
  if (rosterOpen.value) await loadRoster();
}

function openMember(id: string) {
  // 成员就是一个真实会话：直接切过去看它的完整过程
  store.selectConversation(id);
}

onMounted(loadRoster);
watch(() => store.activeConversationId, loadRoster);

function statusMeta(r: SubagentRecord) {
  switch (r.status) {
    case "running":
      return { icon: "🔄", label: "运行中", cls: "run" };
    case "completed":
      return { icon: "✅", label: "已完成", cls: "ok" };
    case "failed":
      return { icon: "❌", label: "失败", cls: "err" };
    default:
      return { icon: "⏳", label: "排队中", cls: "run" };
  }
}
function timeStr(ms: number) {
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}
</script>

<template>
  <div v-if="store.subagents.length || roster.length" class="subagent-panel">
    <div v-if="store.subagents.length" class="subagent-head">
      <span class="subagent-title"><Network :size="15" /> 子代理</span>
      <span class="subagent-count">{{ store.subagents.length }} 个</span>
      <button
        v-if="store.subagents.some((s) => s.status !== 'running')"
        class="subagent-clear"
        title="清空已结束的子代理"
        @click="store.clearFinishedSubagents()"
      >
        ✕ 清空已结束
      </button>
    </div>
    <div v-if="store.subagents.length" class="subagent-list">
      <div v-for="r in store.subagents" :key="r.id" class="subagent-row" :class="statusMeta(r).cls">
        <span class="subagent-status" :title="statusMeta(r).label">
          <RefreshCw v-if="r.status === 'running'" :size="14" class="spin" />
          <CheckCircle2 v-else-if="r.status === 'completed'" :size="14" />
          <XCircle v-else-if="r.status === 'failed'" :size="14" />
          <Hourglass v-else :size="14" />
        </span>
        <div class="subagent-body">
          <div class="subagent-goal">{{ r.goal }}</div>
          <div v-if="r.status === 'completed' && r.resultPreview" class="subagent-preview">
            {{ r.resultPreview }}
          </div>
          <div
            v-else-if="r.status === 'failed' && r.error"
            class="subagent-preview subagent-preview--err"
          >
            {{ r.error }}
          </div>
          <div v-else-if="r.status === 'running'" class="subagent-preview subagent-preview--dim">
            正在独立执行子任务…
          </div>
        </div>
        <div class="subagent-meta">
          <button
            v-if="r.traceId && r.status !== 'running' && r.status !== 'queued'"
            class="subagent-trace"
            title="看它读了什么、调了哪些工具、为什么停"
            @click="traceId = r.traceId ?? null"
          >
            <History :size="12" /> 复盘
          </button>
          <span class="subagent-time">{{ timeStr(r.startedAt) }}</span>
          <span v-if="r.durationSec !== undefined" class="subagent-dur">{{ r.durationSec }}s</span>
        </div>
      </div>
    </div>
    <div class="roster">
      <button class="roster-toggle" @click="toggleRoster">
        <Users :size="13" /> 成员 {{ roster.length || "" }}
        <span class="roster-caret">{{ rosterOpen ? "▾" : "▸" }}</span>
      </button>
      <div v-if="rosterOpen" class="roster-list">
        <p v-if="!roster.length" class="roster-empty">
          还没有成员。让它「建一个调研员」之类的长期成员，就能反复派活。
        </p>
        <div v-for="a in roster" :key="a.id" class="roster-row">
          <span class="roster-name" :title="a.brief">{{ a.name }}</span>
          <span v-if="a.role_id" class="roster-role">{{ a.role_id }}</span>
          <span class="roster-status" :class="a.status">{{
            ROSTER_LABEL[a.status] || a.status
          }}</span>
          <span class="roster-stat">{{ a.turns }} 回合</span>
          <button class="roster-open" title="打开它的会话" @click="openMember(a.id)">打开</button>
        </div>
      </div>
    </div>
    <SubagentTraceDialog :trace-id="traceId" @close="traceId = null" />
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
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.subagent-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-primary);
}
.subagent-count {
  font-size: 11px;
  color: var(--text-muted);
}
.subagent-clear {
  margin-left: auto;
  background: none;
  border: 1px solid var(--border-color);
  color: var(--text-muted);
  font-size: 11px;
  border-radius: 6px;
  padding: 2px 8px;
  cursor: pointer;
}
.roster {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--border-color);
}
.roster-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
}
.roster-toggle:hover {
  color: var(--text-primary);
}
.roster-caret {
  font-size: 9px;
}
.roster-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}
.roster-empty {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
}
.roster-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  padding: 3px 4px;
  border-radius: 5px;
}
.roster-row:hover {
  background: color-mix(in srgb, var(--bg-secondary) 70%, transparent);
}
.roster-name {
  font-weight: 600;
  color: var(--text-primary);
}
.roster-role {
  font-size: 10px;
  color: var(--text-muted);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 0 3px;
}
.roster-status {
  color: var(--text-muted);
}
.roster-status.running {
  color: #4a9eff;
}
.roster-status.failed,
.roster-status.interrupted {
  color: #e06c60;
}
.roster-status.cancelled {
  opacity: 0.6;
}
.roster-stat {
  margin-left: auto;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.roster-open {
  background: none;
  border: 1px solid var(--border-color);
  color: var(--text-muted);
  font-size: 10px;
  border-radius: 5px;
  padding: 0 5px;
  cursor: pointer;
}
.roster-open:hover {
  color: var(--text-primary);
  border-color: var(--text-muted);
}
.subagent-trace {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: none;
  border: 1px solid var(--border-color);
  color: var(--text-muted);
  font-size: 11px;
  border-radius: 6px;
  padding: 1px 6px;
  cursor: pointer;
}
.subagent-trace:hover {
  color: var(--text-primary);
  border-color: var(--text-muted);
}
.subagent-clear:hover {
  color: var(--text-primary);
  border-color: var(--text-muted);
}
.subagent-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.subagent-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}
.subagent-row.ok {
  border-color: rgba(34, 197, 94, 0.35);
}
.subagent-row.err {
  border-color: rgba(248, 113, 113, 0.4);
}
.subagent-status {
  font-size: 13px;
  line-height: 1.4;
  flex-shrink: 0;
}
.subagent-body {
  flex: 1;
  min-width: 0;
}
.subagent-goal {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.subagent-preview {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: pre-wrap;
}
.subagent-preview--err {
  color: #f87171;
}
.subagent-preview--dim {
  color: var(--text-muted);
  font-style: italic;
}
.subagent-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
}
.subagent-time {
  font-size: 10px;
  color: var(--text-muted);
}
.subagent-dur {
  font-size: 10px;
  color: var(--text-muted);
}
</style>
