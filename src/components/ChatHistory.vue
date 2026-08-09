<script setup lang="ts">
import { useChatStore } from "@/stores/chat";

const chatStore = useChatStore();
</script>

<template>
  <div class="history-panel">
    <div class="history-panel__header">
      <h3>对话历史</h3>
      <button class="btn-icon" title="新建对话" @click="chatStore.createConversation()">＋</button>
    </div>
    <div class="history-panel__list">
      <div
        v-for="conv in chatStore.sortedConversations"
        :key="conv.id"
        class="history-item"
        :class="{ 'history-item--active': conv.id === chatStore.activeConversationId }"
        @click="chatStore.selectConversation(conv.id)"
      >
        <div class="history-item__content">
          <div class="history-item__title">{{ conv.title }}</div>
          <div class="history-item__meta">
            {{ conv.messages.length }} 条消息 · {{ new Date(conv.updatedAt).toLocaleDateString("zh-CN") }}
          </div>
        </div>
        <button
          class="history-item__delete"
          title="删除对话"
          @click.stop="chatStore.deleteConversation(conv.id)"
        >
          ✕
        </button>
      </div>
      <div v-if="chatStore.conversations.length === 0" class="history-panel__empty">
        暂无对话，开始新对话吧
      </div>
    </div>
  </div>
</template>

<style scoped>
.history-panel {
  display: flex; flex-direction: column; height: 100%;
  background: var(--bg-sidebar);
}

.history-panel__header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 16px 14px;
}

.history-panel__header h3 {
  font-size: 13px; font-weight: 650; color: var(--text-secondary);
  letter-spacing: 0.02em; text-transform: uppercase;
}

.btn-icon {
  width: 32px; height: 32px; border: none; border-radius: var(--radius-sm);
  background: var(--bg-secondary); color: var(--text-secondary);
  font-size: 18px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.2s;
}
.btn-icon:hover { background: var(--accent-bg); color: var(--accent-color); }

.history-panel__list { flex: 1; overflow-y: auto; padding: 0 10px 10px; }

.history-item {
  display: flex; align-items: center; padding: 10px 14px;
  border-radius: var(--radius-md); cursor: pointer;
  transition: all 0.15s; margin-bottom: 2px;
}
.history-item:hover { background: var(--bg-hover); }
.history-item--active { background: var(--bg-active); }

.history-item__content { flex: 1; min-width: 0; }
.history-item__title {
  font-size: 13px; font-weight: 550; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.history-item--active .history-item__title { font-weight: 650; color: var(--accent-color); }

.history-item__meta {
  font-size: 11px; color: var(--text-muted); margin-top: 3px;
}

.history-item__delete {
  flex-shrink: 0; width: 26px; height: 26px; border: none;
  border-radius: 6px; background: transparent; color: var(--text-muted);
  font-size: 12px; cursor: pointer; opacity: 0;
  transition: all 0.15s; display: flex; align-items: center; justify-content: center;
}
.history-item:hover .history-item__delete { opacity: 1; }
.history-item__delete:hover { background: var(--danger-bg); color: var(--danger-color); }

.history-panel__empty {
  padding: 32px 20px; text-align: center; color: var(--text-muted); font-size: 13px;
}
</style>
