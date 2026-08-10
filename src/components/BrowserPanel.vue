<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const emit = defineEmits<{ sendPage: [url: string, title: string, text: string] }>();

const url = ref("");
const loading = ref(false);
const extracting = ref(false);
const result = ref<{ title: string; text: string; url: string } | null>(null);
const error = ref("");
const history = ref<string[]>([]);
const browserOpen = ref(false);
let unlisten: UnlistenFn | null = null;

onMounted(async () => {
  unlisten = await listen<{ title: string; text: string; url: string }>("browser-content", (e) => {
    result.value = {
      title: e.payload.title,
      url: e.payload.url,
      text: e.payload.text || "(页面内容为空)",
    };
    extracting.value = false;
  });
});

onUnmounted(() => { unlisten?.(); });

async function doOpen() {
  let u = url.value.trim();
  if (!u) return;
  if (!u.startsWith("http")) u = "https://" + u;
  url.value = u;

  loading.value = true;
  error.value = "";
  try {
    await invoke("open_browser", { url: u });
    browserOpen.value = true;
    if (!history.value.includes(u)) history.value.unshift(u);
    if (history.value.length > 20) history.value.pop();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  }
  loading.value = false;
}

async function doExtract() {
  extracting.value = true;
  error.value = "";
  result.value = null;
  try {
    await invoke("extract_browser_content");
    // 结果通过 browser-content 事件异步返回
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
    extracting.value = false;
  }
}

function sendToChat() {
  if (!result.value) return;
  const { url, title, text } = result.value;
  const msg = `📄 **${title || url}**\n${url}\n\n---\n${text}`;
  emit("sendPage", url, title, text);
  // Also put in chat input area by emitting to parent
  window.dispatchEvent(new CustomEvent("daoshengyi:sendPage", {
    detail: { msg, url, title, text }
  }));
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") doOpen();
}
</script>

<template>
  <div class="browser-panel">
    <div class="bp-bar">
      <input
        v-model="url"
        class="bp-url"
        placeholder="输入网址…"
        @keydown="onKeydown"
      />
      <button class="bp-btn" :disabled="loading" @click="doOpen">
        {{ loading ? "…" : "打开" }}
      </button>
    </div>

    <div v-if="browserOpen" class="bp-controls">
      <button class="bp-act" @click="doExtract" :disabled="extracting">
        {{ extracting ? "提取中…" : "📋 提取内容" }}
      </button>
      <span class="bp-hint">在浏览器窗口浏览后点击提取</span>
    </div>

    <div v-if="!browserOpen && !result" class="bp-empty">
      输入网址打开独立浏览器窗口，浏览后提取内容发送给 Agent 分析
    </div>

    <div v-if="error" class="bp-error">{{ error }}</div>

    <div v-if="result" class="bp-result">
      <div class="bp-title">{{ result.title || result.url }}</div>
      <div class="bp-url-display">{{ result.url }}</div>
      <div class="bp-text">{{ result.text }}</div>
      <button class="bp-send" @click="sendToChat">📤 发送到对话</button>
      <span class="bp-info">{{ result.text.length }} 字</span>
    </div>

    <div v-if="history.length" class="bp-history">
      <div class="bp-history-title">历史</div>
      <div v-for="h in history" :key="h" class="bp-history-item" @click="url = h; doOpen()">
        {{ h.replace("https://", "").replace("http://", "").slice(0, 50) }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.browser-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 12px;
  gap: 10px;
  overflow-y: auto;
  font-size: 13px;
  color: #ccc;
}
.bp-bar {
  display: flex;
  gap: 6px;
}
.bp-url {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid #333;
  border-radius: 8px;
  background: #0d0d1a;
  color: #ddd;
  font-size: 13px;
  font-family: inherit;
}
.bp-url:focus { outline: none; border-color: var(--accent-color); }
.bp-btn {
  flex-shrink: 0;
  padding: 8px 14px;
  border: none;
  border-radius: 8px;
  background: #4a9eff;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  min-width: 48px;
}
.bp-btn:disabled { opacity: .4; cursor: not-allowed; }
.bp-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bp-act {
  padding: 6px 12px;
  border: 1px solid #444;
  border-radius: 6px;
  background: #1a1a2e;
  color: #ccc;
  font-size: 12px;
  cursor: pointer;
}
.bp-act:hover:not(:disabled) { border-color: #888; }
.bp-act:disabled { opacity: .4; }
.bp-hint { font-size: 11px; color: #666; }
.bp-empty {
  text-align: center;
  color: #555;
  padding: 32px 16px;
  font-size: 12px;
  line-height: 1.6;
}
.bp-error {
  padding: 10px;
  background: #3a0d0d;
  border-radius: 8px;
  color: #f87171;
  font-size: 12px;
  word-break: break-all;
}
.bp-result {
  border: 1px solid #252540;
  border-radius: 10px;
  padding: 12px;
  overflow-y: auto;
  max-height: 60vh;
}
.bp-title {
  font-size: 14px;
  font-weight: 700;
  color: #eee;
  margin-bottom: 4px;
  word-break: break-all;
}
.bp-url-display {
  font-size: 11px;
  color: #555;
  margin-bottom: 10px;
  word-break: break-all;
}
.bp-text {
  font-size: 12px;
  color: #aaa;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 40vh;
  overflow-y: auto;
}
.bp-send {
  display: block;
  width: 100%;
  margin-top: 10px;
  padding: 8px;
  border: none;
  border-radius: 8px;
  background: #22c55e;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}
.bp-send:hover { background: #16a34a; }
.bp-info {
  display: block;
  text-align: center;
  font-size: 11px;
  color: #555;
  margin-top: 4px;
}
.bp-history { margin-top: auto; padding-top: 6px; border-top: 1px solid #1a1a2e; }
.bp-history-title { font-size: 11px; color: #555; margin-bottom: 4px; }
.bp-history-item {
  font-size: 11px;
  color: #777;
  padding: 2px 0;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bp-history-item:hover { color: #aaa; }
</style>
