<script setup lang="ts">
import { ref, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { Bot, Rocket } from "lucide-vue-next";

interface CodingAgentInfo {
  id: string;
  label: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  status: string;
}

interface CodingAgentResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_sec: number;
  tokens_in: number | null;
  tokens_out: number | null;
}

const agents = ref<CodingAgentInfo[]>([]);
const loading = ref(false);
const error = ref("");

// 委派表单
const delegateAgent = ref("claude");
const delegateMode = ref<"print" | "exec" | "review" | "resume">("print");
const delegateMaxTurns = ref("");
const delegateResumeSession = ref("");
const delegateTask = ref("");
const delegateCwd = ref("");
const delegating = ref(false);
const delegateOutput = ref("");
const delegateError = ref("");
const delegateResult = ref<CodingAgentResult | null>(null);

const MODE_OPTIONS = [
  { value: "print" as const, label: "单次任务", desc: "一次性完成并返回，不自动改文件" },
  { value: "exec" as const, label: "自动批准", desc: "危险操作自动放行，适合已信任的任务" },
  { value: "review" as const, label: "代码评审", desc: "全自动评审代码并给建议" },
  { value: "resume" as const, label: "续写会话", desc: "续接已有 CLI 会话继续执行" },
];

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
  delegateResult.value = null;
  try {
    const out = await invoke<CodingAgentResult>("delegate_coding_agent", {
      agentId: delegateAgent.value,
      task: delegateTask.value.trim(),
      cwd: delegateCwd.value.trim() || null,
      timeoutSecs: 300,
      mode: delegateMode.value,
      maxTurns: delegateMaxTurns.value ? Number(delegateMaxTurns.value) : null,
      resumeSession: delegateResumeSession.value.trim() || null,
    });
    delegateResult.value = out;
    delegateOutput.value = out.stdout || "(完成，无输出)";
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
      <h3><Bot :size="17" /> 编码 Agent 委派</h3>
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
        <select v-model="delegateMode" class="agents-input agents-mode" :title="MODE_OPTIONS.find(m => m.value === delegateMode)?.desc">
          <option v-for="m in MODE_OPTIONS" :key="m.value" :value="m.value">{{ m.label }}</option>
        </select>
        <input v-model="delegateCwd" placeholder="工作目录（可选）" class="agents-input agents-cwd" />
      </div>
      <div v-if="delegateMode === 'resume'" class="delegate-row">
        <input v-model="delegateResumeSession" placeholder="续写会话 ID（resume 模式必填）" class="agents-input agents-cwd" />
      </div>
      <div v-else class="delegate-row">
        <input v-model="delegateMaxTurns" placeholder="最大轮数（可选，如 20）" class="agents-input agents-cwd" />
        <span class="agents-mode-hint">{{ MODE_OPTIONS.find(m => m.value === delegateMode)?.desc }}</span>
      </div>
      <textarea
        v-model="delegateTask"
        rows="3"
        class="agents-input agents-task"
        placeholder="要委派给编码 Agent 的任务，如：检查 src/utils/tokens.ts 并修复其中的类型错误"
      ></textarea>
      <button class="btn-primary" :disabled="delegating || !delegateTask.trim() || (delegateMode === 'resume' && !delegateResumeSession.trim())" @click="delegate">
        {{ delegating ? "执行中…" : "" }}<Rocket v-if="!delegating" :size="14" /> 委派执行
      </button>

      <div v-if="delegateError" class="delegate-error">{{ delegateError }}</div>
      <div v-if="delegateResult" class="delegate-meta">
        <span class="delegate-meta__item" :class="{ bad: delegateResult.exit_code !== 0 }">退出码 {{ delegateResult.exit_code }}</span>
        <span class="delegate-meta__item">耗时 {{ delegateResult.duration_sec.toFixed(1) }}s</span>
        <span v-if="delegateResult.tokens_in !== null" class="delegate-meta__item">≈{{ delegateResult.tokens_in }} in / {{ delegateResult.tokens_out }} out tok</span>
      </div>
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
.agents-mode { flex: 0.9; }
.agents-mode-hint { flex: 1.5; font-size: 11px; color: #888; display: flex; align-items: center; }
.delegate-meta { display: flex; gap: 8px; flex-wrap: wrap; }
.delegate-meta__item {
  font-size: 11px; padding: 2px 8px; border-radius: 5px;
  background: rgba(99,102,241,.12); color: #c7c9ff;
}
.delegate-meta__item.bad { background: rgba(248,113,113,.15); color: #f87171; }
.delegate-output {
  margin: 0; background: #0d0d1a; border-radius: 8px; padding: 10px;
  font-family: ui-monospace, Menlo, monospace; font-size: 11px; line-height: 1.5; color: #ddd;
  white-space: pre-wrap; word-break: break-all; max-height: 260px; overflow: auto;
}
</style>
