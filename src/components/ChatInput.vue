<script setup lang="ts">
import { ref, onMounted, nextTick, onUnmounted } from "vue";
import type { ImageAttachment, FileAttachment, ApiProfile } from "@/types";
import { v4 as uuidv4 } from "@/stores/uuid";
import { useChatStore } from "@/stores/chat";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import SkillManager from "./SkillManager.vue";
import { FileText, Settings } from "lucide-vue-next";

const chatStore = useChatStore();

const emit = defineEmits<{
  send: [text: string, images: ImageAttachment[], files: FileAttachment[]];
  openSettings: [];
}>();

const inputText = ref("");
const attachedImages = ref<ImageAttachment[]>([]);
const attachedFiles = ref<FileAttachment[]>([]);
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
  // 文件内容作为附件上下文传入（注入提示词），不直接拼进消息文本
  emit("send", text, [...attachedImages.value], [...attachedFiles.value]);
  inputText.value = "";
  attachedImages.value = [];
  attachedFiles.value = [];
  if (textareaRef.value) textareaRef.value.style.height = "auto";
}

function handleKeydown(e: KeyboardEvent) {
  if (slashOpen.value && slashFiltered.value.length) {
    if (e.key === "Enter") { e.preventDefault(); commitSlash(); return; }
    if (e.key === "Tab") { e.preventDefault(); slashActive.value = (slashActive.value + 1) % slashFiltered.value.length; return; }
    if (e.key === "ArrowDown") { e.preventDefault(); slashActive.value = Math.min(slashActive.value + 1, slashFiltered.value.length - 1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); slashActive.value = Math.max(slashActive.value - 1, 0); return; }
    if (e.key === "Escape") { slashOpen.value = false; return; }
  } else if (e.key === "Escape") {
    slashOpen.value = false;
  }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
}

function canSend(): boolean {
  return inputText.value.trim().length > 0 || attachedImages.value.length > 0 || attachedFiles.value.length > 0;
}

// --- Slash 命令面板（输入 / 弹出命令，借鉴 Hermes composer 交互） ---
const SLASH_COMMANDS = [
  { name: "/run", args: "<命令>", desc: "执行终端命令" },
  { name: "/read", args: "<路径>", desc: "读取本地文件" },
  { name: "/new", args: "", desc: "新建对话" },
  { name: "/clear", args: "", desc: "清空当前对话" },
  { name: "/help", args: "", desc: "查看可用命令" },
];
const slashOpen = ref(false);
const slashActive = ref(0);
const slashFiltered = ref(SLASH_COMMANDS);

/// 当前光标所在的词（用于识别 `/` 开头的命令输入）
function currentWord(): { start: number; word: string } | null {
  const ta = textareaRef.value;
  if (!ta) return null;
  const selStart = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, selStart);
  const m = before.match(/(\S*)$/);
  if (!m) return null;
  return { start: selStart - m[1].length, word: m[1] };
}

function updateSlash() {
  const w = currentWord();
  if (w && w.word.startsWith("/")) {
    const q = w.word.slice(1).toLowerCase();
    slashFiltered.value = SLASH_COMMANDS.filter((c) => c.name.slice(1).startsWith(q));
    slashActive.value = 0;
    slashOpen.value = slashFiltered.value.length > 0;
  } else {
    slashOpen.value = false;
  }
}

function commitSlash() {
  const c = slashFiltered.value[slashActive.value];
  const w = currentWord();
  const ta = textareaRef.value;
  if (!c || !w || !ta) { slashOpen.value = false; return; }
  const selStart = ta.selectionStart ?? ta.value.length;
  const prefix = `${c.name}${c.args ? " " : ""}`;
  const next = ta.value.slice(0, w.start) + prefix + ta.value.slice(selStart);
  inputText.value = next;
  slashOpen.value = false;
  requestAnimationFrame(() => {
    ta.focus();
    const pos = w.start + prefix.length;
    ta.setSelectionRange(pos, pos);
  });
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

// --- 剪贴板粘贴（图片 / PDF 走统一 Rust 处理） ---
function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    const type = items[i].type;
    const file = items[i].getAsFile();
    if (file && (type.startsWith("image/") || /\.pdf$/i.test(file.name))) {
      e.preventDefault();
      processFile(file);
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

// 附件统一入口：拖拽/粘贴/文件选择都先经 Rust 保存临时文件 + read_attachment 处理，
// 与「附件按钮」走同一条 Rust 路径（图片转 base64 / PDF 提取文本 / 文本读取），
// PDF 额外记录磁盘 path 供分段浏览工具使用。
function processFile(file: File) {
  if (file.size > 20 * 1024 * 1024) { alert("附件不能超过 20MB"); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const dataUrl = reader.result as string;
      const b64 = dataUrl.split(",")[1] || dataUrl;
      const path = await invoke<string>("save_temp_attachment", { data: b64, name: file.name });
      const res = await invoke<{ kind: string; mime: string; content: string }>("read_attachment", { path });
      if (res.kind === "image") {
        attachedImages.value.push({
          id: uuidv4(), base64: `data:${res.mime};base64,${res.content}`,
          mimeType: res.mime, fileName: file.name,
        });
      } else {
        const isPdf = res.mime === "application/pdf" || /\.pdf$/i.test(file.name);
        attachedFiles.value.push({
          id: uuidv4(), name: file.name, content: res.content, mimeType: res.mime,
          path: isPdf ? path : undefined,
        });
      }
    } catch (e) {
      alert(`附件处理失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  reader.readAsDataURL(file);
}

function removeImage(id: string) { attachedImages.value = attachedImages.value.filter((i) => i.id !== id); }

function removeFile(id: string) { attachedFiles.value = attachedFiles.value.filter((f) => f.id !== id); }

function isTauri(): boolean {
  return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

/// 选择附件：桌面环境用 Tauri 原生对话框（支持 macOS 照片库、PDF 等），
/// 浏览器预览环境回退到文件选择器。
async function triggerAttach() {
  if (isTauri()) {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          { name: "图片", extensions: ["png","jpg","jpeg","gif","webp","bmp","svg","heic"] },
          { name: "文档", extensions: ["pdf","md","txt","json","py","js","ts","rs","toml","yaml","yml","xml","csv","log","html","css","sh","rb","go","java","c","cpp","h","hpp"] },
          { name: "所有文件", extensions: ["*"] },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      for (const p of paths) {
        try {
          const res = await invoke<{ kind: string; mime: string; content: string }>("read_attachment", { path: p });
          const name = p.split("/").pop() || p;
          if (res.kind === "image") {
            // 图片大小检查（base64 长度 ≈ 原字节 * 4/3）
            const approxBytes = Math.floor(res.content.length * 3 / 4);
            if (approxBytes > 20 * 1024 * 1024) {
              alert(`图片「${name}」超过 20MB，无法上传`);
              continue;
            }
            attachedImages.value.push({
              id: uuidv4(), base64: `data:${res.mime};base64,${res.content}`,
              mimeType: res.mime, fileName: name,
            });
          } else {
            const isPdf = res.mime === "application/pdf" || /\.pdf$/i.test(name);
            attachedFiles.value.push({
              id: uuidv4(), name, content: res.content, mimeType: res.mime,
              // PDF 记录磁盘路径，供 pdf_read 分段浏览工具使用
              path: isPdf ? p : undefined,
            });
          }
        } catch (e) {
          alert(`读取附件失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/cancelled|aborted|取消/i.test(msg)) return;
      alert(`选择文件失败: ${msg}`);
    }
    return;
  }
  attachInputRef.value?.click();
}

/// Tauri 原生拖拽：直接拿磁盘路径走统一 read_attachment（免 base64 中转，PDF 也有 path）
async function handleDroppedPath(path: string) {
  try {
    const res = await invoke<{ kind: string; mime: string; content: string }>("read_attachment", { path });
    const name = path.split("/").pop() || path;
    if (res.kind === "image") {
      attachedImages.value.push({
        id: uuidv4(), base64: `data:${res.mime};base64,${res.content}`,
        mimeType: res.mime, fileName: name,
      });
    } else {
      const isPdf = res.mime === "application/pdf" || /\.pdf$/i.test(name);
      attachedFiles.value.push({
        id: uuidv4(), name, content: res.content, mimeType: res.mime,
        path: isPdf ? path : undefined,
      });
    }
  } catch (e) {
    alert(`附件处理失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- 拖拽：Tauri 用原生 file-drop 事件拿磁盘路径；浏览器预览回退 HTML5 ---
let unlistenDrag: (() => void) | undefined;
async function setupNativeDragDrop() {
  if (!isTauri()) return;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    unlistenDrag = await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        for (const p of event.payload.paths) void handleDroppedPath(p);
      }
    });
  } catch (e) {
    console.warn("[道生一] 原生拖拽监听失败，回退 HTML5:", e);
  }
}
function onDragOver(e: DragEvent) { e.preventDefault(); }
function onDrop(e: DragEvent) {
  e.preventDefault();
  if (!e.dataTransfer?.files?.length) return;
  for (let i = 0; i < e.dataTransfer.files.length; i++) {
    processFile(e.dataTransfer.files[i]);
  }
}

onMounted(async () => {
  nextTick(() => textareaRef.value?.focus());
  document.addEventListener("click", onDocClick);
  await setupNativeDragDrop();
});
onUnmounted(() => {
  document.removeEventListener("click", onDocClick);
  unlistenDrag?.();
});

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
        <span class="ci-file-icon"><FileText :size="15" /></span>
        <span class="ci-file-name">{{ f.name }}</span>
        <button class="ci-attach-x" title="移除" @click="removeFile(f.id)">✕</button>
      </div>
    </div>

    <!-- 输入行 -->
    <div class="ci-wrap">
      <textarea ref="textareaRef" v-model="inputText" class="ci-text"
        :placeholder="placeholder || '输入消息，Enter 发送，Shift+Enter 换行；输入 / 弹出命令'"
        :disabled="disabled" rows="1"
        @input="autoResize; updateSlash()" @keydown="handleKeydown" @keyup="updateSlash"
        @click="updateSlash" @paste="handlePaste"></textarea>
      <!-- Slash 命令面板（输入 / 弹出） -->
      <div v-if="slashOpen && slashFiltered.length" class="ci-slash">
        <div class="ci-slash-head">命令 <span class="ci-slash-hint">Enter 执行 · Tab 选择 · Esc 关闭</span></div>
        <div
          v-for="(c, i) in slashFiltered" :key="c.name"
          class="ci-slash-item" :class="{ on: i === slashActive }"
          @mousedown.prevent="slashActive = i; commitSlash()"
        >
          <span class="ci-slash-name">{{ c.name }}<span v-if="c.args" class="ci-slash-args"> {{ c.args }}</span></span>
          <span class="ci-slash-desc">{{ c.desc }}</span>
        </div>
      </div>
      <button v-if="disabled" class="ci-send ci-stop" title="停止生成" @click="chatStore.stopStreaming()">⏹</button>
      <button v-else class="ci-send" :disabled="!canSend()" @click="handleSend">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
        </svg>
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
            <div class="ci-drop-foot" @click="emit('openSettings'); showModelDropdown = false"><Settings :size="14" /> 管理 API 配置</div>
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
.ci-wrap { position: relative; display: flex; gap: 8px; align-items: flex-end; background: var(--bg-secondary); border: 1.5px solid transparent; border-radius: 10px; padding: 6px 10px; transition: border-color .2s, box-shadow .2s; }
.ci-wrap:focus-within { border-color: var(--accent-color); box-shadow: 0 0 0 3px rgba(99,102,241,.08); }

.ci-text { flex: 1; border: none; outline: none; resize: none; background: transparent; color: var(--text-primary); font-size: 14px; line-height: 1.6; font-family: inherit; max-height: 160px; min-height: 44px; }
.ci-text::placeholder { color: var(--text-muted); }

.ci-send { flex-shrink: 0; width: 32px; height: 32px; border: none; border-radius: 8px; background: var(--accent-color); color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all .15s; }
.ci-send:disabled { opacity: .3; cursor: not-allowed; }
.ci-send:not(:disabled):hover { background: var(--accent-hover); }
.ci-stop { background: #ef4444; font-size: 15px; }
.ci-stop:hover { background: #dc2626; }

/* Slash 命令面板 */
.ci-slash {
  position: absolute; left: 0; right: 0; bottom: calc(100% + 8px); z-index: 30;
  background: var(--bg-elevated); border: 1px solid var(--border-color);
  border-radius: 10px; box-shadow: var(--shadow-md); overflow: hidden;
}
.ci-slash-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 12px; font-size: 11px; color: var(--text-muted);
  border-bottom: 1px solid var(--border-color);
}
.ci-slash-hint { font-size: 10px; opacity: .8; }
.ci-slash-item {
  display: flex; justify-content: space-between; align-items: center; gap: 10px;
  padding: 7px 12px; cursor: pointer; font-size: 12px; color: var(--text-primary);
}
.ci-slash-item:hover { background: var(--bg-hover); }
.ci-slash-item.on { background: color-mix(in srgb, var(--accent-color) 14%, transparent); }
.ci-slash-name { font-weight: 600; white-space: nowrap; }
.ci-slash-args { font-weight: 400; color: var(--text-muted); font-size: 11px; }
.ci-slash-desc { color: var(--text-muted); font-size: 11px; }

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
