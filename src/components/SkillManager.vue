<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useSkillStore } from "@/stores/skill";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { homeDir } from "@tauri-apps/api/path";
import { getSettings, updateSettings } from "@/api/appSettings";
import {
  importOrigin,
  planSkillImport,
  skillSourceSpecs,
  summarizePlan,
  type ExternalSkillFile,
  type ImportPlan,
} from "@/utils/skill-import";
import {
  packInputsFromSkills,
  packSlugOf,
  readPack,
  type PackSkillMeta,
  type SkillPackRead,
} from "@/utils/skill-pack";
import { useUiStore } from "@/stores/ui";
import { SKILL_CATALOG } from "@/data/skills-catalog";
import { BookOpen, Package, Download, Pencil, Upload, Trash2, FolderUp } from "lucide-vue-next";

import type { Skill } from "@/types";

const store = useSkillStore();
const ui = useUiStore();
const activeTab = ref<"mine" | "catalog" | "import">("mine");
const editing = ref<string | null>(null);
const form = ref<
  Pick<Skill, "name" | "description" | "prompt" | "category" | "enabled" | "source" | "whenToUse">
>({
  name: "",
  description: "",
  prompt: "",
  category: "通用",
  enabled: true,
  source: "user",
  whenToUse: "",
});
const importUrl = ref("");
const importMdText = ref("");
const importMsg = ref("");
const importing = ref(false);
const fileInput = ref<HTMLInputElement>();
/** 设置里的自定义技能目录（每行一个；保存后下次扫描生效） */
const customDirsText = ref("");
/** 批量导出：勾选的技能 id */
const selectedIds = ref<string[]>([]);
const exporting = ref(false);
/** 同名冲突策略（目录扫描 / 多选文件 / 技能包三种批量导入共用） */
const conflictStrategy = ref<"skip" | "overwrite" | "rename">("skip");

/** 来源徽标文案（无 importUrl / 识别不出时为「外部导入」） */
const originLabel = (url?: string) => importOrigin(url)?.label ?? "";

const myEnabled = computed(() => store.skills.filter((s) => s.enabled).length);

function open() {
  activeTab.value = store.skills.length > 0 ? "mine" : "catalog";
  loadCustomDirs();
  ui.openSkills();
}

function cancel() {
  ui.closeSkills();
  editing.value = null;
  importMsg.value = "";
}

/** 把设置里的自定义目录读进文本框（设置可能异步加载完成，故每次打开都同步） */
function loadCustomDirs() {
  customDirsText.value = (getSettings().customSkillDirs ?? []).join("\n");
}

/** 保存自定义目录：去空行 → 写设置 → 下次扫描生效 */
function saveCustomDirs() {
  const dirs = customDirsText.value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  updateSettings({ customSkillDirs: dirs });
  customDirsText.value = dirs.join("\n");
  importMsg.value = dirs.length
    ? `✅ 已保存 ${dirs.length} 个自定义技能目录（下次扫描生效）`
    : "✅ 已清空自定义技能目录";
}

// 从菜单栏「技能库」打开时，同样初始化到合适的分页
watch(
  () => ui.skillsOpen,
  (v) => {
    if (v) {
      activeTab.value = store.skills.length > 0 ? "mine" : "catalog";
      loadCustomDirs();
    }
  },
);

function openEdit(id: string) {
  const s = store.skills.find((x) => x.id === id);
  if (s) {
    editing.value = id;
    form.value = {
      name: s.name,
      description: s.description,
      prompt: s.prompt,
      category: s.category,
      enabled: s.enabled,
      source: s.source,
      whenToUse: s.whenToUse || "",
    };
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
function installCatalog(item: (typeof SKILL_CATALOG)[0]) {
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

// 文件导入（支持多选/多拖：一次选多个 .md）
async function importFileList(list: File[]) {
  if (!list.length) return;
  importing.value = true;
  try {
    const files: ExternalSkillFile[] = [];
    for (const f of list) {
      files.push({
        source: "file",
        label: "本地文件",
        path: f.name,
        name: f.name,
        content: await f.text(),
        bytes: f.size,
      });
    }
    const plan = planSkillImport(files, store.skills, {
      onNameConflict: conflictStrategy.value,
    });
    const { added, updated } = applyPlan(plan);
    importMsg.value = `✅ ${summarizePlan(plan)}（实际写入：新增 ${added}、更新 ${updated}）${conflictNote(plan)}`;
  } catch (err) {
    importMsg.value = `❌ ${err instanceof Error ? err.message : "读取失败"}`;
  }
  importing.value = false;
}

async function onFilesChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const list = Array.from(input.files ?? []);
  input.value = ""; // 允许连续两次选同一批文件
  await importFileList(list);
}

/** 同名冲突提示（按当前策略口味措辞） */
function conflictNote(plan: ImportPlan): string {
  if (!plan.conflicts.length) return "";
  const how = conflictStrategy.value === "skip" ? "已跳过" : "未处理";
  return `；同名冲突 ${plan.conflicts.length} 个${how}`;
}

/**
 * 把导入计划落到技能库（目录扫描 / 多选文件 / 技能包三条路径共用）。
 * `metaBySlug` 用于补写技能包里的 references 与能力声明（包内 manifest 带来）。
 */
function applyPlan(plan: ImportPlan, metaBySlug?: Map<string, PackSkillMeta>) {
  let added = 0;
  let updated = 0;
  for (const item of plan.items) {
    const meta = metaBySlug?.get(packSlugOf(item.file.path));
    const patch: Partial<Skill> = meta
      ? {
          tags: meta.tags ?? [],
          version: meta.version,
          whenToUse: meta.whenToUse ?? item.draft.whenToUse,
          requires: meta.requires,
          references: meta.references?.length ? meta.references : undefined,
        }
      : {};
    if (item.action === "update" && item.targetId) {
      const target = store.skills.find((s) => s.id === item.targetId);
      if (target) {
        target.name = item.renameTo ?? item.draft.name;
        target.description = item.draft.description;
        target.prompt = item.draft.prompt;
        target.updatedAt = Date.now();
        if (meta) store.updateSkill(target.id, patch);
        updated++;
        continue;
      }
    }
    const s = store.importFromMd(item.file.content, item.file.path);
    if (s) {
      const extra: Partial<Skill> = { ...patch };
      if (item.renameTo) extra.name = item.renameTo;
      if (Object.keys(extra).length) store.updateSkill(s.id, extra);
      added++;
    }
  }
  return { added, updated };
}

// 勾选/全选（批量导出）
function toggleSelect(id: string) {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((x) => x !== id)
    : [...selectedIds.value, id];
}
const allSelected = computed(
  () => store.skills.length > 0 && selectedIds.value.length === store.skills.length,
);
function toggleSelectAll() {
  selectedIds.value = allSelected.value ? [] : store.skills.map((s) => s.id);
}

// 批量导出为技能包（.zip）：每个技能一个 <slug>/SKILL.md，可直接丢进 ~/.agents/skills
async function doExportPack() {
  const picked = store.skills.filter((s) => selectedIds.value.includes(s.id));
  if (!picked.length) {
    importMsg.value = "❌ 请先勾选要导出的技能";
    return;
  }
  exporting.value = true;
  importMsg.value = `正在打包 ${picked.length} 个技能…`;
  try {
    const skills = packInputsFromSkills(picked, (id) => store.exportAsMd(id));
    const path = await invoke<string>("export_skill_pack", { skills, fileName: null });
    importMsg.value = `✅ 已导出 ${skills.length} 个技能到技能包：${path}`;
  } catch (e) {
    importMsg.value = `❌ ${e instanceof Error ? e.message : "导出失败"}`;
  }
  exporting.value = false;
}

// 导入技能包（.zip，批量；支持冲突策略与 references 落地）
async function doImportPack() {
  const path = await openDialog({
    multiple: false,
    filters: [{ name: "道生一技能包", extensions: ["zip"] }],
  });
  if (!path || Array.isArray(path)) return;
  importing.value = true;
  importMsg.value = "正在读取技能包…";
  try {
    const read = await invoke<SkillPackRead>("import_skill_pack", { path });
    const packName = path.split("/").pop() || "技能包";
    const { files, metaBySlug } = readPack(read, packName);
    const plan = planSkillImport(files, store.skills, {
      onNameConflict: conflictStrategy.value,
    });
    // Rust 侧忽略的条目（越界路径 / 超限）要如实告知，不能装作没看见
    const ignoredNote = read.ignored
      ? `；包内有 ${read.ignored} 个条目被忽略（路径越界或超过体积上限）`
      : "";
    if (!plan.items.length) {
      importMsg.value = `技能包里没有可导入的技能（${files.length} 个技能）${conflictNote(plan)}${ignoredNote}`;
      importing.value = false;
      return;
    }
    const { added, updated } = applyPlan(plan, metaBySlug);
    importMsg.value = `✅ ${summarizePlan(plan)}（实际写入：新增 ${added}、更新 ${updated}）${conflictNote(plan)}${ignoredNote}`;
  } catch (e) {
    importMsg.value = `❌ ${e instanceof Error ? e.message : "导入技能包失败"}`;
  }
  importing.value = false;
}

// P1-9a 外部技能导入：扫描 Claude Code / Codex / Cursor 等目录并一键导入
async function doExternalImport() {
  importing.value = true;
  importMsg.value = "正在扫描外部技能目录…";
  try {
    const home = (await homeDir()).replace(/\/+$/, "");
    const workspace = String(getSettings().workspace ?? "");
    const specs = skillSourceSpecs(home, workspace, getSettings().customSkillDirs ?? []);
    const specLabel = new Map(specs.map((s) => [s.id, s.label]));
    if (!specs.length) {
      importMsg.value = "❌ 未能确定主目录，无法扫描外部技能";
      importing.value = false;
      return;
    }
    const files = await invoke<ExternalSkillFile[]>("scan_external_skills", {
      sources: specs,
      workspace: workspace || null,
    });
    const plan = planSkillImport(files, store.skills, {
      onNameConflict: conflictStrategy.value,
    });
    if (!plan.items.length) {
      const detail = [
        plan.conflicts.length ? `${plan.conflicts.length} 个同名冲突` : "",
        plan.skipped.length ? `${plan.skipped.length} 个跳过` : "",
      ]
        .filter(Boolean)
        .join("；");
      importMsg.value = `没找到可导入的技能（扫描 ${files.length} 个文件）${detail ? `：${detail}` : ""}`;
      importing.value = false;
      return;
    }
    const { added, updated } = applyPlan(plan);
    const srcText = Object.entries(plan.bySource)
      .map(([k, v]) => `${specLabel.get(k) ?? k} ${v}`)
      .join(" · ");
    // 用**实际写入**的计数（plan 里的新增/更新是意图，这里是结果，两者不一致时以这里为准）
    importMsg.value =
      `✅ ${summarizePlan(plan)}（实际写入：新增 ${added}、更新 ${updated}；扫到 ${files.length} 个文件：${srcText}）` +
      conflictNote(plan);
  } catch (e) {
    importMsg.value = `❌ ${e instanceof Error ? e.message : "扫描失败"}`;
  }
  importing.value = false;
}

// 导出
function doExport(id: string) {
  const md = store.exportAsMd(id);
  const s = store.skills.find((x) => x.id === id);
  const blob = new Blob([md], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${s?.name || "skill"}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

const categoryColors: Record<string, string> = {
  开发: "#4a9eff",
  运维: "#f0a040",
  安全: "#e05555",
  架构: "#a855f7",
  文档: "#22c55e",
  性能: "#f472b6",
  设计: "#38bdf8",
  通用: "#888",
  导入: "#666",
};
</script>

<template>
  <div class="skill-manager">
    <button class="skill-trigger" title="技能库" @click="open">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
      <span v-if="store.skills.length" class="skill-count"
        >{{ myEnabled }}/{{ store.skills.length }}</span
      >
    </button>

    <Teleport to="body">
      <div v-if="ui.skillsOpen" class="sk-overlay" @click.self="cancel">
        <div class="sk-panel">
          <!-- Header + Tabs -->
          <div class="sk-head">
            <h3><BookOpen :size="17" /> 技能库</h3>
            <div class="sk-tabs">
              <button
                :class="['sk-tab', { active: activeTab === 'mine' }]"
                @click="activeTab = 'mine'"
              >
                我的 ({{ myEnabled }}/{{ store.skills.length }})
              </button>
              <button
                :class="['sk-tab', { active: activeTab === 'catalog' }]"
                @click="activeTab = 'catalog'"
              >
                技能市场
              </button>
              <button
                :class="['sk-tab', { active: activeTab === 'import' }]"
                @click="activeTab = 'import'"
              >
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
              <input
                v-model="form.category"
                placeholder="分类（如 开发、安全、运维）"
                class="sk-input"
              />
              <input
                v-model="form.whenToUse"
                placeholder="适用场景（可选，如：需要审查代码安全/质量时）——渐进披露据此匹配"
                class="sk-input"
              />
              <textarea
                v-model="form.prompt"
                placeholder="技能提示词…"
                class="sk-textarea"
                rows="5"
              ></textarea>
              <div class="sk-form-acts">
                <button class="sk-btn sk-btn-pri" @click="saveEdit">保存</button>
                <button class="sk-btn sk-btn-sec" @click="editing = null">取消</button>
              </div>
            </div>

            <div v-if="store.skills.length === 0 && !editing" class="sk-empty">
              还没有技能，去 <a href="#" @click.prevent="activeTab = 'catalog'">技能市场</a> 安装
            </div>

            <div v-if="store.skills.length" class="sk-list-bar">
              <label class="sk-pick">
                <input type="checkbox" :checked="allSelected" @change="toggleSelectAll" />
                <span>全选</span>
              </label>
              <span class="sk-pick-count"
                >已选 {{ selectedIds.length }} / {{ store.skills.length }}</span
              >
              <button
                class="sk-btn sk-btn-sec sk-btn-sm"
                :disabled="exporting || !selectedIds.length"
                @click="doExportPack"
              >
                {{ exporting ? "打包中…" : "导出为技能包 (.zip)" }}
              </button>
            </div>

            <div v-for="s in store.skills" :key="s.id" class="sk-item" :class="{ off: !s.enabled }">
              <label class="sk-pick" :title="selectedIds.includes(s.id) ? '取消选择' : '选择导出'">
                <input
                  type="checkbox"
                  :checked="selectedIds.includes(s.id)"
                  @change="toggleSelect(s.id)"
                />
              </label>
              <div class="sk-item-info" @click="openEdit(s.id)">
                <div class="sk-item-name">
                  {{ s.name }}
                  <span
                    class="sk-tag"
                    :style="{ background: categoryColors[s.category] || '#888' }"
                    >{{ s.category }}</span
                  >
                  <span class="sk-src-tag">
                    <Package v-if="s.source === 'catalog'" :size="12" />
                    <Download v-else-if="s.source === 'import'" :size="12" />
                    <Pencil v-else :size="12" />
                  </span>
                  <span v-if="originLabel(s.importUrl)" class="sk-origin-tag">{{
                    originLabel(s.importUrl)
                  }}</span>
                </div>
                <div class="sk-item-desc">{{ s.description || "无描述" }}</div>
                <div v-if="s.whenToUse" class="sk-item-desc" style="opacity: 0.65; font-size: 11px">
                  适用：{{ s.whenToUse }}
                </div>
              </div>
              <div class="sk-item-acts">
                <button class="sk-btn-mini" title="导出为 .md" @click="doExport(s.id)">
                  <Upload :size="14" />
                </button>
                <label class="sk-toggle">
                  <input type="checkbox" :checked="s.enabled" @change="store.toggleSkill(s.id)" />
                  <span class="sk-toggle-s"></span>
                </label>
                <button class="sk-btn-mini" title="删除" @click="store.removeSkill(s.id)">
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>

            <button
              v-if="editing === null"
              class="sk-btn sk-btn-pri sk-btn-fw"
              @click="editing = ''"
            >
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
                  <span
                    class="sk-tag"
                    :style="{ background: categoryColors[item.category] || '#888' }"
                    >{{ item.category }}</span
                  >
                </div>
                <div class="sk-item-desc">{{ item.description }}</div>
                <div class="sk-item-tags">
                  <span v-for="t in item.tags" :key="t" class="sk-mini-tag">{{ t }}</span>
                </div>
              </div>
              <div class="sk-item-acts">
                <button
                  v-if="store.isInstalled(item.id)"
                  class="sk-btn sk-btn-sec sk-btn-sm"
                  @click="store.toggleSkill(item.id)"
                >
                  {{ store.skills.find((s) => s.id === item.id)?.enabled ? "已启用" : "已禁用" }}
                </button>
                <button v-else class="sk-btn sk-btn-pri sk-btn-sm" @click="installCatalog(item)">
                  安装
                </button>
              </div>
            </div>
          </div>

          <!-- Tab: 导入 -->
          <div v-if="activeTab === 'import'" class="sk-body">
            <!-- 同名冲突策略（目录扫描 / 多选文件 / 技能包三条路径共用） -->
            <div class="sk-import-block">
              <h4>同名冲突处理</h4>
              <select v-model="conflictStrategy" class="sk-select">
                <option value="skip">跳过（默认：保留已有技能，不覆盖）</option>
                <option value="overwrite">覆盖（你手写的技能仍受保护）</option>
                <option value="rename">重命名导入（原名 (2)）</option>
              </select>
            </div>

            <!-- P1-9a 外部技能目录（Claude Code / Codex / Cursor） -->
            <div class="sk-import-block">
              <h4>从其它工具的技能目录导入（推荐）</h4>
              <p class="sk-hint">
                扫描 Claude Code（~/.claude/skills、~/.claude/commands）、<b>通用技能目录</b>
                （~/.agents/skills，即 <code>npx skills add</code> 装技能的位置）、<b>DSH</b>
                （~/.dsh/skills）、Codex（~/.codex/prompts）、当前项目的 .agents/skills ·
                .dsh/skills · .cursor/rules，以及你自己的 ~/Documents/道生一技能。
                目录包（<code>&lt;名字&gt;/SKILL.md</code>）与扁平（<code>&lt;名字&gt;.md</code>）都能识别。
                <b>永不覆盖你手写的同名技能</b>：来源文件没变过的会更新正文，同名冲突会跳过并告知。
              </p>
              <div class="sk-import-row">
                <button class="sk-btn sk-btn-pri" :disabled="importing" @click="doExternalImport">
                  {{ importing ? "扫描中…" : "扫描并导入" }}
                </button>
              </div>
              <textarea
                v-model="customDirsText"
                class="sk-textarea"
                rows="3"
                placeholder="自定义技能目录（每行一个，支持绝对路径或 ~/ 开头，如 ~/work/team-skills）"
              ></textarea>
              <button
                class="sk-btn sk-btn-sec sk-btn-sm"
                style="margin-top: 6px"
                @click="saveCustomDirs"
              >
                保存自定义目录
              </button>
            </div>

            <!-- 技能包（.zip，批量） -->
            <div class="sk-import-block">
              <h4>导入技能包（.zip · 批量）</h4>
              <p class="sk-hint">
                选一个技能包即可一次导入多个技能（含参考资料与能力声明）。包内布局为
                <code>&lt;名字&gt;/SKILL.md</code> + <code>&lt;名字&gt;/references/</code>——
                <b>可以直接丢进 ~/.agents/skills 或 ~/.claude/skills 给别的 agent 用</b>。
              </p>
              <div class="sk-import-row">
                <button class="sk-btn sk-btn-pri" :disabled="importing" @click="doImportPack">
                  {{ importing ? "处理中…" : "选择技能包 (.zip)" }}
                </button>
              </div>
            </div>

            <!-- URL -->
            <div class="sk-import-block">
              <h4>从 URL 导入</h4>
              <div class="sk-import-row">
                <input
                  v-model="importUrl"
                  placeholder="粘贴 .md 原始链接 (GitHub raw / Gist…)"
                  class="sk-input"
                  @keydown.enter="doUrlImport"
                />
                <button class="sk-btn sk-btn-pri" :disabled="importing" @click="doUrlImport">
                  {{ importing ? "导入中…" : "导入" }}
                </button>
              </div>
            </div>

            <!-- 文件 -->
            <div class="sk-import-block">
              <h4>从 .md 文件导入（可多选）</h4>
              <div
                class="sk-drop"
                @click="fileInput?.click()"
                @dragover.prevent
                @drop.prevent="(e) => importFileList(Array.from(e.dataTransfer?.files ?? []))"
              >
                <FolderUp :size="18" /> 拖拽 .md 文件到此处（可以多个），或点击选择
              </div>
              <input
                ref="fileInput"
                type="file"
                accept=".md,.markdown,text/markdown"
                multiple
                hidden
                @change="onFilesChange"
              />
            </div>

            <!-- 粘贴 -->
            <div class="sk-import-block">
              <h4>粘贴 Markdown 内容</h4>
              <textarea
                v-model="importMdText"
                class="sk-textarea"
                rows="6"
                placeholder="粘贴技能 Markdown 内容…

格式示例：
---
name: 代码审查
description: 审查代码安全与性能
category: 开发
---
你是一位资深代码审查专家…"
              ></textarea>
              <button class="sk-btn sk-btn-pri" style="margin-top: 8px" @click="doMdImport">
                导入
              </button>
            </div>

            <div v-if="importMsg" class="sk-msg" :class="{ err: importMsg.startsWith('❌') }">
              {{ importMsg }}
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* trigger button */
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

/* overlay & panel */
.sk-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sk-panel {
  background: #1a1a2e;
  border: 1px solid #2a2a3e;
  border-radius: 14px;
  width: 600px;
  height: min(85vh, 640px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* header */
.sk-head {
  display: flex;
  align-items: center;
  padding: 16px 20px 0;
  gap: 12px;
  flex-shrink: 0;
}
.sk-head h3 {
  margin: 0;
  font-size: 16px;
  white-space: nowrap;
}
.sk-tabs {
  display: flex;
  gap: 4px;
  flex: 1;
}
.sk-tab {
  padding: 6px 14px;
  border: none;
  border-radius: 8px 8px 0 0;
  background: transparent;
  color: #888;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s;
}
.sk-tab:hover {
  color: #ccc;
}
.sk-tab.active {
  background: #252540;
  color: #eee;
}
.sk-close {
  background: none;
  border: none;
  color: #999;
  cursor: pointer;
  font-size: 18px;
  padding: 0 0 0 8px;
}

/* body */
.sk-body {
  padding: 16px 20px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

/* items */
.sk-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border: 1px solid #252540;
  border-radius: 8px;
  margin-bottom: 6px;
  transition: opacity 0.2s;
}
.sk-item.off {
  opacity: 0.45;
}
.sk-item-info {
  flex: 1;
  cursor: pointer;
  min-width: 0;
}
.sk-item-name {
  font-size: 14px;
  font-weight: 600;
  color: #ddd;
  display: flex;
  align-items: center;
  gap: 6px;
}
.sk-item-desc {
  font-size: 12px;
  color: #777;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sk-item-tags {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  flex-wrap: wrap;
}
.sk-mini-tag {
  font-size: 10px;
  padding: 1px 6px;
  background: #252540;
  border-radius: 4px;
  color: #aaa;
}
.sk-item-acts {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.sk-src-tag {
  font-size: 10px;
  opacity: 0.6;
}
.sk-origin-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--border, #444);
  color: var(--text-soft, #999);
  opacity: 0.85;
  white-space: nowrap;
}
/* 批量导出：勾选栏 + 每行勾选框 */
.sk-list-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 2px 10px;
  border-bottom: 1px solid var(--border, #333);
  margin-bottom: 8px;
}
.sk-pick {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-soft, #999);
  cursor: pointer;
  flex-shrink: 0;
}
.sk-pick-count {
  font-size: 12px;
  color: var(--text-soft, #999);
  flex: 1;
}
.sk-select {
  width: 100%;
  padding: 7px 10px;
  border-radius: 6px;
  border: 1px solid var(--border, #333);
  background: var(--bg-input, #1b1b22);
  color: var(--text, #eee);
  font-size: 13px;
}
.sk-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  color: #fff;
  white-space: nowrap;
}

/* buttons */
.sk-btn {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.sk-btn-pri {
  background: #4a9eff;
  color: #fff;
}
.sk-btn-pri:hover {
  background: #3a8eef;
}
.sk-btn-sec {
  background: #333;
  color: #ccc;
}
.sk-btn-sec:hover {
  background: #444;
}
.sk-btn-fw {
  width: 100%;
  margin-top: 8px;
}
.sk-btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}
.sk-btn-mini {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  padding: 2px;
}
.sk-form-acts {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

/* form */
.sk-form {
  border-bottom: 1px solid #252540;
  padding-bottom: 12px;
  margin-bottom: 12px;
}
.sk-input,
.sk-textarea {
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
.sk-textarea {
  resize: vertical;
}

/* import */
.sk-import-block {
  margin-bottom: 16px;
}
.sk-import-block h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: #aaa;
}
.sk-import-row {
  display: flex;
  gap: 8px;
}
/* P1-9a 外部技能导入的说明文字 */
.sk-hint {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.6;
  color: #888;
}
.sk-import-row .sk-input {
  flex: 1;
  margin-bottom: 0;
}
.sk-drop {
  padding: 24px;
  border: 2px dashed #333;
  border-radius: 8px;
  text-align: center;
  color: #666;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s;
}
.sk-drop:hover {
  border-color: #555;
  color: #999;
}
.sk-msg {
  padding: 8px 12px;
  margin-top: 8px;
  border-radius: 6px;
  background: #0d3a0d;
  color: #4ade80;
  font-size: 13px;
}
.sk-msg.err {
  background: #3a0d0d;
  color: #f87171;
}

/* toggle */
.sk-toggle {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
}
.sk-toggle input {
  opacity: 0;
  width: 0;
  height: 0;
}
.sk-toggle-s {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: #444;
  border-radius: 20px;
  transition: 0.2s;
}
.sk-toggle-s::before {
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
.sk-toggle input:checked + .sk-toggle-s {
  background: #4a9eff;
}
.sk-toggle input:checked + .sk-toggle-s::before {
  transform: translateX(16px);
  background: #fff;
}

.sk-empty {
  text-align: center;
  color: #666;
  padding: 32px;
  font-size: 13px;
}
.sk-empty a {
  color: #4a9eff;
}
.sk-cat-desc {
  color: #666;
  font-size: 13px;
  margin-bottom: 12px;
}
</style>
