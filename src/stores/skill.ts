// 技能库 store：管理已启用技能（Skill）与内置技能目录（SkillCatalogItem）。
// 技能 = 一段系统提示词注入（专家指令），支持市场安装 / 导入导出 / 启用状态持久化。
import { defineStore } from "pinia";
import { ref, watch } from "vue";
import type { Skill, SkillCatalogItem } from "@/types";
import { v4 as uuidv4 } from "./uuid";

const STORAGE_KEY = "daoshengyi_skills";

function migrate(s: Skill): Skill {
  return {
    ...s,
    category: s.category || "通用",
    source: s.source || "user",
    version: s.version || "1.0",
  };
}

function loadSkills(): Skill[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw).map(migrate) : [];
  } catch {
    return [];
  }
}

/** 解析 .md 文件 frontmatter */
function parseMd(md: string): { name: string; description: string; prompt: string; category: string; author?: string } | null {
  const fmMatch = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (fmMatch) {
    const front = fmMatch[1];
    const body = fmMatch[2].trim();
    const get = (key: string) => {
      const m = front.match(new RegExp(`${key}:\\s*(.+)`, "i"));
      return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
    };
    const name = get("name") || get("title") || "未命名技能";
    const desc = get("description");
    const cat = get("category") || "导入";
    const author = get("author");
    return { name, description: desc, prompt: body, category: cat, author };
  }
  // 无 frontmatter：整个文件就是 prompt
  const lines = md.trim().split("\n");
  const name = lines[0].replace(/^#+\s*/, "").slice(0, 50) || "导入技能";
  return { name, description: "", prompt: md.trim(), category: "导入" };
}

export const useSkillStore = defineStore("skill", () => {
  const skills = ref<Skill[]>(loadSkills());

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(skills.value));
  }

  watch(skills, save, { deep: true });

  const enabledSkills = () => skills.value.filter((s) => s.enabled);

  const enabledPrompts = () =>
    enabledSkills()
      .map((s) => `## ${s.name}\n${s.prompt}`)
      .join("\n\n");

  // 检查目录项是否已安装
  function isInstalled(catalogId: string) {
    return skills.value.some((s) => s.id === catalogId || s.importUrl === catalogId);
  }

  // 从目录安装
  function installFromCatalog(item: SkillCatalogItem): Skill {
    const existing = skills.value.find((s) => s.id === item.id);
    if (existing) {
      existing.enabled = true;
      existing.updatedAt = Date.now();
      return existing;
    }
    const s: Skill = {
      id: item.id,
      name: item.name,
      description: item.description,
      prompt: item.prompt,
      enabled: true,
      category: item.category,
      source: "catalog",
      author: item.author,
      version: item.version,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    skills.value.push(s);
    return s;
  }

  // 从 .md 文本导入
  function importFromMd(md: string, url?: string): Skill | null {
    const parsed = parseMd(md);
    if (!parsed || !parsed.prompt.trim()) return null;
    const s: Skill = {
      id: uuidv4(),
      ...parsed,
      enabled: true,
      source: "import",
      importUrl: url,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    skills.value.push(s);
    return s;
  }

  // 从远程 URL 导入
  async function importFromUrl(url: string): Promise<Skill> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`下载失败: ${resp.status}`);
    const md = await resp.text();
    const result = importFromMd(md, url);
    if (!result) throw new Error("无法解析技能文件");
    return result;
  }

  // 从文件对象导入
  function importFromFile(file: File): Promise<Skill> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = importFromMd(reader.result as string, file.name);
        if (result) resolve(result);
        else reject(new Error("无法解析文件"));
      };
      reader.onerror = () => reject(new Error("读取文件失败"));
      reader.readAsText(file);
    });
  }

  // 导出技能为 .md
  function exportAsMd(id: string): string {
    const s = skills.value.find((x) => x.id === id);
    if (!s) return "";
    const fm = [
      "---",
      `name: ${s.name}`,
      s.description ? `description: ${s.description}` : "",
      s.category ? `category: ${s.category}` : "",
      s.author ? `author: ${s.author}` : "",
      s.version ? `version: ${s.version}` : "",
      "---",
    ].filter((l) => l !== "").join("\n");
    return fm + "\n\n" + s.prompt;
  }

  function addSkill(skill: Omit<Skill, "id" | "createdAt" | "updatedAt">): Skill {
    const s: Skill = {
      ...skill,
      id: uuidv4(),
      source: "user",
      category: skill.category || "通用",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    skills.value.push(s);
    return s;
  }

  function updateSkill(id: string, patch: Partial<Omit<Skill, "id" | "createdAt">>) {
    const s = skills.value.find((x) => x.id === id);
    if (s) Object.assign(s, patch, { updatedAt: Date.now() });
  }

  function removeSkill(id: string) {
    skills.value = skills.value.filter((x) => x.id !== id);
  }

  function toggleSkill(id: string) {
    const s = skills.value.find((x) => x.id === id);
    if (s) { s.enabled = !s.enabled; s.updatedAt = Date.now(); }
  }

  // 批量启用/禁用
  function setAllEnabled(enabled: boolean) {
    skills.value.forEach((s) => { s.enabled = enabled; s.updatedAt = Date.now(); });
  }

  return {
    skills, addSkill, updateSkill, removeSkill, toggleSkill,
    enabledSkills, enabledPrompts,
    installFromCatalog, importFromMd, importFromUrl, importFromFile,
    exportAsMd, isInstalled, setAllEnabled,
  };
});
