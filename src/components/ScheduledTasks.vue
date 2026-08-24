<script setup lang="ts">
import { ref, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { v4 as uuidv4 } from "@/stores/uuid";
import { AlarmClock } from "lucide-vue-next";

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
  created_at: number;
}

const tasks = ref<ScheduledTask[]>([]);
const error = ref("");
const showAdd = ref(false);
const form = ref({ name: "", command: "", scheduleType: "interval", intervalMinutes: 60, dailyTime: "09:00" });

async function load() {
  try {
    tasks.value = await invoke<ScheduledTask[]>("list_scheduled_tasks");
  } catch (e) { error.value = `加载失败: ${e}`; }
}
onMounted(load);

function computeNextRun(t: { scheduleType: string; intervalMinutes: number; dailyTime: string }): number {
  const now = Date.now();
  if (t.scheduleType === "daily") {
    const [h, m] = t.dailyTime.split(":").map(Number);
    const d = new Date();
    d.setHours(h || 0, m || 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return now + (t.intervalMinutes || 60) * 60000;
}

async function addTask() {
  if (!form.value.name.trim() || !form.value.command.trim()) return;
  const task: ScheduledTask = {
    id: uuidv4(),
    name: form.value.name.trim(),
    command: form.value.command.trim(),
    schedule_type: form.value.scheduleType,
    interval_minutes: form.value.scheduleType === "interval" ? form.value.intervalMinutes : 60,
    daily_time: form.value.scheduleType === "daily" ? form.value.dailyTime : "",
    enabled: true,
    next_run_at: computeNextRun(form.value),
    last_run_at: null,
    last_result: null,
    created_at: Date.now(),
  };
  try {
    await invoke("save_scheduled_task", { task });
    showAdd.value = false;
    form.value = { name: "", command: "", scheduleType: "interval", intervalMinutes: 60, dailyTime: "09:00" };
    error.value = "";
    await load();
  } catch (e) { error.value = `保存失败: ${e}`; }
}

async function remove(id: string) {
  try { await invoke("delete_scheduled_task", { id }); await load(); }
  catch (e) { error.value = `删除失败: ${e}`; }
}
async function toggle(t: ScheduledTask) {
  try { await invoke("toggle_scheduled_task", { id: t.id, enabled: !t.enabled }); await load(); }
  catch (e) { error.value = `切换失败: ${e}`; }
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function scheduleLabel(t: ScheduledTask): string {
  return t.schedule_type === "daily" ? `每天 ${t.daily_time}` : `每 ${t.interval_minutes} 分钟`;
}
</script>

<template>
  <div class="tasks-panel">
    <div class="tasks-panel__head">
      <h3><AlarmClock :size="17" /> 定时任务</h3>
      <button class="btn-icon" title="刷新" @click="load">⟳</button>
    </div>
    <p v-if="error" class="tasks-error">{{ error }}</p>
    <p class="tasks-desc">后台定时执行命令（每 N 分钟 / 每天指定时刻），结果保留最近 1000 字符。调度线程每 30 秒检查一次。</p>

    <!-- 添加 -->
    <button v-if="!showAdd" class="btn-primary tasks-add" @click="showAdd = true">＋ 添加定时任务</button>
    <div v-else class="tasks-form">
      <input v-model="form.name" placeholder="任务名称" class="tasks-input" />
      <input v-model="form.command" placeholder="要执行的命令（如 backup.sh 或 rm -rf /tmp/cache）" class="tasks-input" />
      <div class="tasks-form__row">
        <select v-model="form.scheduleType" class="tasks-input tasks-select">
          <option value="interval">每 N 分钟</option>
          <option value="daily">每天指定时刻</option>
        </select>
        <input
          v-if="form.scheduleType === 'interval'"
          v-model.number="form.intervalMinutes"
          type="number" min="1" class="tasks-input tasks-small" title="间隔分钟"
        />
        <input
          v-else
          v-model="form.dailyTime"
          type="time" class="tasks-input tasks-small"
        />
      </div>
      <div class="tasks-form__acts">
        <button class="btn-primary" @click="addTask">保存</button>
        <button class="btn-secondary" @click="showAdd = false">取消</button>
      </div>
    </div>

    <!-- 列表 -->
    <div v-if="tasks.length" class="tasks-list">
      <div v-for="t in tasks" :key="t.id" class="task-item" :class="{ 'task-item--off': !t.enabled }">
        <div class="task-item__main">
          <div class="task-item__name">{{ t.name }}</div>
          <div class="task-item__cmd"><code>$ {{ t.command }}</code></div>
          <div class="task-item__meta">
            <span>调度：{{ scheduleLabel(t) }}</span>
            <span>下次：{{ fmtTime(t.next_run_at) }}</span>
            <span v-if="t.last_run_at">上次：{{ fmtTime(t.last_run_at) }}</span>
          </div>
          <pre v-if="t.last_result" class="task-item__result">{{ t.last_result }}</pre>
        </div>
        <div class="task-item__acts">
          <button class="btn-mini" :title="t.enabled ? '暂停' : '启用'" @click="toggle(t)">{{ t.enabled ? "⏸" : "▶" }}</button>
          <button class="btn-mini btn-danger" title="删除" @click="remove(t.id)">✕</button>
        </div>
      </div>
    </div>
    <div v-else-if="!showAdd" class="tasks-empty">暂无定时任务</div>
  </div>
</template>

<style scoped>
.tasks-panel { display: flex; flex-direction: column; gap: 10px; }
.tasks-panel__head { display: flex; align-items: center; justify-content: space-between; }
.tasks-panel__head h3 { margin: 0; font-size: 14px; }
.btn-icon {
  width: 28px; height: 28px; border: none; border-radius: 6px;
  background: var(--bg-secondary, #1a1a30); color: var(--text-secondary, #aaa);
  font-size: 15px; cursor: pointer;
}
.tasks-error { color: #f87171; font-size: 12px; margin: 0; }
.tasks-desc { margin: 0; font-size: 12px; color: #888; }
.tasks-add { align-self: flex-start; }
.btn-primary { background: var(--accent-color, #7c6cff); color: #fff; border: none; border-radius: 6px; padding: 6px 14px; font-size: 12px; cursor: pointer; }
.btn-secondary { background: transparent; color: #aaa; border: 1px solid #333; border-radius: 6px; padding: 6px 14px; font-size: 12px; cursor: pointer; }
.btn-mini {
  width: 26px; height: 26px; border: none; border-radius: 6px;
  background: var(--bg-secondary, #1a1a30); color: #aaa; font-size: 12px; cursor: pointer;
}
.btn-danger:hover { background: rgba(248,113,113,.15); color: #f87171; }

.tasks-form { display: flex; flex-direction: column; gap: 6px; background: #151528; border: 1px solid #2a2a45; border-radius: 8px; padding: 10px; }
.tasks-input { padding: 6px 8px; border: 1px solid #333; border-radius: 6px; background: #0d0d1a; color: #ddd; font-size: 12px; }
.tasks-form__row { display: flex; gap: 6px; }
.tasks-select { flex: 1; }
.tasks-small { width: 110px; }
.tasks-form__acts { display: flex; gap: 6px; }

.tasks-list { display: flex; flex-direction: column; gap: 6px; }
.task-item {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
  background: #151528; border: 1px solid #2a2a45; border-radius: 8px; padding: 10px;
}
.task-item--off { opacity: .5; }
.task-item__main { flex: 1; min-width: 0; }
.task-item__name { font-size: 13px; font-weight: 600; color: #eee; }
.task-item__cmd { font-size: 12px; color: #9fe6a0; margin-top: 2px; word-break: break-all; }
.task-item__meta { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; color: #888; margin-top: 4px; }
.task-item__result {
  margin: 6px 0 0; background: #0d0d1a; border-radius: 6px; padding: 6px 8px;
  font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #bbb;
  white-space: pre-wrap; word-break: break-all; max-height: 90px; overflow: auto;
}
.task-item__acts { display: flex; gap: 4px; flex-shrink: 0; }
.tasks-empty { color: #777; font-size: 12px; }
</style>
