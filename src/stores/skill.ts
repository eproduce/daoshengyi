import { defineStore } from "pinia";
import { ref, watch } from "vue";
import type { Skill } from "@/types";
import { v4 as uuidv4 } from "./uuid";

const STORAGE_KEY = "daoshengyi_skills";

function loadSkills(): Skill[] {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? JSON.parse(s) : [];
  } catch {
    return [];
  }
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

  function addSkill(skill: Omit<Skill, "id" | "createdAt" | "updatedAt">): Skill {
    const s: Skill = {
      ...skill,
      id: uuidv4(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    skills.value.push(s);
    return s;
  }

  function updateSkill(id: string, patch: Partial<Omit<Skill, "id" | "createdAt">>) {
    const s = skills.value.find((x) => x.id === id);
    if (s) {
      Object.assign(s, patch, { updatedAt: Date.now() });
    }
  }

  function removeSkill(id: string) {
    skills.value = skills.value.filter((x) => x.id !== id);
  }

  function toggleSkill(id: string) {
    const s = skills.value.find((x) => x.id === id);
    if (s) {
      s.enabled = !s.enabled;
      s.updatedAt = Date.now();
    }
  }

  return { skills, addSkill, updateSkill, removeSkill, toggleSkill, enabledSkills, enabledPrompts };
});
