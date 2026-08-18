import { defineStore } from "pinia";

export type SettingsTab = "api" | "mcp" | "ollama" | "stats" | "health" | "tasks" | "agents";

// 全局 UI 意图状态：供系统菜单栏事件（main.ts 的 listen）与各组件共享。
// 链路：菜单点击 → Rust on_menu_event → emit "menu://action" → main.ts 分发 → 写本 store → 组件响应。
export const useUiStore = defineStore("ui", {
  state: () => ({
    settingsOpen: false,
    settingsTab: "api" as SettingsTab,
    aboutOpen: false,
    skillsOpen: false,
    sidebarVisible: true,
    themeToggleCounter: 0, // 菜单「切换主题」→ App.vue watch 后调用 toggleTheme
    exportCounter: 0,      // 菜单「导出对话」→ App.vue watch 后触发导出
  }),
  actions: {
    openSettings(tab: SettingsTab = "api") {
      this.settingsTab = tab;
      this.settingsOpen = true;
    },
    closeSettings() { this.settingsOpen = false; },
    openAbout() { this.aboutOpen = true; },
    closeAbout() { this.aboutOpen = false; },
    openSkills() { this.skillsOpen = true; },
    closeSkills() { this.skillsOpen = false; },
    toggleSidebar() { this.sidebarVisible = !this.sidebarVisible; },
    requestThemeToggle() { this.themeToggleCounter += 1; },
    requestExport() { this.exportCounter += 1; },
  },
});
