<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import ChatHistory from "./components/ChatHistory.vue";
import ChatMessage from "./components/ChatMessage.vue";
import SubagentPanel from "./components/SubagentPanel.vue";
import ChatInput from "./components/ChatInput.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import AppLogo from "./components/AppLogo.vue";
import { useChatStore } from "./stores/chat";
import { useOllamaStore } from "./stores/ollama";
import { useTheme } from "./composables/useTheme";
import { formatCost } from "@/utils/tokens";
import type { ImageAttachment, FileAttachment } from "@/types";

const chatStore = useChatStore();
const ollamaStore = useOllamaStore();
const { theme, toggleTheme } = useTheme();

const showSettings = ref(false);
const settingsInitialTab = ref<"api" | "mcp" | "ollama">("api");
const showSidebar = ref(true);

// 首次启动自动检测 Ollama 本地视觉模型（结合硬件评估智能引导）
const ollamaBanner = ref(false);       // 硬件允许 → 一键部署横幅
const ollamaNotRecBanner = ref(false); // 硬件不足 → 建议线上 API 横幅
const hardwareMessage = ref("");
function openSettings(tab: "api" | "mcp" | "ollama" = "api") {
  settingsInitialTab.value = tab;
  showSettings.value = true;
}
async function checkOllamaOnStart() {
  // 与设置页共享全局 ollama store（main.ts 已注册进度监听，幂等）
  await ollamaStore.init();
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
const messagesContainer = ref<HTMLDivElement>();

function scrollToBottom() {
  requestAnimationFrame(() => {
    const el = messagesContainer.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(() => chatStore.activeConversation?.messages.length, () => scrollToBottom());
watch(() => chatStore.activeConversation?.messages.at(-1)?.content, () => scrollToBottom());
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
    <aside class="sidebar" :class="{ 'sidebar--collapsed': !showSidebar }">
      <ChatHistory />
    </aside>

    <!-- 主内容区 -->
    <div class="main-area">
      <!-- 顶部栏 -->
      <header class="topbar">
        <div class="topbar__left">
          <button class="topbar__btn" title="切换侧边栏" @click="showSidebar = !showSidebar">
            ☰
          </button>
          <AppLogo :size="22" class="topbar__logo" />
          <h1 class="topbar__title">道生一</h1>
        </div>
        <div class="topbar__right">
          <div
            v-if="chatStore.conversationStats.tokens > 0"
            class="topbar__stats"
            :title="`当前对话 Token 消耗与估算费用`"
          >
            <span class="stat">{{ chatStore.conversationStats.tokens.toLocaleString() }} tok</span>
            <span class="stat">{{ formatCost(chatStore.conversationStats.cost) }}</span>
            <span
              v-if="chatStore.cacheHitRate !== null"
              class="stat stat--cache"
              :title="`缓存命中 ${chatStore.cacheHitTotal.toLocaleString()} tok / 未命中 ${chatStore.cacheMissTotal.toLocaleString()} tok`"
            >缓存 {{ chatStore.cacheHitRate.toFixed(0) }}%</span>
          </div>
          <button class="topbar__btn" title="导出 Markdown" @click="exportMarkdown">📥</button>
          <button class="topbar__btn" title="清空对话" @click="chatStore.clearCurrentConversation()">🗑</button>
          <button class="topbar__btn" title="切换主题" @click="toggleTheme">
            {{ theme === "light" ? "🌙" : "☀️" }}
          </button>
          <button class="topbar__btn" title="API 设置" @click="openSettings('api')">
            ⚙️
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
              <div class="tip-card"><span class="tip-key">⌘/Ctrl + N</span> 新建对话</div>
              <div class="tip-card"><span class="tip-key">/run</span> 执行终端命令</div>
              <div class="tip-card"><span class="tip-key">/read</span> 读取本地文件</div>
              <div class="tip-card"><span class="tip-key">📋 粘贴图片</span> 本地视觉识别</div>
              <div class="tip-card"><span class="tip-key">⏰ 定时任务</span> 后台自动执行</div>
              <div class="tip-card"><span class="tip-key">🩺 诊断</span> 系统健康与日志</div>
            </div>
          </div>

          <!-- 消息列表 -->
          <template v-if="chatStore.activeConversation">
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
        @open-settings="showSettings = true"
      />

      <!-- 停止生成按钮 -->
      <div v-if="chatStore.isStreaming" class="stop-bar">
        <button class="stop-btn" @click="handleStop">⏹ 停止生成</button>
      </div>
    </div>

    <!-- 设置弹窗 -->
    <SettingsDialog v-if="showSettings" :initial-tab="settingsInitialTab" @close="showSettings = false" />
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

.topbar__stats {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 12px; margin-right: 4px;
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

/* 消息内容居中容器：宽屏下限制阅读宽度（借鉴 Hermes 工作台的居中布局） */
.messages-inner {
  max-width: 920px; margin: 0 auto; min-height: 100%;
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
  padding: 8px 20px; border: 1px solid var(--border-color);
  border-radius: 24px; background: var(--bg-elevated);
  color: var(--text-secondary); font-size: 13px; font-weight: 500;
  cursor: pointer; box-shadow: var(--shadow-md); transition: all 0.2s;
}
.stop-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

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
