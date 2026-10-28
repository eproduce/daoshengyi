// 应用设置统一读写服务
// 所有配置（API 配置、MCP 服务器、活跃对话）统一经 Rust 端 SQLite 持久化，
// API Key 在 Rust 端 AES-256-GCM 加密后落盘。
// 本模块维护一份内存缓存，chat store 与 mcp store 通过 updateSettings 更新，
// 内部 debounce 合并写回 Rust，避免两个 store 各自写盘互相覆盖。

import { invoke } from "@tauri-apps/api/core";
import { ref } from "vue";
import type { ApiProfile } from "@/types";

/** 设置变更计数。缓存对象本身不是响应式的，组件要订阅设置变化（如语音开关决定是否显示麦克风按钮）
 *  就 watch 这个 ref —— 比把整个缓存塞进 reactive 更小、也不会让 Rust 端的结构体耦合到 Vue。 */
export const settingsRevision = ref(0);

/** 命令沙箱的网络策略（与 Rust `sandbox::NetworkPolicy` 对齐） */
export type SandboxNetwork = "allow" | "loopback-only" | "deny";

/** P1-4 权限规则的结构（与 utils/permission-rules.ts 的 PermissionRule 兼容） */
export interface PermissionRuleShape {
  id?: string;
  action: "allow" | "deny" | "ask";
  tool?: string;
  command?: string;
  path?: string;
  reason?: string;
  enabled?: boolean;
}

/** P1-3 生命周期钩子的结构（与 utils/hooks.ts 的 HookRule 兼容） */
export interface HookRuleShape {
  id?: string;
  event: "turn_start" | "tool_before" | "tool_after" | "turn_end";
  tool?: string;
  when?: "any" | "success" | "error";
  action: "notify" | "inject" | "block" | "shell" | "http";
  text?: string;
  command?: string;
  url?: string;
  method?: "GET" | "POST";
  body?: string;
  timeout?: number;
  allow_danger?: boolean;
  allow_private?: boolean;
  enabled?: boolean;
}

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
  approvalMode: "manual" | "smart" | "yolo" | "on-failure";
  /// 命令沙箱（吸收自 Codex 的 SandboxMode）：off=不加沙箱（默认）｜read-only=禁写入｜
  /// workspace-write=只允许写入工作区目录（需先设置工作区）。macOS 用 Seatbelt 实现。
  sandboxMode: "off" | "read-only" | "workspace-write";
  /// 命令沙箱的网络策略（仅在沙箱开启时生效）：allow（默认）/ loopback-only / deny
  sandboxNetwork?: "allow" | "loopback-only" | "deny";
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
  /// code-mode：允许模型用 run_code 在可终止的沙箱 Worker 里执行 JS（能力只经工具桥）
  codeModeEnabled?: boolean;
  /// 本地视觉运行时：auto（默认，就绪就用 llama.cpp）/ llamacpp（强制）
  /// （云端 / 其它 OpenAI 兼容端点统一走 profiles，不在本地模型设置里配置）
  localVisionRuntime?: "auto" | "llamacpp";
  /// P0-6 预算护栏（元；0/缺省 = 不限）：达到 80% 预警、100% 发送前拦截
  budgetSession?: number;
  budgetDaily?: number;
  budgetMonthly?: number;
  /// P1-4 声明式权限规则（有序，第一条命中即生效）：
  /// `[{ "action": "deny", "tool": "run_command", "command": "rm -rf" }]`
  permissionRules?: PermissionRuleShape[];
  /// P1-3 生命周期钩子（事件 → 动作）：
  /// `[{ "event": "turn_end", "action": "notify", "text": "完成" }]`
  hooks?: HookRuleShape[];
  /// P1-8 输出风格 id（default / concise / detailed / teaching / review）
  outputStyle?: string;
  /// IM 网关配置（钉钉/飞书/企微）：platform/enabled/白名单/触发前缀/凭据等
  imConfig: Record<string, unknown>;
  /// 全局快捷键：显示/隐藏主窗口（Phase 5，默认 CommandOrControl+Shift+Space）
  globalShortcutToggle: string;
  /// 全局快捷键：新建对话（默认 CommandOrControl+Shift+K）
  globalShortcutNewChat: string;
  /// 全局快捷键：按住说话 / 一键全停（默认 CommandOrControl+Shift+V；仅语音开启时注册）
  globalShortcutVoice: string;
  /// Puppeteer 浏览器内核选择：auto（默认浏览器优先）/ chrome / edge / chromium / brave
  browserEngine: string;
  /// O2 SSRF 防护：是否拒绝抓取内网/保留地址（fetch_page 等出站请求前校验，默认 true）
  ssrfDenyPrivate: boolean;
  /// O2 SSRF 防护：是否放行本机环回（127.0.0.1 / localhost / ::1），默认 true
  ssrfAllowLoopback: boolean;
  /// O2 SSRF 白名单：完全放行的 hostname（精确或子域）
  ssrfAllowHosts: string[];
  /// O2 SSRF 白名单：允许访问私有地址的 hostname（环回仍拦）
  ssrfAllowPrivateHosts: string[];
  /// P1-9a 扩展：自定义技能扫描目录（等价 DSH 的 `Config.customSkillDirs`）；
  /// 除内置来源外额外扫描这些目录里的 `SKILL.md` / 扁平 `<name>.md`。
  customSkillDirs: string[];
  /// 系统通知：任务完成 / 最终产物就绪时发系统通知（默认开；仅窗口未聚焦时打扰）
  notifyOnFinish: boolean;
  /// 环境层：HUD 浮层开关（默认开）——关掉后 `present` 不再冒浮层，只钉回会话
  surfaceHud: boolean;
  /// 环境层：语音播报开关（默认**关**）——出声属于打扰，必须显式打开
  surfaceSpeech: boolean;
  /// 环境层：语音音色（`say -v` 的名字；空 = 系统默认）
  surfaceSpeechVoice: string;
  /// 环境层：系统音色语速（`say -r`，词/分；0 = 系统默认）；175 偏拖、240 偏赶，190 听得清
  surfaceSpeechRate: number;
  /// 环境层：句末补停顿（默认开）——`say` 的句间停顿很短，长句像连珠炮
  surfaceSpeechPause: boolean;
  /// 环境层：静默模式（默认关）——打开后只钉回会话，不出声、不冒层
  surfaceSilent: boolean;
  /// 环境层：任务结束时自动把结论呈到桌面（默认开）——模型不一定记得调 present，宿主兜一次
  surfaceAutoFinish: boolean;
  /// 环境层：**自定义音色**的命令模板（空 = 用系统 `say`）。
  /// 占位符：`{text}` / `{out}`（输出音频）/ `{ref}`（参考音频）；含 `{out}` 由我们播放
  surfaceTtsCommand: string;
  /// 环境层：自定义音色的**参考音频**路径（零样本克隆类引擎需要一段参考音）
  surfaceTtsReference: string;
  /// 环境层：勿扰时段（`"22:30"`；两个都填才生效，支持跨零点）
  surfaceQuietStart: string;
  surfaceQuietEnd: string;
  /// 语音输入（耳朵）总开关（默认**关**）：常驻录音是隐私红线，必须显式开启
  voiceEnabled: boolean;
  /// 连续语音对话：转写后**自动提交**（默认关）——全项目唯一会自动发消息的路径
  voiceAutoSend: boolean;
  /// 说完判定：VAD 静音毫秒（400~1500，默认 800）
  voiceSilenceMs: number;
  /// 会话窗口：说完/念完后多久没说话就收麦（5000~30000，默认 10000）
  voiceSessionWindowMs: number;
}

let cache: AppSettingsPayload = {
  profiles: [],
  activeProfileId: "",
  mcpServers: [],
  activeConversationId: null,
  workspace: null,
  yoloMode: false,
  approvalMode: "manual",
  sandboxMode: "off",
  sandboxNetwork: "allow",
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
  codeModeEnabled: false,
  imConfig: {},
  globalShortcutToggle: "CommandOrControl+Shift+Space",
  globalShortcutNewChat: "CommandOrControl+Shift+K",
  globalShortcutVoice: "CommandOrControl+Shift+V",
  browserEngine: "auto",
  ssrfDenyPrivate: true,
  ssrfAllowLoopback: true,
  ssrfAllowHosts: [],
  ssrfAllowPrivateHosts: [],
  customSkillDirs: [],
  notifyOnFinish: true,
  surfaceHud: true,
  surfaceSpeech: false,
  surfaceSpeechVoice: "",
  surfaceSpeechRate: 190,
  surfaceSpeechPause: true,
  surfaceSilent: false,
  surfaceAutoFinish: true,
  surfaceTtsCommand: "",
  surfaceTtsReference: "",
  surfaceQuietStart: "",
  surfaceQuietEnd: "",
  voiceEnabled: false,
  voiceAutoSend: false,
  voiceSilenceMs: 800,
  voiceSessionWindowMs: 10_000,
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
    settingsRevision.value++;
    return cache;
  })();
  return loading;
}

/// 同步获取当前缓存（可能尚未加载完成）
export function getSettings(): AppSettingsPayload {
  return cache;
}

/// 强制从 Rust 重新加载设置（Rust 端修改配置后调用，刷新本地缓存）
export async function reloadSettings(): Promise<AppSettingsPayload> {
  if (!isTauri()) return cache;
  try {
    cache = await invoke<AppSettingsPayload>("load_app_settings");
    settingsRevision.value++;
  } catch (e) {
    console.warn("[道生一] 重新加载设置失败:", e);
  }
  return cache;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveChain: Promise<void> = Promise.resolve();

/// 立刻把当前缓存写回 Rust（不防抖），返回写入完成的 Promise
function persistNow(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  const snapshot = JSON.stringify(cache);
  // 串行写，避免并发覆盖
  saveChain = saveChain
    .then(() => invoke("save_app_settings", { settings: JSON.parse(snapshot) }))
    .then(() => undefined)
    .catch((e) => console.warn("[道生一] 保存设置失败:", e));
  return saveChain;
}

/// 更新设置字段并 debounce 写回 Rust
///
/// 注意防抖的副作用：改完设置**紧接着调用依赖该设置的 Rust 命令**（如「试听」要读
/// 语音开关）会踩空——命令读到的是旧值。这种场景请先 `await flushSettings()`。
export function updateSettings(patch: Partial<AppSettingsPayload>) {
  cache = { ...cache, ...patch };
  settingsRevision.value++;
  if (!isTauri()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistNow();
  }, 300);
}

/// 取消防抖并把设置**立即**刷到 Rust，等写入完成后再返回
/// （给「改完要立刻生效」的调用方用，比如设置页里的「试一下」按钮）
export async function flushSettings(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await persistNow();
}
