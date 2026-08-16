<script setup lang="ts">
import { ref, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";

interface CodingAgentInfo {
  id: string;
  label: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  status: string;
}

const agents = ref<CodingAgentInfo[]>([]);
const loading = ref(false);
const error = ref("");

// 委派表单
const delegateAgent = ref("claude");
const delegateTask = ref("");
const delegateCwd = ref("");
const delegating = ref(false);
const delegateOutput = ref("");
const delegateError = ref("");

const INSTALL_HINTS: Record<string, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
};

async function load() {
  loading.value = true;
  error.value = "";
  try {
    agents.value = await invoke<CodingAgentInfo[]>("check_coding_agents");
  } catch (e) {
    error.value = `检测失败: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function delegate() {
  if (!delegateTask.value.trim()) return;
  delegating.value = true;
  delegateOutput.value = "";
  delegateError.value = "";
  try {
    const out = await invoke<string>("delegate_coding_agent", {
      agentId: delegateAgent.value,
      task: delegateTask.value.trim(),
      cwd: delegateCwd.value.trim() || null,
      timeoutSecs: 300,
    });
    delegateOutput.value = out;
  } catch (e) {
    delegateError.value = e instanceof Error ? e.message : String(e);
  } finally {
    delegating.value = false;
  }
}
</script>

<template>
  <div class="agents-panel">
    <div class="agents-panel__head">
      <h3>🤖 编码 Agent 委派</h3>
      <button class="btn-icon" :disabled="loading" title="重新检测" @click="load">{{ loading ? "…" : "⟳" }}</button>
    </div>
    <p v-if="error" class="agents-error">{{ error }}</p>
    <p class="agents-desc">检测本机安装的编码 Agent（Claude Code / Codex），可将任务委派给它们执行。委派通过命令行单次任务模式运行（不占用对话上下文）。</p>

    <!-- 安装状态 -->
    <div class="agents-list">
      <div v-for="a in agents" :key="a.id" class="agent-card" :class="{ 'agent-card--off': !a.installed }">
        <div class="agent-card__name">
          {{ a.label }}
          <span class="agent-card__status" :class="a.installed ? 'ok' : 'bad'">{{ a.status }}</span>
        </div>
        <div class="agent-card__meta" v-if="a.installed">
          <span>版本：{{ a.version || "未知" }}</span>
          <span class="agent-card__path">{{ a.path }}</span>
        </div>
        <div class="agent-card__hint" v-else>
          未安装。安装命令：<code>{{ INSTALL_HINTS[a.id] }}</code>
        </div>
      </div>
    </div>

    <!-- 委派表单 -->
    <div class="delegate-box">
      <div class="delegate-box__title">委派任务</div>
      <div class="delegate-row">
        <select v-model="delegateAgent" class="agents-input agents-select">
          <option v-for="a in agents" :key="a.id" :value="a.id" :disabled="!a.installed">
            {{ a.label }}{{ a.installed ? "" : "（未安装）" }}
          </option>
        </select>
        <input v-model="delegateCwd" placeholder="工作目录（可选）" class="agents-input agents-cwd" />
      </div>
      <textarea
        v-model="delegateTask"
        rows="3"
        class="agents-input agents-task"
        placeholder="要委派给编码 Agent 的任务，如：检查 src/utils/tokens.ts 并修复其中的类型错误"
      ></textarea>
      <button class="btn-primary" :disabled="delegating || !delegateTask.trim()" @click="delegate">
        {{ delegating ? "执行中…" : "🚀 委派执行" }}
      </button>

      <div v-if="delegateError" class="delegate-error">{{ delegateError }}</div>
      <pre v-if="delegateOutput" class="delegate-output">{{ delegateOutput }}</pre>
    </div>
  </div>
</template>

<style scoped>
.agents-panel { display: flex; flex-direction: column; gap: 12px; }
.agents-panel__head { display: flex; align-items: center; justify-content: space-between; }
.agents-panel__head h3 { margin: 0; font-size: 14px; }
.btn-icon {
  width: 28px; height: 28px; border: none; border-radius: 6px;
  background: var(--bg-secondary, #1a1a30); color: var(--text-secondary, #aaa);
  font-size: 15px; cursor: pointer;
}
.agents-error { color: #f87171; font-size: 12px; margin: 0; }
.agents-desc { margin: 0; font-size: 12px; color: #888; }

.agents-list { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.agent-card { background: #151528; border: 1px solid #2a2a45; border-radius: 8px; padding: 10px; }
.agent-card--off { opacity: .55; }
.agent-card__name { font-size: 13px; font-weight: 600; color: #eee; display: flex; align-items: center; gap: 6px; }
.agent-card__status { font-size: 10px; padding: 1px 6px; border-radius: 4px; }
.agent-card__status.ok { background: rgba(74,222,128,.15); color: #4ade80; }
.agent-card__status.bad { background: rgba(248,113,113,.15); color: #f87171; }
.agent-card__meta { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; font-size: 11px; color: #888; }
.agent-card__path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-card__hint { margin-top: 4px; font-size: 11px; color: #aaa; word-break: break-all; }
.agent-card__hint code { color: #9fe6a0; }

.delegate-box {
  background: #151528; border: 1px solid #2a2a45; border-radius: 8px;
  padding: 12px; display: flex; flex-direction: column; gap: 8px;
}
.delegate-box__title { font-size: 13px; font-weight: 600; color: #ddd; }
.delegate-row { display: flex; gap: 6px; }
.agents-input {
  padding: 6px 8px; border: 1px solid #333; border-radius: 6px;
  background: #0d0d1a; color: #ddd; font-size: 12px;
}
.agents-select { flex: 1; }
.agents-cwd { flex: 1.5; }
.agents-task { width: 100%; box-sizing: border-box; resize: vertical; font-family: inherit; }
.btn-primary { align-self: flex-start; background: var(--accent-color, #7c6cff); color: #fff; border: none; border-radius: 6px; padding: 7px 16px; font-size: 12px; cursor: pointer; }
.btn-primary:disabled { opacity: .5; cursor: not-allowed; }
.delegate-error { color: #f87171; font-size: 12px; }
.delegate-output {
  margin: 0; background: #0d0d1a; border-radius: 8px; padding: 10px;
  font-family: ui-monospace, Menlo, monospace; font-size: 11px; line-height: 1.5; color: #ddd;
  white-space: pre-wrap; word-break: break-all; max-height: 260px; overflow: auto;
}
</style>
