<script setup lang="ts">
// S7 交互式 PTY：启动/交互长驻进程（dev server、REPL 等）（Codex 能力整合）
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { usePtyStore } from "@/stores/pty";
import { getSettings } from "@/api/appSettings";
import { Play, Square, Trash2, RotateCw, Terminal as TerminalIcon } from "lucide-vue-next";

const pty = usePtyStore();

const cmd = ref("npm run dev");
const cwd = ref(getSettings().workspace || "");
const input = ref("");
const outputEl = ref<HTMLElement | null>(null);

const active = computed(() => pty.sessions.find((s) => s.id === pty.activeId) ?? null);

let timer: ReturnType<typeof setInterval> | null = null;
let scrollLocked = false;

async function startPolling() {
  stopPolling();
  timer = setInterval(() => { pty.poll(true); }, 400);
}

function stopPolling() {
  if (timer) { clearInterval(timer); timer = null; }
}

function select(id: number) {
  pty.activeId = id;
}

async function doSpawn() {
  if (!cmd.value.trim()) return;
  await pty.spawn(cmd.value.trim(), cwd.value.trim() || undefined);
  await nextTick();
  scrollBottom();
}

async function doSend() {
  if (!active.value || !input.value) return;
  // 交互式程序（REPL）通常需要回车；发送时追加 \n
  await pty.write(active.value.id, `${input.value}\n`);
  input.value = "";
  scrollBottom();
}

function scrollBottom() {
  if (outputEl.value) {
    outputEl.value.scrollTop = outputEl.value.scrollHeight;
  }
}

// 有新增输出时自动滚动到底（用户手动上滚后暂时不抢）
function onScroll() {
  if (!outputEl.value) return;
  const el = outputEl.value;
  scrollLocked = el.scrollTop + el.clientHeight < el.scrollHeight - 40;
}

watch(() => active.value?.output.length, () => {
  if (!scrollLocked) nextTick(scrollBottom);
});

watch(() => active.value?.id, () => { scrollLocked = false; nextTick(scrollBottom); });

onMounted(() => {
  pty.refreshList();
  startPolling();
});
onUnmounted(stopPolling);
</script>

<template>
  <div class="pty-panel">
    <h3><TerminalIcon :size="17" /> 交互式终端（PTY）</h3>
    <p class="ollama-desc">启动长驻/交互式进程（dev server、REPL、watch 等），在此实时查看输出并输入指令。命令用 <code>sh -c</code> 执行，支持管道 / 重定向 / 环境变量。</p>

    <div class="pty-form">
      <input v-model="cmd" class="pty-input" placeholder="命令，如：npm run dev、python3、node -i" @keyup.enter="doSpawn" />
      <input v-model="cwd" class="pty-input" placeholder="工作目录（留空=默认）" @keyup.enter="doSpawn" />
      <button class="btn-secondary" :disabled="pty.busy" @click="doSpawn"><Play :size="14" /> 启动</button>
    </div>

    <div v-if="pty.sessions.length" class="pty-sessions">
      <div
        v-for="s in pty.sessions"
        :key="s.id"
        class="pty-session-tab"
        :class="{ 'pty-session-tab--active': s.id === pty.activeId }"
        @click="select(s.id)"
      >
        <span class="pty-session-tab__status" :class="s.running ? 'is-running' : ''"></span>
        <span class="pty-session-tab__cmd">{{ s.command.slice(0, 26) }}{{ s.command.length > 26 ? "…" : "" }}</span>
        <button class="pty-session-tab__kill" title="终止" @click.stop="pty.kill(s.id)"><Square :size="12" /></button>
      </div>
    </div>

    <div v-if="active" class="pty-terminal">
      <pre ref="outputEl" class="pty-output" @scroll="onScroll">{{ active.output || "（等待输出…）" }}</pre>
      <div class="pty-input-row">
        <input
          v-model="input"
          class="pty-input"
          placeholder="输入内容，回车发送（自动补 \n）"
          @keyup.enter="doSend"
          :disabled="!active.running"
        />
        <button class="btn-secondary" :disabled="!active.running || !input" @click="doSend">发送</button>
        <button class="btn-ghost" :disabled="!active.running" @click="active && pty.kill(active.id)"><Trash2 :size="14" /> 终止</button>
      </div>
      <div class="pty-hint">
        <RotateCw :size="12" /> 状态：{{ active.running ? "运行中（每 0.4s 刷新输出）" : "已结束" }}
      </div>
    </div>

    <div v-else class="pty-empty">暂无终端会话，输入命令点击「启动」开始。</div>
    <p v-if="pty.error" class="form-hint--error">{{ pty.error }}</p>
  </div>
</template>

<style scoped>
.pty-panel { display: flex; flex-direction: column; gap: 10px; }
.pty-form { display: flex; gap: 8px; flex-wrap: wrap; }
.pty-input {
  flex: 1; min-width: 180px; padding: 8px 10px; font-size: 12px;
  background: var(--bg-secondary); color: var(--text-primary);
  border: 1px solid var(--border-color); border-radius: var(--radius-md); outline: none;
}
.pty-input:focus { border-color: var(--accent-color); }
.pty-sessions { display: flex; gap: 6px; flex-wrap: wrap; }
.pty-session-tab {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 10px; border: 1px solid var(--border-color); border-radius: var(--radius-md);
  background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; font-size: 12px;
}
.pty-session-tab--active { border-color: var(--accent-color); background: var(--accent-bg); }
.pty-session-tab__status { width: 8px; height: 8px; border-radius: 50%; background: var(--border-color); }
.pty-session-tab__status.is-running { background: #22c55e; }
.pty-session-tab__kill { background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 0; }
.pty-session-tab__kill:hover { color: var(--danger-color); }
.pty-terminal {
  border: 1px solid var(--border-color); border-radius: var(--radius-md); overflow: hidden;
  background: #0d1117;
}
.pty-output {
  height: 320px; overflow-y: auto; margin: 0; padding: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5;
  color: #e6edf3; white-space: pre-wrap; word-break: break-all;
}
.pty-input-row { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #21262d; }
.pty-input-row .pty-input { background: #161b22; color: #e6edf3; border-color: #21262d; }
.pty-hint { display: flex; align-items: center; gap: 6px; padding: 0 10px 10px; font-size: 11px; color: var(--text-secondary); }
.pty-empty { color: var(--text-secondary); font-size: 13px; padding: 12px 0; }
</style>
