<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import ChatHistory from "./components/ChatHistory.vue";
import ChatMessage from "./components/ChatMessage.vue";
import TaskPlanCard from "./components/TaskPlanCard.vue";
import SubagentPanel from "./components/SubagentPanel.vue";
import ChatInput from "./components/ChatInput.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import AboutDialog from "./components/AboutDialog.vue";
import WorkflowDialog from "./components/WorkflowDialog.vue";
import DiffConfirmDialog from "./components/DiffConfirmDialog.vue";
import UndoBubble from "./components/UndoBubble.vue";
import AppLogo from "./components/AppLogo.vue";
import { PERSONAS } from "./data/personas-catalog";
import { useChatStore } from "./stores/chat";
import { useOllamaStore } from "./stores/ollama";
import { useUiStore, type SettingsTab } from "./stores/ui";
import { useTheme } from "./composables/useTheme";
import { formatCost } from "@/utils/tokens";
import type { ImageAttachment, FileAttachment } from "@/types";
import { Download, Trash2, Moon, Sun, Settings, MessageSquarePlus, Terminal, FileText, Paperclip, AlarmClock, Stethoscope, Square } from "lucide-vue-next";

const chatStore = useChatStore();
const ollamaStore = useOllamaStore();
const ui = useUiStore();
const { theme, toggleTheme } = useTheme();

// 首次启动自动检测 Ollama 本地视觉模型（结合硬件评估智能引导）
const ollamaBanner = ref(false);       // 硬件允许 → 一键部署横幅
const ollamaNotRecBanner = ref(false); // 硬件不足 → 建议线上 API 横幅
const hardwareMessage = ref("");
function openSettings(tab: SettingsTab = "api") {
  ui.openSettings(tab);
}

// 系统菜单事件（main.ts 分发）触发的响应：切换主题 / 导出对话
watch(() => ui.themeToggleCounter, () => toggleTheme());
watch(() => ui.exportCounter, () => {
  const id = chatStore.activeConversationId;
  if (id) chatStore.downloadExport(id, "md");
});
// 根据当前 Ollama 状态计算聊天窗口引导横幅。抽取为独立函数，供启动时与
// 状态变化（含一键部署完成）时实时重算——修复「部署完成后横幅仍残留」。
function evaluateOllamaBanner() {
  const s = ollamaStore.status;
  const hw = ollamaStore.hw;
  ollamaBanner.value = false;
  ollamaNotRecBanner.value = false;
  if (!s) return;
  hardwareMessage.value = hw?.message ?? "";
  const hasLlava = s.models?.some((m) => m.includes("llava-phi3")) ?? false;
  if (s.installed && s.running && hasLlava) return; // 已就绪，无需引导
  if (s.installing) return; // 正在安装中，不打扰
  if (hw?.verdict === "not_recommended") {
    ollamaNotRecBanner.value = true; // 硬件不足 → 建议线上 API
  } else {
    ollamaBanner.value = true; // recommended / warning 都允许本地部署
  }
}
async function checkOllamaOnStart() {
  // 与设置页共享全局 ollama store（main.ts 已注册进度监听，幂等）
  await ollamaStore.init();
  evaluateOllamaBanner();
}
// 实时跟随 Ollama 状态：部署中隐藏横幅；状态/硬件变化（含一键部署完成后
// store.deploy 内 refreshStatus 更新 status）自动重算，无需重启应用。
watch([() => ollamaStore.busy, () => ollamaStore.status, () => ollamaStore.hw], () => {
  if (ollamaStore.busy) {
    ollamaBanner.value = false;
    ollamaNotRecBanner.value = false;
    return;
  }
  evaluateOllamaBanner();
});
const messagesContainer = ref<HTMLDivElement>();

function scrollToBottom() {
  requestAnimationFrame(() => {
    const el = messagesContainer.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(() => chatStore.activeConversation?.messages.length, () => scrollToBottom());
// .at(-1) 是 ES2022，旧 WKWebView 不支持 → 用 length-1 兼容写法
watch(() => {
  const msgs = chatStore.activeConversation?.messages;
  return msgs && msgs.length > 0 ? msgs[msgs.length - 1].content : undefined;
}, () => scrollToBottom());
// 流式输出时跟随滚动
watch(() => chatStore.streamingContent, () => scrollToBottom());
watch(() => chatStore.streamingReasoning, () => scrollToBottom());

function handleSend(text: string, images: ImageAttachment[], files: FileAttachment[]) {
  chatStore.sendMessage(
    text,
    images.length > 0 ? images : undefined,
    files.length > 0 ? files : undefined
  );
}

function handleStop() { chatStore.stopStreaming(); }

function onPersonaChange(e: Event) {
  chatStore.setPersona((e.target as HTMLSelectElement).value);
}

// 导出对话
function exportMarkdown() {
  const conv = chatStore.activeConversation;
  if (!conv || conv.messages.length === 0) return;
  let md = `# ${conv.title}\n\n`;
  for (const m of conv.messages) {
    md += m.role === "user" ? `### 你\n\n${m.content}\n\n` : `### 道生一\n\n${m.content}\n\n`;
    if (m.reasoning_content) md += `<details><summary>🧠 思考过程</summary>\n\n${m.reasoning_content}\n\n</details>\n\n`;
    if (m.images?.length) m.images.forEach((img, i) => md += `![图片${i + 1}](${img.base64.slice(0, 50)}...)\n\n`);
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
  a.download = `${conv.title}.md`; a.click();
}

// 快捷键
function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "n") { e.preventDefault(); chatStore.createConversation(); }
  if (e.key === "Escape" && chatStore.isStreaming) { chatStore.stopStreaming(); }
}

onMounted(() => {
  if (chatStore.conversations.length === 0) chatStore.createConversation();
  scrollToBottom();
  document.addEventListener("keydown", onKeydown);
  checkOllamaOnStart();
});
onUnmounted(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="app-layout">
    <!-- 侧边栏 -->
    <aside class="sidebar" :class="{ 'sidebar--collapsed': !ui.sidebarVisible }">
      <ChatHistory />
    </aside>

    <!-- 主内容区 -->
    <div class="main-area">
      <!-- 顶部栏 -->
      <header class="topbar">
        <div class="topbar__left">
          <button class="topbar__btn" title="切换侧边栏" @click="ui.toggleSidebar()">
            ☰
          </button>
          <AppLogo :size="22" class="topbar__logo" />
          <h1 class="topbar__title">道生一</h1>
        </div>
        <div class="topbar__right">
          <select
            class="topbar__persona"
            :value="chatStore.activePersonaId"
            title="切换人格 / 对话角色"
            @change="onPersonaChange"
          >
            <option value="">🧑 通用助手</option>
            <option v-for="p in PERSONAS" :key="p.id" :value="p.id">{{ p.emoji }} {{ p.name }}</option>
          </select>
          <div
            v-if="chatStore.usageAggTotal > 0"
            class="topbar__stats"
            :title="`历史累计 Token 消耗与估算费用（含已删除会话）；缓存命中率为当前对话`"
          >
            <span class="stat">{{ chatStore.usageAggTotal.toLocaleString() }} tok</span>
            <span class="stat">{{ formatCost(chatStore.usageAggCost) }}</span>
            <span
              v-if="chatStore.cacheHitRate !== null"
              class="stat stat--cache"
              :title="`缓存命中 ${chatStore.cacheHitTotal.toLocaleString()} tok / 未命中 ${chatStore.cacheMissTotal.toLocaleString()} tok`"
            >缓存 {{ chatStore.cacheHitRate.toFixed(0) }}%</span>
          </div>
          <button class="topbar__btn" title="导出 Markdown" @click="exportMarkdown"><Download :size="17" /></button>
          <button class="topbar__btn" title="清空对话" @click="chatStore.clearCurrentConversation()"><Trash2 :size="17" /></button>
          <button class="topbar__btn" title="切换主题" @click="toggleTheme">
            <Moon v-if="theme === 'light'" :size="17" />
            <Sun v-else :size="17" />
          </button>
          <button class="topbar__btn" title="API 设置" @click="openSettings('api')">
            <Settings :size="17" />
          </button>
        </div>
      </header>

      <!-- Ollama 本地视觉模型引导横幅（硬件允许时） -->
      <div v-if="ollamaBanner" class="ollama-banner">
        <span>💡 检测到本地视觉模型（Ollama + llava-phi3）未就绪，你的硬件足以支持，可免费在本机识别图片。</span>
        <button class="ollama-banner__btn" @click="openSettings('ollama')">一键部署</button>
        <button class="ollama-banner__close" title="关闭" @click="ollamaBanner = false">✕</button>
      </div>

      <!-- 硬件不足时：建议配置线上视觉模型 API -->
      <div v-if="ollamaNotRecBanner" class="ollama-banner ollama-banner--warn">
        <span>⚠️ {{ hardwareMessage || '你的硬件可能不适合本地部署视觉模型，建议配置线上视觉模型 API。' }}</span>
        <button class="ollama-banner__btn" @click="openSettings('api')">配置线上 API</button>
        <button class="ollama-banner__close" title="关闭" @click="ollamaNotRecBanner = false">✕</button>
      </div>

      <!-- 消息区域 -->
      <div ref="messagesContainer" class="messages-container">
        <div class="messages-inner">
          <!-- 空状态 -->
          <div
            v-if="!chatStore.activeConversation || chatStore.activeConversation.messages.length === 0"
            class="empty-state"
          >
            <div class="empty-state__icon"><AppLogo :size="56" /></div>
            <h2>道生一</h2>
            <p>AI Agent 桌面客户端 · 支持多模态对话与图片识别</p>
            <div class="empty-state__tips">
              <div class="tip-card"><span class="tip-key"><MessageSquarePlus :size="14" /> ⌘/Ctrl + N</span> 新建对话</div>
              <div class="tip-card"><span class="tip-key"><Terminal :size="14" /> /run</span> 执行终端命令</div>
              <div class="tip-card"><span class="tip-key"><FileText :size="14" /> /read</span> 读取本地文件</div>
              <div class="tip-card"><span class="tip-key"><Paperclip :size="14" /> 粘贴图片</span> 本地视觉识别</div>
              <div class="tip-card"><span class="tip-key"><AlarmClock :size="14" /> 定时任务</span> 后台自动执行</div>
              <div class="tip-card"><span class="tip-key"><Stethoscope :size="14" /> 诊断</span> 系统健康与日志</div>
            </div>
          </div>

          <!-- 消息列表 -->
          <template v-if="chatStore.activeConversation">
            <TaskPlanCard />
            <ChatMessage
              v-for="msg in chatStore.activeConversation.messages"
              :key="msg.id"
              :message="msg"
            />
            <SubagentPanel />
          </template>
        </div>
      </div>

      <!-- 输入区域 -->
      <ChatInput
        :disabled="chatStore.isStreaming"
        @send="handleSend"
        @open-settings="ui.openSettings('api')"
      />

      <!-- 停止生成按钮 -->
      <div v-if="chatStore.isStreaming" class="stop-bar">
        <button class="stop-btn" @click="handleStop"><Square :size="14" /> 停止生成</button>
      </div>

      <!-- 切换模型配置提示 -->
      <div v-if="chatStore.profileSwitching" class="switch-overlay">
        <div class="switch-overlay__box">🔄 正在切换模型配置…</div>
      </div>
    </div>

    <!-- 设置弹窗 -->
    <SettingsDialog v-if="ui.settingsOpen" :initial-tab="ui.settingsTab" @close="ui.closeSettings()" />

    <!-- 关于道生一 -->
    <AboutDialog v-if="ui.aboutOpen" @close="ui.closeAbout()" />

    <!-- 可视化工作流（Phase 3） -->
    <WorkflowDialog v-if="ui.workflowOpen" @close="ui.closeWorkflow()" />

    <!-- P-A4 应用内 diff 确认（文件编辑需确认时弹出） -->
    <DiffConfirmDialog />

    <!-- 会话内撤销气泡（最近文件操作可一键回滚） -->
    <UndoBubble />
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  background: var(--bg-primary);
}

.sidebar {
  width: 270px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-color);
  background: var(--bg-sidebar);
  transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s ease;
  overflow: hidden;
}
.sidebar--collapsed { width: 0; opacity: 0; }

.main-area {
  flex: 1; display: flex; flex-direction: column; min-width: 0;
  position: relative; background: var(--bg-primary);
}

.topbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 20px; height: 54px;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.topbar__left { display: flex; align-items: center; gap: 12px; }
.topbar__logo { display: flex; }
.topbar__title {
  font-size: 16px; font-weight: 700; color: var(--text-primary);
  letter-spacing: -0.01em;
  background: linear-gradient(135deg, var(--accent-color), #06b6d4);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  background-clip: text;
}
.topbar__right { display: flex; align-items: center; gap: 6px; }

.topbar__persona {
  appearance: none; -webkit-appearance: none;
  height: 28px; padding: 0 26px 0 12px;
  border: 1px solid var(--border-color); border-radius: 16px;
  background-color: var(--bg-secondary);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23888888' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center;
  color: var(--text-secondary); font-size: 11px; line-height: 1; font-family: inherit;
  cursor: pointer; outline: none; max-width: 160px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.topbar__persona:focus { border-color: var(--accent-color); }
.topbar__persona option { background: var(--bg-secondary); color: var(--text-primary); }

.topbar__stats {
  display: flex; align-items: center; gap: 8px;
  height: 28px; padding: 0 12px; margin-right: 4px;
  border: 1px solid var(--border-color); border-radius: 16px;
  background: var(--bg-secondary);
}
.topbar__stats .stat {
  font-size: 11px; font-weight: 600; color: var(--text-secondary);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.topbar__stats .stat--cache {
  color: var(--accent-color); font-weight: 700;
}

.topbar__btn {
  width: 34px; height: 34px; border: none; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-secondary); font-size: 15px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: all 0.2s;
}
.topbar__btn:hover { background: var(--bg-hover); color: var(--text-primary); }

.messages-container {
  flex: 1; overflow-y: auto; overflow-x: hidden;
  background: var(--bg-primary);
  scroll-behavior: smooth;
}

/* 消息内容居中容器：小屏填满可用宽度，大屏封顶 1400px，减少高分屏全屏时的两侧空白 */
.messages-inner {
  max-width: min(100% - 48px, 1400px); margin: 0 auto; min-height: 100%;
  display: flex; flex-direction: column;
  padding: 16px 24px 28px;
}

.empty-state {
  flex: 1; display: flex; flex-direction: column; align-items: center;
  justify-content: center; text-align: center; padding: 40px 24px;
}
.empty-state__icon {
  width: 80px; height: 80px; border-radius: 24px;
  background: var(--accent-light);
  display: flex; align-items: center; justify-content: center;
  font-size: 40px; margin-bottom: 20px;
  box-shadow: var(--shadow-md);
}
.empty-state h2 {
  font-size: 24px; font-weight: 700; color: var(--text-primary);
  margin: 0 0 8px; letter-spacing: -0.02em;
}
.empty-state p {
  font-size: 14px; color: var(--text-secondary);
  max-width: 420px; line-height: 1.6; margin-bottom: 28px;
}
.empty-state__tips {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
  max-width: 560px; width: 100%;
}
.tip-card {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 14px 10px; border: 1px solid var(--border-color);
  border-radius: var(--radius-md); background: var(--bg-elevated);
  font-size: 12px; color: var(--text-secondary);
  transition: border-color .2s, transform .15s;
}
.tip-card:hover { border-color: var(--accent-color); transform: translateY(-1px); }
.tip-key {
  font-size: 12px; font-weight: 600; color: var(--accent-color);
  font-variant-numeric: tabular-nums;
}

.stop-bar {
  position: absolute; bottom: 100px; left: 50%; transform: translateX(-50%);
  z-index: 10;
}
.stop-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 18px; border: 1.5px solid var(--danger-color);
  border-radius: 24px; background: var(--bg-elevated);
  color: var(--danger-color); font-size: 13px; font-weight: 500;
  cursor: pointer; box-shadow: var(--shadow-md); transition: all 0.2s;
}
.stop-btn:hover {
  background: var(--danger-color); color: #fff;
  transform: translateY(-1px); box-shadow: var(--shadow-lg);
}
.stop-btn:active { transform: translateY(0); }

/* 切换模型配置提示 overlay */
.switch-overlay {
  position: absolute; inset: 0; z-index: 50;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.35); backdrop-filter: blur(2px);
}
.switch-overlay__box {
  padding: 16px 28px; border-radius: 14px;
  background: var(--bg-elevated); border: 1px solid var(--border-color);
  color: var(--text-primary); font-size: 14px; font-weight: 600;
  box-shadow: var(--shadow-md);
}

/* Ollama 引导横幅 */
.ollama-banner {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 16px; margin: 8px 16px 0;
  background: linear-gradient(135deg, rgba(99,102,241,.12), rgba(34,197,94,.1));
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 13px; color: var(--text-primary);
  flex-shrink: 0;
}
.ollama-banner span { flex: 1; }
.ollama-banner__btn {
  padding: 4px 12px; border: none; border-radius: 6px;
  background: var(--accent-color); color: #fff;
  font-size: 12px; cursor: pointer; white-space: nowrap;
}
.ollama-banner__btn:hover { background: var(--accent-hover); }
.ollama-banner--warn {
  background: linear-gradient(135deg, rgba(245,158,11,.16), rgba(239,68,68,.1));
}
.ollama-banner--warn .ollama-banner__btn { background: #f59e0b; }
.ollama-banner--warn .ollama-banner__btn:hover { background: #d97706; }
.ollama-banner__close {
  background: none; border: none; color: var(--text-secondary);
  cursor: pointer; font-size: 12px; padding: 4px;
}
.ollama-banner__close:hover { color: var(--text-primary); }
</style>
