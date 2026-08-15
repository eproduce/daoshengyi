import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { useMcpStore } from "./stores/mcp";
import "./assets/styles/main.css";

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
// 确保 mcp store 在应用启动时即实例化：
// 触发配置加载与已启用 MCP 服务器的自动重连（Pinia store 默认惰性初始化，
// 若不主动实例化，需用户打开 MCP 面板才生效，导致工具提示缺失）
useMcpStore();
app.mount("#app");
