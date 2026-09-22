<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { v4 as uuidv4 } from "@/stores/uuid";
import { notify, askConfirm } from "@/utils/dialog";
import {
  AlarmClock,
  Plus,
  RefreshCw,
  Play,
  Pause,
  Pencil,
  Trash2,
  Clock,
  Info,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Timer,
  CalendarClock,
} from "lucide-vue-next";
import {
  EMPTY_FORM,
  SCHEDULE_PRESETS,
  COMMAND_EXAMPLES,
  applyPreset,
  matchPresetId,
  nextRunAt,
  nextRunPreview,
  relativeTime,
  fmtDateTime,
  runStatus,
  RUN_STATUS_TEXT,
  scheduleLabel,
  validateTaskForm,
  type RunStatus,
  type TaskForm,
} from "@/utils/schedule-format";

interface ScheduledTask {
  id: string;
  name: string;
  command: string;
  schedule_type: string;
  interval_minutes: number;
  daily_time: string;
  enabled: boolean;
  next_run_at: number;
  last_run_at: number | null;
  last_result: string | null;
  /** 上次退出码（0 = 成功）；老数据可能为 null */
  last_exit_code: number | null;
  created_at: number;
}

const tasks = ref<ScheduledTask[]>([]);
const error = ref("");
const loading = ref(false);
const showForm = ref(false);
const editingId = ref<string | null>(null);
const form = ref<TaskForm>({ ...EMPTY_FORM });
/** 正在「立即运行」的任务 id（按钮转圈 + 防重复点击） */
const runningId = ref<string | null>(null);
/** 卡片上的相对时间需要一个会走的「现在」（30 秒一跳，与后端轮询节奏一致） */
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;

const activePresetId = computed(() => matchPresetId(form.value));
const preview = computed(() => nextRunPreview(form.value, now.value));
const isEditing = computed(() => editingId.value !== null);

async function load() {
  loading.value = true;
  try {
    tasks.value = await invoke<ScheduledTask[]>("list_scheduled_tasks");
    error.value = "";
  } catch (e) {
    error.value = `加载失败: ${e}`;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  load();
  ticker = setInterval(() => (now.value = Date.now()), 30_000);
});
onUnmounted(() => {
  if (ticker) clearInterval(ticker);
});

function openCreate() {
  editingId.value = null;
  form.value = { ...EMPTY_FORM };
  showForm.value = true;
}

function openEdit(t: ScheduledTask) {
  editingId.value = t.id;
  form.value = {
    name: t.name,
    command: t.command,
    scheduleType: t.schedule_type === "daily" ? "daily" : "interval",
    intervalMinutes: t.interval_minutes > 0 ? t.interval_minutes : 60,
    dailyTime: t.daily_time || "09:00",
  };
  showForm.value = true;
}

function closeForm() {
  showForm.value = false;
  editingId.value = null;
  form.value = { ...EMPTY_FORM };
}

function usePreset(id: string) {
  const preset = SCHEDULE_PRESETS.find((p) => p.id === id);
  if (preset) form.value = applyPreset(form.value, preset);
}

function useExample(example: { label: string; command: string }) {
  form.value.command = example.command;
  if (!form.value.name.trim()) form.value.name = example.label;
}

async function saveTask() {
  const problem = validateTaskForm(form.value);
  if (problem) {
    await notify(problem);
    return;
  }
  const existing = editingId.value ? tasks.value.find((t) => t.id === editingId.value) : null;
  const nowMs = Date.now();
  const task: ScheduledTask = {
    id: existing?.id ?? uuidv4(),
    name: form.value.name.trim(),
    command: form.value.command.trim(),
    schedule_type: form.value.scheduleType,
    interval_minutes: form.value.scheduleType === "interval" ? form.value.intervalMinutes : 60,
    daily_time: form.value.scheduleType === "daily" ? form.value.dailyTime : "",
    enabled: existing?.enabled ?? true,
    // 新建/改调度都按「从现在起」重算下次时间：改完立刻生效，不留旧时刻
    next_run_at: nextRunAt(form.value, nowMs),
    last_run_at: existing?.last_run_at ?? null,
    last_result: existing?.last_result ?? null,
    last_exit_code: existing?.last_exit_code ?? null,
    created_at: existing?.created_at ?? nowMs,
  };
  try {
    await invoke("save_scheduled_task", { task });
    const wasEditing = !!existing;
    closeForm();
    await load();
    await notify(wasEditing ? `已更新「${task.name}」` : `已创建「${task.name}」`, "info");
  } catch (e) {
    error.value = `保存失败: ${e}`;
  }
}

async function removeTask(t: ScheduledTask) {
  const ok = await askConfirm(`删除定时任务「${t.name}」？\n\n$ ${t.command}`);
  if (!ok) return;
  try {
    await invoke("delete_scheduled_task", { id: t.id });
    await load();
  } catch (e) {
    error.value = `删除失败: ${e}`;
  }
}

async function toggle(t: ScheduledTask) {
  try {
    await invoke("toggle_scheduled_task", { id: t.id, enabled: !t.enabled });
    await load();
    await notify(t.enabled ? `已暂停「${t.name}」` : `已启用「${t.name}」`, "info");
  } catch (e) {
    error.value = `切换失败: ${e}`;
  }
}

/** 立即运行一次（用于验证配置）：不改动下次运行时间，只记录本次结果 */
async function runNow(t: ScheduledTask) {
  if (runningId.value) return;
  runningId.value = t.id;
  try {
    const r = await invoke<{ exit_code: number | null; duration_ms: number; result: string }>(
      "run_scheduled_task_now",
      { id: t.id },
    );
    await load();
    const ok = r.exit_code === 0;
    const head = r.result.length > 300 ? `${r.result.slice(0, 300)}…` : r.result;
    await notify(
      `${ok ? "运行成功" : `运行失败（退出码 ${r.exit_code ?? "?"}）`}（${r.duration_ms}ms）\n\n${head}`,
      ok ? "info" : "error",
    );
  } catch (e) {
    error.value = `运行失败: ${e}`;
  } finally {
    runningId.value = null;
  }
}

function statusOf(t: ScheduledTask): RunStatus {
  return runStatus(t);
}
const STATUS_ICON: Record<RunStatus, unknown> = {
  never: Timer,
  ok: CheckCircle2,
  fail: XCircle,
  timeout: AlertCircle,
  unknown: Info,
};
function statusText(t: ScheduledTask): string {
  const s = statusOf(t);
  if (s === "never") return RUN_STATUS_TEXT.never;
  const at = t.last_run_at ? fmtDateTime(t.last_run_at) : "";
  return `${RUN_STATUS_TEXT[s]} · ${at}`;
}
</script>

<template>
  <div class="tasks-panel">
    <div class="tasks-panel__head">
      <h3><AlarmClock :size="16" /> 定时任务</h3>
      <div class="tasks-panel__head-acts">
        <button class="btn-ghost" title="刷新" :disabled="loading" @click="load">
          <RefreshCw :size="13" />
        </button>
        <button v-if="!showForm" class="btn-primary" @click="openCreate">
          <Plus :size="13" /> 新建任务
        </button>
      </div>
    </div>

    <p class="tasks-hint">
      到点后在本机执行一条命令，输出记在任务卡片里。后台每 30 秒检查一次；错过的时间
      <b>只补跑一次</b>（不会连续重跑），单次最多执行 300 秒。
    </p>
    <p v-if="error" class="tasks-error">{{ error }}</p>

    <!-- 新建 / 编辑（同一套表单） -->
    <div v-if="showForm" class="tasks-form">
      <div class="form-title">{{ isEditing ? "编辑任务" : "新建任务" }}</div>

      <div class="field">
        <span class="field__label">① 跑什么</span>
        <input v-model="form.name" class="input" placeholder="任务名称（如：每天备份文档）" />
        <input
          v-model="form.command"
          class="input input--mono"
          placeholder="要执行的命令，如 df -h /"
          @keydown.enter="saveTask"
        />
      </div>
      <div class="example-row">
        <span class="example-row__label">试试：</span>
        <button v-for="e in COMMAND_EXAMPLES" :key="e.label" class="chip" @click="useExample(e)">
          {{ e.label }}
        </button>
      </div>

      <div class="field">
        <span class="field__label">② 什么时候跑</span>
        <div class="preset-row">
          <button
            v-for="p in SCHEDULE_PRESETS"
            :key="p.id"
            class="chip"
            :class="{ 'chip--on': activePresetId === p.id }"
            @click="usePreset(p.id)"
          >
            {{ p.label }}
          </button>
        </div>
        <div class="custom-row">
          <select v-model="form.scheduleType" class="input select">
            <option value="interval">按间隔重复</option>
            <option value="daily">每天固定时刻</option>
          </select>
          <template v-if="form.scheduleType === 'interval'">
            <span>每</span>
            <input
              v-model.number="form.intervalMinutes"
              type="number"
              min="1"
              class="input input--num"
            />
            <span>分钟</span>
          </template>
          <template v-else>
            <span>每天</span>
            <input v-model="form.dailyTime" type="time" class="input input--num" />
          </template>
        </div>
        <div class="preview">
          <CalendarClock :size="13" /> 下次运行：<b>{{ preview }}</b>
        </div>
      </div>

      <div class="form-acts">
        <button class="btn-primary" @click="saveTask">
          {{ isEditing ? "保存修改" : "创建任务" }}
        </button>
        <button class="btn-secondary" @click="closeForm">取消</button>
      </div>
    </div>

    <!-- 任务列表 -->
    <div v-if="tasks.length" class="tasks-list">
      <div
        v-for="t in tasks"
        :key="t.id"
        class="task-card"
        :class="{ 'task-card--off': !t.enabled }"
      >
        <div class="task-card__top">
          <component
            :is="STATUS_ICON[statusOf(t)]"
            :size="14"
            class="status"
            :class="`status--${statusOf(t)}`"
          />
          <span class="task-card__name">{{ t.name }}</span>
          <span v-if="!t.enabled" class="badge">已暂停</span>
        </div>

        <div class="task-card__cmd">
          <code>$ {{ t.command }}</code>
        </div>

        <div class="task-card__meta">
          <span><Clock :size="12" /> {{ scheduleLabel(t) }}</span>
          <span :class="{ 'meta-overdue': t.enabled && t.next_run_at <= now }">
            <CalendarClock :size="12" /> 下次 {{ fmtDateTime(t.next_run_at) }}（{{
              relativeTime(t.next_run_at, now)
            }}）
          </span>
          <span>{{ statusText(t) }}</span>
        </div>

        <details v-if="t.last_result" class="task-card__result">
          <summary>查看上次输出</summary>
          <pre>{{ t.last_result }}</pre>
        </details>

        <div class="task-card__acts">
          <button class="btn-mini" :disabled="runningId === t.id" @click="runNow(t)">
            <Play :size="12" /> {{ runningId === t.id ? "运行中…" : "立即运行" }}
          </button>
          <button class="btn-mini" @click="toggle(t)">
            <component :is="t.enabled ? Pause : Play" :size="12" />
            {{ t.enabled ? "暂停" : "启用" }}
          </button>
          <button class="btn-mini" @click="openEdit(t)"><Pencil :size="12" /> 编辑</button>
          <button class="btn-mini btn-mini--danger" @click="removeTask(t)">
            <Trash2 :size="12" /> 删除
          </button>
        </div>
      </div>
    </div>

    <div v-else-if="!showForm" class="tasks-empty">
      <Info :size="14" /> 还没有定时任务。点右上角「新建任务」，或先想清楚一件事：<b
        >你希望它每天自动替你做什么？</b
      >
    </div>
  </div>
</template>

<style scoped>
.tasks-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tasks-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.tasks-panel__head h3 {
  margin: 0;
  font-size: 14px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-primary);
}
.tasks-panel__head-acts {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tasks-hint {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.tasks-hint b {
  color: var(--text-primary);
}
.tasks-error {
  color: #f87171;
  font-size: 12px;
  margin: 0;
}

/* 按钮：每个类都必须显式给 color —— 否则继承默认黑字，暗色主题下看不见 */
.btn-primary,
.btn-secondary,
.btn-ghost,
.btn-mini {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}
.btn-primary {
  background: var(--accent-color);
  color: #fff;
  border: 1px solid var(--accent-color);
  padding: 5px 12px;
}
.btn-secondary {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  padding: 5px 12px;
}
.btn-ghost {
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
}
.btn-ghost:disabled {
  opacity: 0.5;
  cursor: default;
}
.btn-mini {
  background: var(--bg-secondary);
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  padding: 4px 8px;
  font-size: 11.5px;
}
.btn-mini:hover:not(:disabled) {
  color: var(--text-primary);
}
.btn-mini:disabled {
  opacity: 0.6;
  cursor: default;
}
.btn-mini--danger:hover {
  background: rgba(248, 113, 113, 0.15);
  color: #f87171;
  border-color: rgba(248, 113, 113, 0.4);
}

/* 表单 */
.tasks-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--bg-soft);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px;
}
.form-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field__label {
  font-size: 11.5px;
  color: var(--text-secondary);
}
.input {
  padding: 6px 9px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 12px;
}
.input--mono {
  font-family: ui-monospace, Menlo, monospace;
}
.input--num {
  width: 120px;
}
.select {
  padding-right: 26px;
}
.example-row,
.preset-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.example-row__label {
  font-size: 11.5px;
  color: var(--text-secondary);
}
.chip {
  background: var(--bg-secondary);
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 11.5px;
  cursor: pointer;
}
.chip--on {
  background: var(--accent-color);
  border-color: var(--accent-color);
  color: #fff;
}
.custom-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}
.preview {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--text-secondary);
}
.preview b {
  color: var(--text-primary);
}
.form-acts {
  display: flex;
  gap: 6px;
}

/* 任务卡片 */
.tasks-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.task-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--bg-soft);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 10px;
}
.task-card--off {
  opacity: 0.55;
}
.task-card__top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.task-card__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.status--ok {
  color: #4ade80;
}
.status--fail,
.status--timeout {
  color: #f87171;
}
.status--never,
.status--unknown {
  color: var(--text-secondary);
}
.badge {
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
}
.task-card__cmd {
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
}
.task-card__cmd code {
  font-family: ui-monospace, Menlo, monospace;
}
.task-card__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  font-size: 11.5px;
  color: var(--text-secondary);
}
.task-card__meta > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.meta-overdue {
  color: #fbbf24;
}
.task-card__result summary {
  font-size: 11.5px;
  color: var(--text-secondary);
  cursor: pointer;
}
.task-card__result pre {
  margin: 6px 0 0;
  background: var(--bg-input);
  border-radius: 6px;
  padding: 6px 8px;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow: auto;
}
.task-card__acts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tasks-empty {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}
.tasks-empty b {
  color: var(--text-primary);
}
</style>
