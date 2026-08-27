<script setup lang="ts">
// P-A4 应用内 diff 确认：文件编辑类工具（replace_string/insert_string/delete_file）
// 开启「文件编辑需确认」后，先在此弹窗展示 unified diff（或删除路径），
// 用户点「应用」才真正写盘，「拒绝」则返回提示给 Agent。
import { computed, ref } from "vue";
import { useChatStore } from "@/stores/chat";
import { FileEdit, FileX2, Check, X } from "lucide-vue-next";

const chatStore = useChatStore();
const req = computed(() => chatStore.editConfirm);
// 会话级权限记忆（§3.10 🟡）：勾选后本会话内该工具（replace_string/insert_string/delete_file）不再弹确认
const remember = ref(false);
function apply() {
  const r = req.value;
  if (!r) return;
  if (remember.value && r.tool) chatStore.rememberSessionPermit(r.tool);
  chatStore.resolveEditConfirm(true);
}
function reject() {
  remember.value = false;
  chatStore.resolveEditConfirm(false);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="req" class="dcd-overlay">
      <div class="dcd-card">
        <header class="dcd-head">
          <span class="dcd-title">
            <FileEdit v-if="req.kind === 'edit'" :size="16" />
            <FileX2 v-else :size="16" />
            {{ req.kind === "delete" ? "确认删除文件" : "确认文件编辑" }}
          </span>
          <span class="dcd-tool">{{ req.tool }}</span>
        </header>
        <div class="dcd-path">{{ req.path }}</div>

        <template v-if="req.kind === 'edit'">
          <p class="dcd-hint">Agent 请求修改此文件，确认无误后点「应用」才会写入：</p>
          <pre class="dcd-diff"><code>{{ req.diff }}</code></pre>
        </template>
        <template v-else>
          <p class="dcd-hint">Agent 请求删除此文件（仅主目录内文件）：</p>
          <pre class="dcd-diff">{{ req.path }}</pre>
        </template>

        <div class="dcd-actions">
          <label v-if="req.rememberLabel" class="dcd-remember">
            <input type="checkbox" v-model="remember" />
            <span>{{ req.rememberLabel }}</span>
          </label>
          <span class="dcd-spacer"></span>
          <button class="dcd-btn dcd-btn--reject" @click="reject">
            <X :size="14" /> 拒绝
          </button>
          <button class="dcd-btn dcd-btn--apply" @click="apply">
            <Check :size="14" /> 应用
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dcd-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 2000; display: flex; align-items: center; justify-content: center; }
.dcd-card { width: min(720px, 92vw); max-height: 82vh; display: flex; flex-direction: column; background: var(--bg, #fff); color: var(--text, #222); border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.25); overflow: hidden; }
.dcd-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border, #eee); }
.dcd-title { display: inline-flex; align-items: center; gap: 7px; font-weight: 700; font-size: 14px; color: #c62828; }
.dcd-tool { font-size: 11px; color: var(--text-secondary, #888); background: var(--bg-soft, #f5f5f5); padding: 2px 8px; border-radius: 10px; }
.dcd-path { padding: 8px 16px; font-size: 12px; color: var(--text-secondary, #555); word-break: break-all; background: var(--bg-soft, #f5f5f5); border-bottom: 1px solid var(--border, #eee); }
.dcd-hint { margin: 12px 16px 6px; font-size: 12px; color: var(--text-secondary, #888); }
.dcd-diff { margin: 0 16px; flex: 1; min-height: 120px; max-height: 46vh; overflow: auto; font-size: 12px; line-height: 1.6; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #1e1e2e; color: #e6e6e6; border-radius: 8px; padding: 12px; white-space: pre; }
.dcd-actions { display: flex; align-items: center; gap: 10px; padding: 14px 16px; }
.dcd-remember { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary, #666); cursor: pointer; user-select: none; }
.dcd-remember input { cursor: pointer; }
.dcd-spacer { flex: 1; }
.dcd-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 18px; border-radius: 8px; border: 1px solid var(--border, #ddd); cursor: pointer; font-size: 13px; font-weight: 600; }
.dcd-btn--reject { background: var(--bg-input, #fff); color: var(--text-secondary, #666); }
.dcd-btn--reject:hover { border-color: #c62828; color: #c62828; }
.dcd-btn--apply { background: #4caf50; border-color: #4caf50; color: #fff; }
.dcd-btn--apply:hover { opacity: .9; }
</style>
