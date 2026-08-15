<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useChatStore } from "@/stores/chat";
import type { ApiProfile, HardwareInfo } from "@/types";
import { v4 as uuidv4 } from "@/stores/uuid";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getSettings, updateSettings } from "@/api/appSettings";
import McpSettings from "./McpSettings.vue";
import { PROMPT_TEMPLATES } from "@/data/prompt-templates";

const props = defineProps<{ initialTab?: "api" | "mcp" | "ollama" }>();
const emit = defineEmits<{
  close: [];
}>();

const chatStore = useChatStore();
const activeTab = ref<"api" | "mcp" | "ollama">("api");
watch(() => props.initialTab, (t) => { if (t) activeTab.value = t; }, { immediate: true });

// --- Ollama 本地视觉模型管理 ---
const ollama = ref<{ installed: boolean; running: boolean; models: string[] } | null>(null);
const ollamaBusy = ref(false);
const ollamaProgress = ref("");
const ollamaPercent = ref<number | null>(null);
let ollamaUnlisten: (() => void) | null = null;

const hw = ref<HardwareInfo | null>(null);
function verdictText(v: string) {
  return v === "recommended" ? "✅ 推荐本地部署" : v === "warning" ? "⚠️ 可部署，但占用资源较高" : "❌ 不推荐本地部署";
}

const hasLlava = computed(() => ollama.value?.models.some((m) => m.includes("llava-phi3")) ?? false);

async function refreshOllama() {
  try {
    ollama.value = await invoke("ollama_status");
  } catch { ollama.value = null; }
}

async function deployOllama() {
  if (ollamaBusy.value) return;
  ollamaBusy.value = true;
  ollamaProgress.value = "";
  ollamaPercent.value = null;
  try {
    await invoke("ollama_setup");
    await refreshOllama();
  } catch (e) {
    ollamaProgress.value = e instanceof Error ? e.message : String(e);
  }
  ollamaBusy.value = false;
}

onMounted(() => {
  refreshOllama();
  invoke<HardwareInfo>("check_hardware").then((h) => { hw.value = h; }).catch(() => {});
  listen<{ text?: string; percent?: number } | string>("ollama-progress", (e) => {
    const p = e.payload;
    if (typeof p === "string") {
      ollamaProgress.value = p;
      return;
    }
    if (typeof p.text === "string") ollamaProgress.value = p.text;
    if (typeof p.percent === "number") ollamaPercent.value = p.percent;
  })
    .then((un) => { ollamaUnlisten = un; })
    .catch(() => {});
});
onUnmounted(() => { ollamaUnlisten?.(); });

const editingId = ref<string>(chatStore.activeProfileId);
const editingProfile = ref<ApiProfile>({
  ...(chatStore.activeProfile || chatStore.profiles[0]),
});

const isNew = ref(false);

// 提示词模板
const selectedTemplateId = ref("");
function applyTemplate(id: string) {
  const t = PROMPT_TEMPLATES.find((p) => p.id === id);
  if (t) {
    editingProfile.value.systemPrompt = t.prompt;
    selectedTemplateId.value = id;
  }
}

// 动态获取厂商模型列表
const availableModels = ref<string[]>([]);
const loadingModels = ref(false);
const modelError = ref("");
const showModelDropdown = ref(false);

async function fetchModels() {
  if (!editingProfile.value.baseUrl || !editingProfile.value.apiKey) {
    modelError.value = "请先填写 API 地址和 API Key";
    return;
  }
  loadingModels.value = true;
  modelError.value = "";
  try {
    const models = await invoke<string[]>("list_models", {
      baseUrl: editingProfile.value.baseUrl,
      apiKey: editingProfile.value.apiKey,
    });
    availableModels.value = models;
    editingProfile.value.availableModels = models;
    if (models.length > 0) {
      modelError.value = `获取到 ${models.length} 个模型`;
      showModelDropdown.value = true;
    } else {
      modelError.value = "未获取到模型列表";
    }
  } catch (e: unknown) {
    availableModels.value = [];
    modelError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loadingModels.value = false;
  }
}

// 按输入过滤模型列表
const filteredModels = computed(() => {
  const kw = editingProfile.value.model.trim().toLowerCase();
  if (!kw) return availableModels.value;
  return availableModels.value.filter((m) => m.toLowerCase().includes(kw));
});

function pickModel(m: string) {
  editingProfile.value.model = m;
  showModelDropdown.value = false;
}

function onModelBlur() {
  setTimeout(() => {
    showModelDropdown.value = false;
  }, 150);
}

// Agent 工作区（借鉴 DeepSeek Harness 的 workspace 概念）
const workspace = ref(getSettings().workspace || "");
function saveWorkspace() {
  const v = workspace.value.trim();
  updateSettings({ workspace: v || null });
}

// 切换编辑目标
function selectProfile(id: string) {
  const p = chatStore.profiles.find((p) => p.id === id);
  if (p) {
    editingId.value = id;
    editingProfile.value = { ...p };
    isNew.value = false;
    selectedTemplateId.value = "";
  }
}

function startNew() {
  editingId.value = "";
  editingProfile.value = {
    id: uuidv4(),
    name: "新配置",
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-v4-flash",
    maxTokens: 4096,
    temperature: 0.7,
    thinkingEnabled: true,
    reasoningEffort: "high",
    systemPrompt: "",
    enableWebSearch: false,
    maxContextMessages: 50,
  };
  isNew.value = true;
}

function handleSave() {
  if (isNew.value) {
    chatStore.addProfile({ ...editingProfile.value });
  } else {
    chatStore.updateProfile(editingId.value, { ...editingProfile.value });
  }
  // 自动切换到保存的配置
  chatStore.switchProfile(editingProfile.value.id);
  emit("close");
}

function handleDelete() {
  if (isNew.value || chatStore.profiles.length <= 1) return;
  chatStore.deleteProfile(editingId.value);
  emit("close");
}
</script>

<template>
  <div class="settings-overlay" @click.self="emit('close')">
    <div class="settings-dialog">
      <div class="settings-dialog__header">
        <div class="settings-tabs">
          <button :class="['settings-tab', { active: activeTab === 'api' }]" @click="activeTab = 'api'">API 配置</button>
          <button :class="['settings-tab', { active: activeTab === 'mcp' }]" @click="activeTab = 'mcp'">🔌 MCP 服务器</button>
          <button :class="['settings-tab', { active: activeTab === 'ollama' }]" @click="activeTab = 'ollama'">🤖 本地模型</button>
        </div>
        <button class="btn-close" @click="emit('close')">✕</button>
      </div>

      <div class="settings-dialog__body">
        <!-- API 配置 -->
        <div v-show="activeTab === 'api'">
        <!-- 配置列表 -->
        <div class="profile-tabs">
          <button
            v-for="p in chatStore.profiles"
            :key="p.id"
            class="profile-tab"
            :class="{ 'profile-tab--active': editingId === p.id && !isNew }"
            @click="selectProfile(p.id)"
          >
            {{ p.name }}
          </button>
          <button class="profile-tab profile-tab--add" @click="startNew">＋</button>
        </div>

        <!-- 编辑表单 -->
        <div class="form-group">
          <label>配置名称</label>
          <input
            v-model="editingProfile.name"
            type="text"
            placeholder="如: DeepSeek"
          />
        </div>

        <div class="form-group">
          <label>API 地址</label>
          <input
            v-model="editingProfile.baseUrl"
            type="text"
            placeholder="https://api.deepseek.com"
          />
          <span class="form-hint">API 基础地址</span>
        </div>

        <div class="form-group">
          <label>API Key</label>
          <input
            v-model="editingProfile.apiKey"
            type="password"
            placeholder="sk-..."
          />
          <span class="form-hint">您的 API 密钥</span>
        </div>

        <div class="form-group">
          <label>模型</label>
          <div class="model-row">
            <div class="model-select">
              <input
                v-model="editingProfile.model"
                type="text"
                placeholder="deepseek-v4-flash"
                @focus="showModelDropdown = true"
                @input="showModelDropdown = true"
                @blur="onModelBlur"
              />
              <div
                v-if="showModelDropdown && filteredModels.length > 0"
                class="model-select__dropdown"
              >
                <div
                  v-for="m in filteredModels"
                  :key="m"
                  class="model-select__option"
                  :class="{ on: m === editingProfile.model }"
                  @mousedown.prevent="pickModel(m)"
                >{{ m }}</div>
              </div>
            </div>
            <button
              type="button"
              class="btn-secondary btn-fetch"
              :disabled="loadingModels"
              @click="fetchModels"
            >
              {{ loadingModels ? "获取中…" : "获取模型" }}
            </button>
          </div>
          <span
            v-if="modelError"
            class="form-hint"
            :class="{ 'form-hint--error': availableModels.length === 0 && !loadingModels }"
          >{{ modelError }}</span>
          <span v-else class="form-hint">可手动输入，或点击「获取模型」从厂商拉取可用模型列表</span>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>最大 Token</label>
            <input v-model.number="editingProfile.maxTokens" type="number" min="1" max="128000" />
          </div>
          <div class="form-group">
            <label>上下文消息数</label>
            <input v-model.number="editingProfile.maxContextMessages" type="number" min="4" max="200" />
          </div>
        </div>

        <!-- 思考模式 (DeepSeek) -->
        <div class="form-group">
          <label class="toggle-row">
            <span>思考模式 (DeepSeek R1/V4)</span>
            <input v-model="editingProfile.thinkingEnabled" type="checkbox" class="toggle-input" />
          </label>
          <span class="form-hint">开启后模型先深度思考再回答，响应更慢但质量更高</span>
        </div>

        <div class="form-group">
          <label class="toggle-row">
            <span>🌐 联网搜索</span>
            <input v-model="editingProfile.enableWebSearch" type="checkbox" class="toggle-input" />
          </label>
          <span class="form-hint">允许模型搜索互联网获取最新信息</span>
        </div>

        <div class="form-group">
          <label>系统提示词</label>
          <textarea
            v-model="editingProfile.systemPrompt"
            class="form-textarea"
            placeholder="你是一个有帮助的AI助手。"
            rows="3"
          ></textarea>
          <span class="form-hint">定义 AI 的角色和行为方式</span>
        </div>

        <!-- 提示词模板 -->
        <div class="form-group">
          <label>📚 提示词模板</label>
          <select
            class="form-select"
            :value="selectedTemplateId"
            @change="applyTemplate(($event.target as HTMLSelectElement).value)"
          >
            <option value="" disabled>选择角色模板一键应用...</option>
            <option
              v-for="t in PROMPT_TEMPLATES"
              :key="t.id"
              :value="t.id"
            >
              {{ t.icon }} {{ t.name }} — {{ t.description }}
            </option>
          </select>
          <span class="form-hint">应用后会自动填充上方系统提示词，可直接修改</span>
        </div>

        <!-- Agent 工作区 -->
        <div class="form-group">
          <label>📂 Agent 工作区</label>
          <input
            v-model="workspace"
            type="text"
            placeholder="/path/to/project"
            @blur="saveWorkspace"
            @keyup.enter="saveWorkspace"
          />
          <span class="form-hint">Agent 执行命令、读取文件的默认目录（空则不限定）</span>
        </div>
      </div>

      <!-- MCP 服务器管理 -->
      <div v-show="activeTab === 'mcp'"><McpSettings /></div>

      <!-- Ollama 本地视觉模型管理 -->
      <div v-show="activeTab === 'ollama'" class="ollama-panel">
        <h3>🤖 本地视觉模型（Ollama）</h3>
        <p class="ollama-desc">用于本地识别图片内容。模型完全在你电脑上运行，免费且隐私安全，无需联网。是否适合本地部署取决于硬件性能。</p>
        <div v-if="hw" class="hw-card">
          <div class="hw-card__title">🖥️ 硬件评估 <span class="hw-score">综合 {{ hw.score }} 分</span></div>
          <div class="hw-card__row">CPU：{{ hw.cpu_cores }} 核{{ hw.cpu_brand ? ' · ' + hw.cpu_brand : '' }}</div>
          <div class="hw-card__row">内存：{{ hw.memory_gb }} GB</div>
          <div class="hw-card__row">显卡：{{ hw.gpu_name || '核显' }}{{ hw.gpu_memory_mb ? ' · ' + hw.gpu_memory_mb + ' MB' : '' }}{{ hw.has_metal ? ' · Metal' : '' }}</div>
          <div class="hw-card__verdict" :class="'hw-card__verdict--' + hw.verdict">{{ verdictText(hw.verdict) }}</div>
          <p class="hw-card__msg">{{ hw.message }}</p>
        </div>
        <div v-if="!ollama" class="ollama-loading">正在检测 Ollama 环境...</div>
        <template v-else>
          <div class="ollama-status">
            <div class="ollama-item">
              <span class="ollama-dot" :class="ollama.installed ? 'green' : 'red'"></span>
              Ollama 程序：{{ ollama.installed ? '已安装' : '未安装' }}
            </div>
            <div class="ollama-item">
              <span class="ollama-dot" :class="ollama.running ? 'green' : 'red'"></span>
              Ollama 服务：{{ ollama.running ? '运行中' : '未运行' }}
            </div>
            <div class="ollama-item" v-if="ollama.running">
              <span class="ollama-dot" :class="hasLlava ? 'green' : 'red'"></span>
              视觉模型 llava-phi3：{{ hasLlava ? '已部署' : '未部署' }}
            </div>
            <div v-if="ollama.running && ollama.models.length" class="ollama-models">
              已部署模型：{{ ollama.models.join(', ') }}
            </div>
          </div>
          <button
            v-if="hw?.verdict === 'not_recommended'"
            class="btn-primary"
            @click="activeTab = 'api'"
          >配置线上视觉模型 API</button>
          <button
            v-else
            class="btn-primary"
            :disabled="ollamaBusy"
            @click="deployOllama"
          >
            {{ ollamaBusy ? '部署中...' : (ollama.installed && hasLlava ? '重新检测' : '一键部署') }}
          </button>
          <p class="ollama-hint" v-if="hw?.verdict !== 'not_recommended'">首次部署将安装 Ollama 并下载约 2GB 模型，耗时较长，请耐心等待。</p>
        </template>
        <div v-if="ollamaPercent !== null && ollamaPercent < 100" class="ollama-bar">
          <div class="ollama-bar__fill" :style="{ width: ollamaPercent + '%' }"></div>
          <span class="ollama-bar__label">{{ Math.round(ollamaPercent) }}%</span>
        </div>
        <div v-if="ollamaProgress" class="ollama-progress">{{ ollamaProgress }}</div>
      </div>
    </div>

    <div class="settings-dialog__footer">
      <button
        v-if="!isNew && chatStore.profiles.length > 1"
        class="btn-danger"
        @click="handleDelete"
      >
        删除此配置
      </button>
      <div class="settings-dialog__footer-spacer"></div>
      <button class="btn-secondary" @click="emit('close')">取消</button>
      <button class="btn-primary" @click="handleSave">保存</button>
    </div>
  </div>
  </div>
</template>

<style scoped>
.settings-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,.5); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  z-index: 100; animation: fadeIn .2s;
}

.settings-dialog {
  width: 520px; height: min(85vh, 720px);
  background: var(--bg-elevated); border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl); overflow: hidden;
  animation: scaleIn .25s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex; flex-direction: column;
  border: 1px solid var(--border-color);
}

.settings-dialog__header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 24px; border-bottom: 1px solid var(--border-color); flex-shrink: 0;
}
.settings-tabs { display: flex; gap: 4px; }
.settings-tab {
  padding: 6px 14px; border: none; border-radius: 8px;
  background: transparent; color: #888; font-size: 13px; cursor: pointer; transition: all .15s;
}
.settings-tab:hover { color: #ccc; }
.settings-tab.active { background: #252540; color: #eee; }

.btn-close {
  width: 32px; height: 32px; border: none; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-secondary); font-size: 16px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: all .15s;
}
.btn-close:hover { background: var(--bg-hover); color: var(--text-primary); }

.settings-dialog__body {
  padding: 24px; display: flex; flex-direction: column; gap: 18px;
  overflow-y: auto; flex: 1; min-height: 0;
}

.profile-tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.profile-tab {
  padding: 6px 16px; border: 1.5px solid var(--border-color);
  border-radius: 22px; background: var(--bg-secondary);
  color: var(--text-secondary); font-size: 12px; font-weight: 550;
  cursor: pointer; transition: all .2s;
}
.profile-tab:hover { border-color: var(--accent-color); color: var(--text-primary); }
.profile-tab--active {
  background: var(--accent-color); border-color: var(--accent-color); color: #fff;
}
.profile-tab--add { font-size: 18px; padding: 4px 12px; }

.form-group { display: flex; flex-direction: column; gap: 6px; }
.form-group label {
  font-size: 12px; font-weight: 650; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: .04em;
}
.form-group input {
  padding: 10px 14px; border: 1.5px solid var(--border-color);
  border-radius: var(--radius-md); background: var(--bg-secondary);
  color: var(--text-primary); font-size: 13px; font-family: inherit;
  outline: none; transition: all .2s;
}
.form-group input:focus {
  border-color: var(--accent-color);
  box-shadow: 0 0 0 3px rgba(99,102,241,.1);
}
.form-hint { font-size: 11px; color: var(--text-muted); }
.form-textarea {
  padding: 10px 14px; border: 1.5px solid var(--border-color);
  border-radius: var(--radius-md); background: var(--bg-secondary);
  color: var(--text-primary); font-size: 13px; font-family: inherit;
  outline: none; resize: vertical; transition: all .2s;
}
.form-textarea:focus {
  border-color: var(--accent-color);
  box-shadow: 0 0 0 3px rgba(99,102,241,.1);
}
.form-select {
  padding: 10px 14px; border: 1.5px solid var(--border-color);
  border-radius: var(--radius-md); background: var(--bg-secondary);
  color: var(--text-primary); font-size: 13px; font-family: inherit;
  outline: none; cursor: pointer; transition: all .2s;
}
.form-select:focus {
  border-color: var(--accent-color);
  box-shadow: 0 0 0 3px rgba(99,102,241,.1);
}
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }

.model-row { display: flex; align-items: center; gap: 8px; }
.model-select { position: relative; flex: 1; min-width: 0; }
.model-select input { width: 100%; box-sizing: border-box; }
.model-select__dropdown {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0;
  max-height: 240px; overflow-y: auto; z-index: 60;
  background: var(--bg-elevated); border: 1px solid var(--border-color);
  border-radius: var(--radius-md); box-shadow: var(--shadow-xl);
}
.model-select__option {
  padding: 8px 14px; font-size: 13px; cursor: pointer;
  color: var(--text-primary); transition: background .12s;
}
.model-select__option:hover { background: var(--bg-hover); }
.model-select__option.on { color: var(--accent-color); font-weight: 600; }
.btn-fetch {
  padding: 10px 14px; font-size: 12px; white-space: nowrap; flex-shrink: 0;
}
.form-hint--error { color: #f87171; }

.toggle-row {
  display: flex; align-items: center; justify-content: space-between;
  cursor: pointer;
}
.toggle-input {
  width: 40px; height: 22px;
  appearance: none; -webkit-appearance: none;
  background: var(--border-color); border-radius: 12px;
  position: relative; cursor: pointer; transition: background .2s;
}
.toggle-input::after {
  content: ''; position: absolute; top: 2px; left: 2px;
  width: 18px; height: 18px; border-radius: 50%;
  background: #fff; transition: transform .2s;
}
.toggle-input:checked { background: var(--accent-color); }
.toggle-input:checked::after { transform: translateX(18px); }

.settings-dialog__footer {
  display: flex; align-items: center; gap: 10px;
  padding: 16px 24px; border-top: 1px solid var(--border-color); flex-shrink: 0;
}
.settings-dialog__footer-spacer { flex: 1; }

.btn-primary, .btn-secondary, .btn-danger {
  padding: 9px 22px; border: none; border-radius: var(--radius-md);
  font-size: 13px; font-weight: 650; cursor: pointer;
  transition: all .2s cubic-bezier(0.4, 0, 0.2, 1);
}
.btn-primary { background: var(--accent-color); color: #fff; }
.btn-primary:hover { background: var(--accent-hover); box-shadow: 0 4px 12px rgba(99,102,241,.3); }
.btn-secondary {
  background: var(--bg-secondary); color: var(--text-primary);
  border: 1px solid var(--border-color);
}
.btn-secondary:hover { background: var(--bg-hover); }
.btn-danger { background: var(--danger-bg); color: var(--danger-color); }
.btn-danger:hover { background: rgba(239,68,68,.15); }

@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes scaleIn {
  from { opacity: 0; transform: scale(.94) translateY(8px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

/* --- Ollama 本地视觉模型面板 --- */
.ollama-panel { display: flex; flex-direction: column; gap: 12px; }
.ollama-panel h3 { margin: 0; font-size: 16px; }
.ollama-desc { margin: 0; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
.ollama-loading { color: var(--text-secondary); font-size: 13px; padding: 8px 0; }
.ollama-status { display: flex; flex-direction: column; gap: 8px; padding: 12px;
  background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; }
.ollama-item { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.ollama-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.ollama-dot.green { background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,.5); }
.ollama-dot.red { background: #ef4444; }
.ollama-models { font-size: 12px; color: var(--text-secondary); word-break: break-all; }
.ollama-panel .btn-primary { align-self: flex-start; margin-top: 4px; }
.ollama-panel .btn-primary:disabled { opacity: .6; cursor: not-allowed; }
.ollama-hint { margin: 0; color: var(--text-secondary); font-size: 12px; }
.ollama-progress { white-space: pre-wrap; font-size: 13px; line-height: 1.6; padding: 10px 12px;
  background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px;
  color: var(--text-primary); max-height: 200px; overflow-y: auto; }
.ollama-bar { position: relative; height: 22px; background: var(--bg-secondary);
  border: 1px solid var(--border-color); border-radius: 6px; overflow: hidden; }
.ollama-bar__fill { height: 100%; background: linear-gradient(90deg, var(--accent-color), #22c55e);
  transition: width .3s ease; }
.ollama-bar__label { position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; font-size: 12px; font-weight: 600; color: var(--text-primary);
  text-shadow: 0 1px 2px rgba(0,0,0,.3); }

/* 硬件评估卡片 */
.hw-card { display: flex; flex-direction: column; gap: 6px; padding: 12px;
  background: var(--bg-secondary); border: 1px solid var(--border-color);
  border-radius: 8px; font-size: 13px; }
.hw-card__title { font-weight: 600; display: flex; align-items: center; gap: 8px; }
.hw-score { font-size: 11px; font-weight: 500; color: var(--text-secondary);
  background: var(--bg-hover); padding: 1px 8px; border-radius: 10px; }
.hw-card__row { color: var(--text-secondary); }
.hw-card__verdict { font-weight: 600; margin-top: 4px; }
.hw-card__verdict--recommended { color: #22c55e; }
.hw-card__verdict--warning { color: #f59e0b; }
.hw-card__verdict--not_recommended { color: #ef4444; }
.hw-card__msg { margin: 0; color: var(--text-secondary); line-height: 1.6;
  border-top: 1px dashed var(--border-color); padding-top: 8px; }
</style>
