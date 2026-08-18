<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUpdated } from "vue";
import type { ChatMessage as Msg, ImageAttachment } from "@/types";
import { Marked } from "marked";
import hljs from "@/utils/hljs";
import { useChatStore } from "@/stores/chat";
import { invoke } from "@tauri-apps/api/core";
import { formatCost } from "@/utils/tokens";
import AppLogo from "./AppLogo.vue";

const chatStore = useChatStore();
const props = defineProps<{ message: Msg }>();

const previewImage = ref<ImageAttachment | null>(null);
const showReasoning = ref(true);
const copied = ref(false);

// 终端命令结果渲染（借鉴 DeepSeek Harness 的 terminal card）
const isTerminalContent = computed(() => {
  const c = props.message.content;
  return typeof c === "string" && c.startsWith("$ ") && c.includes("退出码");
});
const terminalCommand = computed(() => {
  const c = props.message.content;
  if (!c) return "";
  return c.split("\n")[0].replace(/^\$\s*/, "");
});
const terminalOutput = computed(() => {
  const c = props.message.content;
  if (!c) return "";
  return c.split("\n").slice(1).join("\n").trim();
});

const marked = new Marked(); marked.setOptions({ breaks: true, gfm: true });

// 识别本地文件路径 → 转成可点击链接（href="#" + data-path，点击拦截调系统打开）
// 支持 ~/ 开头与中文目录；排除 markdown 链接/括号内
const LOCAL_FILE_RE = /(?<![\w\/])((?:~\/|\/)[A-Za-z0-9_@.\/\-\u4e00-\u9fa5]*\/[^ \t\n\r\[\]\(\)"']*\.(?:csv|xlsx?|xlsm|pdf|docx?|txt|md|json|png|jpe?g|gif|webp|bmp|svg|py|js|ts|rs|toml|yaml|ya?ml|xml|log|sh|rb|go|java|c|cpp|h|hpp|html?|css|sql|db|zip|tar\.gz|7z))/gi;

function linkifyLocalPaths(s: string): string {
  return s.replace(LOCAL_FILE_RE, (m) => {
    const name = m.split("/").pop() || m;
    const encoded = encodeURIComponent(m);
    return `<a href="#" class="local-file-link" data-path="${encoded}">📄 ${name}</a>`;
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 用 marked 的 renderer 在渲染时把路径替换为链接：renderer 输出直接拼进最终 HTML，
// 不经过 marked 对 raw HTML 的二次解析/转义，确保链接确实渲染成可点击元素。
// 同时覆盖 text（纯文本）与 codespan（反引号行内代码），因为 agent 常把路径包在 ` 里
marked.use({
  renderer: {
    text(token: { text: string }) {
      return linkifyLocalPaths(token.text);
    },
    codespan(token: { text: string }) {
      const linked = linkifyLocalPaths(token.text);
      // 是本地文件路径 → 直接渲染成可点击链接，而不是 <code>
      if (linked !== token.text) return linked;
      return `<code>${escapeHtml(token.text)}</code>`;
    },
  },
});

function md(s: string) { return s ? marked.parse(s) as string : ""; }

// 拦截本地文件链接：用系统默认应用打开（如 Excel/Numbers 打开 CSV）
async function onContentClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest?.('a.local-file-link');
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  const path = decodeURIComponent(a.getAttribute("data-path") || "");
  if (!path) return;
  try {
    await invoke("open_file", { path });
  } catch (err) {
    alert(`打开文件失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function highlight() {
  // 直接从 DOM 找代码块，不依赖 ref 时序
  const el = document.querySelector(`[data-msg-id="${props.message.id}"]`);
  if (!el) return;
  el.querySelectorAll("pre code:not(.hljs)").forEach(b => hljs.highlightElement(b as HTMLElement));
  el.querySelectorAll("pre").forEach(pre => {
    if (pre.querySelector(".code-copy-btn")) return;
    const btn = document.createElement("button");
    btn.className = "code-copy-btn"; btn.textContent = "复制";
    btn.onclick = () => { navigator.clipboard.writeText(pre.querySelector("code")?.textContent || ""); btn.textContent = "✓"; setTimeout(() => btn.textContent = "复制", 2000); };
    pre.style.position = "relative"; pre.appendChild(btn);
  });
}

// 只把【真实存在】的文件渲染为可点击链接：逐一检查 data-path 指向的文件是否存在，
// 不存在的替换为"文件不存在"提示文本（防止 agent 在回复中编造路径，点击后打开失败）
async function verifyFileLinks() {
  const el = document.querySelector(`[data-msg-id="${props.message.id}"]`);
  if (!el) return;
  const links = [...el.querySelectorAll<HTMLAnchorElement>("a.local-file-link")];
  for (const a of links) {
    const path = decodeURIComponent(a.getAttribute("data-path") || "");
    if (!path) continue;
    let exists = false;
    try { exists = await invoke<boolean>("file_exists", { path }); } catch { exists = false; }
    if (exists) continue;
    const span = document.createElement("span");
    span.className = "file-link-missing";
    span.title = `${path}（文件不存在）`;
    span.textContent = `📄 ${a.textContent}（文件不存在）`;
    a.replaceWith(span);
  }
}

async function copyAll() { await chatStore.copyToClipboard(props.message.content); copied.value = true; setTimeout(() => copied.value = false, 2000); }

// 工具活动卡片展开状态（按工具名）
const toolOpen = ref<Set<string>>(new Set());
function toggleTool(name: string) {
  const s = new Set(toolOpen.value);
  s.has(name) ? s.delete(name) : s.add(name);
  toolOpen.value = s;
}

// 流式结束后高亮 + 首次挂载高亮 + 校验文件链接存在性
let highlighted = false;
onMounted(() => { if (props.message.content && !props.message.streaming) highlighted = false; });
onUpdated(() => {
  if (props.message.content && !props.message.streaming && !highlighted) {
    highlighted = true;
    nextTick(() => { highlight(); verifyFileLinks(); });
  }
});
watch(() => props.message.streaming, (s) => { if (!s) highlighted = false; });
</script>

<template>
  <div v-if="message.role === 'assistant' && message.streaming" class="message message--assistant">
    <div class="message__avatar"><AppLogo :size="24" /></div>
    <div class="message__body">
      <div class="message__bubble bubble-active">
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
  </div>

  <div v-else class="message" :class="`message--${message.role}`" :data-msg-id="message.id">
    <div class="message__avatar"><span v-if="message.role === 'user'">👤</span><AppLogo v-else :size="24" /></div>
    <div class="message__body">
      <div class="message__bubble">
        <div v-if="message.images?.length" class="message__images">
          <div v-for="img in message.images" :key="img.id" class="message__image-item" @click="previewImage = img">
            <img :src="img.base64" :alt="img.fileName || '图片'" />
          </div>
        </div>

        <!-- 附件上下文卡片（文件内容不直接展示，仅显示文件名） -->
        <div v-if="message.attachments?.length" class="message__attachments">
          <div v-for="f in message.attachments" :key="f.id" class="attach-card" :title="`${f.name} · ${(f.content || '').length} 字符`">
            <span class="attach-card-icon">📄</span>
            <span class="attach-card-name">{{ f.name }}</span>
          </div>
        </div>

        <div v-if="message.reasoning_content" class="msg-reason">
          <div class="reason-head" @click="showReasoning = !showReasoning">
            <span class="reason-arrow">{{ showReasoning ? '▾' : '▸' }}</span><span class="reason-label">🧠 深度思考</span>
          </div>
          <div v-show="showReasoning" class="reason-body">{{ message.reasoning_content }}</div>
        </div>

        <!-- ReAct 工具活动卡片 -->
        <div v-if="message.tools?.length" class="msg-tools">
          <div
            v-for="(t, i) in message.tools" :key="i"
            class="tool-card" :class="`tool-card--${t.status}`"
          >
            <div class="tool-card__head" @click="toggleTool(t.name)">
              <span class="tool-card__icon">{{ t.status === 'error' ? '❌' : t.status === 'running' ? '⏳' : '✅' }}</span>
              <span class="tool-card__name">{{ t.name }}</span>
              <span v-if="t.server && t.server !== 'app'" class="tool-card__server">{{ t.server }}</span>
              <span v-if="t.durationMs !== undefined" class="tool-card__dur">{{ (t.durationMs / 1000).toFixed(1) }}s</span>
              <span class="tool-card__arrow">{{ toolOpen.has(t.name) ? '▾' : '▸' }}</span>
            </div>
            <div v-show="toolOpen.has(t.name)" class="tool-card__body">
              <div v-if="t.argsPreview" class="tool-card__pre"><div class="tool-card__label">参数</div><pre>{{ t.argsPreview }}</pre></div>
              <div v-if="t.resultPreview" class="tool-card__pre"><div class="tool-card__label">结果</div><pre>{{ t.resultPreview }}</pre></div>
              <div v-if="t.error" class="tool-card__pre tool-card__err"><div class="tool-card__label">错误</div><pre>{{ t.error }}</pre></div>
            </div>
          </div>
        </div>

        <template v-if="message.content">
          <div v-if="isTerminalContent" class="terminal-card">
            <div class="terminal-card__bar">
              <span class="terminal-card__dot r"></span>
              <span class="terminal-card__dot y"></span>
              <span class="terminal-card__dot g"></span>
              <span class="terminal-card__cmd">$ {{ terminalCommand }}</span>
            </div>
            <pre class="terminal-card__body">{{ terminalOutput }}</pre>
          </div>
          <div v-else class="message__content markdown-body" v-html="md(message.content)" @click="onContentClick"></div>
        </template>
      </div>

      <div class="message__meta">
        <span class="message__time">{{ new Date(message.timestamp).toLocaleTimeString("zh-CN") }}</span>
        <span v-if="message.role === 'assistant' && message.duration" class="msg-meta">· {{ message.duration }}s</span>
        <span v-if="message.role === 'assistant' && message.tokens" class="msg-meta">· {{ message.tokens }} tokens</span>
        <span v-if="message.role === 'assistant' && message.cost" class="msg-meta">· {{ formatCost(message.cost) }}</span>
        <div v-if="message.role === 'assistant' && message.content" class="msg-actions">
          <button class="msg-act-btn" @click="copyAll">{{ copied ? '✓ 已复制' : '📋 复制' }}</button>
          <button class="msg-act-btn" @click="chatStore.retryLast()">🔄 重试</button>
        </div>
      </div>
    </div>
  </div>

  <div v-if="previewImage" class="image-preview-overlay" @click="previewImage = null">
    <img :src="previewImage.base64" class="image-preview__img" @click.stop />
    <button class="image-preview__close" @click="previewImage = null">✕</button>
  </div>
</template>

<style scoped>
.message { display: flex; gap: 10px; padding: 10px 20px; align-items: flex-start; }
.message--user { flex-direction: row-reverse; }
.message__avatar { flex-shrink: 0; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; font-size: 18px; opacity: .9; }
.message__body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.message--user .message__body { align-items: flex-end; }
.message--assistant .message__body { align-items: flex-start; }
.message__bubble {
  max-width: 78%; min-width: 0;
  padding: 10px 14px;
  border-radius: 14px;
  background: var(--bg-assistant-bubble);
  border: 1px solid var(--border-color);
  box-shadow: var(--shadow-sm);
  position: relative;
}
.message--assistant .message__bubble { border-bottom-left-radius: 4px; }

/* 动态光圈流转：agent 思考/处理任务时气泡边缘流光旋转（仅 streaming 中的气泡） */
@property --spin-angle {
  syntax: "<angle>";
  inherits: false;
  initial-value: 0deg;
}
.message--assistant .bubble-active::before {
  content: "";
  position: absolute;
  inset: -1.5px;
  border-radius: inherit;
  padding: 1.5px;
  background: conic-gradient(
    from var(--spin-angle),
    transparent 0%,
    var(--accent-color) 12%,
    #8b5cf6 24%,
    #22d3ee 36%,
    transparent 48%,
    transparent 62%,
    var(--accent-color) 74%,
    transparent 86%
  );
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  pointer-events: none;
  animation: spinAngle 2.6s linear infinite;
}
@keyframes spinAngle { to { --spin-angle: 360deg; } }
.message--user .message__bubble {
  background: linear-gradient(135deg, var(--accent-color), var(--accent-hover));
  border-color: transparent;
  border-bottom-right-radius: 4px;
  box-shadow: 0 2px 10px rgba(99, 102, 241, 0.28);
}
.message--user .message__bubble .message__content { color: #fff; }
.message--user :deep(.markdown-body) { color: #fff; }
.message--user :deep(.markdown-body a) { color: #fff; text-decoration: underline; }
.message--user :deep(.markdown-body code) { background: rgba(255,255,255,.2); color: #fff; }
.message__images { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.message__image-item { width: 120px; height: 120px; border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--border-color); cursor: pointer; transition: transform .15s; }
.message__image-item:hover { transform: scale(1.03); }
.message__image-item img { width: 100%; height: 100%; object-fit: cover; }

/* 附件上下文卡片 */
.message__attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.attach-card { display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; font-size: 11px; }
.attach-card-icon { font-size: 13px; }
.attach-card-name { color: var(--text-secondary); max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.message--user .attach-card { background: rgba(255,255,255,.18); border-color: rgba(255,255,255,.3); }
.message--user .attach-card-name { color: #fff; }
.message__content { font-size: 14px; line-height: 1.65; color: var(--text-primary); word-break: break-word; }
.local-file-link { color: var(--accent-color); text-decoration: underline; cursor: pointer; font-weight: 500; }
.local-file-link:hover { opacity: .8; }
.file-link-missing { color: var(--text-muted); font-weight: 500; cursor: default; font-style: italic; }
.message--user .message__content .local-file-link { color: #fff; }
.message__cursor { display: inline-block; width: 7px; height: 16px; background: var(--accent-color); animation: blink 1s step-end infinite; vertical-align: text-bottom; margin-left: 2px; border-radius: 2px; }
.message__meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 5px; padding: 0 4px; }
.message--user .message__meta { justify-content: flex-end; }
.message__time { font-size: 10px; color: var(--text-muted); }
.msg-meta { color: var(--text-muted); }
.msg-actions { display: flex; gap: 6px; }
.msg-act-btn { padding: 3px 10px; border: 1px solid var(--border-color); border-radius: 5px; background: var(--bg-secondary); color: var(--text-secondary); font-size: 11px; cursor: pointer; transition: all .15s; }
.msg-act-btn:hover { border-color: var(--accent-color); color: var(--accent-color); background: var(--accent-bg); }

/* 终端命令结果卡片 */
.terminal-card {
  background: #0d0d1a; border: 1px solid #252540; border-radius: 10px;
  overflow: hidden; font-family: "SF Mono", "Fira Code", ui-monospace, monospace;
}
.terminal-card__bar {
  display: flex; align-items: center; gap: 5px;
  padding: 6px 10px; background: #1a1a2e; border-bottom: 1px solid #252540;
}
.terminal-card__dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.terminal-card__dot.r { background: #ff5f57; }
.terminal-card__dot.y { background: #febc2e; }
.terminal-card__dot.g { background: #28c840; }
.terminal-card__cmd {
  font-size: 11px; color: #8a8aa0; margin-left: 6px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.terminal-card__body {
  margin: 0; padding: 10px 12px; font-size: 12px; line-height: 1.5;
  color: #cdd6f4; white-space: pre-wrap; word-break: break-word;
  max-height: 400px; overflow-y: auto;
}
.message__thinking { display: flex; align-items: center; gap: 4px; padding: 4px 0; }
.thinking-dot { font-size: 7px; color: var(--text-muted); animation: dotPulse 1.4s infinite; }
.thinking-dot:nth-child(1) { animation-delay: 0s; } .thinking-dot:nth-child(2) { animation-delay: .2s; } .thinking-dot:nth-child(3) { animation-delay: .4s; }
.thinking-text { font-size: 12px; color: var(--text-muted); margin-left: 2px; }
@keyframes dotPulse { 0%,80%,100% { opacity: .2; transform: scale(.8); } 40% { opacity: 1; transform: scale(1.2); color: var(--accent-color); } }
.msg-reason { margin-bottom: 8px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); overflow: hidden; }
.reason-head { display: flex; align-items: center; gap: 6px; padding: 6px 12px; background: var(--bg-secondary); cursor: pointer; font-size: 12px; }
.reason-head:hover { background: var(--bg-hover); }
.reason-arrow { font-size: 9px; color: var(--text-muted); }
.reason-label { font-weight: 600; color: var(--text-secondary); }

/* ReAct 工具活动卡片 */
.msg-tools { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.tool-card { border: 1px solid var(--border-color); border-radius: var(--radius-sm); overflow: hidden; }
.tool-card--done { border-color: rgba(34,197,94,.3); }
.tool-card--error { border-color: rgba(248,113,113,.4); }
.tool-card__head {
  display: flex; align-items: center; gap: 6px; padding: 5px 10px;
  background: var(--bg-secondary); cursor: pointer; font-size: 12px;
}
.tool-card__head:hover { background: var(--bg-hover); }
.tool-card__icon { font-size: 12px; }
.tool-card__name { font-weight: 600; color: var(--text-primary); }
.tool-card__server { font-size: 10px; color: var(--text-muted); border: 1px solid var(--border-color); border-radius: 4px; padding: 0 4px; }
.tool-card__dur { margin-left: auto; font-size: 10px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.tool-card__arrow { font-size: 9px; color: var(--text-muted); }
.tool-card__body { padding: 8px 10px; border-top: 1px solid var(--border-color); background: var(--bg-primary); }
.tool-card__pre { margin-bottom: 6px; }
.tool-card__pre:last-child { margin-bottom: 0; }
.tool-card__label { font-size: 10px; color: var(--text-muted); margin-bottom: 3px; }
.tool-card__pre pre {
  margin: 0; padding: 6px 8px; background: #0d0d1a; border-radius: 6px;
  font-family: ui-monospace, Menlo, monospace; font-size: 11px; line-height: 1.5;
  color: var(--text-secondary); white-space: pre-wrap; word-break: break-all;
  max-height: 160px; overflow: auto;
}
.tool-card__err pre { color: #f87171; }
.reason-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: var(--accent-bg); color: var(--accent-color); font-weight: 600; animation: pulse 2s infinite; }
.reason-body { padding: 8px 12px; font-size: 12px; color: var(--text-muted); line-height: 1.55; border-top: 1px solid var(--border-color); max-height: 240px; overflow-y: auto; white-space: pre-wrap; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .6; } }
.image-preview-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.85); display: flex; align-items: center; justify-content: center; z-index: 200; cursor: pointer; animation: fadeIn .2s; }
.image-preview__img { max-width: 90vw; max-height: 90vh; border-radius: var(--radius-lg); cursor: default; }
.image-preview__close { position: fixed; top: 16px; right: 16px; width: 36px; height: 36px; border: none; border-radius: 50%; background: rgba(255,255,255,.12); color: #fff; font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
:deep(.code-copy-btn) { position: absolute; top: 6px; right: 6px; padding: 2px 8px; border: 1px solid rgba(255,255,255,.15); border-radius: 4px; background: rgba(255,255,255,.06); color: rgba(255,255,255,.5); font-size: 10px; cursor: pointer; transition: all .15s; z-index: 1; }
:deep(.code-copy-btn:hover) { background: rgba(255,255,255,.12); color: #fff; }
@keyframes fadeSlideIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes blink { 50% { opacity: 0; } }
</style>
