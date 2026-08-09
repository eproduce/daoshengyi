<script setup lang="ts">
import { ref, onMounted, nextTick, onUnmounted } from "vue";
import type { ImageAttachment } from "@/types";
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
const textareaRef = ref<HTMLTextAreaElement>();
const fileInputRef = ref<HTMLInputElement>();
const showModelDropdown = ref(false);
const modelDropdownRef = ref<HTMLDivElement>();
const modelBtnRef = ref<HTMLDivElement>();

defineProps<{ disabled: boolean; placeholder?: string }>();

function handleSend() {
  const text = inputText.value.trim();
  if (!text && attachedImages.value.length === 0) return;
  emit("send", text, [...attachedImages.value]);
  inputText.value = "";
  attachedImages.value = [];
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

function selectProfile(id: string) { chatStore.switchProfile(id); showModelDropdown.value = false; }
function toggleModelDropdown() { showModelDropdown.value = !showModelDropdown.value; }

function toggleThinking() {
  const p = chatStore.activeProfile;
  if (p) chatStore.updateProfile(p.id, { thinkingEnabled: !p.thinkingEnabled });
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
}

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

function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  if (!input.files) return;
  for (let i = 0; i < input.files.length; i++) processImageFile(input.files[i]);
  input.value = "";
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
function triggerFileSelect() { fileInputRef.value?.click(); }

// 拖拽图片
function onDragOver(e: DragEvent) { e.preventDefault(); }
function onDrop(e: DragEvent) {
  e.preventDefault();
  if (!e.dataTransfer?.files) return;
  for (let i = 0; i < e.dataTransfer.files.length; i++) processImageFile(e.dataTransfer.files[i]);
}

onMounted(() => {
  nextTick(() => textareaRef.value?.focus());
  document.addEventListener("click", onDocClick);
});
onUnmounted(() => document.removeEventListener("click", onDocClick));
</script>

<template>
  <div class="chat-input" @dragover="onDragOver" @drop="onDrop">
    <div v-if="attachedImages.length" class="ci-imgs">
      <div v-for="img in attachedImages" :key="img.id" class="ci-img">
        <img :src="img.base64" :alt="img.fileName || '图片'" />
        <button class="ci-img-x" @click="removeImage(img.id)">✕</button>
      </div>
    </div>

    <div class="ci-wrap">
      <button class="ci-add" title="添加图片" :disabled="disabled" @click="triggerFileSelect">🖼</button>
      <input ref="fileInputRef" type="file" accept="image/*" multiple hidden @change="handleFileSelect" />
      <textarea ref="textareaRef" v-model="inputText" class="ci-text"
        :placeholder="placeholder || '输入消息，Enter 发送，Ctrl+V 粘贴图片...'"
        :disabled="disabled" rows="1"
        @input="autoResize" @keydown="handleKeydown" @paste="handlePaste"></textarea>
      <button class="ci-send" :disabled="disabled || (!inputText.trim() && !attachedImages.length)" @click="handleSend">
        <span v-if="!disabled">发送</span><span v-else class="spinner"></span>
      </button>
    </div>

    <div class="ci-bar">
      <div class="ci-model">
        <div ref="modelBtnRef" class="ci-model-btn" @click="toggleModelDropdown">
          <span class="ci-model-provider">{{ chatStore.activeProfile?.name }}</span>
          <span class="ci-model-name">{{ chatStore.activeProfile?.model }}</span>
          <span class="ci-model-arrow">▾</span>
        </div>
        <div v-if="showModelDropdown" ref="modelDropdownRef" class="ci-model-drop">
          <div v-for="p in chatStore.profiles" :key="p.id" class="ci-model-item"
            :class="{ 'ci-model-item--on': p.id === chatStore.activeProfileId }"
            @click="selectProfile(p.id)">
            <span class="ci-model-item-name">{{ p.name }}</span>
            <span class="ci-model-item-model">{{ p.model }}</span>
            <span v-if="p.id === chatStore.activeProfileId" class="ci-model-item-check">✓</span>
          </div>
          <div class="ci-model-foot" @click="emit('openSettings'); showModelDropdown = false">⚙️ 管理</div>
        </div>
      </div>

      <button class="ci-think" :class="{ 'ci-think--on': chatStore.activeProfile?.thinkingEnabled }" @click="toggleThinking">
        🧠 {{ chatStore.activeProfile?.thinkingEnabled ? '深度思考' : '快速' }}
      </button>
      <button class="ci-think" :class="{ 'ci-think--on': chatStore.activeProfile?.enableWebSearch }" @click="toggleWebSearch">
        🌐 {{ chatStore.activeProfile?.enableWebSearch ? '联网' : '离线' }}
      </button>
      <SkillManager />
    </div>
  </div>
</template>

<style scoped>
.chat-input { padding: 12px 20px 14px; background: var(--bg-primary); }

.ci-imgs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.ci-img { position: relative; width: 64px; height: 64px; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border-color); }
.ci-img img { width: 100%; height: 100%; object-fit: cover; }
.ci-img-x { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; border: none; border-radius: 50%; background: rgba(0,0,0,.5); color: #fff; font-size: 9px; cursor: pointer; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity .15s; }
.ci-img:hover .ci-img-x { opacity: 1; }

.ci-wrap { display: flex; gap: 8px; align-items: flex-end; background: var(--bg-secondary); border: 1.5px solid transparent; border-radius: var(--radius-md); padding: 6px 10px; transition: border-color .2s, box-shadow .2s; }
.ci-wrap:focus-within { border-color: var(--accent-color); box-shadow: 0 0 0 3px rgba(99,102,241,.08); }

.ci-add { flex-shrink: 0; width: 30px; height: 30px; border: none; border-radius: 6px; background: transparent; color: var(--text-muted); font-size: 15px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all .15s; }
.ci-add:hover:not(:disabled) { color: var(--accent-color); }
.ci-add:disabled { opacity: .3; cursor: not-allowed; }

.ci-text { flex: 1; border: none; outline: none; resize: none; background: transparent; color: var(--text-primary); font-size: 13px; line-height: 1.5; font-family: inherit; max-height: 160px; min-height: 24px; }
.ci-text::placeholder { color: var(--text-muted); }

.ci-send { flex-shrink: 0; padding: 5px 14px; border: none; border-radius: 6px; background: var(--accent-color); color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; transition: all .15s; }
.ci-send:disabled { opacity: .35; cursor: not-allowed; }
.ci-send:not(:disabled):hover { background: var(--accent-hover); }

.spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid transparent; border-top-color: #fff; border-radius: 50%; animation: spin .6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.ci-bar { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; gap: 8px; }

.ci-model { position: relative; }
.ci-model-btn { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 6px; background: var(--bg-secondary); border: 1px solid var(--border-color); cursor: pointer; font-size: 11px; transition: all .15s; }
.ci-model-btn:hover { border-color: var(--accent-color); }
.ci-model-provider { font-weight: 600; color: var(--text-primary); }
.ci-model-name { color: var(--text-muted); font-size: 10px; font-family: "SF Mono","Fira Code",monospace; }
.ci-model-arrow { color: var(--text-muted); font-size: 8px; }

.ci-model-drop { position: absolute; bottom: calc(100% + 4px); left: 0; min-width: 220px; background: var(--bg-elevated); border: 1px solid var(--border-color); border-radius: var(--radius-md); box-shadow: var(--shadow-lg); z-index: 50; animation: popUp .15s ease; overflow: hidden; }
.ci-model-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; font-size: 12px; transition: background .1s; }
.ci-model-item:hover { background: var(--bg-hover); }
.ci-model-item--on { background: var(--bg-active); }
.ci-model-item-name { font-weight: 600; color: var(--text-primary); }
.ci-model-item-model { color: var(--text-muted); font-size: 10px; font-family: "SF Mono","Fira Code",monospace; }
.ci-model-item-check { color: var(--accent-color); font-weight: 700; margin-left: auto; font-size: 11px; }
.ci-model-foot { padding: 6px 12px; border-top: 1px solid var(--border-color); font-size: 11px; color: var(--text-muted); cursor: pointer; transition: background .1s; }
.ci-model-foot:hover { background: var(--bg-hover); }

.ci-think { padding: 4px 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-secondary); color: var(--text-secondary); font-size: 11px; font-weight: 550; cursor: pointer; transition: all .15s; }
.ci-think:hover { border-color: var(--accent-color); }
.ci-think--on { background: var(--accent-bg); border-color: var(--accent-color); color: var(--accent-color); }

@keyframes popUp { from { opacity: 0; transform: translateY(3px) scale(.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
</style>
