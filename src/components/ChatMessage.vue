<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import type { ChatMessage as Msg, ImageAttachment } from "@/types";
import { Marked } from "marked";
import hljs from "@/utils/hljs";
import { useChatStore } from "@/stores/chat";

const chatStore = useChatStore();
const props = defineProps<{ message: Msg }>();

const contentRef = ref<HTMLDivElement>();
const previewImage = ref<ImageAttachment | null>(null);
const showReasoning = ref(true);
const copied = ref(false);

const marked = new Marked(); marked.setOptions({ breaks: true, gfm: true });
function md(s: string) { return s ? marked.parse(s) as string : ""; }

function highlight() {
  if (!contentRef.value) return;
  contentRef.value.querySelectorAll("pre code:not(.hljs)").forEach(b => hljs.highlightElement(b as HTMLElement));
  contentRef.value.querySelectorAll("pre").forEach(pre => {
    if (pre.querySelector(".code-copy-btn")) return;
    const btn = document.createElement("button");
    btn.className = "code-copy-btn"; btn.textContent = "复制";
    btn.onclick = () => { navigator.clipboard.writeText(pre.querySelector("code")?.textContent || ""); btn.textContent = "✓"; setTimeout(() => btn.textContent = "复制", 2000); };
    pre.style.position = "relative"; pre.appendChild(btn);
  });
}

async function copyAll() { await chatStore.copyToClipboard(props.message.content); copied.value = true; setTimeout(() => copied.value = false, 2000); }

// 流式结束后高亮
watch(() => props.message.streaming, (s) => { if (!s) nextTick(highlight); });
</script>

<template>
  <div v-if="message.role === 'assistant' && message.streaming" class="message message--assistant">
    <div class="message__avatar"><span>🤖</span></div>
    <div class="message__body">
      <div class="message__role">道生一</div>
      <!-- 直接绑定 store 的 streaming ref，渲染最快 -->
      <div v-if="chatStore.streamingReasoning" class="msg-reason">
        <div class="reason-head" @click="showReasoning = !showReasoning">
          <span class="reason-arrow">{{ showReasoning ? '▾' : '▸' }}</span>
          <span class="reason-label">🧠 深度思考</span>
          <span v-if="!chatStore.streamingContent" class="reason-badge">进行中</span>
        </div>
        <div v-show="showReasoning" class="reason-body">{{ chatStore.streamingReasoning }}</div>
      </div>
      <div v-if="chatStore.streamingContent" class="message__content" style="white-space:pre-wrap">{{ chatStore.streamingContent }}</div>
      <div v-else-if="!chatStore.streamingReasoning" class="message__thinking">
        <span class="thinking-dot">●</span><span class="thinking-dot">●</span><span class="thinking-dot">●</span>
        <span class="thinking-text">思考中...</span>
      </div>
      <div class="message__cursor"></div>
    </div>
  </div>

  <div v-else class="message" :class="`message--${message.role}`">
    <div class="message__avatar"><span v-if="message.role === 'user'">👤</span><span v-else>🤖</span></div>
    <div class="message__body">
      <div class="message__role">{{ message.role === "user" ? "你" : "道生一" }}</div>

      <div v-if="message.images?.length" class="message__images">
        <div v-for="img in message.images" :key="img.id" class="message__image-item" @click="previewImage = img">
          <img :src="img.base64" :alt="img.fileName || '图片'" />
        </div>
      </div>

      <div v-if="message.reasoning_content" class="msg-reason">
        <div class="reason-head" @click="showReasoning = !showReasoning">
          <span class="reason-arrow">{{ showReasoning ? '▾' : '▸' }}</span><span class="reason-label">🧠 深度思考</span>
        </div>
        <div v-show="showReasoning" class="reason-body">{{ message.reasoning_content }}</div>
      </div>

      <div v-if="message.content" ref="contentRef" class="message__content markdown-body" v-html="md(message.content)"></div>

      <div class="message__time">
        {{ new Date(message.timestamp).toLocaleTimeString("zh-CN") }}
        <span v-if="message.role === 'assistant' && message.duration" class="msg-meta">· {{ message.duration }}s</span>
        <span v-if="message.role === 'assistant' && message.tokens" class="msg-meta">· {{ message.tokens }} tokens</span>
      </div>

      <div v-if="message.role === 'assistant' && message.content" class="msg-actions">
        <button class="msg-act-btn" @click="copyAll">{{ copied ? '✓ 已复制' : '📋 复制' }}</button>
        <button class="msg-act-btn" @click="chatStore.retryLast()">🔄 重试</button>
      </div>
    </div>
  </div>

  <div v-if="previewImage" class="image-preview-overlay" @click="previewImage = null">
    <img :src="previewImage.base64" class="image-preview__img" @click.stop />
    <button class="image-preview__close" @click="previewImage = null">✕</button>
  </div>
</template>

<style scoped>
.message { display: flex; gap: 14px; padding: 20px 24px; animation: fadeSlideIn .3s; }
.message--user { background: var(--bg-user-bubble); }
.message--assistant { background: var(--bg-assistant-bubble); }
.message__avatar { flex-shrink: 0; width: 38px; height: 38px; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: center; font-size: 18px; color: #fff; background: var(--avatar-ai); box-shadow: var(--shadow-sm); }
.message--user .message__avatar { background: var(--avatar-user); }
.message__body { flex: 1; min-width: 0; }
.message__role { font-weight: 650; font-size: 13px; color: var(--text-secondary); margin-bottom: 8px; }
.message__images { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
.message__image-item { width: 140px; height: 140px; border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--border-color); cursor: pointer; transition: all .2s; box-shadow: var(--shadow-sm); }
.message__image-item:hover { transform: scale(1.04); }
.message__image-item img { width: 100%; height: 100%; object-fit: cover; }
.message__content { font-size: 14px; line-height: 1.7; color: var(--text-primary); word-break: break-word; }
.message__cursor { display: inline-block; width: 8px; height: 18px; background: var(--accent-color); animation: blink 1s step-end infinite; vertical-align: text-bottom; margin-left: 3px; border-radius: 2px; }
.message__time { font-size: 11px; color: var(--text-muted); margin-top: 10px; }
.msg-meta { color: var(--text-muted); }
.msg-actions { display: flex; gap: 6px; margin-top: 8px; }
.msg-act-btn { padding: 4px 12px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-secondary); color: var(--text-secondary); font-size: 11px; font-weight: 500; cursor: pointer; }
.msg-act-btn:hover { border-color: var(--accent-color); color: var(--accent-color); }
.message__thinking { display: flex; align-items: center; gap: 5px; padding: 6px 0; }
.thinking-dot { font-size: 8px; color: var(--text-muted); animation: dotPulse 1.4s infinite; }
.thinking-dot:nth-child(1) { animation-delay: 0s; } .thinking-dot:nth-child(2) { animation-delay: .2s; } .thinking-dot:nth-child(3) { animation-delay: .4s; }
.thinking-text { font-size: 13px; color: var(--text-muted); margin-left: 4px; }
@keyframes dotPulse { 0%,80%,100% { opacity: .2; transform: scale(.8); } 40% { opacity: 1; transform: scale(1.3); color: var(--accent-color); } }
.msg-reason { margin-bottom: 10px; border: 1px solid var(--border-color); border-radius: var(--radius-md); overflow: hidden; }
.reason-head { display: flex; align-items: center; gap: 8px; padding: 8px 14px; background: var(--bg-secondary); cursor: pointer; }
.reason-head:hover { background: var(--bg-hover); }
.reason-arrow { font-size: 10px; color: var(--text-muted); }
.reason-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.reason-badge { font-size: 10px; padding: 2px 8px; border-radius: 10px; background: var(--accent-bg); color: var(--accent-color); font-weight: 600; animation: pulse 2s infinite; }
.reason-body { padding: 10px 14px; font-size: 13px; color: var(--text-muted); line-height: 1.6; border-top: 1px solid var(--border-color); max-height: 300px; overflow-y: auto; white-space: pre-wrap; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .6; } }
.image-preview-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.85); display: flex; align-items: center; justify-content: center; z-index: 200; cursor: pointer; animation: fadeIn .2s; }
.image-preview__img { max-width: 90vw; max-height: 90vh; border-radius: var(--radius-lg); cursor: default; }
.image-preview__close { position: fixed; top: 20px; right: 20px; width: 40px; height: 40px; border: none; border-radius: 50%; background: rgba(255,255,255,.12); color: #fff; font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
:deep(.code-copy-btn) { position: absolute; top: 8px; right: 8px; padding: 3px 10px; border: 1px solid rgba(255,255,255,.2); border-radius: 5px; background: rgba(255,255,255,.08); color: rgba(255,255,255,.6); font-size: 11px; cursor: pointer; transition: all .15s; z-index: 1; }
:deep(.code-copy-btn:hover) { background: rgba(255,255,255,.15); color: #fff; }
@keyframes fadeSlideIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes blink { 50% { opacity: 0; } }
</style>
