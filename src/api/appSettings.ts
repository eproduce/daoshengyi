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
  /** 透传给 MCP server 进程的环境变量（如 PUPPETEER_EXECUTABLE_PATH 指定浏览器） */
  env?: Record<string, string>;
}

export interface AppSettingsPayload {
  profiles: ApiProfile[];
  activeProfileId: string;
  mcpServers: McpServerPersist[];
  activeConversationId: string | null;
  /// Agent 工作区目录
  workspace: string | null;
  /// YOLO 模式：开启后危险命令自动批准执行（不再弹确认）
  yoloMode: boolean;
  /// 危险命令审批模式：manual（手动确认，默认）/ smart（辅助模型智能判断）/ yolo（全部自动批准）
  approvalMode: "manual" | "smart" | "yolo";
  /// 辅助任务使用的 Profile（空 = 跟随主模型）：用于 Smart 审批 / 子代理等辅助任务
  auxiliaryProfileId: string;
  /// 飞书群机器人 Webhook（主动推送用）
  feishuWebhook: string;
  /// 企业微信群机器人 Webhook（主动推送用）
  wecomWebhook: string;
  /// 钉钉群机器人 Webhook（主动推送用）
  dingtalkWebhook: string;
  /// 钉钉群机器人加签密钥（SEC 开头，可选）
  dingtalkSecret: string;
  /// P-A7 权限矩阵：被禁用的工具名列表（callMcpTool/callBuiltinTool 拦截）
  disabledTools: string[];
  /// P-A7 权限矩阵：路径白名单（Agent 文件/命令类工具只能访问这些目录；空 = 不限制）
  allowedPaths: string[];
  /// P-A12 多模型路由：任务类型 → Profile id（summarize/coding/search → profileId）
  modelRouting: Record<string, string>;
  /// 长期记忆 §3.2：是否启用记忆注入（默认开）
  memoryEnabled: boolean;
  /// 长期记忆 §3.2：相关记忆检索条数（默认 6）
  memoryRecallLimit: number;
  /// 知识库 RAG 自动注入：每次对话前自动检索默认知识库并注入相关分块（默认关）
  ragEnabled: boolean;
  /// 知识库 RAG 自动注入：默认知识库名（空=未配置）
  ragKb: string;
  /// P-A4 应用内 diff 确认：开启后文件编辑类工具先展示 diff/路径确认，用户确认后才写盘
  fileEditConfirm: boolean;
  /// IM 网关配置（钉钉/飞书/企微）：platform/enabled/白名单/触发前缀/凭据等
  imConfig: Record<string, unknown>;
  /// 全局快捷键：显示/隐藏主窗口（Phase 5，默认 CommandOrControl+Shift+Space）
  globalShortcutToggle: string;
  /// 全局快捷键：新建对话（默认 CommandOrControl+Shift+K）
  globalShortcutNewChat: string;
  /// Puppeteer 浏览器内核选择：auto（默认浏览器优先）/ chrome / edge / chromium / brave
  browserEngine: string;
}

let cache: AppSettingsPayload = {
  profiles: [],
  activeProfileId: "",
  mcpServers: [],
  activeConversationId: null,
  workspace: null,
  yoloMode: false,
  approvalMode: "manual",
  auxiliaryProfileId: "",
  feishuWebhook: "",
  wecomWebhook: "",
  dingtalkWebhook: "",
  dingtalkSecret: "",
  disabledTools: [],
  allowedPaths: [],
  modelRouting: {},
  memoryEnabled: true,
  memoryRecallLimit: 6,
  ragEnabled: false,
  ragKb: "",
  fileEditConfirm: false,
  imConfig: {},
  globalShortcutToggle: "CommandOrControl+Shift+Space",
  globalShortcutNewChat: "CommandOrControl+Shift+K",
  browserEngine: "auto",
};
let loaded = false;
let loading: Promise<AppSettingsPayload> | null = null;

function isTauri(): boolean {
  // Tauri 2 注入的是 __TAURI_INTERNALS__；__TAURI__ 仅在 withGlobalTauri 时存在
  return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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

/// 强制从 Rust 重新加载设置（Rust 端一键部署自动配置 Ollama 后调用，刷新本地缓存）
export async function reloadSettings(): Promise<AppSettingsPayload> {
  if (!isTauri()) return cache;
  try {
    cache = await invoke<AppSettingsPayload>("load_app_settings");
  } catch (e) {
    console.warn("[道生一] 重新加载设置失败:", e);
  }
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
      .then(() => undefined)
      .catch((e) => console.warn("[道生一] 保存设置失败:", e));
  }, 300);
}
