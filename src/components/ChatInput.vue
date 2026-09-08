<script setup lang="ts">
import { ref, computed, onMounted, nextTick, onUnmounted } from "vue";
import type { ImageAttachment, FileAttachment, ApiProfile } from "@/types";
import { v4 as uuidv4 } from "@/stores/uuid";
import { useChatStore } from "@/stores/chat";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import SkillManager from "./SkillManager.vue";
import { Settings } from "lucide-vue-next";
import { fileTypeIcon } from "@/utils/file-icons";
import { notify } from "@/utils/dialog";
import { estimateMessageTokens, modelContextWindowTokens } from "@/utils/tokens";
import { MODES } from "@/data/modes-catalog";
import { PERSONAS } from "@/data/personas-catalog";

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
// 输入法组合状态：拼音等 IME 在组词/上屏阶段按 Enter 是确认拼音，不得触发发送
const composing = ref(false);
// 最近一次 IME 组合结束时间戳（毫秒）。WebKit(WKWebView/Safari)下拼音候选按 Enter 确认时，
// keydown 常在 compositionend 之后才派发且无组合标记（isComposing=false/keyCode=13），无法直接识别，
// 只能靠「紧跟组合结束的极短时间窗内吞掉一次 Enter」来区分——该 Enter 实为输入法确认上屏，不是发送。
let lastImeEndAt = 0;
function onCompositionEnd() {
  composing.value = false;
  lastImeEndAt = Date.now();
}
const showModelDropdown = ref(false);
const showReasoningDropdown = ref(false);
const showModeDropdown = ref(false);
const modelDropdownRef = ref<HTMLDivElement>();
const modelBtnRef = ref<HTMLDivElement>();
const reasoningRef = ref<HTMLDivElement>();
const modeDropdownRef = ref<HTMLDivElement>();
// 当前 Agent 模式（§3.11：对话/任务/办公/研究/编码/速答）
const currentMode = computed(() => MODES.find((m) => m.id === chatStore.activeModeId) || MODES[0]);
// 角色/人设（原在顶栏右上，整合到底部输入工具栏、与「模式」相邻）
const showPersonaDropdown = ref(false);
const personaDropdownRef = ref<HTMLDivElement>();
const currentPersona = computed(
  () => PERSONAS.find((p) => p.id === chatStore.activePersonaId),
);
// 模式记忆（Phase B）：各模式使用频次（下拉显示「常用 ×N」）
const modeHist = computed(() => chatStore.readModeHist());

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
  // 输入法组合中（拼音候选/组词/上屏）按 Enter：仅确认输入法内容，不发送、不执行 slash。
  // 三重判定兼容不同内核：①composition 事件标记 ②KeyboardEvent.isComposing ③WebKit 传统 keyCode 229（IME 处理中的按键）。
  const imeEnter = composing.value || e.isComposing || e.keyCode === 229;
  if (slashOpen.value && slashFiltered.value.length) {
    if (e.key === "Enter" && !imeEnter) {
      e.preventDefault();
      commitSlash();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      slashActive.value = (slashActive.value + 1) % slashFiltered.value.length;
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      slashActive.value = Math.min(slashActive.value + 1, slashFiltered.value.length - 1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      slashActive.value = Math.max(slashActive.value - 1, 0);
      return;
    }
    if (e.key === "Escape") {
      slashOpen.value = false;
      return;
    }
  } else if (e.key === "Escape") {
    slashOpen.value = false;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    // 组合中(候选/预编辑)的 Enter：仅上屏，不发送
    if (imeEnter) return;
    // WebKit 候选确认 Enter 在 compositionend 后以无标记 keydown 到达 → 组合刚结束 200ms 内吞掉一次（只吞一次）
    if (lastImeEndAt !== 0 && Date.now() - lastImeEndAt < 200) {
      lastImeEndAt = 0;
      return;
    }
    handleSend();
  }
}

function canSend(): boolean {
  return (
    inputText.value.trim().length > 0 ||
    attachedImages.value.length > 0 ||
    attachedFiles.value.length > 0
  );
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
  // 仅当 `/` 开头的词位于**行首**（w.start === 0，即消息的开头第一个词）才触发命令面板：
  // 命令参数里可能含 `/`（如 `/run /Users/foo` 的路径、URL 等），这些不应再触发面板，
  // 否则用户无法正常输入含 `/` 的内容。面板只是辅助建议（可 Esc 关闭、可继续自由输入），
  // 不强制用户选择命令——非行首的 `/` 一律当作普通内容正常输入。
  if (w && w.word.startsWith("/") && w.start === 0) {
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
  if (!c || !w || !ta) {
    slashOpen.value = false;
    return;
  }
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

// 输入框 input 事件：若 WebView 未派发 compositionstart、但 input 携带 isComposing（预编辑中），同步置位 composing
function onInput(e: Event) {
  if ((e as InputEvent).isComposing) composing.value = true;
  autoResize();
  updateSlash();
}

function toggleModelDropdown() {
  showModelDropdown.value = !showModelDropdown.value;
}

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
  if (
    showModelDropdown.value &&
    modelDropdownRef.value &&
    !modelDropdownRef.value.contains(t) &&
    modelBtnRef.value &&
    !modelBtnRef.value.contains(t)
  ) {
    showModelDropdown.value = false;
  }
  if (showReasoningDropdown.value && reasoningRef.value && !reasoningRef.value.contains(t)) {
    showReasoningDropdown.value = false;
  }
  if (showModeDropdown.value && modeDropdownRef.value && !modeDropdownRef.value.contains(t)) {
    showModeDropdown.value = false;
  }
  if (
    showPersonaDropdown.value &&
    personaDropdownRef.value &&
    !personaDropdownRef.value.contains(t)
  ) {
    showPersonaDropdown.value = false;
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
  if (file.size > 20 * 1024 * 1024) {
    notify("附件不能超过 20MB");
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const dataUrl = reader.result as string;
      const b64 = dataUrl.split(",")[1] || dataUrl;
      const path = await invoke<string>("save_temp_attachment", { data: b64, name: file.name });
      const res = await invoke<{ kind: string; mime: string; content: string }>("read_attachment", {
        path,
      });
      if (res.kind === "image") {
        attachedImages.value.push({
          id: uuidv4(),
          base64: `data:${res.mime};base64,${res.content}`,
          mimeType: res.mime,
          fileName: file.name,
        });
      } else {
        const isPdf = res.mime === "application/pdf" || /\.pdf$/i.test(file.name);
        attachedFiles.value.push({
          id: uuidv4(),
          name: file.name,
          content: res.content,
          mimeType: res.mime,
          path: isPdf ? path : undefined,
        });
      }
    } catch (e) {
      notify(`附件处理失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  reader.readAsDataURL(file);
}

function removeImage(id: string) {
  attachedImages.value = attachedImages.value.filter((i) => i.id !== id);
}

function removeFile(id: string) {
  attachedFiles.value = attachedFiles.value.filter((f) => f.id !== id);
}

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
          { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic"] },
          {
            name: "文档",
            extensions: [
              "pdf",
              "md",
              "txt",
              "json",
              "py",
              "js",
              "ts",
              "rs",
              "toml",
              "yaml",
              "yml",
              "xml",
              "csv",
              "log",
              "html",
              "css",
              "sh",
              "rb",
              "go",
              "java",
              "c",
              "cpp",
              "h",
              "hpp",
            ],
          },
          { name: "所有文件", extensions: ["*"] },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      for (const p of paths) {
        try {
          const res = await invoke<{ kind: string; mime: string; content: string }>(
            "read_attachment",
            { path: p },
          );
          const name = p.split("/").pop() || p;
          if (res.kind === "image") {
            // 图片大小检查（base64 长度 ≈ 原字节 * 4/3）
            const approxBytes = Math.floor((res.content.length * 3) / 4);
            if (approxBytes > 20 * 1024 * 1024) {
              notify(`图片「${name}」超过 20MB，无法上传`);
              continue;
            }
            attachedImages.value.push({
              id: uuidv4(),
              base64: `data:${res.mime};base64,${res.content}`,
              mimeType: res.mime,
              fileName: name,
            });
          } else {
            const isPdf = res.mime === "application/pdf" || /\.pdf$/i.test(name);
            attachedFiles.value.push({
              id: uuidv4(),
              name,
              content: res.content,
              mimeType: res.mime,
              // PDF 记录磁盘路径，供 pdf_read 分段浏览工具使用
              path: isPdf ? p : undefined,
            });
          }
        } catch (e) {
          notify(`读取附件失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/cancelled|aborted|取消/i.test(msg)) return;
      notify(`选择文件失败: ${msg}`);
    }
    return;
  }
  attachInputRef.value?.click();
}

/// Tauri 原生拖拽：直接拿磁盘路径走统一 read_attachment（免 base64 中转，PDF 也有 path）
async function handleDroppedPath(path: string) {
  try {
    const res = await invoke<{ kind: string; mime: string; content: string }>("read_attachment", {
      path,
    });
    const name = path.split("/").pop() || path;
    if (res.kind === "image") {
      attachedImages.value.push({
        id: uuidv4(),
        base64: `data:${res.mime};base64,${res.content}`,
        mimeType: res.mime,
        fileName: name,
      });
    } else {
      const isPdf = res.mime === "application/pdf" || /\.pdf$/i.test(name);
      attachedFiles.value.push({
        id: uuidv4(),
        name,
        content: res.content,
        mimeType: res.mime,
        path: isPdf ? path : undefined,
      });
    }
  } catch (e) {
    notify(`附件处理失败: ${e instanceof Error ? e.message : String(e)}`);
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
function onDragOver(e: DragEvent) {
  e.preventDefault();
}
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

// ── 上下文用量指示（类似 harness）：发送/停止按钮左侧显示“已用 / 总量” ──
// 已用 = 当前会话将发送的最近消息文本估算 token（图片按 ~850/张粗估）；
// 总量 = 模型 context window（按端点/模型推断）。
const ctxLimit = computed(() =>
  modelContextWindowTokens(
    chatStore.currentConfig?.baseUrl || "",
    chatStore.currentConfig?.model,
  ),
);
const ctxUsed = computed(() => {
  const conv = chatStore.activeConversation;
  if (!conv || !conv.messages.length) return 0;
  const maxCtx = chatStore.currentConfig?.maxContextMessages || 50;
  const list = conv.messages.slice(-maxCtx);
  let n = 0;
  for (const m of list) {
    if (m.role === "system") continue;
    if (typeof m.content === "string") n += estimateMessageTokens(m.content);
    if (m.images?.length) n += m.images.length * 850;
  }
  return n;
});
const ctxPct = computed(() =>
  ctxLimit.value ? Math.min(100, Math.round((ctxUsed.value / ctxLimit.value) * 100)) : 0,
);
const ctxWarn = computed(() => ctxPct.value >= 80);
function fmtCtx(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

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
        <span class="ci-file-icon"
          ><component :is="fileTypeIcon(f.name, f.mimeType)" :size="15"
        /></span>
        <span class="ci-file-name">{{ f.name }}</span>
        <button class="ci-attach-x" title="移除" @click="removeFile(f.id)">✕</button>
      </div>
    </div>

    <!-- 输入行 -->
    <div class="ci-wrap" :class="{ 'ci-wrap--busy': disabled }">
      <textarea
        ref="textareaRef"
        v-model="inputText"
        class="ci-text"
        :placeholder="placeholder || '输入消息，Enter 发送，Shift+Enter 换行；输入 / 弹出命令'"
        rows="1"
        @input="onInput"
        @keydown="handleKeydown"
        @keyup="updateSlash"
        @click="updateSlash"
        @paste="handlePaste"
        @compositionstart="composing = true"
        @compositionend="onCompositionEnd"
      ></textarea>
      <!-- Slash 命令面板（输入 / 弹出） -->
      <div v-if="slashOpen && slashFiltered.length" class="ci-slash">
        <div class="ci-slash-head">
          命令 <span class="ci-slash-hint">Enter 执行 · Tab 选择 · Esc 关闭</span>
        </div>
        <div
          v-for="(c, i) in slashFiltered"
          :key="c.name"
          class="ci-slash-item"
          :class="{ on: i === slashActive }"
          @mousedown.prevent="
            slashActive = i;
            commitSlash();
          "
        >
          <span class="ci-slash-name"
            >{{ c.name }}<span v-if="c.args" class="ci-slash-args"> {{ c.args }}</span></span
          >
          <span class="ci-slash-desc">{{ c.desc }}</span>
        </div>
      </div>
      <!-- 上下文用量指示（估算已用/模型总量），位于停止/发送按钮左侧 -->
      <span
        v-if="chatStore.activeConversation"
        class="ci-ctx"
        :class="{ 'ci-ctx--warn': ctxWarn }"
        :title="`当前会话上下文估算 ${fmtCtx(ctxUsed)} / ${fmtCtx(ctxLimit)} tokens（含图片按 ~850/张粗估，不含系统/技能/RAG 注入）；≥80% 变红预警`"
      >
        <span class="ci-ctx__num"
          >{{ fmtCtx(ctxUsed) }}<i class="ci-ctx__sep">/</i>{{ fmtCtx(ctxLimit) }}</span
        >
        <span class="ci-ctx__bar"><i :style="{ width: ctxPct + '%' }" /></span>
      </span>
      <!-- 停止生成：仅忙碌时显示（停止会同时取消已排队消息） -->
      <button
        v-if="disabled"
        class="ci-send ci-stop"
        title="停止生成（同时取消排队消息）"
        @click="chatStore.stopStreaming()"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="5" y="5" width="14" height="14" rx="2" />
        </svg>
      </button>
      <!-- 发送：空闲=直接发送；忙碌=点击入队，当前回复结束后自动发出 -->
      <button
        class="ci-send"
        :class="{ 'ci-send--queue': disabled }"
        :disabled="!canSend()"
        :title="
          disabled
            ? chatStore.pendingCount > 0
              ? `正在生成中——发送将排队（待发 ${chatStore.pendingCount} 条），当前回复结束后自动发出`
              : '正在生成中——发送将排队，当前回复结束后自动发出'
            : '发送（Enter）'
        "
        @click="handleSend"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line x1="12" y1="19" x2="12" y2="5" />
          <polyline points="5 12 12 5 19 12" />
        </svg>
        <span v-if="disabled && chatStore.pendingCount > 0" class="ci-send-badge">{{
          chatStore.pendingCount
        }}</span>
      </button>
    </div>

    <!-- 工具栏 -->
    <div class="ci-bar">
      <div class="ci-bar-left">
        <!-- 模型选择 -->
        <div class="ci-tool-group">
          <div ref="modelBtnRef" class="ci-pill" @click="toggleModelDropdown">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
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
                <span
                  v-if="p.id === chatStore.activeProfileId && m === p.model"
                  class="ci-drop-check"
                  >✓</span
                >
              </div>
            </div>
            <div
              class="ci-drop-foot"
              @click="
                emit('openSettings');
                showModelDropdown = false;
              "
            >
              <Settings :size="14" /> 管理 API 配置
            </div>
          </div>
        </div>

        <!-- 思考模式 -->
        <div class="ci-tool-group">
          <button
            v-if="!chatStore.activeProfile?.thinkingEnabled"
            class="ci-pill"
            title="开启思考模式（模型先展示推理过程再回答）"
            @click="toggleThinking"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span>快速</span>
          </button>
          <button
            v-else
            class="ci-pill active ci-pill-think"
            title="思考模式已开启 · 点击调整思考深度"
            @click.stop="showReasoningDropdown = !showReasoningDropdown"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span
              >思考 · {{ effortLabels[chatStore.activeProfile?.reasoningEffort || "high"] }}</span
            >
            <svg
              class="ci-chev"
              width="8"
              height="8"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span class="ci-pill-close" title="关闭思考模式" @click.stop="toggleThinking">✕</span>
          </button>
          <div
            v-if="showReasoningDropdown"
            ref="reasoningRef"
            class="ci-drop ci-drop-sm"
            @click.stop
          >
            <div
              v-for="lv in ['low', 'high', 'max'] as const"
              :key="lv"
              class="ci-drop-item"
              :class="{ on: chatStore.activeProfile?.reasoningEffort === lv }"
              @click="setReasoningEffort(lv)"
            >
              {{ effortLabels[lv] }}
              {{ lv === "low" ? "· 快速" : lv === "high" ? "· 深度" : "· 极致" }}
            </div>
            <div class="ci-drop-foot" @click.stop="toggleThinking">关闭思考模式</div>
          </div>
        </div>

        <!-- 联网搜索 -->
        <button
          class="ci-pill"
          :class="{ active: chatStore.activeProfile?.enableWebSearch }"
          :title="
            chatStore.activeProfile?.enableWebSearch
              ? '点击关闭联网搜索（模型将不再搜索互联网）'
              : '点击开启联网搜索（允许模型搜索互联网获取最新信息）'
          "
          @click="toggleWebSearch"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <span>{{ chatStore.activeProfile?.enableWebSearch ? "联网" : "离线" }}</span>
        </button>

        <!-- 角色/人设（原在顶栏右上 → 整合到底部工具栏，与「模式」相邻） -->
        <div class="ci-tool-group">
          <button
            class="ci-pill"
            :class="{ active: chatStore.activePersonaId !== '' }"
            title="切换角色 / 人设"
            @click.stop="showPersonaDropdown = !showPersonaDropdown"
          >
            <span>{{ currentPersona ? `${currentPersona.emoji} ${currentPersona.name}` : "🧑 通用助手" }}</span>
            <svg
              class="ci-chev"
              width="8"
              height="8"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <div
            v-if="showPersonaDropdown"
            ref="personaDropdownRef"
            class="ci-drop ci-drop-sm ci-drop-personas"
            @click.stop
          >
            <div
              v-for="p in PERSONAS"
              :key="p.id"
              class="ci-drop-item"
              :class="{ on: chatStore.activePersonaId === p.id }"
              @click="
                chatStore.setPersona(p.id);
                showPersonaDropdown = false;
              "
            >
              <span class="ci-drop-name"
                >{{ p.emoji }} {{ p.name
                }}<span class="ci-drop-cat">{{ p.category }}</span></span
              >
              <span class="ci-drop-desc">{{ p.description }}</span>
              <span v-if="chatStore.activePersonaId === p.id" class="ci-drop-check">✓</span>
            </div>
            <div
              class="ci-drop-foot"
              @click="
                chatStore.setPersona('');
                showPersonaDropdown = false;
              "
            >
              通用助手（关闭角色）
            </div>
          </div>
        </div>

        <!-- Agent 模式（§3.11：对话/任务/办公/研究/编码/速答） -->
        <div class="ci-tool-group">
          <button
            class="ci-pill"
            :class="{ active: chatStore.activeModeId !== 'chat' }"
            title="切换运行模式"
            @click.stop="showModeDropdown = !showModeDropdown"
          >
            <span>{{ currentMode.emoji }} {{ currentMode.name }}</span>
            <svg
              class="ci-chev"
              width="8"
              height="8"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <div
            v-if="showModeDropdown"
            ref="modeDropdownRef"
            class="ci-drop ci-drop-sm ci-drop-modes"
            @click.stop
          >
            <div
              v-for="m in MODES"
              :key="m.id"
              class="ci-drop-item"
              :class="{ on: chatStore.activeModeId === m.id }"
              @click="
                chatStore.setMode(m.id);
                showModeDropdown = false;
              "
            >
              <span class="ci-drop-name"
                >{{ m.emoji }} {{ m.name
                }}<span v-if="modeHist[m.id]" class="ci-drop-times"
                  >常用 ×{{ modeHist[m.id] }}</span
                ></span
              >
              <span class="ci-drop-desc">{{ m.description }}</span>
              <span v-if="chatStore.activeModeId === m.id" class="ci-drop-check">✓</span>
            </div>
          </div>
        </div>

        <!-- 附件上传（图片与文件统一入口） -->
        <button class="ci-pill" title="上传图片或文件" @click="triggerAttach">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path
              d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
            />
          </svg>
          <span>附件</span>
        </button>
        <input
          ref="attachInputRef"
          type="file"
          accept="image/*,.md,.txt,.json,.py,.js,.ts,.rs,.toml,.yaml,.yml,.xml,.csv,.log,.html,.css,.sh,.rb,.go,.java,.c,.cpp,.h,.hpp"
          multiple
          hidden
          @change="handleAttachSelect"
        />
      </div>

      <div class="ci-bar-right">
        <SkillManager />
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-input {
  padding: 12px 20px 14px;
  background: var(--bg-primary);
}

/* 附件栏（图片缩略图 + 文件卡片，参考 DeepSeek Chat 附件栏） */
.ci-attach {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.ci-attach-item {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.ci-attach-img {
  width: 56px;
  height: 56px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border-color);
}
.ci-attach-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.ci-attach-file {
  gap: 5px;
  padding: 6px 10px 6px 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 11px;
}
.ci-file-icon {
  font-size: 13px;
}
.ci-file-name {
  color: var(--text-secondary);
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ci-attach-x {
  position: absolute;
  top: 2px;
  right: 2px;
  z-index: 1;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 10px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s;
}
.ci-attach-item:hover .ci-attach-x {
  opacity: 1;
}

/* 输入行 */
.ci-wrap {
  position: relative;
  display: flex;
  gap: 8px;
  align-items: flex-end;
  background: var(--bg-secondary);
  border: 1.5px solid transparent;
  border-radius: 10px;
  padding: 6px 10px;
  transition:
    border-color 0.2s,
    box-shadow 0.2s;
}
.ci-wrap:focus-within {
  border-color: var(--accent-color);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.08);
}
/* 生成中（busy=disabled=isStreaming）：输入框旋转流光描边——原 agent 回复气泡的
   动态光圈迁移至此，让“正在处理”的视觉重心落到发送框；busy 时优先于聚焦高亮 */
.ci-wrap--busy,
.ci-wrap--busy:focus-within {
  border-color: transparent;
  box-shadow: none;
}
.ci-wrap--busy {
  background:
    linear-gradient(var(--bg-secondary), var(--bg-secondary)) padding-box,
    conic-gradient(
        from var(--ci-spin-angle),
        var(--accent-color) 0%,
        #8b5cf6 15%,
        #22d3ee 30%,
        var(--accent-color) 45%,
        transparent 62%,
        var(--accent-color) 78%,
        transparent 92%
      )
      border-box;
  animation: ciSpin 2.6s linear infinite;
}
@property --ci-spin-angle {
  syntax: "<angle>";
  inherits: false;
  initial-value: 0deg;
}
@keyframes ciSpin {
  to {
    --ci-spin-angle: 360deg;
  }
}

.ci-text {
  flex: 1;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.6;
  font-family: inherit;
  max-height: 160px;
  min-height: 44px;
}
.ci-text::placeholder {
  color: var(--text-muted);
}

.ci-send {
  position: relative;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: var(--accent-color);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
/* 忙碌中：发送钮降级为“入队”样式（描边透明底），与右侧红色停止钮区分 */
.ci-send--queue {
  background: transparent;
  color: var(--accent-color);
  border: 1px solid var(--border-color);
}
.ci-send--queue:not(:disabled):hover {
  background: var(--bg-hover);
  border-color: var(--accent-color);
}
.ci-send-badge {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  border-radius: 8px;
  background: var(--danger-color);
  color: #fff;
  font-size: 9px;
  line-height: 15px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  border: 1px solid var(--bg-secondary);
}
.ci-send:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.ci-send:not(:disabled):hover {
  background: var(--accent-hover);
}
.ci-stop {
  background: var(--danger-color);
  font-size: 0;
}
.ci-stop:hover {
  background: #dc2626;
  transform: scale(1.06);
}
.ci-stop:active {
  transform: scale(0.94);
}

/* 上下文用量指示（发送/停止按钮左侧） */
.ci-ctx {
  flex-shrink: 0;
  align-self: flex-end;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  margin: 0 4px 6px 2px;
  padding: 0 8px 0 10px;
  border-left: 1px solid var(--border-color);
  color: var(--text-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  line-height: 1.25;
  user-select: none;
  cursor: default;
}
.ci-ctx__num {
  display: flex;
  gap: 3px;
  font-weight: 600;
}
.ci-ctx__sep {
  opacity: 0.5;
}
.ci-ctx--warn .ci-ctx__num {
  color: var(--danger-color);
  font-weight: 700;
}
.ci-ctx__bar {
  display: block;
  width: 64px;
  height: 3px;
  border-radius: 2px;
  background: var(--border-color);
  overflow: hidden;
}
.ci-ctx__bar i {
  display: block;
  height: 100%;
  background: var(--accent-color);
  border-radius: 2px;
  transition: width 0.2s;
}
.ci-ctx--warn .ci-ctx__bar i {
  background: var(--danger-color);
}

/* Slash 命令面板 */
.ci-slash {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 30;
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: var(--shadow-md);
  overflow: hidden;
}
.ci-slash-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  font-size: 11px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-color);
}
.ci-slash-hint {
  font-size: 10px;
  opacity: 0.8;
}
.ci-slash-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-primary);
}
.ci-slash-item:hover {
  background: var(--bg-hover);
}
.ci-slash-item.on {
  background: color-mix(in srgb, var(--accent-color) 14%, transparent);
}
.ci-slash-name {
  font-weight: 600;
  white-space: nowrap;
}
.ci-slash-args {
  font-weight: 400;
  color: var(--text-muted);
  font-size: 11px;
}
.ci-slash-desc {
  color: var(--text-muted);
  font-size: 11px;
}

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid transparent;
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 工具栏 */
.ci-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  gap: 8px;
  flex-wrap: wrap;
}
.ci-bar-left {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.ci-tool-group {
  position: relative;
  display: flex;
  align-items: center;
}

/* Pill 按钮 */
.ci-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.ci-pill:hover {
  border-color: #555;
  color: var(--text-primary);
}
.ci-pill.active {
  background: rgba(99, 102, 241, 0.12);
  border-color: var(--accent-color);
  color: var(--accent-color);
}
.ci-pill-think {
  cursor: default;
  padding-right: 4px;
  gap: 6px;
}
.ci-pill-think .ci-chev {
  margin-left: 2px;
  opacity: 0.6;
}
.ci-pill-think:hover .ci-chev {
  opacity: 1;
}
.ci-pill-close {
  background: none;
  border: none;
  color: inherit;
  opacity: 0.4;
  cursor: pointer;
  padding: 0 2px;
  font-size: 10px;
  line-height: 1;
  margin-left: 2px;
  border-radius: 3px;
}
.ci-pill-close:hover {
  opacity: 0.8;
  background: rgba(255, 255, 255, 0.1);
}
.ci-pill-sub {
  color: var(--text-muted);
  font-size: 10px;
  font-family: "SF Mono", "Fira Code", monospace;
  opacity: 0.8;
}

/* 下拉 */
.ci-drop {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 200px;
  background: #1e1e32;
  border: 1px solid #333;
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  z-index: 50;
  animation: popUp 0.15s ease;
  overflow: hidden;
}
.ci-drop-sm {
  min-width: 100px;
}
.ci-drop-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 12px;
  color: #ccc;
  transition: background 0.1s;
}
.ci-drop-item:hover {
  background: #252540;
}
.ci-drop-item.on {
  background: rgba(99, 102, 241, 0.1);
  color: #a5b4fc;
}
.ci-drop-name {
  font-weight: 600;
}
.ci-drop-model {
  color: var(--text-muted);
  font-size: 10px;
  font-family: "SF Mono", "Fira Code", monospace;
}
.ci-drop-desc {
  color: var(--text-muted, #888);
  font-size: 10px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ci-drop-times {
  margin-left: 6px;
  font-size: 10px;
  color: #f5a623;
  font-weight: 500;
}
.ci-drop-modes {
  min-width: 230px;
  max-height: 320px;
  overflow-y: auto;
}
.ci-drop-personas {
  min-width: 250px;
  max-height: 360px;
  overflow-y: auto;
}
.ci-drop-cat {
  margin-left: 6px;
  font-size: 10px;
  color: var(--text-muted, #888);
  font-weight: 400;
}
.ci-drop-modes .ci-drop-item {
  display: grid;
  grid-template-columns: 1fr auto;
  row-gap: 1px;
}
.ci-drop-modes .ci-drop-name {
  grid-column: 1;
}
.ci-drop-modes .ci-drop-desc {
  grid-column: 1;
  grid-row: 2;
  max-width: 190px;
}
.ci-drop-modes .ci-drop-check {
  grid-column: 2;
  grid-row: 1 / span 2;
}
.ci-drop-check {
  color: var(--accent-color);
  font-weight: 700;
  margin-left: auto;
  font-size: 11px;
}
.ci-drop-foot {
  padding: 7px 12px;
  border-top: 1px solid #333;
  font-size: 11px;
  color: #888;
  cursor: pointer;
  transition: background 0.1s;
}
.ci-drop-foot:hover {
  background: #252540;
}

/* 模型分组下拉 */
.ci-drop-models {
  min-width: 240px;
  max-height: 360px;
  overflow-y: auto;
}
.ci-drop-group-title {
  padding: 6px 12px 4px;
  font-size: 10px;
  font-weight: 700;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.ci-drop-group:first-child .ci-drop-group-title {
  padding-top: 8px;
}
.ci-drop-group + .ci-drop-group {
  border-top: 1px solid #26263c;
  margin-top: 2px;
  padding-top: 2px;
}

.ci-bar-right {
  display: flex;
  align-items: center;
}

@keyframes popUp {
  from {
    opacity: 0;
    transform: translateY(3px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>
