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
    case "open-memory": ui.openSettings("memory"); break;
  }
}).catch(() => {});

// ── 修复复制 KaTeX 公式字母翻倍 ───────────────────────────────────────
// KaTeX 每个公式含「隐藏的 MathML 无障碍层 + 可见 HTML 层」，复制时两层都会被选中，
// 导致 "$p$" 复制成 "pp"、"3^6=729" 复制成 "36=72936=729"。
// 这里在 copy 事件中剥离选区里的 .katex-mathml，只保留可见层（对所有复制方式生效）。
// 说明：user-select:none（main.css）已覆盖常规鼠标选择；此处理器兜底 ⌘A/程序化复制等。
document.addEventListener("copy", (e) => {
  try {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const frag = sel.getRangeAt(0).cloneContents();
    if (!frag.querySelector(".katex")) return; // 选区里没有公式就不干预默认复制
    frag.querySelectorAll(".katex .katex-mathml").forEach((n) => n.remove());
    const holder = document.createElement("div");
    holder.style.position = "fixed";
    holder.style.left = "-9999px";
    holder.appendChild(frag);
    document.body.appendChild(holder);
    const text = holder.textContent ?? "";
    const html = holder.innerHTML;
    holder.remove();
    if (e.clipboardData) {
      e.clipboardData.setData("text/plain", text);
      e.clipboardData.setData("text/html", html);
      e.preventDefault();
    }
  } catch { /* 异常时回退系统默认复制 */ }
});
