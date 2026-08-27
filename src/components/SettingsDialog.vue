<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useChatStore } from "@/stores/chat";
import { useOllamaStore } from "@/stores/ollama";
import type { ApiProfile } from "@/types";
import { v4 as uuidv4 } from "@/stores/uuid";
import { invoke } from "@tauri-apps/api/core";
import { getSettings, updateSettings } from "@/api/appSettings";
import McpSettings from "./McpSettings.vue";
import UsageStats from "./UsageStats.vue";
import HealthPanel from "./HealthPanel.vue";
import ScheduledTasks from "./ScheduledTasks.vue";
import MemoryPanel from "./MemoryPanel.vue";
import { PROMPT_TEMPLATES } from "@/data/prompt-templates";
import { Settings, KeyRound, Puzzle, Brain, ChartColumn, Stethoscope, AlarmClock, Send, Globe, Folder, ShieldAlert, Cpu, Monitor, BookOpen, Shield, GitBranch, Keyboard } from "lucide-vue-next";

type SettingsTabId = "api" | "mcp" | "ollama" | "stats" | "health" | "tasks" | "push" | "memory" | "permissions" | "shortcuts";
const props = defineProps<{ initialTab?: SettingsTabId }>();
const emit = defineEmits<{
  close: [];
}>();

const chatStore = useChatStore();
const ollamaStore = useOllamaStore();
const activeTab = ref<SettingsTabId>("api");
watch(() => props.initialTab, (t) => { if (t) activeTab.value = t; }, { immediate: true });

// --- Ollama 本地视觉模型管理（状态存于全局 store，关闭界面不中断部署与进度） ---
function verdictText(v: string) {
  return v === "recommended" ? "✅ 推荐本地部署" : v === "warning" ? "⚠️ 可部署，但占用资源较高" : "❌ 不推荐本地部署";
}

onMounted(() => {
  // 打开时刷新一次状态（若后台仍在部署，进度/百分比已保存在 store 中自动恢复）
  ollamaStore.refreshStatus();
});

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
// 回填已持久化的模型列表：打开设置/切换配置时自动恢复（重启后无需重新获取）
watch(
  () => editingProfile.value.availableModels,
  (v) => { availableModels.value = v ?? []; },
  { immediate: true }
);
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
    // 立即持久化到已保存的配置：即使不点「保存」，下次打开/重启后也能直接看到模型列表
    const saved = chatStore.profiles.find((p) => p.id === editingId.value);
    if (saved) chatStore.updateProfile(saved.id, { availableModels: models });
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

// 危险命令审批模式：manual（手动确认，默认）/ smart（智能审批，辅助模型判断）/ yolo（全部自动批准）
const APPROVAL_MODES = [
  { value: "manual" as const, label: "手动确认", desc: "危险命令先弹窗询问，确认后执行" },
  { value: "smart" as const, label: "Smart 智能审批", desc: "辅助模型判断安全则自动放行，判定有风险再询问" },
  { value: "yolo" as const, label: "YOLO 全部放行", desc: "危险命令自动批准执行，不询问（高风险）" },
];
const approvalMode = ref<"manual" | "smart" | "yolo">(
  getSettings().approvalMode || (getSettings().yoloMode ? "yolo" : "manual")
);
function onApprovalModeChange(mode: "manual" | "smart" | "yolo") {
  approvalMode.value = mode;
  updateSettings({ approvalMode: mode, yoloMode: mode === "yolo" });
}

// 辅助任务模型（用于 Smart 审批 / 子代理等）：空 = 跟随主模型
const auxiliaryProfileId = ref(getSettings().auxiliaryProfileId || "");
function onAuxProfileChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  auxiliaryProfileId.value = v;
  updateSettings({ auxiliaryProfileId: v });
}

// 主动推送 Webhook（飞书 / 企业微信 / 钉钉群机器人，加密落盘）
const feishuWebhook = ref(getSettings().feishuWebhook || "");
const wecomWebhook = ref(getSettings().wecomWebhook || "");
const dingtalkWebhook = ref(getSettings().dingtalkWebhook || "");
const dingtalkSecret = ref(getSettings().dingtalkSecret || "");
function savePushWebhooks() {
  updateSettings({
    feishuWebhook: feishuWebhook.value.trim(),
    wecomWebhook: wecomWebhook.value.trim(),
    dingtalkWebhook: dingtalkWebhook.value.trim(),
    dingtalkSecret: dingtalkSecret.value.trim(),
  });
}

// P-A7 权限矩阵：禁用工具 + 路径白名单（每行一个，@change 即时保存）
const disabledTools = ref((getSettings().disabledTools ?? []).join("\n"));
const allowedPaths = ref((getSettings().allowedPaths ?? []).join("\n"));
function savePermissions() {
  updateSettings({
    disabledTools: disabledTools.value.split("\n").map((s) => s.trim()).filter(Boolean),
    allowedPaths: allowedPaths.value.split("\n").map((s) => s.trim()).filter(Boolean),
  });
}

// P-A4 应用内 diff 确认：文件编辑类工具先预览 diff/路径，用户确认后才写盘
const fileEditConfirm = ref(getSettings().fileEditConfirm ?? false);
function saveEditConfirm() {
  updateSettings({ fileEditConfirm: fileEditConfirm.value });
}

// P-A12 多模型路由：任务类型 → Profile id（摘要/记忆辅助、编程子代理）
const routeSummarize = ref(getSettings().modelRouting?.["summarize"] || "");
const routeCoding = ref(getSettings().modelRouting?.["coding"] || "");
function saveRouting() {
  updateSettings({
    modelRouting: { summarize: routeSummarize.value, coding: routeCoding.value },
  });
}

// Phase 5 全局快捷键：显示/隐藏主窗口 + 新建对话（保存后即时重注册）
const shortcutToggle = ref(getSettings().globalShortcutToggle || "CommandOrControl+Shift+Space");
const shortcutNewChat = ref(getSettings().globalShortcutNewChat || "CommandOrControl+Shift+K");
function saveShortcuts() {
  updateSettings({
    globalShortcutToggle: shortcutToggle.value.trim() || "CommandOrControl+Shift+Space",
    globalShortcutNewChat: shortcutNewChat.value.trim() || "CommandOrControl+Shift+K",
  });
  // 立即应用新快捷键（Rust 注销旧注册并按新配置注册）
  invoke("apply_global_shortcuts", {
    toggle: shortcutToggle.value.trim() || "CommandOrControl+Shift+Space",
    newChat: shortcutNewChat.value.trim() || "CommandOrControl+Shift+K",
  }).catch(() => { /* 注册失败（被占用）由 Rust 日志记录 */ });
}
function resetShortcuts() {
  shortcutToggle.value = "CommandOrControl+Shift+Space";
  shortcutNewChat.value = "CommandOrControl+Shift+K";
  saveShortcuts();
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
        <h2 class="settings-title"><Settings :size="18" /> 设置</h2>
        <button class="btn-close" @click="emit('close')">✕</button>
      </div>

      <div class="settings-dialog__body">
        <!-- 左侧菜单 -->
        <nav class="settings-nav">
          <button :class="['settings-tab', { active: activeTab === 'api' }]" @click="activeTab = 'api'"><span class="settings-tab__icon"><KeyRound :size="15" /></span>API 配置</button>
          <button :class="['settings-tab', { active: activeTab === 'mcp' }]" @click="activeTab = 'mcp'"><span class="settings-tab__icon"><Puzzle :size="15" /></span>插件</button>
          <button :class="['settings-tab', { active: activeTab === 'ollama' }]" @click="activeTab = 'ollama'"><span class="settings-tab__icon"><Brain :size="15" /></span>本地模型</button>
          <button :class="['settings-tab', { active: activeTab === 'stats' }]" @click="activeTab = 'stats'"><span class="settings-tab__icon"><ChartColumn :size="15" /></span>用量统计</button>
          <button :class="['settings-tab', { active: activeTab === 'health' }]" @click="activeTab = 'health'"><span class="settings-tab__icon"><Stethoscope :size="15" /></span>诊断</button>
          <button :class="['settings-tab', { active: activeTab === 'tasks' }]" @click="activeTab = 'tasks'"><span class="settings-tab__icon"><AlarmClock :size="15" /></span>定时任务</button>
          <button :class="['settings-tab', { active: activeTab === 'memory' }]" @click="activeTab = 'memory'"><span class="settings-tab__icon"><BookOpen :size="15" /></span>记忆</button>
          <button :class="['settings-tab', { active: activeTab === 'permissions' }]" @click="activeTab = 'permissions'"><span class="settings-tab__icon"><Shield :size="15" /></span>权限</button>
          <button :class="['settings-tab', { active: activeTab === 'push' }]" @click="activeTab = 'push'"><span class="settings-tab__icon"><Send :size="15" /></span>推送</button>
          <button :class="['settings-tab', { active: activeTab === 'shortcuts' }]" @click="activeTab = 'shortcuts'"><span class="settings-tab__icon"><Keyboard :size="15" /></span>快捷键</button>
        </nav>

        <!-- 右侧内容 -->
        <div class="settings-content">
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
            <span><Globe :size="14" /> 联网搜索</span>
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
          <label><Folder :size="14" /> Agent 工作区</label>
          <input
            v-model="workspace"
            type="text"
            placeholder="/path/to/project"
            @blur="saveWorkspace"
            @keyup.enter="saveWorkspace"
          />
          <span class="form-hint">Agent 执行命令、读取文件的默认目录（空则不限定）</span>
        </div>

        <!-- 危险命令审批模式 -->
        <div class="form-group">
          <label class="form-label"><ShieldAlert :size="14" /> 危险命令审批模式</label>
          <div class="approval-modes">
            <button
              v-for="m in APPROVAL_MODES"
              :key="m.value"
              :class="['approval-mode', { active: approvalMode === m.value }]"
              @click="onApprovalModeChange(m.value)"
            >
              <span class="approval-mode-name">{{ m.label }}</span>
              <span class="approval-mode-desc">{{ m.desc }}</span>
            </button>
          </div>
          <span class="form-hint">检测到危险命令（rm -rf / sudo / mkfs / dd 等）时的处理方式。</span>
        </div>

        <!-- 辅助任务模型 -->
        <div class="form-group">
          <label class="form-label"><Puzzle :size="14" /> 辅助任务模型</label>
          <select :value="auxiliaryProfileId" class="form-select" @change="onAuxProfileChange">
            <option value="">跟随主模型</option>
            <option v-for="p in chatStore.profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <span class="form-hint">用于 Smart 智能审批、子代理等辅助任务；可选更便宜/更快的模型，节省主模型额度。不配置则跟随主模型。</span>
        </div>

        <!-- P-A12 模型路由：按任务类型自动选模型 -->
        <div class="form-group">
          <label class="form-label"><GitBranch :size="14" /> 模型路由（按任务类型）</label>
          <label class="form-label" style="font-size:12px;font-weight:400">摘要 / 记忆辅助模型</label>
          <select v-model="routeSummarize" class="form-select" @change="saveRouting">
            <option value="">跟随辅助/主模型</option>
            <option v-for="p in chatStore.profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <label class="form-label" style="font-size:12px;font-weight:400;margin-top:8px">编程子代理模型</label>
          <select v-model="routeCoding" class="form-select" @change="saveRouting">
            <option value="">跟随辅助/主模型</option>
            <option v-for="p in chatStore.profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <span class="form-hint">摘要/记忆提取、编程子代理等任务可指定专门模型（如更便宜的或本地 Ollama）；未配置则跟随「辅助任务模型」，再跟随主模型。</span>
        </div>
      </div>

      <!-- MCP 服务器管理 -->
      <div v-show="activeTab === 'mcp'"><McpSettings /></div>

      <!-- Ollama 本地视觉模型管理（状态存于全局 store，关闭界面不中断部署） -->
      <div v-show="activeTab === 'ollama'" class="ollama-panel">
        <h3><Cpu :size="17" /> 本地视觉模型（Ollama）</h3>
        <p class="ollama-desc">用于本地识别图片内容。模型完全在你电脑上运行，免费且隐私安全，无需联网。是否适合本地部署取决于硬件性能。</p>
        <div v-if="ollamaStore.hw" class="hw-card">
          <div class="hw-card__title"><Monitor :size="15" /> 硬件评估 <span class="hw-score">综合 {{ ollamaStore.hw.score }} 分</span></div>
          <div class="hw-card__row">CPU：{{ ollamaStore.hw.cpu_cores }} 核{{ ollamaStore.hw.cpu_brand ? ' · ' + ollamaStore.hw.cpu_brand : '' }}</div>
          <div class="hw-card__row">内存：{{ ollamaStore.hw.memory_gb }} GB</div>
          <div class="hw-card__row">显卡：{{ ollamaStore.hw.gpu_name || '核显' }}{{ ollamaStore.hw.gpu_memory_mb ? ' · ' + ollamaStore.hw.gpu_memory_mb + ' MB' : '' }}{{ ollamaStore.hw.has_metal ? ' · Metal' : '' }}</div>
          <div class="hw-card__verdict" :class="'hw-card__verdict--' + ollamaStore.hw.verdict">{{ verdictText(ollamaStore.hw.verdict) }}</div>
          <p class="hw-card__msg">{{ ollamaStore.hw.message }}</p>
        </div>
        <div v-if="!ollamaStore.status" class="ollama-loading">正在检测 Ollama 环境...</div>
        <template v-else>
          <div class="ollama-status">
            <div class="ollama-item">
              <span class="ollama-dot" :class="ollamaStore.status.installed ? 'green' : (ollamaStore.status.installing ? 'yellow' : 'red')"></span>
              Ollama 程序：{{ ollamaStore.status.installed ? '已安装' : (ollamaStore.status.installing ? '正在安装中...' : '未安装') }}
            </div>
            <div class="ollama-item">
              <span class="ollama-dot" :class="ollamaStore.status.running ? 'green' : 'red'"></span>
              Ollama 服务：{{ ollamaStore.status.running ? '运行中' : '未运行' }}
            </div>
            <div class="ollama-item" v-if="ollamaStore.status.running">
              <span class="ollama-dot" :class="ollamaStore.hasLlava ? 'green' : 'red'"></span>
              视觉模型 llava-phi3：{{ ollamaStore.hasLlava ? '已部署' : '未部署' }}
            </div>
            <div v-if="ollamaStore.status.running && ollamaStore.status.models.length" class="ollama-models">
              已部署模型：{{ ollamaStore.status.models.join(', ') }}
            </div>
          </div>
          <button
            v-if="ollamaStore.hw?.verdict === 'not_recommended'"
            class="btn-primary"
            @click="activeTab = 'api'"
          >配置线上视觉模型 API</button>
          <button
            v-else
            class="btn-primary"
            :disabled="ollamaStore.busy"
            @click="ollamaStore.deploy()"
          >
            {{ ollamaStore.busy ? '部署中...' : (ollamaStore.status.installed && ollamaStore.hasLlava ? '重新检测' : '一键部署') }}
          </button>
          <p class="ollama-hint" v-if="ollamaStore.hw?.verdict !== 'not_recommended'">首次部署将安装 Ollama 并下载约 2GB 模型，耗时较长；关闭此界面会继续在后台下载，可稍后回来查看进度。</p>
        </template>
        <div v-if="ollamaStore.percent !== null && ollamaStore.percent < 100" class="ollama-bar">
          <div class="ollama-bar__fill" :style="{ width: ollamaStore.percent + '%' }"></div>
          <span class="ollama-bar__label">{{ Math.round(ollamaStore.percent) }}%</span>
        </div>
        <div v-if="ollamaStore.progress" class="ollama-progress">{{ ollamaStore.progress }}</div>
      </div>

      <!-- 用量统计 -->
      <div v-show="activeTab === 'stats'"><UsageStats /></div>

      <!-- 运行时诊断 -->
      <div v-show="activeTab === 'health'"><HealthPanel /></div>

      <!-- 定时任务 -->
      <div v-show="activeTab === 'tasks'"><ScheduledTasks /></div>

      <!-- 长期记忆 -->
      <div v-show="activeTab === 'memory'"><MemoryPanel /></div>

      <!-- P-A7 权限矩阵：工具级开关 + 路径白名单 -->
      <div v-show="activeTab === 'permissions'">
        <h3><Shield :size="17" /> 权限矩阵</h3>
        <p class="ollama-desc">工具级开关：被禁用的工具 Agent 无法调用；路径白名单：配置后 Agent 的文件/命令类工具只能访问白名单内目录（写操作始终受主目录边界约束）。留空 = 不限制。</p>
        <div class="form-group approval-mode">
          <label class="memory-config__toggle" style="display: inline-flex; align-items: center; gap: 8px; cursor: pointer;">
            <input type="checkbox" v-model="fileEditConfirm" @change="saveEditConfirm" />
            <span>文件编辑需确认（Agent 改文件前先预览 diff，你确认后才写入）</span>
          </label>
          <span class="form-hint">开启后，Agent 调用 replace_string / insert_string / delete_file 会先弹出 diff/路径确认框，点「应用」才真正写盘；关闭则保持自动应用（可用「禁用工具」白名单保护文件）。</span>
        </div>
        <div class="form-group">
          <label>禁用工具（每行一个工具名）</label>
          <textarea
            v-model="disabledTools"
            rows="5"
            placeholder="如：write_file&#10;subagent_delegate&#10;puppeteer_screenshot"
            @change="savePermissions"
          ></textarea>
          <span class="form-hint">在此列出的工具会被直接拦截（提示「已在权限矩阵中禁用」）。常见用途：禁用 write_file/delete_file 防止 Agent 改文件、禁用浏览器工具防止弹窗。</span>
        </div>
        <div class="form-group">
          <label>路径白名单（每行一个目录）</label>
          <textarea
            v-model="allowedPaths"
            rows="5"
            placeholder="如：/Users/wanghuan/op&#10;~/Pictures"
            @change="savePermissions"
          ></textarea>
          <span class="form-hint">配置后 Agent 的 list_dir / 文件编辑 / git / 测试 / 项目分析等工具只能访问这些目录；留空 = 不限制。</span>
        </div>
      </div>

      <!-- 主动推送（飞书 / 企业微信群机器人） -->
      <div v-show="activeTab === 'push'">
        <div class="form-group">
          <label>飞书群机器人 Webhook</label>
          <input
            v-model="feishuWebhook"
            type="password"
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
            @change="savePushWebhooks"
          />
          <span class="form-hint">飞书群 → 设置 → 群机器人 → 添加「自定义机器人」→ 复制 Webhook 地址</span>
        </div>
        <div class="form-group">
          <label>企业微信群机器人 Webhook</label>
          <input
            v-model="wecomWebhook"
            type="password"
            placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
            @change="savePushWebhooks"
          />
          <span class="form-hint">企业微信群 → 添加「群机器人」→ 复制 Webhook 地址。之后可让 Agent 调用 send_im 主动推送，或配定时任务用 curl 定时推送。</span>
        </div>
        <div class="form-group">
          <label>钉钉群机器人 Webhook</label>
          <input
            v-model="dingtalkWebhook"
            type="password"
            placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
            @change="savePushWebhooks"
          />
          <span class="form-hint">钉钉群 → 设置 → 机器人 → 添加「自定义」→ 复制 Webhook 地址</span>
        </div>
        <div class="form-group">
          <label>钉钉加签密钥（可选）</label>
          <input
            v-model="dingtalkSecret"
            type="password"
            placeholder="SEC...（钉钉安全设置选「加签」时才需填写）"
            @change="savePushWebhooks"
          />
          <span class="form-hint">钉钉机器人安全设置若选「加签」，填 SEC 开头的密钥；选「自定义关键词」则留空</span>
        </div>
      </div>

      <!-- Phase 5 全局快捷键 -->
      <div v-show="activeTab === 'shortcuts'">
        <h3><Keyboard :size="17" /> 全局快捷键</h3>
        <p class="ollama-desc">全局快捷键在应用最小化/隐藏到后台时仍生效。格式：修饰键 + 键名（如 CommandOrControl+Shift+Space）。仅支持单个非修饰键 + 修饰键组合。</p>
        <div class="form-group">
          <label>显示 / 隐藏主窗口（快速召唤）</label>
          <input v-model="shortcutToggle" placeholder="CommandOrControl+Shift+Space" @change="saveShortcuts" />
          <span class="form-hint">macOS 用 Command / ⌘；Windows/Linux 用 Control / Ctrl。例：CommandOrControl+Shift+Space、CommandOrControl+Alt+D</span>
        </div>
        <div class="form-group">
          <label>新建对话</label>
          <input v-model="shortcutNewChat" placeholder="CommandOrControl+Shift+K" @change="saveShortcuts" />
          <span class="form-hint">保存后立即生效（注销旧快捷键并按新配置重新注册）。若提示被占用，说明与其他应用冲突，请换一个组合。</span>
        </div>
        <button class="settings-reset-btn" @click="resetShortcuts">恢复默认（⌘⇧Space / ⌘⇧K）</button>
      </div>
        </div>
      </div>

    <div class="settings-dialog__footer">
      <!-- 删除/保存 只对「API 配置」页生效（针对正在编辑的模型配置），其余页只保留关闭 -->
      <button
        v-if="activeTab === 'api' && !isNew && chatStore.profiles.length > 1"
        class="btn-danger"
        @click="handleDelete"
      >
        删除此配置
      </button>
      <div class="settings-dialog__footer-spacer"></div>
      <button class="btn-secondary" @click="emit('close')">取消</button>
      <button v-if="activeTab === 'api'" class="btn-primary" @click="handleSave">保存</button>
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
  width: 640px; height: min(85vh, 720px);
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
.settings-title { font-size: 15px; font-weight: 700; color: var(--text-primary); }

/* 左侧菜单 */
.settings-nav {
  width: 168px; flex-shrink: 0; border-right: 1px solid var(--border-color);
  padding: 12px 8px; display: flex; flex-direction: column; gap: 2px;
  overflow-y: auto; background: var(--bg-secondary);
}
.settings-tab {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 9px 12px; border: none; border-radius: 8px;
  background: transparent; color: var(--text-secondary); font-size: 13px;
  cursor: pointer; text-align: left; transition: all .15s;
}
.settings-tab:hover { background: var(--bg-hover); color: var(--text-primary); }
.settings-tab.active { background: var(--accent-bg); color: var(--accent-color); font-weight: 600; }
.settings-tab__icon { width: 20px; text-align: center; flex-shrink: 0; }

.btn-close {
  width: 32px; height: 32px; border: none; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-secondary); font-size: 16px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: all .15s;
}
.btn-close:hover { background: var(--bg-hover); color: var(--text-primary); }

.settings-dialog__body {
  display: flex; flex-direction: row; gap: 0;
  overflow: hidden; flex: 1; min-height: 0; padding: 0;
}

/* 右侧内容区：各 panel 在此滚动 */
.settings-content {
  flex: 1; min-width: 0; overflow-y: auto;
  padding: 20px 24px; display: flex; flex-direction: column; gap: 18px;
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
.settings-reset-btn {
  padding: 8px 14px; border: 1.5px solid var(--border-color); border-radius: var(--radius-md);
  background: var(--bg-secondary); color: var(--text-secondary); font-size: 12px; cursor: pointer; transition: all .2s;
}
.settings-reset-btn:hover { border-color: var(--accent-color); color: var(--accent-color); }
.approval-modes { display: flex; flex-direction: column; gap: 6px; margin-bottom: 6px; }
.approval-mode {
  display: flex; align-items: center; gap: 10px; padding: 8px 12px;
  border: 1.5px solid var(--border-color); border-radius: var(--radius-md);
  background: var(--bg-secondary); color: var(--text-primary); cursor: pointer;
  text-align: left; font-family: inherit; transition: all .15s;
}
.approval-mode:hover { border-color: var(--accent-color); }
.approval-mode.active { border-color: var(--accent-color); background: color-mix(in srgb, var(--accent-color) 12%, transparent); }
.approval-mode-name { font-size: 13px; font-weight: 600; white-space: nowrap; }
.approval-mode-desc { font-size: 11px; color: var(--text-muted); }
.form-select {
  width: 100%; padding: 8px 10px; border: 1.5px solid var(--border-color);
  border-radius: var(--radius-md); background: var(--bg-secondary); color: var(--text-primary);
  font-size: 13px; font-family: inherit; outline: none;
}
.form-select:focus { border-color: var(--accent-color); }
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
.ollama-dot.yellow { background: #f59e0b; box-shadow: 0 0 6px rgba(245,158,11,.5); animation: ollama-blink 1s ease-in-out infinite; }
.ollama-dot.red { background: #ef4444; }
@keyframes ollama-blink { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
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
