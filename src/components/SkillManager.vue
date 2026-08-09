<script setup lang="ts">
import { ref } from "vue";
import { useSkillStore } from "@/stores/skill";

const store = useSkillStore();
const visible = ref(false);
const editing = ref<string | null>(null);
const form = ref({ name: "", description: "", prompt: "", enabled: true });

function openAdd() {
  editing.value = null;
  form.value = { name: "", description: "", prompt: "", enabled: true };
  visible.value = true;
}

function openEdit(id: string) {
  const s = store.skills.find((x) => x.id === id);
  if (s) {
    editing.value = id;
    form.value = { name: s.name, description: s.description, prompt: s.prompt, enabled: s.enabled };
    visible.value = true;
  }
}

function save() {
  if (!form.value.name.trim() || !form.value.prompt.trim()) return;
  if (editing.value) {
    store.updateSkill(editing.value, form.value);
  } else {
    store.addSkill(form.value);
  }
  visible.value = false;
}

function remove(id: string) {
  if (confirm("确定删除此技能？")) store.removeSkill(id);
}

function cancel() {
  visible.value = false;
}
</script>

<template>
  <div class="skill-manager">
    <button class="skill-trigger" @click="openAdd" title="技能库">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
        <line x1="8" y1="7" x2="16" y2="7"/>
        <line x1="8" y1="11" x2="14" y2="11"/>
      </svg>
      <span class="skill-count" v-if="store.skills.length">{{ store.skills.filter(s=>s.enabled).length }}/{{ store.skills.length }}</span>
    </button>

    <!-- 技能列表下拉 -->
    <Teleport to="body">
      <div v-if="visible" class="skill-overlay" @click.self="cancel">
        <div class="skill-panel">
          <div class="skill-header">
            <h3>📚 技能库</h3>
            <button class="btn-close" @click="cancel">✕</button>
          </div>

          <!-- 技能列表 -->
          <div class="skill-list">
            <div
              v-for="s in store.skills"
              :key="s.id"
              class="skill-item"
              :class="{ disabled: !s.enabled }"
            >
              <div class="skill-info" @click="openEdit(s.id)">
                <div class="skill-name">{{ s.name }}</div>
                <div class="skill-desc">{{ s.description || '无描述' }}</div>
              </div>
              <div class="skill-actions">
                <label class="toggle">
                  <input
                    type="checkbox"
                    :checked="s.enabled"
                    @change="store.toggleSkill(s.id)"
                  />
                  <span class="toggle-slider"></span>
                </label>
                <button class="btn-icon" @click="remove(s.id)" title="删除">🗑</button>
              </div>
            </div>
            <div v-if="store.skills.length === 0" class="skill-empty">
              暂无技能，点击下方按钮添加
            </div>
          </div>

          <!-- 编辑 / 新增表单 -->
          <div v-if="editing !== undefined || !editing" class="skill-form">
            <input v-model="form.name" placeholder="技能名称" class="input" />
            <input v-model="form.description" placeholder="简短描述（可选）" class="input" />
            <textarea
              v-model="form.prompt"
              placeholder="技能提示词（系统将注入到对话上下文中）"
              class="textarea"
              rows="6"
            ></textarea>
            <div class="form-actions">
              <button class="btn btn-primary" @click="save">
                {{ editing ? '保存' : '添加' }}
              </button>
              <button class="btn btn-secondary" @click="cancel">取消</button>
            </div>
          </div>

          <button v-if="!editing && editing !== null" class="btn btn-primary btn-full" @click="openAdd()">
            + 添加技能
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.skill-manager {
  display: inline-flex;
  align-items: center;
}
.skill-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid var(--border-color, #333);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary, #999);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
}
.skill-trigger:hover {
  color: var(--text-primary, #eee);
  border-color: var(--accent, #888);
}
.skill-count {
  font-size: 11px;
  color: var(--accent, #888);
}
.skill-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.skill-panel {
  background: #1a1a2e;
  border: 1px solid #333;
  border-radius: 12px;
  width: 520px;
  max-height: 80vh;
  overflow-y: auto;
  padding: 20px;
}
.skill-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.skill-header h3 {
  margin: 0;
  font-size: 16px;
}
.btn-close {
  background: none;
  border: none;
  color: #999;
  cursor: pointer;
  font-size: 18px;
}
.skill-list {
  margin-bottom: 16px;
  max-height: 40vh;
  overflow-y: auto;
}
.skill-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border: 1px solid #2a2a3e;
  border-radius: 8px;
  margin-bottom: 6px;
  transition: opacity 0.2s;
}
.skill-item.disabled { opacity: 0.5; }
.skill-info {
  flex: 1;
  cursor: pointer;
  min-width: 0;
}
.skill-name {
  font-size: 14px;
  font-weight: 600;
  color: #ddd;
}
.skill-desc {
  font-size: 12px;
  color: #777;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.skill-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.toggle {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
}
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle-slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: #444;
  border-radius: 20px;
  transition: 0.2s;
}
.toggle-slider::before {
  content: "";
  position: absolute;
  height: 16px;
  width: 16px;
  left: 2px;
  bottom: 2px;
  background: #aaa;
  border-radius: 50%;
  transition: 0.2s;
}
.toggle input:checked + .toggle-slider { background: #4a9eff; }
.toggle input:checked + .toggle-slider::before {
  transform: translateX(16px);
  background: #fff;
}
.btn-icon {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  padding: 2px;
}
.skill-form {
  border-top: 1px solid #2a2a3e;
  padding-top: 12px;
}
.skill-form .input,
.skill-form .textarea {
  width: 100%;
  padding: 8px 12px;
  margin-bottom: 8px;
  border: 1px solid #333;
  border-radius: 6px;
  background: #0d0d1a;
  color: #ddd;
  font-size: 13px;
  box-sizing: border-box;
  font-family: inherit;
}
.skill-form .textarea {
  resize: vertical;
}
.form-actions {
  display: flex;
  gap: 8px;
}
.btn {
  padding: 6px 16px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.btn-primary { background: #4a9eff; color: #fff; }
.btn-primary:hover { background: #3a8eef; }
.btn-secondary { background: #333; color: #ccc; }
.btn-full { width: 100%; margin-top: 8px; }
.skill-empty {
  text-align: center;
  color: #666;
  padding: 24px;
  font-size: 13px;
}
</style>
