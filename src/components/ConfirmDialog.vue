<script setup lang="ts">
// 应用内确认/提示弹窗（P1-11）：替代 macOS 原生 Alert —— 长文案（命令/键值/列表）结构化排版，
// 危险操作红色主按钮且**默认焦点在「取消」**（手快回车不会误放行）。
// 由 stores/appDialog.ts 排队驱动；App.vue 常驻挂载一份。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { AlertTriangle, Check, Copy, Info, ShieldAlert, X } from "lucide-vue-next";
import { appDialogHost, useAppDialogStore } from "@/stores/appDialog";

const store = useAppDialogStore();
const req = computed(() => store.current);
const icon = computed(() => {
  const t = req.value?.tone;
  if (t === "error") return ShieldAlert;
  if (t === "warning") return AlertTriangle;
  return Info;
});
const confirmBtn = ref<HTMLButtonElement | null>(null);
const cancelBtn = ref<HTMLButtonElement | null>(null);
const copied = ref("");

/** 危险操作把焦点给「取消」，其余给主按钮 */
function focusDefault() {
  nextTick(() => {
    if (req.value?.danger) cancelBtn.value?.focus();
    else confirmBtn.value?.focus();
  });
}
watch(req, () => {
  copied.value = "";
  focusDefault();
  void requestAttentionIfUnfocused();
});

/**
 * 窗口不在前台时闪一下 Dock（IM 配对/权限确认可能是用户切到别的应用时才来的）——
 * 应用内弹窗不像系统弹窗那样会自动置顶，得主动提醒，否则用户根本不知道有请求在等。
 */
async function requestAttentionIfUnfocused() {
  try {
    if (typeof document !== "undefined" && document.hasFocus()) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().requestUserAttention(2 /* Critical：持续闪烁 */);
  } catch {
    /* 浏览器预览 / 权限不足：忽略 */
  }
}

function confirm() {
  if (req.value) store.settle(req.value.id, true);
}
function cancel() {
  if (req.value) store.settle(req.value.id, false);
}
async function copyMono(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = text.slice(0, 40);
  } catch {
    copied.value = "";
  }
}
/** Esc=取消（通知类=关闭）；Enter=默认按钮（危险操作=取消） */
function onKey(e: KeyboardEvent) {
  if (!req.value) return;
  if (e.key === "Escape") {
    e.preventDefault();
    cancel();
  } else if (e.key === "Enter" && !e.shiftKey) {
    const el = document.activeElement as HTMLElement | null;
    if (el && el.tagName === "TEXTAREA") return;
    e.preventDefault();
    if (req.value.kind === "notify" || !req.value.danger) confirm();
    else cancel();
  }
}

onMounted(() => {
  appDialogHost.ready = true;
  focusDefault();
});
onUnmounted(() => {
  // 宿主消失（热重载/关闭）：把挂起的请求按「否」收掉，避免调用方永久 await
  appDialogHost.ready = false;
  store.settleAll(false);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="cd-fade">
      <div v-if="req" class="cd-overlay" @keydown="onKey">
        <div
          class="cd-card"
          :class="`cd-card--${req.tone}`"
          role="dialog"
          aria-modal="true"
          :aria-label="req.title"
        >
          <header class="cd-head">
            <span class="cd-icon"><component :is="icon" :size="18" /></span>
            <span class="cd-title">{{ req.title }}</span>
            <span v-if="store.queue.length > 1" class="cd-queue">
              还有 {{ store.queue.length - 1 }} 条待确认
            </span>
          </header>

          <div class="cd-body">
            <template v-for="(b, bi) in req.blocks" :key="bi">
              <p v-if="b.kind === 'p'" class="cd-p">
                <template v-for="(seg, si) in b.parts" :key="si">
                  <strong v-if="seg.bold">{{ seg.text }}</strong>
                  <code v-else-if="seg.code" class="cd-code">{{ seg.text }}</code>
                  <template v-else>{{ seg.text }}</template>
                </template>
              </p>

              <div v-else-if="b.kind === 'mono'" class="cd-mono">
                <button
                  class="cd-copy"
                  :title="copied ? '已复制' : '复制'"
                  @click="copyMono(b.lines.join('\n'))"
                >
                  <Check v-if="copied" :size="12" />
                  <Copy v-else :size="12" />
                </button>
                <pre><code>{{ b.lines.join("\n") }}</code></pre>
              </div>

              <ul v-else-if="b.kind === 'list'" class="cd-list">
                <li v-for="(item, ii) in b.items" :key="ii">
                  <template v-for="(seg, si) in item" :key="si">
                    <strong v-if="seg.bold">{{ seg.text }}</strong>
                    <code v-else-if="seg.code" class="cd-code">{{ seg.text }}</code>
                    <template v-else>{{ seg.text }}</template>
                  </template>
                </li>
              </ul>

              <dl v-else-if="b.kind === 'kv'" class="cd-kv">
                <template v-for="(row, ri) in b.rows" :key="ri">
                  <dt>{{ row.k }}</dt>
                  <dd>{{ row.v }}</dd>
                </template>
              </dl>
            </template>
          </div>

          <footer class="cd-actions">
            <button
              v-if="req.kind === 'confirm'"
              ref="cancelBtn"
              class="cd-btn cd-btn--ghost"
              @click="cancel"
            >
              <X :size="14" /> {{ req.cancelText }}
            </button>
            <button
              ref="confirmBtn"
              class="cd-btn"
              :class="req.danger ? 'cd-btn--danger' : 'cd-btn--primary'"
              @click="confirm"
            >
              <Check :size="14" /> {{ req.confirmText }}
            </button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.cd-overlay {
  position: fixed;
  inset: 0;
  z-index: 2200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(2px);
}
.cd-card {
  width: min(520px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated, #fff);
  color: var(--text-primary, #1a1a2e);
  border: 1px solid var(--border-color, #e8e8ec);
  border-radius: var(--radius-lg, 16px);
  box-shadow: var(--shadow-xl, 0 24px 60px rgba(0, 0, 0, 0.15));
  overflow: hidden;
}
.cd-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 14px 16px 12px;
}
.cd-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--accent-bg, rgba(99, 102, 241, 0.06));
  color: var(--accent-color, #6366f1);
}
.cd-card--warning .cd-icon {
  background: rgba(245, 158, 11, 0.12);
  color: #f59e0b;
}
.cd-card--error .cd-icon {
  background: var(--danger-bg, rgba(239, 68, 68, 0.08));
  color: var(--danger-color, #ef4444);
}
.cd-title {
  flex: 1;
  font-size: 14.5px;
  font-weight: 650;
  letter-spacing: 0.01em;
  line-height: 1.35;
}
.cd-queue {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--text-muted, #9a9ab0);
  background: var(--bg-hover, rgba(0, 0, 0, 0.04));
  padding: 3px 8px;
  border-radius: 999px;
}
.cd-body {
  padding: 0 16px 4px;
  overflow: auto;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text-secondary, #5a5a72);
}
.cd-p {
  margin: 6px 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.cd-mono {
  position: relative;
  margin: 8px 0;
  background: var(--pre-bg, #1e1e2e);
  border-radius: var(--radius-sm, 8px);
  padding: 10px 36px 10px 12px;
}
.cd-mono pre {
  margin: 0;
  overflow: auto;
  max-height: 40vh;
}
.cd-mono code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--pre-text, #cdd6f4);
  white-space: pre-wrap;
  word-break: break-all;
}
.cd-copy {
  position: absolute;
  top: 7px;
  right: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.12);
  color: var(--pre-text, #cdd6f4);
}
.cd-copy:hover {
  background: rgba(255, 255, 255, 0.22);
}
.cd-list {
  margin: 6px 0;
  padding-left: 20px;
}
.cd-list li {
  margin: 3px 0;
}
.cd-kv {
  margin: 8px 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  background: var(--bg-hover, rgba(0, 0, 0, 0.03));
  border-radius: var(--radius-sm, 8px);
  padding: 10px 12px;
}
.cd-kv dt {
  font-size: 12px;
  color: var(--text-muted, #9a9ab0);
  white-space: nowrap;
}
.cd-kv dd {
  margin: 0;
  font-size: 12.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text-primary, #1a1a2e);
  word-break: break-all;
}
.cd-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: var(--code-bg, #f4f4f8);
  border-radius: 4px;
  padding: 1px 5px;
}
.cd-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 16px 14px;
}
.cd-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  border-radius: var(--radius-sm, 8px);
  border: 1px solid transparent;
  cursor: pointer;
  transition:
    background 0.15s,
    opacity 0.15s,
    transform 0.05s;
}
.cd-btn:active {
  transform: translateY(1px);
}
.cd-btn--ghost {
  background: var(--bg-secondary, #f0f0f3);
  border-color: var(--border-color, #e8e8ec);
  color: var(--text-secondary, #5a5a72);
}
.cd-btn--ghost:hover {
  background: var(--bg-hover, rgba(0, 0, 0, 0.06));
}
.cd-btn--primary {
  background: var(--accent-color, #6366f1);
  color: #fff;
}
.cd-btn--primary:hover {
  background: var(--accent-hover, #4f46e5);
}
.cd-btn--danger {
  background: var(--danger-color, #ef4444);
  color: #fff;
}
.cd-btn--danger:hover {
  filter: brightness(0.94);
}
.cd-btn:focus-visible {
  outline: 2px solid var(--accent-color, #6366f1);
  outline-offset: 2px;
}
.cd-fade-enter-active,
.cd-fade-leave-active {
  transition: opacity 0.16s ease;
}
.cd-fade-enter-active .cd-card,
.cd-fade-leave-active .cd-card {
  transition:
    transform 0.16s ease,
    opacity 0.16s ease;
}
.cd-fade-enter-from,
.cd-fade-leave-to {
  opacity: 0;
}
.cd-fade-enter-from .cd-card {
  transform: translateY(6px) scale(0.98);
}
</style>
