import { createApp } from "vue";
import { createPinia } from "pinia";
import { listen } from "@tauri-apps/api/event";
import App from "./App.vue";
import { useMcpStore } from "./stores/mcp";
import { useOllamaStore } from "./stores/ollama";
import { useChatStore } from "./stores/chat";
import { useUiStore } from "./stores/ui";
import "./assets/styles/main.css";

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
// 确保 mcp store 在应用启动时即实例化：
// 触发配置加载与已启用 MCP 服务器的自动重连（Pinia store 默认惰性初始化，
// 若不主动实例化，需用户打开 MCP 面板才生效，导致工具提示缺失）
useMcpStore();
// 全局注册 Ollama 进度监听并做首次硬件/服务检测（不随设置界面关闭而中断）
useOllamaStore().init();

// Rust 端一键部署完成后自动刷新 API 配置（自动切换为本地 Ollama，无需手动配置）
listen("ollama-configured", () => {
  const chat = useChatStore();
  chat.reloadProfilesFromRust().catch(() => {});
});
app.mount("#app");

// 系统菜单栏事件分发：菜单在 src-tauri/src/lib.rs 构建，点击后经 Rust
// on_menu_event 转发为 "menu://action" 事件，这里按动作 id 路由到对应功能。
listen<string>("menu://action", (e) => {
  const ui = useUiStore();
  const chat = useChatStore();
  switch (e.payload) {
    case "about": ui.openAbout(); break;
    case "settings": ui.openSettings("api"); break;
    case "new-chat": chat.createConversation(); break;
    case "export-md": ui.requestExport(); break;
    case "toggle-sidebar": ui.toggleSidebar(); break;
    case "toggle-theme": ui.requestThemeToggle(); break;
    case "open-skills": ui.openSkills(); break;
    case "open-mcp": ui.openSettings("mcp"); break;
    case "open-ollama": ui.openSettings("ollama"); break;
    case "open-stats": ui.openSettings("stats"); break;
    case "open-tasks": ui.openSettings("tasks"); break;
    case "open-health": ui.openSettings("health"); break;
    case "open-agents": ui.openSettings("agents"); break;
  }
}).catch(() => {});
