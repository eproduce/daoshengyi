<script setup lang="ts">
import { ref } from "vue";
import { useChatStore } from "@/stores/chat";

const chatStore = useChatStore();
// 是否显示归档视图（归档会话：恢复 / 导出 / 彻底删除）
const showArchived = ref(false);
</script>

<template>
  <div class="history-panel">
    <div class="history-panel__header">
      <h3>{{ showArchived ? "🗄 已归档" : "对话历史" }}</h3>
      <div class="history-panel__acts">
        <button v-if="!showArchived" class="btn-icon" title="查看归档" @click="showArchived = true">🗄</button>
        <button v-else class="btn-icon" title="返回对话列表" @click="showArchived = false">←</button>
        <button v-if="!showArchived" class="btn-icon" title="新建对话" @click="chatStore.createConversation()">＋</button>
      </div>
    </div>
    <div class="history-panel__list">
      <!-- 主列表（未归档） -->
      <template v-if="!showArchived">
        <div
          v-for="conv in chatStore.visibleConversations"
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
          <div class="history-item__btns">
            <button class="history-item__btn" title="导出为 Markdown" @click.stop="chatStore.downloadExport(conv.id, 'md')">⤓</button>
            <button class="history-item__btn" title="归档（隐藏，可恢复）" @click.stop="chatStore.archiveConversation(conv.id)">🗂</button>
            <button class="history-item__delete" title="删除对话" @click.stop="chatStore.deleteConversation(conv.id)">✕</button>
          </div>
        </div>
        <div v-if="chatStore.visibleConversations.length === 0" class="history-panel__empty">
          暂无对话，开始新对话吧
        </div>
      </template>

      <!-- 归档列表 -->
      <template v-else>
        <div
          v-for="conv in chatStore.archivedConversations"
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
          <div class="history-item__btns">
            <button class="history-item__btn" title="导出为 Markdown" @click.stop="chatStore.downloadExport(conv.id, 'md')">⤓</button>
            <button class="history-item__btn" title="恢复（移回主列表）" @click.stop="chatStore.unarchiveConversation(conv.id)">↩</button>
            <button class="history-item__delete" title="彻底删除" @click.stop="chatStore.deleteArchived(conv.id)">✕</button>
          </div>
        </div>
        <div v-if="chatStore.archivedConversations.length === 0" class="history-panel__empty">
          暂无归档会话
        </div>
      </template>
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

.history-panel__acts { display: flex; gap: 4px; }

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

.history-item__btns { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.history-item__btn {
  flex-shrink: 0; width: 26px; height: 26px; border: none;
  border-radius: 6px; background: transparent; color: var(--text-muted);
  font-size: 13px; cursor: pointer; opacity: 0;
  transition: all 0.15s; display: flex; align-items: center; justify-content: center;
}
.history-item:hover .history-item__btn { opacity: 1; }
.history-item__btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.history-item__delete:hover { background: var(--danger-bg); color: var(--danger-color); }

.history-panel__empty {
  padding: 32px 20px; text-align: center; color: var(--text-muted); font-size: 13px;
}
</style>
