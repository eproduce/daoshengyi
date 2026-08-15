import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { v4 as uuidv4 } from "./uuid";
import { initSettings, updateSettings, type McpServerPersist } from "@/api/appSettings";

interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
}

const STORAGE_KEY = "daoshengyi_mcp_servers";

// 同步兜底：先读 localStorage 旧数据（作为迁移源）
function loadLegacy(): McpServerConfig[] {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? JSON.parse(s) : [];
  } catch { return []; }
}

// 持久化形态 → 运行时形态（补运行时状态）
function toConfig(p: McpServerPersist): McpServerConfig {
  return { ...p, connected: false, toolCount: 0 };
}

export const useMcpStore = defineStore("mcp", () => {
  const servers = ref<McpServerConfig[]>(loadLegacy());

  function save() {
    updateSettings({
      mcpServers: servers.value.map((s) => ({
        id: s.id, name: s.name, command: s.command, args: s.args, enabled: s.enabled,
      })),
    });
  }
  watch(servers, save, { deep: true });

  // 异步从 Rust 加载；无 Rust 数据但有 localStorage 旧数据时执行迁移
  async function initFromRust() {
    if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return;
    try {
      const legacy = localStorage.getItem(STORAGE_KEY);
      const settings = await initSettings();
      if (settings.mcpServers.length > 0) {
        servers.value = settings.mcpServers.map(toConfig);
        if (legacy) localStorage.removeItem(STORAGE_KEY);
      } else if (legacy) {
        save();
        localStorage.removeItem(STORAGE_KEY);
      }
      // 应用启动后自动重连已启用的服务器，恢复工具可用性
      void autoConnectEnabled();
    } catch (e) {
      console.warn("[道生一] 从 Rust 加载 MCP 配置失败，回退 localStorage:", e);
    }
  }
  initFromRust();

  /** 自动重连所有已启用的 MCP 服务器（应用重启/页面刷新后恢复连接与工具缓存） */
  async function autoConnectEnabled() {
    for (const s of servers.value) {
      if (s.enabled && !s.connected) {
        try { await connect(s.id); } catch { /* 连接失败保持未连接，不阻塞 */ }
      }
    }
    // 刷新 chat store 的工具缓存，使工具提示可注入
    try { await syncToChat(); } catch { /* ignore */ }
  }

  function add(config: Omit<McpServerConfig, "id" | "connected" | "toolCount">) {
    servers.value.push({ ...config, id: uuidv4(), connected: false, toolCount: 0 });
  }

  function update(id: string, patch: Partial<McpServerConfig>) {
    const s = servers.value.find(x => x.id === id);
    if (s) Object.assign(s, patch);
  }

  async function remove(id: string) {
    const s = servers.value.find(x => x.id === id);
    // 删除已连接服务器时先断开（终止进程），避免进程残留
    if (s && s.connected) {
      try { await invoke("mcp_disconnect", { name: s.name }); } catch { /* ignore */ }
    }
    servers.value = servers.value.filter(x => x.id !== id);
  }

  async function connect(id: string) {
    const s = servers.value.find(x => x.id === id);
    if (!s) return;
    // MCP 依赖 Rust 后端，仅在 Tauri 桌面环境可用
    if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
      throw new Error("MCP 服务器需要在桌面应用中连接（当前为浏览器预览，Tauri API 不可用）");
    }
    try {
      const args = s.args.split(/\s+/).filter(a => a.length > 0);
      const tools = await invoke<{ name: string; description: string }[]>("mcp_connect", {
        name: s.name, command: s.command, args,
      });
      s.connected = true;
      s.toolCount = tools.length;
    } catch (e: unknown) {
      s.connected = false;
      s.toolCount = 0;
      throw e;
    }
  }

  const connectedCount = () => servers.value.filter(s => s.connected).length;
  const totalTools = () => servers.value.reduce((sum, s) => sum + s.toolCount, 0);

  // 同步到 chat store 的 MCP 缓存
  async function syncToChat() {
    try {
      const { refreshMcpTools } = await import("./chat");
      await refreshMcpTools();
    } catch { /* ignore */ }
  }

  /// 断开指定服务器（kill 进程，浏览器类服务器随之关闭浏览器，形成使用闭环）
  async function disconnect(id: string) {
    const s = servers.value.find(x => x.id === id);
    if (!s || !s.connected) return;
    try {
      await invoke("mcp_disconnect", { name: s.name });
    } finally {
      s.connected = false;
      s.toolCount = 0;
    }
  }

  /// 按服务器名标记为未连接（供 chat store 在任务完成后调用）
  function markDisconnected(serverNames: string[]) {
    for (const s of servers.value) {
      if (serverNames.includes(s.name)) {
        s.connected = false;
        s.toolCount = 0;
      }
    }
  }

  return {
    servers, add, update, remove, connect,
    connectEnabled: autoConnectEnabled, disconnect, markDisconnected,
    connectedCount, totalTools, syncToChat,
  };
});
