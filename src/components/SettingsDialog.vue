<script setup lang="ts">
import { ref } from "vue";
import { useChatStore } from "@/stores/chat";
import type { ApiProfile } from "@/types";
import { v4 as uuidv4 } from "@/stores/uuid";
import McpSettings from "./McpSettings.vue";

const emit = defineEmits<{
  close: [];
}>();

const chatStore = useChatStore();
const activeTab = ref<"api" | "mcp">("api");

const editingId = ref<string>(chatStore.activeProfileId);
const editingProfile = ref<ApiProfile>({
  ...(chatStore.activeProfile || chatStore.profiles[0]),
});

const isNew = ref(false);

// 切换编辑目标
function selectProfile(id: string) {
  const p = chatStore.profiles.find((p) => p.id === id);
  if (p) {
    editingId.value = id;
    editingProfile.value = { ...p };
    isNew.value = false;
  }
}

function startNew() {
  editingId.value = "";
  editingProfile.value = {
    id: uuidv4(),
    name: "新配置",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o",
    maxTokens: 4096,
    temperature: 0.7,
    thinkingEnabled: false,
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
            placeholder="如: OpenAI、DeepSeek"
          />
        </div>

        <div class="form-group">
          <label>API 地址</label>
          <input
            v-model="editingProfile.baseUrl"
            type="text"
            placeholder="https://api.openai.com"
          />
          <span class="form-hint">OpenAI 兼容 API 的基础地址</span>
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
          <input
            v-model="editingProfile.model"
            type="text"
            placeholder="gpt-4o"
          />
          <span class="form-hint">例如: gpt-4o, deepseek-chat, claude-3-opus 等</span>
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

      <!-- MCP 服务器管理 -->
      <div v-show="activeTab === 'mcp'"><McpSettings /></div>
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
  width: 520px; max-height: 85vh;
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
  overflow-y: auto; flex: 1;
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
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }

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
</style>
