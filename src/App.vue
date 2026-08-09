<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import ChatHistory from "./components/ChatHistory.vue";
import ChatMessage from "./components/ChatMessage.vue";
import ChatInput from "./components/ChatInput.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import { useChatStore } from "./stores/chat";
import { useTheme } from "./composables/useTheme";
import type { ImageAttachment } from "@/types";

const chatStore = useChatStore();
const { theme, toggleTheme } = useTheme();

const showSettings = ref(false);
const showSidebar = ref(true);
const messagesContainer = ref<HTMLDivElement>();

function scrollToBottom() {
  requestAnimationFrame(() => {
    const el = messagesContainer.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(() => chatStore.activeConversation?.messages.length, () => scrollToBottom());
watch(() => chatStore.activeConversation?.messages.at(-1)?.content, () => scrollToBottom());

function handleSend(text: string, images: ImageAttachment[]) {
  chatStore.sendMessage(text, images.length > 0 ? images : undefined);
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
          <h1 class="topbar__title">道生一</h1>
        </div>
        <div class="topbar__right">
          <button class="topbar__btn" title="导出 Markdown" @click="exportMarkdown">📥</button>
          <button class="topbar__btn" title="清空对话" @click="chatStore.clearCurrentConversation()">🗑</button>
          <button class="topbar__btn" title="切换主题" @click="toggleTheme">
            {{ theme === "light" ? "🌙" : "☀️" }}
          </button>
          <button class="topbar__btn" title="API 设置" @click="showSettings = true">
            ⚙️
          </button>
        </div>
      </header>

      <!-- 消息区域 -->
      <div ref="messagesContainer" class="messages-container">
        <!-- 空状态 -->
        <div
          v-if="!chatStore.activeConversation || chatStore.activeConversation.messages.length === 0"
          class="empty-state"
        >
          <div class="empty-state__icon">🤖</div>
          <h2>道生一</h2>
          <p>AI Agent 桌面客户端 · 支持多模态对话与图片识别</p>
        </div>

        <!-- 消息列表 -->
        <template v-if="chatStore.activeConversation">
          <ChatMessage
            v-for="msg in chatStore.activeConversation.messages"
            :key="msg.id"
            :message="msg"
          />
        </template>
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
    <SettingsDialog v-if="showSettings" @close="showSettings = false" />
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
.topbar__title {
  font-size: 16px; font-weight: 700; color: var(--text-primary);
  letter-spacing: -0.01em;
  background: linear-gradient(135deg, var(--accent-color), #06b6d4);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  background-clip: text;
}
.topbar__right { display: flex; align-items: center; gap: 6px; }

.topbar__btn {
  width: 34px; height: 34px; border: none; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-secondary); font-size: 15px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: all 0.2s;
}
.topbar__btn:hover { background: var(--bg-hover); color: var(--text-primary); }

.messages-container {
  flex: 1; overflow-y: auto;
  background: var(--bg-primary);
  scroll-behavior: smooth;
}

.empty-state {
  display: flex; flex-direction: column; align-items: center;
  justify-content: center; height: 100%; text-align: center; padding: 60px;
}
.empty-state__icon {
  width: 80px; height: 80px; border-radius: 24px;
  background: var(--accent-light);
  display: flex; align-items: center; justify-content: center;
  font-size: 40px; margin-bottom: 24px;
}
.empty-state h2 {
  font-size: 24px; font-weight: 700; color: var(--text-primary);
  margin: 0 0 8px; letter-spacing: -0.02em;
}
.empty-state p {
  font-size: 14px; color: var(--text-secondary);
  max-width: 360px; line-height: 1.6;
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
</style>
