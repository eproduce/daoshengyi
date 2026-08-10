<script setup lang="ts">
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

const emit = defineEmits<{ sendPage: [url: string, title: string, text: string] }>();

const url = ref("");
const loading = ref(false);
const result = ref<{ title: string; text: string; url: string } | null>(null);
const error = ref("");
const history = ref<string[]>([]);

async function doFetch() {
  let u = url.value.trim();
  if (!u) return;
  if (!u.startsWith("http")) u = "https://" + u;
  url.value = u;

  loading.value = true;
  error.value = "";
  result.value = null;

  try {
    const data = await invoke<{ title: string; text: string; url: string }>("fetch_page", { url: u });
    result.value = data;
    if (!history.value.includes(u)) history.value.unshift(u);
    if (history.value.length > 20) history.value.pop();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  }
  loading.value = false;
}

function sendToChat() {
  if (!result.value) return;
  emit("sendPage", result.value.url, result.value.title, result.value.text);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") doFetch();
}
</script>

<template>
  <div class="browser-panel">
    <div class="bp-bar">
      <input
        v-model="url"
        class="bp-url"
        placeholder="输入网址，Enter 抓取…"
        @keydown="onKeydown"
      />
      <button class="bp-btn" :disabled="loading" @click="doFetch">
        {{ loading ? "加载中…" : "抓取" }}
      </button>
    </div>

    <div v-if="error" class="bp-error">{{ error }}</div>

    <div v-if="result" class="bp-result">
      <div class="bp-title">{{ result.title || result.url }}</div>
      <div class="bp-text">{{ result.text }}</div>
      <div class="bp-acts">
        <button class="bp-btn bp-btn-send" @click="sendToChat">📤 发送到对话</button>
        <span class="bp-info">{{ result.text.length }} 字</span>
      </div>
    </div>

    <div v-if="history.length && !result" class="bp-history">
      <div class="bp-history-title">最近</div>
      <div v-for="h in history" :key="h" class="bp-history-item" @click="url = h; doFetch()">
        {{ h }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.browser-panel { height: 100%; display: flex; flex-direction: column; padding: 12px; gap: 10px; overflow-y: auto; }
.bp-bar { display: flex; gap: 6px; }
.bp-url { flex: 1; padding: 8px 12px; border: 1px solid #333; border-radius: 8px; background: #0d0d1a; color: #ddd; font-size: 13px; font-family: inherit; }
.bp-url:focus { outline: none; border-color: var(--accent-color); }
.bp-btn { padding: 8px 16px; border: none; border-radius: 8px; background: #4a9eff; color: #fff; font-size: 13px; cursor: pointer; white-space: nowrap; }
.bp-btn:disabled { opacity: .4; }
.bp-btn-send { background: #22c55e; margin-top: 8px; }
.bp-error { padding: 12px; background: #3a0d0d; border-radius: 8px; color: #f87171; font-size: 13px; }
.bp-result { flex: 1; overflow-y: auto; }
.bp-title { font-size: 15px; font-weight: 700; color: #eee; margin-bottom: 8px; word-break: break-all; }
.bp-text { font-size: 13px; color: #bbb; line-height: 1.7; white-space: pre-wrap; word-break: break-all; }
.bp-acts { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
.bp-info { font-size: 11px; color: #666; }
.bp-history { margin-top: 4px; }
.bp-history-title { font-size: 12px; color: #666; margin-bottom: 6px; }
.bp-history-item { font-size: 12px; color: #888; padding: 4px 0; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bp-history-item:hover { color: #aaa; }
</style>
