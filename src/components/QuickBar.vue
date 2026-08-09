<script setup lang="ts">
import { useChatStore } from "@/stores/chat";
import { ref, onMounted, onUnmounted } from "vue";

const chatStore = useChatStore();
const emit = defineEmits<{
  openSettings: [];
}>();

const showDropdown = ref(false);
const dropdownRef = ref<HTMLDivElement>();
const selectorRef = ref<HTMLDivElement>();

function handleSelect(id: string) {
  chatStore.switchProfile(id);
  showDropdown.value = false;
}

function toggleDropdown() {
  showDropdown.value = !showDropdown.value;
}

function toggleThinking() {
  const profile = chatStore.activeProfile;
  if (profile) {
    chatStore.updateProfile(profile.id, { thinkingEnabled: !profile.thinkingEnabled });
  }
}

function onDocumentClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (
    showDropdown.value &&
    dropdownRef.value &&
    !dropdownRef.value.contains(target) &&
    selectorRef.value &&
    !selectorRef.value.contains(target)
  ) {
    showDropdown.value = false;
  }
}

onMounted(() => document.addEventListener("click", onDocumentClick));
onUnmounted(() => document.removeEventListener("click", onDocumentClick));
</script>

<template>
  <div class="quick-bar">
    <div ref="selectorRef" class="quick-bar__selector" @click="toggleDropdown">
      <span class="quick-bar__label">{{ chatStore.activeProfile?.name || "选择 API" }}</span>
      <span class="quick-bar__divider">·</span>
      <span class="quick-bar__model">{{ chatStore.activeProfile?.model || "未配置" }}</span>
      <span class="quick-bar__arrow">▾</span>
    </div>

    <!-- 思考模式开关 -->
    <button
      class="thinking-toggle"
      :class="{ 'thinking-toggle--on': chatStore.activeProfile?.thinkingEnabled }"
      @click="toggleThinking"
      :title="chatStore.activeProfile?.thinkingEnabled ? '关闭深度思考' : '开启深度思考'"
    >
      <span class="thinking-toggle__icon">🧠</span>
      <span class="thinking-toggle__label">{{ chatStore.activeProfile?.thinkingEnabled ? '深度思考' : '快速回答' }}</span>
    </button>

    <div v-if="showDropdown" ref="dropdownRef" class="quick-bar__dropdown">
      <div
        v-for="profile in chatStore.profiles"
        :key="profile.id"
        class="quick-bar__item"
        :class="{ 'quick-bar__item--active': profile.id === chatStore.activeProfileId }"
        @click="handleSelect(profile.id)"
      >
        <div class="quick-bar__item-top">
          <span class="quick-bar__item-name">{{ profile.name }}</span>
          <span v-if="profile.id === chatStore.activeProfileId" class="quick-bar__check">✓</span>
        </div>
        <div class="quick-bar__item-detail">
          {{ profile.model }} · {{ profile.baseUrl }}
        </div>
      </div>
      <div class="quick-bar__dropdown-footer">
        <button class="quick-bar__settings-btn" @click="emit('openSettings'); showDropdown = false">
          ⚙️ 管理配置
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.quick-bar {
  position: relative; padding: 10px 24px;
  background: var(--bg-elevated);
  border-top: 1px solid var(--border-color);
  display: flex; align-items: center; gap: 10px;
}

.quick-bar__selector {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 14px; border-radius: 22px;
  background: var(--bg-secondary); border: 1px solid var(--border-color);
  cursor: pointer; font-size: 12px;
  transition: all 0.2s; user-select: none;
}
.quick-bar__selector:hover {
  border-color: var(--accent-color); box-shadow: var(--shadow-sm);
}

.quick-bar__label {
  font-weight: 650; color: var(--text-primary);
}
.quick-bar__divider { color: var(--text-muted); }
.quick-bar__model {
  color: var(--text-secondary);
  font-family: "SF Mono", "Fira Code", monospace; font-size: 11px;
}
.quick-bar__arrow {
  color: var(--text-muted); font-size: 9px;
  transition: transform 0.2s;
}

.quick-bar__dropdown {
  position: absolute; bottom: calc(100% + 6px); left: 24px;
  width: 320px; max-height: 300px; overflow-y: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  z-index: 50; animation: popUp .18s cubic-bezier(0.4, 0, 0.2, 1);
}

.quick-bar__item {
  padding: 12px 16px; cursor: pointer;
  transition: background 0.12s;
}
.quick-bar__item:first-child { border-radius: var(--radius-lg) var(--radius-lg) 0 0; }
.quick-bar__item:hover { background: var(--bg-hover); }
.quick-bar__item--active { background: var(--bg-active); }

.quick-bar__item-top {
  display: flex; align-items: center; justify-content: space-between;
}
.quick-bar__item-name {
  font-size: 13px; font-weight: 600; color: var(--text-primary);
}
.quick-bar__check { color: var(--accent-color); font-weight: 700; font-size: 13px; }
.quick-bar__item-detail {
  font-size: 11px; color: var(--text-muted); margin-top: 2px;
  font-family: "SF Mono", "Fira Code", monospace;
}

.quick-bar__dropdown-footer {
  padding: 10px 16px; border-top: 1px solid var(--border-color);
}
.quick-bar__settings-btn {
  width: 100%; padding: 8px; border: none; border-radius: var(--radius-sm);
  background: var(--bg-secondary); color: var(--text-secondary);
  font-size: 12px; font-weight: 500; cursor: pointer; transition: all .15s;
}
.quick-bar__settings-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

@keyframes popUp {
  from { opacity: 0; transform: translateY(6px) scale(.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
</style>
