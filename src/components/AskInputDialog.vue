<script setup lang="ts">
// 融合 Codex 的 request_user_input：Agent 在长任务中途**向用户提问**并等待回答，
// 而不是「问完就结束回合」。用应用内弹窗（WKWebView 下原生 prompt 不可用），
// 复用 editConfirm 的 Promise 挂起模式；用户点「停止」按跳过处理，避免工具循环挂死。
import { computed, ref, watch } from "vue";
import { useChatStore } from "@/stores/chat";
import { HelpCircle, Send, SkipForward } from "lucide-vue-next";

const chatStore = useChatStore();
const req = computed(() => chatStore.askInput);
const answer = ref("");

watch(req, (r) => {
  answer.value = r?.defaultValue ?? "";
});

function submit() {
  const text = answer.value.trim();
  if (!text) return; // 空回答请用「跳过」
  chatStore.resolveAskInput(text);
}
function skip() {
  chatStore.resolveAskInput(null);
}
function pick(choice: string) {
  chatStore.resolveAskInput(choice);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="req" class="aid-overlay">
      <div class="aid-card">
        <header class="aid-head">
          <span class="aid-title"><HelpCircle :size="16" /> Agent 想跟你确认</span>
        </header>
        <p class="aid-question">{{ req.question }}</p>
        <p v-if="req.context" class="aid-context">{{ req.context }}</p>

        <div v-if="req.choices?.length" class="aid-choices">
          <button v-for="c in req.choices" :key="c" class="aid-choice" @click="pick(c)">
            {{ c }}
          </button>
        </div>

        <textarea
          v-model="answer"
          class="aid-input"
          rows="3"
          :placeholder="req.placeholder || '输入你的回答（Enter 提交，Shift+Enter 换行）'"
          @keydown.enter.exact.prevent="submit"
        ></textarea>

        <div class="aid-actions">
          <span class="aid-hint">跳过 = Agent 按「无法确认」继续推进</span>
          <span class="aid-spacer"></span>
          <button class="aid-btn aid-btn--skip" @click="skip">
            <SkipForward :size="14" /> 跳过
          </button>
          <button class="aid-btn aid-btn--send" :disabled="!answer.trim()" @click="submit">
            <Send :size="14" /> 提交
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.aid-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 2100;
  display: flex;
  align-items: center;
  justify-content: center;
}
.aid-card {
  width: min(560px, 92vw);
  background: var(--bg, #fff);
  color: var(--text, #222);
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.aid-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.aid-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 14px;
}
.aid-question {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.aid-context {
  margin: 0;
  font-size: 12.5px;
  opacity: 0.75;
  white-space: pre-wrap;
}
.aid-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.aid-choice {
  border: 1px solid var(--border, #ddd);
  background: transparent;
  color: inherit;
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12.5px;
  cursor: pointer;
}
.aid-choice:hover {
  border-color: var(--accent, #4c8bf5);
  color: var(--accent, #4c8bf5);
}
.aid-input {
  width: 100%;
  resize: vertical;
  border: 1px solid var(--border, #ddd);
  border-radius: 8px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 13px;
  background: var(--bg-input, transparent);
  color: inherit;
}
.aid-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.aid-hint {
  font-size: 11.5px;
  opacity: 0.6;
}
.aid-spacer {
  flex: 1;
}
.aid-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border-radius: 8px;
  border: 1px solid transparent;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}
.aid-btn--skip {
  background: transparent;
  border-color: var(--border, #ddd);
  color: inherit;
}
.aid-btn--send {
  background: var(--accent, #4c8bf5);
  color: #fff;
}
.aid-btn--send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
