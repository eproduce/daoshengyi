<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useSkillStore } from "@/stores/skill";
import { useUiStore } from "@/stores/ui";
import { SKILL_CATALOG } from "@/data/skills-catalog";
import { BookOpen, Package, Download, Pencil, Upload, Trash2, FolderUp } from "lucide-vue-next";

import type { Skill } from "@/types";

const store = useSkillStore();
const ui = useUiStore();
const activeTab = ref<"mine" | "catalog" | "import">("mine");
const editing = ref<string | null>(null);
const form = ref<Pick<Skill, "name" | "description" | "prompt" | "category" | "enabled" | "source">>({
  name: "", description: "", prompt: "", category: "通用", enabled: true, source: "user",
});
const importUrl = ref("");
const importMdText = ref("");
const importMsg = ref("");
const importing = ref(false);
const fileInput = ref<HTMLInputElement>();

const myEnabled = computed(() => store.skills.filter(s => s.enabled).length);

function open() {
  activeTab.value = store.skills.length > 0 ? "mine" : "catalog";
  ui.openSkills();
}

function cancel() {
  ui.closeSkills();
  editing.value = null;
  importMsg.value = "";
}

// 从菜单栏「技能库」打开时，同样初始化到合适的分页
watch(() => ui.skillsOpen, (v) => {
  if (v) activeTab.value = store.skills.length > 0 ? "mine" : "catalog";
});

function openEdit(id: string) {
  const s = store.skills.find((x) => x.id === id);
  if (s) {
    editing.value = id;
    form.value = { name: s.name, description: s.description, prompt: s.prompt, category: s.category, enabled: s.enabled, source: s.source };
    activeTab.value = "mine";
  }
}

function saveEdit() {
  if (!form.value.name.trim() || !form.value.prompt.trim()) return;
  if (editing.value) {
    store.updateSkill(editing.value, form.value);
  } else {
    store.addSkill({ ...form.value });
  }
  editing.value = null;
}

// 目录安装
function installCatalog(item: typeof SKILL_CATALOG[0]) {
  store.installFromCatalog(item);
}

// URL 导入
async function doUrlImport() {
  if (!importUrl.value.trim()) return;
  importing.value = true;
  importMsg.value = "";
  try {
    const s = await store.importFromUrl(importUrl.value.trim());
    importMsg.value = `✅ 已导入: ${s.name}`;
    importUrl.value = "";
  } catch (e: unknown) {
    importMsg.value = `❌ ${e instanceof Error ? e.message : "导入失败"}`;
  }
  importing.value = false;
}

// MD 文本导入
function doMdImport() {
  if (!importMdText.value.trim()) return;
  const s = store.importFromMd(importMdText.value);
  if (s) {
    importMsg.value = `✅ 已导入: ${s.name}`;
    importMdText.value = "";
  } else {
    importMsg.value = "❌ 无法解析技能内容";
  }
}

// 文件导入
function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  store.importFromFile(file).then(s => {
    importMsg.value = `✅ 已导入: ${s.name}`;
  }).catch(err => {
    importMsg.value = `❌ ${err.message}`;
  });
}

// 导出
function doExport(id: string) {
  const md = store.exportAsMd(id);
  const s = store.skills.find(x => x.id === id);
  const blob = new Blob([md], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${s?.name || "skill"}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

const categoryColors: Record<string, string> = {
  "开发": "#4a9eff", "运维": "#f0a040", "安全": "#e05555",
  "架构": "#a855f7", "文档": "#22c55e", "性能": "#f472b6",
  "设计": "#38bdf8", "通用": "#888", "导入": "#666",
};
</script>

<template>
  <div class="skill-manager">
    <button class="skill-trigger" @click="open" title="技能库">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
      </svg>
      <span class="skill-count" v-if="store.skills.length">{{ myEnabled }}/{{ store.skills.length }}</span>
    </button>

    <Teleport to="body">
      <div v-if="ui.skillsOpen" class="sk-overlay" @click.self="cancel">
        <div class="sk-panel">

          <!-- Header + Tabs -->
          <div class="sk-head">
            <h3><BookOpen :size="17" /> 技能库</h3>
            <div class="sk-tabs">
              <button :class="['sk-tab', { active: activeTab === 'mine' }]" @click="activeTab = 'mine'">
                我的 ({{ myEnabled }}/{{ store.skills.length }})
              </button>
              <button :class="['sk-tab', { active: activeTab === 'catalog' }]" @click="activeTab = 'catalog'">
                技能市场
              </button>
              <button :class="['sk-tab', { active: activeTab === 'import' }]" @click="activeTab = 'import'">
                导入
              </button>
            </div>
            <button class="sk-close" @click="cancel">✕</button>
          </div>

          <!-- Tab: 我的技能 -->
          <div v-if="activeTab === 'mine'" class="sk-body">
            <div v-if="editing !== null" class="sk-form">
              <input v-model="form.name" placeholder="技能名称" class="sk-input" />
              <input v-model="form.description" placeholder="简短描述" class="sk-input" />
              <input v-model="form.category" placeholder="分类（如 开发、安全、运维）" class="sk-input" />
              <textarea v-model="form.prompt" placeholder="技能提示词…" class="sk-textarea" rows="5"></textarea>
              <div class="sk-form-acts">
                <button class="sk-btn sk-btn-pri" @click="saveEdit">保存</button>
                <button class="sk-btn sk-btn-sec" @click="editing = null">取消</button>
              </div>
            </div>

            <div v-if="store.skills.length === 0 && !editing" class="sk-empty">
              还没有技能，去 <a href="#" @click.prevent="activeTab='catalog'">技能市场</a> 安装
            </div>

            <div v-for="s in store.skills" :key="s.id" class="sk-item" :class="{ off: !s.enabled }">
              <div class="sk-item-info" @click="openEdit(s.id)">
                <div class="sk-item-name">
                  {{ s.name }}
                  <span class="sk-tag" :style="{ background: categoryColors[s.category] || '#888' }">{{ s.category }}</span>
                  <span class="sk-src-tag">
                    <Package v-if="s.source === 'catalog'" :size="12" />
                    <Download v-else-if="s.source === 'import'" :size="12" />
                    <Pencil v-else :size="12" />
                  </span>
                </div>
                <div class="sk-item-desc">{{ s.description || '无描述' }}</div>
              </div>
              <div class="sk-item-acts">
                <button class="sk-btn-mini" @click="doExport(s.id)" title="导出为 .md"><Upload :size="14" /></button>
                <label class="sk-toggle">
                  <input type="checkbox" :checked="s.enabled" @change="store.toggleSkill(s.id)" />
                  <span class="sk-toggle-s"></span>
                </label>
                <button class="sk-btn-mini" @click="store.removeSkill(s.id)" title="删除"><Trash2 :size="14" /></button>
              </div>
            </div>

            <button v-if="editing === null" class="sk-btn sk-btn-pri sk-btn-fw" @click="editing = '';">
              + 自定义技能
            </button>
          </div>

          <!-- Tab: 技能市场 -->
          <div v-if="activeTab === 'catalog'" class="sk-body">
            <div class="sk-cat-desc">安装社区精选技能，扩展 AI 助手的能力边界</div>
            <div v-for="item in SKILL_CATALOG" :key="item.id" class="sk-item">
              <div class="sk-item-info">
                <div class="sk-item-name">
                  {{ item.name }}
                  <span class="sk-tag" :style="{ background: categoryColors[item.category] || '#888' }">{{ item.category }}</span>
                </div>
                <div class="sk-item-desc">{{ item.description }}</div>
                <div class="sk-item-tags">
                  <span v-for="t in item.tags" :key="t" class="sk-mini-tag">{{ t }}</span>
                </div>
              </div>
              <div class="sk-item-acts">
                <button v-if="store.isInstalled(item.id)" class="sk-btn sk-btn-sec sk-btn-sm" @click="store.toggleSkill(item.id)">
                  {{ store.skills.find(s => s.id === item.id)?.enabled ? '已启用' : '已禁用' }}
                </button>
                <button v-else class="sk-btn sk-btn-pri sk-btn-sm" @click="installCatalog(item)">
                  安装
                </button>
              </div>
            </div>
          </div>

          <!-- Tab: 导入 -->
          <div v-if="activeTab === 'import'" class="sk-body">
            <!-- URL -->
            <div class="sk-import-block">
              <h4>从 URL 导入</h4>
              <div class="sk-import-row">
                <input v-model="importUrl" placeholder="粘贴 .md 原始链接 (GitHub raw / Gist…)" class="sk-input" @keydown.enter="doUrlImport" />
                <button class="sk-btn sk-btn-pri" :disabled="importing" @click="doUrlImport">{{ importing ? '导入中…' : '导入' }}</button>
              </div>
            </div>

            <!-- 文件 -->
            <div class="sk-import-block">
              <h4>从 .md 文件导入</h4>
              <div class="sk-drop" @click="fileInput?.click()" @dragover.prevent @drop.prevent="(e) => { const f = e.dataTransfer?.files?.[0]; if (f) store.importFromFile(f).then(s => importMsg = `✅ ${s.name}`).catch(e => importMsg = `❌ ${e.message}`); }">
                <FolderUp :size="18" /> 拖拽 .md 文件到此处，或点击选择
              </div>
              <input ref="fileInput" type="file" accept=".md,.markdown,text/markdown" hidden @change="onFileChange" />
            </div>

            <!-- 粘贴 -->
            <div class="sk-import-block">
              <h4>粘贴 Markdown 内容</h4>
              <textarea v-model="importMdText" class="sk-textarea" rows="6" placeholder="粘贴技能 Markdown 内容…

格式示例：
---
name: 代码审查
description: 审查代码安全与性能
category: 开发
---
你是一位资深代码审查专家…"></textarea>
              <button class="sk-btn sk-btn-pri" style="margin-top:8px" @click="doMdImport">导入</button>
            </div>

            <div v-if="importMsg" class="sk-msg" :class="{ err: importMsg.startsWith('❌') }">{{ importMsg }}</div>
          </div>

        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* trigger button */
.skill-manager { display:inline-flex;align-items:center; }
.skill-trigger { display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border:1px solid var(--border-color,#333);border-radius:6px;background:transparent;color:var(--text-secondary,#999);cursor:pointer;font-size:12px;transition:all .15s; }
.skill-trigger:hover { color:var(--text-primary,#eee);border-color:var(--accent,#888); }
.skill-count { font-size:11px;color:var(--accent,#888); }

/* overlay & panel */
.sk-overlay { position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1000;display:flex;align-items:center;justify-content:center; }
.sk-panel { background:#1a1a2e;border:1px solid #2a2a3e;border-radius:14px;width:600px;height:min(85vh,640px);display:flex;flex-direction:column;overflow:hidden; }

/* header */
.sk-head { display:flex;align-items:center;padding:16px 20px 0;gap:12px;flex-shrink:0; }
.sk-head h3 { margin:0;font-size:16px;white-space:nowrap; }
.sk-tabs { display:flex;gap:4px;flex:1; }
.sk-tab { padding:6px 14px;border:none;border-radius:8px 8px 0 0;background:transparent;color:#888;cursor:pointer;font-size:13px;transition:all .15s; }
.sk-tab:hover { color:#ccc; }
.sk-tab.active { background:#252540;color:#eee; }
.sk-close { background:none;border:none;color:#999;cursor:pointer;font-size:18px;padding:0 0 0 8px; }

/* body */
.sk-body { padding:16px 20px;overflow-y:auto;flex:1;min-height:0; }

/* items */
.sk-item { display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid #252540;border-radius:8px;margin-bottom:6px;transition:opacity .2s; }
.sk-item.off { opacity:.45; }
.sk-item-info { flex:1;cursor:pointer;min-width:0; }
.sk-item-name { font-size:14px;font-weight:600;color:#ddd;display:flex;align-items:center;gap:6px; }
.sk-item-desc { font-size:12px;color:#777;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
.sk-item-tags { display:flex;gap:4px;margin-top:4px;flex-wrap:wrap; }
.sk-mini-tag { font-size:10px;padding:1px 6px;background:#252540;border-radius:4px;color:#aaa; }
.sk-item-acts { display:flex;align-items:center;gap:6px;flex-shrink:0; }
.sk-src-tag { font-size:10px;opacity:.6; }
.sk-tag { font-size:10px;padding:1px 6px;border-radius:4px;color:#fff;white-space:nowrap; }

/* buttons */
.sk-btn { padding:6px 14px;border:none;border-radius:6px;cursor:pointer;font-size:13px; }
.sk-btn-pri { background:#4a9eff;color:#fff; }
.sk-btn-pri:hover { background:#3a8eef; }
.sk-btn-sec { background:#333;color:#ccc; }
.sk-btn-sec:hover { background:#444; }
.sk-btn-fw { width:100%;margin-top:8px; }
.sk-btn-sm { padding:4px 10px;font-size:12px; }
.sk-btn-mini { background:none;border:none;cursor:pointer;font-size:14px;padding:2px; }
.sk-form-acts { display:flex;gap:8px;margin-top:8px; }

/* form */
.sk-form { border-bottom:1px solid #252540;padding-bottom:12px;margin-bottom:12px; }
.sk-input,.sk-textarea { width:100%;padding:8px 12px;margin-bottom:8px;border:1px solid #333;border-radius:6px;background:#0d0d1a;color:#ddd;font-size:13px;box-sizing:border-box;font-family:inherit; }
.sk-textarea { resize:vertical; }

/* import */
.sk-import-block { margin-bottom:16px; }
.sk-import-block h4 { margin:0 0 8px;font-size:13px;color:#aaa; }
.sk-import-row { display:flex;gap:8px; }
.sk-import-row .sk-input { flex:1;margin-bottom:0; }
.sk-drop { padding:24px;border:2px dashed #333;border-radius:8px;text-align:center;color:#666;cursor:pointer;font-size:13px;transition:all .15s; }
.sk-drop:hover { border-color:#555;color:#999; }
.sk-msg { padding:8px 12px;margin-top:8px;border-radius:6px;background:#0d3a0d;color:#4ade80;font-size:13px; }
.sk-msg.err { background:#3a0d0d;color:#f87171; }

/* toggle */
.sk-toggle { position:relative;display:inline-block;width:36px;height:20px; }
.sk-toggle input { opacity:0;width:0;height:0; }
.sk-toggle-s { position:absolute;cursor:pointer;inset:0;background:#444;border-radius:20px;transition:.2s; }
.sk-toggle-s::before { content:"";position:absolute;height:16px;width:16px;left:2px;bottom:2px;background:#aaa;border-radius:50%;transition:.2s; }
.sk-toggle input:checked+.sk-toggle-s { background:#4a9eff; }
.sk-toggle input:checked+.sk-toggle-s::before { transform:translateX(16px);background:#fff; }

.sk-empty { text-align:center;color:#666;padding:32px;font-size:13px; }
.sk-empty a { color:#4a9eff; }
.sk-cat-desc { color:#666;font-size:13px;margin-bottom:12px; }
</style>
