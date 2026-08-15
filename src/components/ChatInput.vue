<script setup lang="ts">
import { ref, onMounted, nextTick, onUnmounted } from "vue";
import type { ImageAttachment, ApiProfile } from "@/types";
import { v4 as uuidv4 } from "@/stores/uuid";
import { useChatStore } from "@/stores/chat";
import SkillManager from "./SkillManager.vue";

const chatStore = useChatStore();

const emit = defineEmits<{
  send: [text: string, images: ImageAttachment[]];
  openSettings: [];
}>();

const inputText = ref("");
const attachedImages = ref<ImageAttachment[]>([]);
const attachedFiles = ref<{ id: string; name: string; content: string }[]>([]);
const textareaRef = ref<HTMLTextAreaElement>();
const attachInputRef = ref<HTMLInputElement>();
const showModelDropdown = ref(false);
const showReasoningDropdown = ref(false);
const modelDropdownRef = ref<HTMLDivElement>();
const modelBtnRef = ref<HTMLDivElement>();
const reasoningRef = ref<HTMLDivElement>();

defineProps<{ disabled: boolean; placeholder?: string }>();

function handleSend() {
  const text = inputText.value.trim();
  if (!text && attachedImages.value.length === 0 && attachedFiles.value.length === 0) return;
  // 将文件内容附加到消息文本
  let finalText = text;
  if (attachedFiles.value.length > 0) {
    const fileTexts = attachedFiles.value.map(f => `\n\n--- 文件: ${f.name} ---\n${f.content.slice(0, 8000)}`).join("");
    finalText = finalText + fileTexts;
  }
  emit("send", finalText, [...attachedImages.value]);
  inputText.value = "";
  attachedImages.value = [];
  attachedFiles.value = [];
  if (textareaRef.value) textareaRef.value.style.height = "auto";
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
}

function autoResize() {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

function toggleModelDropdown() { showModelDropdown.value = !showModelDropdown.value; }

// 某个配置下可选的模型列表（拉取到的 + 当前值兜底）
function profileModels(p: ApiProfile): string[] {
  const list = [...(p.availableModels?.length ? p.availableModels : [])];
  if (p.model && !list.includes(p.model)) list.unshift(p.model);
  return list;
}

// 切换到指定配置的指定模型
function selectModel(profileId: string, model: string) {
  if (chatStore.activeProfileId !== profileId) chatStore.switchProfile(profileId);
  chatStore.updateProfile(profileId, { model });
  showModelDropdown.value = false;
}

function toggleThinking() {
  const p = chatStore.activeProfile;
  if (p) {
    const newVal = !p.thinkingEnabled;
    chatStore.updateProfile(p.id, {
      thinkingEnabled: newVal,
      reasoningEffort: newVal ? p.reasoningEffort || "high" : "low",
    });
  }
}

function setReasoningEffort(level: "low" | "high" | "max") {
  const p = chatStore.activeProfile;
  if (p) {
    chatStore.updateProfile(p.id, { reasoningEffort: level, thinkingEnabled: true });
  }
  showReasoningDropdown.value = false;
}

function toggleWebSearch() {
  const p = chatStore.activeProfile;
  if (p) chatStore.updateProfile(p.id, { enableWebSearch: !p.enableWebSearch });
}

function onDocClick(e: MouseEvent) {
  const t = e.target as HTMLElement;
  if (showModelDropdown.value && modelDropdownRef.value && !modelDropdownRef.value.contains(t) &&
      modelBtnRef.value && !modelBtnRef.value.contains(t)) {
    showModelDropdown.value = false;
  }
  if (showReasoningDropdown.value && reasoningRef.value && !reasoningRef.value.contains(t)) {
    showReasoningDropdown.value = false;
  }
}

// --- 图片处理 ---
function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith("image/")) {
      e.preventDefault();
      const blob = items[i].getAsFile();
      if (blob) processImageFile(blob);
    }
  }
}

// --- 附件处理（图片与文件统一入口，按类型分流） ---
function handleAttachSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  if (!input.files) return;
  for (let i = 0; i < input.files.length; i++) processFile(input.files[i]);
  input.value = "";
}

function processFile(file: File) {
  if (file.type.startsWith("image/")) processImageFile(file);
  else processDocFile(file);
}

function processImageFile(file: File) {
  if (!file.type.startsWith("image/")) return;
  if (file.size > 20 * 1024 * 1024) { alert("图片不能超过 20MB"); return; }
  const reader = new FileReader();
  reader.onload = () => attachedImages.value.push({
    id: uuidv4(), base64: reader.result as string,
    mimeType: file.type, fileName: file.name,
  });
  reader.readAsDataURL(file);
}

function removeImage(id: string) { attachedImages.value = attachedImages.value.filter((i) => i.id !== id); }

// --- 文本文件处理 ---
function processDocFile(file: File) {
  if (file.size > 5 * 1024 * 1024) { alert("文件不能超过 5MB"); return; }
  const reader = new FileReader();
  reader.onload = () => attachedFiles.value.push({
    id: uuidv4(),
    name: file.name,
    content: reader.result as string,
  });
  reader.readAsText(file);
}

function removeFile(id: string) { attachedFiles.value = attachedFiles.value.filter((f) => f.id !== id); }
function triggerAttach() { attachInputRef.value?.click(); }

// --- 拖拽 ---
function onDragOver(e: DragEvent) { e.preventDefault(); }
function onDrop(e: DragEvent) {
  e.preventDefault();
  if (!e.dataTransfer?.files) return;
  for (let i = 0; i < e.dataTransfer.files.length; i++) {
    const f = e.dataTransfer.files[i];
    if (f.type.startsWith("image/")) processImageFile(f);
    else processDocFile(f);
  }
}

onMounted(() => {
  nextTick(() => textareaRef.value?.focus());
  document.addEventListener("click", onDocClick);
});
onUnmounted(() => document.removeEventListener("click", onDocClick));

const effortLabels: Record<string, string> = { low: "低", high: "高", max: "最大" };
</script>

<template>
  <div class="chat-input" @dragover="onDragOver" @drop="onDrop">
    <!-- 附件栏（图片与文件统一展示，参考 DeepSeek Chat 附件栏） -->
    <div v-if="attachedImages.length || attachedFiles.length" class="ci-attach">
      <div v-for="img in attachedImages" :key="img.id" class="ci-attach-item ci-attach-img">
        <img :src="img.base64" :alt="img.fileName || '图片'" />
        <button class="ci-attach-x" title="移除" @click="removeImage(img.id)">✕</button>
      </div>
      <div v-for="f in attachedFiles" :key="f.id" class="ci-attach-item ci-attach-file">
        <span class="ci-file-icon">📄</span>
        <span class="ci-file-name">{{ f.name }}</span>
        <button class="ci-attach-x" title="移除" @click="removeFile(f.id)">✕</button>
      </div>
    </div>

    <!-- 输入行 -->
    <div class="ci-wrap">
      <textarea ref="textareaRef" v-model="inputText" class="ci-text"
        :placeholder="placeholder || '输入消息，Enter 发送，Shift+Enter 换行...'"
        :disabled="disabled" rows="1"
        @input="autoResize" @keydown="handleKeydown" @paste="handlePaste"></textarea>
      <button class="ci-send" :disabled="disabled || (!inputText.trim() && !attachedImages.length && !attachedFiles.length)" @click="handleSend">
        <svg v-if="!disabled" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
        </svg>
        <span v-else class="spinner"></span>
      </button>
    </div>

    <!-- 工具栏 -->
    <div class="ci-bar">
      <div class="ci-bar-left">
        <!-- 模型选择 -->
        <div class="ci-tool-group">
          <div ref="modelBtnRef" class="ci-pill" @click="toggleModelDropdown">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            <span>{{ chatStore.activeProfile?.name }}</span>
            <span class="ci-pill-sub">{{ chatStore.activeProfile?.model }}</span>
          </div>
          <div v-if="showModelDropdown" ref="modelDropdownRef" class="ci-drop ci-drop-models">
            <div v-for="p in chatStore.profiles" :key="p.id" class="ci-drop-group">
              <div class="ci-drop-group-title">{{ p.name }}</div>
              <div
                v-for="m in profileModels(p)"
                :key="m"
                class="ci-drop-item"
                :class="{ on: p.id === chatStore.activeProfileId && m === p.model }"
                @click="selectModel(p.id, m)"
              >
                <span class="ci-drop-name">{{ m }}</span>
                <span v-if="p.id === chatStore.activeProfileId && m === p.model" class="ci-drop-check">✓</span>
              </div>
            </div>
            <div class="ci-drop-foot" @click="emit('openSettings'); showModelDropdown = false">⚙️ 管理 API 配置</div>
          </div>
        </div>

        <!-- 思考模式 -->
        <div class="ci-tool-group">
          <button v-if="!chatStore.activeProfile?.thinkingEnabled" class="ci-pill" @click="toggleThinking">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span>快速</span>
          </button>
          <button v-else class="ci-pill active ci-pill-think" @click.stop="showReasoningDropdown = !showReasoningDropdown">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span>思考 · {{ effortLabels[chatStore.activeProfile?.reasoningEffort || 'high'] }}</span>
            <svg class="ci-chev" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9"/></svg>
            <span class="ci-pill-close" @click.stop="toggleThinking" title="关闭思考模式">✕</span>
          </button>
          <div v-if="showReasoningDropdown" ref="reasoningRef" class="ci-drop ci-drop-sm" @click.stop>
            <div v-for="lv in (['low','high','max'] as const)" :key="lv" class="ci-drop-item"
              :class="{ on: chatStore.activeProfile?.reasoningEffort === lv }"
              @click="setReasoningEffort(lv)">
              {{ effortLabels[lv] }} {{ lv === 'low' ? '· 快速' : lv === 'high' ? '· 深度' : '· 极致' }}
            </div>
            <div class="ci-drop-foot" @click.stop="toggleThinking">关闭思考模式</div>
          </div>
        </div>

        <!-- 联网搜索 -->
        <button class="ci-pill" :class="{ active: chatStore.activeProfile?.enableWebSearch }" @click="toggleWebSearch">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <span>{{ chatStore.activeProfile?.enableWebSearch ? '联网' : '离线' }}</span>
        </button>

        <!-- 附件上传（图片与文件统一入口） -->
        <button class="ci-pill" @click="triggerAttach" title="上传图片或文件">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          <span>附件</span>
        </button>
        <input ref="attachInputRef" type="file" accept="image/*,.md,.txt,.json,.py,.js,.ts,.rs,.toml,.yaml,.yml,.xml,.csv,.log,.html,.css,.sh,.rb,.go,.java,.c,.cpp,.h,.hpp" multiple hidden @change="handleAttachSelect" />
      </div>

      <div class="ci-bar-right">
        <SkillManager />
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-input { padding: 12px 20px 14px; background: var(--bg-primary); }

/* 附件栏（图片缩略图 + 文件卡片，参考 DeepSeek Chat 附件栏） */
.ci-attach { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.ci-attach-item { position: relative; display: inline-flex; align-items: center; }
.ci-attach-img { width: 56px; height: 56px; border-radius: 8px; overflow: hidden; border: 1px solid var(--border-color); }
.ci-attach-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ci-attach-file { gap: 5px; padding: 6px 10px 6px 8px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; font-size: 11px; }
.ci-file-icon { font-size: 13px; }
.ci-file-name { color: var(--text-secondary); max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ci-attach-x { position: absolute; top: 2px; right: 2px; z-index: 1; width: 18px; height: 18px; border: none; border-radius: 50%; background: rgba(0,0,0,.6); color: #fff; font-size: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity .15s; }
.ci-attach-item:hover .ci-attach-x { opacity: 1; }

/* 输入行 */
.ci-wrap { display: flex; gap: 8px; align-items: flex-end; background: var(--bg-secondary); border: 1.5px solid transparent; border-radius: 10px; padding: 6px 10px; transition: border-color .2s, box-shadow .2s; }
.ci-wrap:focus-within { border-color: var(--accent-color); box-shadow: 0 0 0 3px rgba(99,102,241,.08); }

.ci-text { flex: 1; border: none; outline: none; resize: none; background: transparent; color: var(--text-primary); font-size: 13px; line-height: 1.5; font-family: inherit; max-height: 160px; min-height: 24px; }
.ci-text::placeholder { color: var(--text-muted); }

.ci-send { flex-shrink: 0; width: 32px; height: 32px; border: none; border-radius: 8px; background: var(--accent-color); color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all .15s; }
.ci-send:disabled { opacity: .3; cursor: not-allowed; }
.ci-send:not(:disabled):hover { background: var(--accent-hover); }

.spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid transparent; border-top-color: #fff; border-radius: 50%; animation: spin .6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* 工具栏 */
.ci-bar { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; gap: 8px; flex-wrap: wrap; }
.ci-bar-left { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }

.ci-tool-group { position: relative; display: flex; align-items: center; }

/* Pill 按钮 */
.ci-pill {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 10px; border: 1px solid var(--border-color); border-radius: 6px;
  background: var(--bg-secondary); color: var(--text-secondary);
  font-size: 11px; font-weight: 500; cursor: pointer;
  transition: all .15s; white-space: nowrap;
}
.ci-pill:hover { border-color: #555; color: var(--text-primary); }
.ci-pill.active { background: rgba(99,102,241,.12); border-color: var(--accent-color); color: var(--accent-color); }
.ci-pill-think { cursor: default; padding-right: 4px; gap: 6px; }
.ci-pill-think .ci-chev { margin-left: 2px; opacity: .6; }
.ci-pill-think:hover .ci-chev { opacity: 1; }
.ci-pill-close { background: none; border: none; color: inherit; opacity: .4; cursor: pointer; padding: 0 2px; font-size: 10px; line-height: 1; margin-left: 2px; border-radius: 3px; }
.ci-pill-close:hover { opacity: .8; background: rgba(255,255,255,.1); }
.ci-pill-sub { color: var(--text-muted); font-size: 10px; font-family: "SF Mono","Fira Code",monospace; opacity: .8; }

/* 下拉 */
.ci-drop { position: absolute; bottom: calc(100% + 6px); left: 0; min-width: 200px; background: #1e1e32; border: 1px solid #333; border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,.4); z-index: 50; animation: popUp .15s ease; overflow: hidden; }
.ci-drop-sm { min-width: 100px; }
.ci-drop-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; font-size: 12px; color: #ccc; transition: background .1s; }
.ci-drop-item:hover { background: #252540; }
.ci-drop-item.on { background: rgba(99,102,241,.1); color: #a5b4fc; }
.ci-drop-name { font-weight: 600; }
.ci-drop-model { color: var(--text-muted); font-size: 10px; font-family: "SF Mono","Fira Code",monospace; }
.ci-drop-check { color: var(--accent-color); font-weight: 700; margin-left: auto; font-size: 11px; }
.ci-drop-foot { padding: 7px 12px; border-top: 1px solid #333; font-size: 11px; color: #888; cursor: pointer; transition: background .1s; }
.ci-drop-foot:hover { background: #252540; }

/* 模型分组下拉 */
.ci-drop-models { min-width: 240px; max-height: 360px; overflow-y: auto; }
.ci-drop-group-title {
  padding: 6px 12px 4px; font-size: 10px; font-weight: 700;
  color: #666; text-transform: uppercase; letter-spacing: .05em;
}
.ci-drop-group:first-child .ci-drop-group-title { padding-top: 8px; }
.ci-drop-group + .ci-drop-group { border-top: 1px solid #26263c; margin-top: 2px; padding-top: 2px; }

.ci-bar-right { display: flex; align-items: center; }

@keyframes popUp { from { opacity: 0; transform: translateY(3px) scale(.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
</style>
