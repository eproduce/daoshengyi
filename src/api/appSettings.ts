// 应用设置统一读写服务
// 所有配置（API 配置、MCP 服务器、活跃对话）统一经 Rust 端 SQLite 持久化，
// API Key 在 Rust 端 AES-256-GCM 加密后落盘。
// 本模块维护一份内存缓存，chat store 与 mcp store 通过 updateSettings 更新，
// 内部 debounce 合并写回 Rust，避免两个 store 各自写盘互相覆盖。

import { invoke } from "@tauri-apps/api/core";
import type { ApiProfile } from "@/types";

export interface McpServerPersist {
  id: string;
  name: string;
  command: string;
  args: string;
  enabled: boolean;
}

export interface AppSettingsPayload {
  profiles: ApiProfile[];
  activeProfileId: string;
  mcpServers: McpServerPersist[];
  activeConversationId: string | null;
  /// Agent 工作区目录
  workspace: string | null;
}

let cache: AppSettingsPayload = {
  profiles: [],
  activeProfileId: "",
  mcpServers: [],
  activeConversationId: null,
  workspace: null,
};
let loaded = false;
let loading: Promise<AppSettingsPayload> | null = null;

function isTauri(): boolean {
  return !!(window as unknown as { __TAURI__?: unknown }).__TAURI__;
}

/// 加载设置（仅首次真正 invoke，后续返回缓存）
export function initSettings(): Promise<AppSettingsPayload> {
  if (loading) return loading;
  loading = (async () => {
    if (loaded) return cache;
    if (isTauri()) {
      try {
        cache = await invoke<AppSettingsPayload>("load_app_settings");
      } catch (e) {
        console.warn("[道生一] 加载设置失败，使用默认:", e);
      }
    }
    loaded = true;
    return cache;
  })();
  return loading;
}

/// 同步获取当前缓存（可能尚未加载完成）
export function getSettings(): AppSettingsPayload {
  return cache;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveChain: Promise<void> = Promise.resolve();

/// 更新设置字段并 debounce 写回 Rust
export function updateSettings(patch: Partial<AppSettingsPayload>) {
  cache = { ...cache, ...patch };
  if (!isTauri()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const snapshot = JSON.stringify(cache);
    // 串行写，避免并发覆盖
    saveChain = saveChain
      .then(() => invoke("save_app_settings", { settings: JSON.parse(snapshot) }))
      .catch((e) => console.warn("[道生一] 保存设置失败:", e));
  }, 300);
}
