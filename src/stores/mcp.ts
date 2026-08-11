import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { v4 as uuidv4 } from "./uuid";

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

function load(): McpServerConfig[] {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? JSON.parse(s) : [];
  } catch { return []; }
}

export const useMcpStore = defineStore("mcp", () => {
  const servers = ref<McpServerConfig[]>(load());

  function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(servers.value)); }
  watch(servers, save, { deep: true });

  function add(config: Omit<McpServerConfig, "id" | "connected" | "toolCount">) {
    servers.value.push({ ...config, id: uuidv4(), connected: false, toolCount: 0 });
  }

  function update(id: string, patch: Partial<McpServerConfig>) {
    const s = servers.value.find(x => x.id === id);
    if (s) Object.assign(s, patch);
  }

  function remove(id: string) {
    servers.value = servers.value.filter(x => x.id !== id);
  }

  async function connect(id: string) {
    const s = servers.value.find(x => x.id === id);
    if (!s) return;
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

  return { servers, add, update, remove, connect, connectedCount, totalTools, syncToChat };
});
