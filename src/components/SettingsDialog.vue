<script setup lang="ts">
import { ref, computed, watch, onMounted, type Component } from "vue";
import { useChatStore } from "@/stores/chat";
import { useOllamaStore } from "@/stores/ollama";
import type { ApiProfile } from "@/types";
import { v4 as uuidv4 } from "@/stores/uuid";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { getSettings, updateSettings, type PermissionRuleShape } from "@/api/appSettings";
import { contextsFromAudit, dryRun, parseRules, validateRules } from "@/utils/permission-rules";
import { validateHooks } from "@/utils/hooks";
import { DEFAULT_STYLE_ID, OUTPUT_STYLES, getOutputStyle } from "@/utils/output-styles";
// 主题偏好（含「跟随系统」）——纯逻辑在 utils/theme.ts，composable 只负责响应式与落地
import { useTheme } from "@/composables/useTheme";
import { themePrefHint, themePrefLabel, resolveTheme, type ThemePref } from "@/utils/theme";
import type { HookRuleShape } from "@/api/appSettings";
import { notify } from "@/utils/dialog";
import McpSettings from "./McpSettings.vue";
import UsageStats from "./UsageStats.vue";
import HealthPanel from "./HealthPanel.vue";
import ScheduledTasks from "./ScheduledTasks.vue";
import MemoryPanel from "./MemoryPanel.vue";
import ImGatewayPanel from "./ImGatewayPanel.vue";
import AuditPanel from "./AuditPanel.vue";
import UndoPanel from "./UndoPanel.vue";
import PtyPanel from "./PtyPanel.vue";
import { PROMPT_TEMPLATES } from "@/data/prompt-templates";
import {
  Settings,
  KeyRound,
  Puzzle,
  Brain,
  ChartColumn,
  Stethoscope,
  AlarmClock,
  Globe,
  Folder,
  ShieldAlert,
  Cpu,
  Monitor,
  BookOpen,
  Shield,
  GitBranch,
  Keyboard,
  Database,
  MessagesSquare,
  ListChecks,
  History,
  Bell,
  Terminal as TerminalIcon,
  Palette,
} from "lucide-vue-next";

type SettingsTabId =
  | "api"
  | "mcp"
  | "ollama"
  | "stats"
  | "health"
  | "tasks"
  | "memory"
  | "kb"
  | "im"
  | "audit"
  | "undo"
  | "permissions"
  | "shortcuts"
  | "appearance"
  | "pty";

/**
 * 设置导航分组。
 *
 * 分类依据是**用户意图**（「我来这儿想干嘛」），不是实现模块 —— 15 个 tab 平铺时，
 * 用户得逐个扫完才知道该点哪个；按意图分组后每个问题只需要看一组：
 *
 *  模型与工具    接哪家的模型、能调什么工具    （把「插件」与 API/本地模型归在一起：
 *                                              它们回答的是同一个问题）
 *  记忆与知识    它记得什么、能查什么
 *  安全与恢复    能做什么 → 做了什么 → 怎么撒回  （权限/审计/撤销 是闭环的三步）
 *  自动化与连接  让它自己跑 / 对外通信 / 手动执行
 *  界面与运行    长什么样、怎么操作、花了多少、卡哪了
 */
const SETTINGS_GROUPS: {
  label: string;
  tabs: { id: SettingsTabId; label: string; icon: Component }[];
}[] = [
  {
    label: "模型与工具",
    tabs: [
      { id: "api", label: "API 配置", icon: KeyRound },
      { id: "ollama", label: "本地模型", icon: Brain },
      { id: "mcp", label: "插件", icon: Puzzle },
    ],
  },
  {
    label: "记忆与知识",
    tabs: [
      { id: "memory", label: "记忆", icon: BookOpen },
      { id: "kb", label: "知识库", icon: Database },
    ],
  },
  {
    label: "安全与恢复",
    tabs: [
      { id: "permissions", label: "权限", icon: Shield },
      { id: "audit", label: "审计", icon: ListChecks },
      { id: "undo", label: "撤销", icon: History },
    ],
  },
  {
    label: "自动化与连接",
    tabs: [
      { id: "tasks", label: "定时任务", icon: AlarmClock },
      { id: "im", label: "即时聊天", icon: MessagesSquare },
      { id: "pty", label: "终端", icon: TerminalIcon },
    ],
  },
  {
    label: "界面与运行",
    tabs: [
      { id: "appearance", label: "外观", icon: Palette },
      { id: "shortcuts", label: "快捷键", icon: Keyboard },
      { id: "stats", label: "用量统计", icon: ChartColumn },
      { id: "health", label: "诊断", icon: Stethoscope },
    ],
  },
];
const props = defineProps<{ initialTab?: SettingsTabId }>();
const emit = defineEmits<{
  close: [];
}>();

const chatStore = useChatStore();
const ollamaStore = useOllamaStore();
// 主题：跟随系统 / 深色 / 浅色（生效值由 composable 算好，这里只管偏好）
const { pref: themePref, systemDark, setThemePref } = useTheme();
/** 当前真正生效的主题（跟随系统时由系统决定）—— 展示层用它，避免用户对着「跟随系统」猜 */
const resolvedTheme = computed(() => resolveTheme(themePref.value, systemDark.value));
const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];
const activeTab = ref<SettingsTabId>("api");
watch(
  () => props.initialTab,
  (t) => {
    if (t) activeTab.value = t;
  },
  { immediate: true },
);

// --- Ollama 本地视觉模型管理（状态存于全局 store，关闭界面不中断部署与进度） ---
function verdictText(v: string) {
  return v === "recommended"
    ? "✅ 推荐本地部署"
    : v === "warning"
      ? "⚠️ 可部署，但占用资源较高"
      : "❌ 不推荐本地部署";
}

onMounted(() => {
  // 打开时刷新一次状态（若后台仍在部署，进度/百分比已保存在 store 中自动恢复）
  ollamaStore.refreshStatus();
  refreshKb();
  loadExecRules();
});

const editingId = ref<string>(chatStore.activeProfileId);
const editingProfile = ref<ApiProfile>({
  ...(chatStore.activeProfile || chatStore.profiles[0]),
});

const isNew = ref(false);

// 提示词模板
const selectedTemplateId = ref("");
function applyTemplate(id: string) {
  const t = PROMPT_TEMPLATES.find((p) => p.id === id);
  if (t) {
    editingProfile.value.systemPrompt = t.prompt;
    selectedTemplateId.value = id;
  }
}

// 动态获取厂商模型列表
const availableModels = ref<string[]>([]);
// 回填已持久化的模型列表：打开设置/切换配置时自动恢复（重启后无需重新获取）
watch(
  () => editingProfile.value.availableModels,
  (v) => {
    availableModels.value = v ?? [];
  },
  { immediate: true },
);
const loadingModels = ref(false);
const modelError = ref("");
const showModelDropdown = ref(false);

async function fetchModels() {
  if (!editingProfile.value.baseUrl || !editingProfile.value.apiKey) {
    modelError.value = "请先填写 API 地址和 API Key";
    return;
  }
  loadingModels.value = true;
  modelError.value = "";
  try {
    const models = await invoke<string[]>("list_models", {
      baseUrl: editingProfile.value.baseUrl,
      apiKey: editingProfile.value.apiKey,
    });
    availableModels.value = models;
    editingProfile.value.availableModels = models;
    // 立即持久化到已保存的配置：即使不点「保存」，下次打开/重启后也能直接看到模型列表
    const saved = chatStore.profiles.find((p) => p.id === editingId.value);
    if (saved) chatStore.updateProfile(saved.id, { availableModels: models });
    if (models.length > 0) {
      modelError.value = `获取到 ${models.length} 个模型`;
      showModelDropdown.value = true;
    } else {
      modelError.value = "未获取到模型列表";
    }
  } catch (e: unknown) {
    availableModels.value = [];
    modelError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loadingModels.value = false;
  }
}

// 按输入过滤模型列表
const filteredModels = computed(() => {
  const kw = editingProfile.value.model.trim().toLowerCase();
  if (!kw) return availableModels.value;
  return availableModels.value.filter((m) => m.toLowerCase().includes(kw));
});

function pickModel(m: string) {
  editingProfile.value.model = m;
  showModelDropdown.value = false;
}

function onModelBlur() {
  setTimeout(() => {
    showModelDropdown.value = false;
  }, 150);
}

// Agent 工作区（借鉴 DeepSeek Harness 的 workspace 概念）
const workspace = ref(getSettings().workspace || "");
function saveWorkspace() {
  const v = workspace.value.trim();
  updateSettings({ workspace: v || null });
}

// 危险命令审批模式：manual（手动确认，默认）/ smart（智能审批，辅助模型判断）/
// on-failure（先执行，失败后才升级请求授权，对齐 Codex 的 ApprovalMode::OnFailure）/ yolo（全部自动批准）
const APPROVAL_MODES = [
  { value: "manual" as const, label: "手动确认", desc: "危险命令先弹窗询问，确认后执行" },
  {
    value: "smart" as const,
    label: "Smart 智能审批",
    desc: "辅助模型判断安全则自动放行，判定有风险再询问",
  },
  {
    value: "on-failure" as const,
    label: "失败后再问",
    desc: "危险命令直接执行；失败（非零退出/超时）后再询问是否换方式重试",
  },
  {
    value: "yolo" as const,
    label: "YOLO 全部放行",
    desc: "危险命令自动批准执行，不询问（高风险）",
  },
];
const approvalMode = ref<"manual" | "smart" | "yolo" | "on-failure">(
  getSettings().approvalMode || (getSettings().yoloMode ? "yolo" : "manual"),
);
function onApprovalModeChange(mode: "manual" | "smart" | "yolo" | "on-failure") {
  approvalMode.value = mode;
  updateSettings({ approvalMode: mode, yoloMode: mode === "yolo" });
}

// 命令沙箱（吸收自 Codex 的 SandboxMode）：macOS 用系统自带 Seatbelt 限制命令的文件写入面。
// off=不加沙箱（默认，行为不变）｜read-only=禁一切写入｜workspace-write=只允许写工作区。
const SANDBOX_MODES = [
  { value: "off" as const, label: "关闭", desc: "不加沙箱，命令照旧执行（默认）" },
  {
    value: "read-only" as const,
    label: "只读",
    desc: "禁止命令写入文件（/tmp 除外）——调研/分析类任务",
  },
  {
    value: "workspace-write" as const,
    label: "工作区可写",
    desc: "只允许写入工作区目录（需先设置工作区），越界写入会被系统拒绝",
  },
];
const sandboxMode = ref<"off" | "read-only" | "workspace-write">(
  getSettings().sandboxMode || "off",
);
function onSandboxModeChange(mode: "off" | "read-only" | "workspace-write") {
  sandboxMode.value = mode;
  updateSettings({ sandboxMode: mode });
}

// 辅助任务模型（用于 Smart 审批 / 子代理等）：空 = 跟随主模型
const auxiliaryProfileId = ref(getSettings().auxiliaryProfileId || "");
function onAuxProfileChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  auxiliaryProfileId.value = v;
  updateSettings({ auxiliaryProfileId: v });
}

// P-A7 权限矩阵：禁用工具 + 路径白名单（每行一个，@change 即时保存）
const disabledTools = ref((getSettings().disabledTools ?? []).join("\n"));
const allowedPaths = ref((getSettings().allowedPaths ?? []).join("\n"));
function savePermissions() {
  updateSettings({
    disabledTools: disabledTools.value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    allowedPaths: allowedPaths.value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  });
}

// P1-4：主目录（规则里 `~/…` 的展开基准）
const homeForRules = ref("");
void (async () => {
  try {
    homeForRules.value = (await homeDir()).replace(/\/+$/, "");
  } catch {
    homeForRules.value = "";
  }
})();

// P1-8 输出风格：一次设置、全会话生效（写在系统提示末尾，幂等替换）
const outputStyle = ref(getSettings().outputStyle ?? DEFAULT_STYLE_ID);
function saveOutputStyle() {
  updateSettings({ outputStyle: outputStyle.value });
  notify(`回复风格已切换为：${getOutputStyle(outputStyle.value)?.label ?? outputStyle.value}`);
}

// P1-3 生命周期钩子：JSON 编辑 + 校验（危险命令/内网地址在 utils/hooks.ts 里拦）
const hooksText = ref(JSON.stringify(getSettings().hooks ?? [], null, 2));
const hooksErrors = ref<string[]>([]);

function saveHooks(): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(hooksText.value || "[]");
  } catch (e) {
    hooksErrors.value = [`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`];
    return false;
  }
  const errs = validateHooks(parsed);
  hooksErrors.value = errs;
  if (errs.length) return false;
  updateSettings({ hooks: parsed as HookRuleShape[] });
  return true;
}

// P1-4 声明式权限规则：JSON 编辑 + 校验 + 用最近真实工具调用试跑（dry-run）
const rulesText = ref(JSON.stringify(getSettings().permissionRules ?? [], null, 2));
const rulesErrors = ref<string[]>([]);
const dryRows = ref<{ detail: string; decision: string; matched: string }[]>([]);
const dryCounts = ref<{ allow: number; deny: number; ask: number; none: number } | null>(null);

function saveRules(): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rulesText.value || "[]");
  } catch (e) {
    rulesErrors.value = [`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`];
    return false;
  }
  const errs = validateRules(parsed);
  rulesErrors.value = errs;
  if (errs.length) return false;
  updateSettings({ permissionRules: parsed as PermissionRuleShape[] });
  return true;
}

/// 试跑：把规则套到最近的真实工具调用上，**启用前先看清会拦住/放开什么**
async function dryRunRulesNow() {
  dryCounts.value = null;
  if (!saveRules()) return;
  const { rules } = parseRules(JSON.parse(rulesText.value || "[]"));
  let rows: { tool_name: string; arguments: string }[] = [];
  try {
    rows = await invoke<{ tool_name: string; arguments: string }[]>("list_tool_audit", {
      limit: 100,
    });
  } catch {
    rows = [];
  }
  const res = dryRun(rules, contextsFromAudit(rows), homeForRules.value);
  dryRows.value = res.rows.slice(0, 30);
  dryCounts.value = res.counts;
}

// P-A4 应用内 diff 确认：文件编辑类工具先预览 diff/路径，用户确认后才写盘
const fileEditConfirm = ref(getSettings().fileEditConfirm ?? false);
function saveEditConfirm() {
  updateSettings({ fileEditConfirm: fileEditConfirm.value });
}

// P0-资源 本地视觉运行时：auto（默认可就绪就用 llama.cpp）/ llamacpp / ollama
// 切换后需重查一次状态：ollama_status 会返回「当前实际会用哪个后端」
const localVisionRuntime = ref<"auto" | "llamacpp" | "ollama">(
  getSettings().localVisionRuntime ?? "auto",
);
function saveLocalVisionRuntime() {
  updateSettings({ localVisionRuntime: localVisionRuntime.value });
  void ollamaStore.refreshStatus();
  void ollamaStore.refreshRuntime();
}

// S1 命令执行策略引擎：规则文件编辑（设置→权限 区块；规则持久化在 app_data/execpolicy.rules）
const execRules = ref("");
const execTestCmd = ref("");
const execTestResult = ref("");
async function loadExecRules() {
  try {
    execRules.value = await invoke<string>("list_exec_rules");
  } catch {
    /* 读取失败保持空 */
  }
}
async function saveExecRules() {
  try {
    await invoke("save_exec_rules", { content: execRules.value });
    notify("命令执行策略已保存");
  } catch (e) {
    notify(`保存失败：${e}`);
  }
}
async function resetExecRules() {
  try {
    await invoke("reset_exec_rules");
    await loadExecRules();
    notify("已恢复默认命令执行策略");
  } catch (e) {
    notify(`恢复失败：${e}`);
  }
}
async function testExecRule() {
  if (!execTestCmd.value.trim()) {
    execTestResult.value = "";
    return;
  }
  try {
    const r = await invoke<{ decision: string; matched: string | null }>("test_command_policy", {
      command: execTestCmd.value.trim(),
    });
    const label =
      r.decision === "allow"
        ? "✅ 放行"
        : r.decision === "deny"
          ? "⛔ 拦截"
          : r.decision === "prompt"
            ? "⚠️ 需确认"
            : "（未命中规则，走默认审批）";
    execTestResult.value = `决策：${label}${r.matched ? `　命中规则：\`${r.matched}\`` : ""}`; // eslint-disable-line no-irregular-whitespace
  } catch (e) {
    execTestResult.value = `测试失败：${e}`;
  }
}

// 知识库 RAG 自动注入：开启后每次对话前自动检索默认知识库并注入相关分块（会话首轮）
const kbList = ref<{ name: string; chunks: number }[]>([]);
const ragEnabled = ref(getSettings().ragEnabled ?? false);
const ragKb = ref(getSettings().ragKb ?? "");
async function refreshKb() {
  try {
    kbList.value = await invoke<{ name: string; chunks: number }[]>("kb_list");
    if (!kbList.value.some((k) => k.name === ragKb.value) && kbList.value.length > 0) {
      ragKb.value = kbList.value[0].name;
    }
  } catch {
    kbList.value = [];
  }
}
function saveRag() {
  updateSettings({ ragEnabled: ragEnabled.value, ragKb: ragKb.value });
}

// P-A12 多模型路由：任务类型 → Profile id（摘要/记忆辅助、编程子代理）
const routeSummarize = ref(getSettings().modelRouting?.["summarize"] || "");
const routeCoding = ref(getSettings().modelRouting?.["coding"] || "");
function saveRouting() {
  updateSettings({
    modelRouting: { summarize: routeSummarize.value, coding: routeCoding.value },
  });
}

// Phase 5 全局快捷键：显示/隐藏主窗口 + 新建对话（保存后即时重注册）
const shortcutToggle = ref(getSettings().globalShortcutToggle || "CommandOrControl+Shift+Space");
const shortcutNewChat = ref(getSettings().globalShortcutNewChat || "CommandOrControl+Shift+K");
function saveShortcuts() {
  updateSettings({
    globalShortcutToggle: shortcutToggle.value.trim() || "CommandOrControl+Shift+Space",
    globalShortcutNewChat: shortcutNewChat.value.trim() || "CommandOrControl+Shift+K",
  });
  // 立即应用新快捷键（Rust 注销旧注册并按新配置注册）
  invoke("apply_global_shortcuts", {
    toggle: shortcutToggle.value.trim() || "CommandOrControl+Shift+Space",
    newChat: shortcutNewChat.value.trim() || "CommandOrControl+Shift+K",
  }).catch(() => {
    /* 注册失败（被占用）由 Rust 日志记录 */
  });
}
function resetShortcuts() {
  shortcutToggle.value = "CommandOrControl+Shift+Space";
  shortcutNewChat.value = "CommandOrControl+Shift+K";
  saveShortcuts();
}

// ── 系统通知：任务完成 / 最终产物就绪时提醒（窗口未聚焦时才发） ──
const notifyOnFinish = ref(getSettings().notifyOnFinish ?? true);
const notifGranted = ref<boolean | null>(null);
/// 通知可用性诊断：把「为什么发不出去」说清楚（非 .app / 未授权 / 已就绪）
const notifDiagnose = ref<{
  granted: boolean;
  state: string;
  bundled: boolean;
  hint: string;
} | null>(null);
async function refreshNotifPermission() {
  try {
    notifGranted.value = await invoke<boolean>("notification_permission_granted");
  } catch {
    notifGranted.value = null;
  }
  try {
    notifDiagnose.value = await invoke<{
      granted: boolean;
      state: string;
      bundled: boolean;
      hint: string;
    }>("notification_diagnose");
  } catch {
    notifDiagnose.value = null;
  }
}
function saveNotify() {
  updateSettings({ notifyOnFinish: notifyOnFinish.value });
}
async function requestNotif() {
  try {
    notifGranted.value = await invoke<boolean>("request_notification_permission");
    await refreshNotifPermission();
    if (!notifDiagnose.value?.bundled) {
      notify(
        "已完成权限请求，但当前是开发模式（非 .app）：macOS 不会投递通知。\n\n请用打包版验证：npm run tauri build 后打开 target/release/bundle/macos 下的「道生一.app」。",
      );
    } else if (notifGranted.value) {
      notify("已获得通知权限");
    } else {
      notify("未获得通知权限：可在「系统设置 → 通知 → 道生一」中手动允许");
    }
  } catch (e) {
    notify(`请求通知权限失败：${e}`);
  }
}
async function testNotify() {
  try {
    const ok = await invoke<boolean>("notify_user", {
      title: "道生一 · 通知测试",
      body: "任务完成时就会这样提醒你（窗口在前台时不打扰）",
      onlyWhenUnfocused: false, // 测试时强制发送
    });
    await refreshNotifPermission();
    if (!ok) {
      notify(`通知未发送\n\n${notifDiagnose.value?.hint ?? "原因未知（可在应用日志中查看）"}`);
    }
  } catch (e) {
    notify(`测试通知失败：${e}`);
  }
}
refreshNotifPermission();

// 切换编辑目标
function selectProfile(id: string) {
  const p = chatStore.profiles.find((p) => p.id === id);
  if (p) {
    editingId.value = id;
    editingProfile.value = { ...p };
    isNew.value = false;
    selectedTemplateId.value = "";
  }
}

function startNew() {
  editingId.value = "";
  editingProfile.value = {
    id: uuidv4(),
    name: "新配置",
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-v4-flash",
    maxTokens: 4096,
    temperature: 0.7,
    thinkingEnabled: true,
    reasoningEffort: "high",
    systemPrompt: "",
    enableWebSearch: false,
    maxContextMessages: 50,
  };
  isNew.value = true;
}

function handleSave() {
  if (isNew.value) {
    chatStore.addProfile({ ...editingProfile.value });
  } else {
    chatStore.updateProfile(editingId.value, { ...editingProfile.value });
  }
  // 自动切换到保存的配置
  chatStore.switchProfile(editingProfile.value.id);
  emit("close");
}

function handleDelete() {
  if (isNew.value || chatStore.profiles.length <= 1) return;
  chatStore.deleteProfile(editingId.value);
  emit("close");
}
</script>

<template>
  <div class="settings-overlay" @click.self="emit('close')">
    <div class="settings-dialog">
      <div class="settings-dialog__header">
        <h2 class="settings-title"><Settings :size="18" /> 设置</h2>
        <button class="btn-close" @click="emit('close')">✕</button>
      </div>

      <div class="settings-dialog__body">
        <!-- 左侧菜单 -->
        <!-- 左侧菜单：按「你来这儿想干嘛」分 5 组（而不是按实现模块平铺 15 项） -->
        <nav class="settings-nav">
          <div v-for="g in SETTINGS_GROUPS" :key="g.label" class="settings-nav__group">
            <div class="settings-nav__group-title">{{ g.label }}</div>
            <button
              v-for="t in g.tabs"
              :key="t.id"
              :class="['settings-tab', { active: activeTab === t.id }]"
              @click="activeTab = t.id"
            >
              <span class="settings-tab__icon"><component :is="t.icon" :size="15" /></span
              >{{ t.label }}
            </button>
          </div>
        </nav>

        <!-- 右侧内容 -->
        <div class="settings-content">
          <!-- API 配置 -->
          <div v-show="activeTab === 'api'">
            <!-- 配置列表 -->
            <div class="profile-tabs">
              <button
                v-for="p in chatStore.profiles"
                :key="p.id"
                class="profile-tab"
                :class="{ 'profile-tab--active': editingId === p.id && !isNew }"
                @click="selectProfile(p.id)"
              >
                {{ p.name }}
              </button>
              <button class="profile-tab profile-tab--add" @click="startNew">＋</button>
            </div>

            <!-- 编辑表单 -->
            <div class="form-group">
              <label>配置名称</label>
              <input v-model="editingProfile.name" type="text" placeholder="如: DeepSeek" />
            </div>

            <div class="form-group">
              <label>API 地址</label>
              <input
                v-model="editingProfile.baseUrl"
                type="text"
                placeholder="https://api.deepseek.com"
              />
              <span class="form-hint">API 基础地址</span>
            </div>

            <div class="form-group">
              <label>API Key</label>
              <input v-model="editingProfile.apiKey" type="password" placeholder="sk-..." />
              <span class="form-hint">您的 API 密钥</span>
            </div>

            <div class="form-group">
              <label>模型</label>
              <div class="model-row">
                <div class="model-select">
                  <input
                    v-model="editingProfile.model"
                    type="text"
                    placeholder="deepseek-v4-flash"
                    @focus="showModelDropdown = true"
                    @input="showModelDropdown = true"
                    @blur="onModelBlur"
                  />
                  <div
                    v-if="showModelDropdown && filteredModels.length > 0"
                    class="model-select__dropdown"
                  >
                    <div
                      v-for="m in filteredModels"
                      :key="m"
                      class="model-select__option"
                      :class="{ on: m === editingProfile.model }"
                      @mousedown.prevent="pickModel(m)"
                    >
                      {{ m }}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  class="btn-secondary btn-fetch"
                  :disabled="loadingModels"
                  @click="fetchModels"
                >
                  {{ loadingModels ? "获取中…" : "获取模型" }}
                </button>
              </div>
              <span
                v-if="modelError"
                class="form-hint"
                :class="{ 'form-hint--error': availableModels.length === 0 && !loadingModels }"
                >{{ modelError }}</span
              >
              <span v-else class="form-hint"
                >可手动输入，或点击「获取模型」从厂商拉取可用模型列表</span
              >
            </div>

            <div class="form-row">
              <div class="form-group">
                <label>最大 Token</label>
                <input
                  v-model.number="editingProfile.maxTokens"
                  type="number"
                  min="1"
                  max="128000"
                />
              </div>
              <div class="form-group">
                <label>上下文消息数</label>
                <input
                  v-model.number="editingProfile.maxContextMessages"
                  type="number"
                  min="4"
                  max="200"
                />
              </div>
            </div>

            <!-- 思考模式 (DeepSeek) -->
            <div class="form-group">
              <label class="toggle-row">
                <span>思考模式 (DeepSeek R1/V4)</span>
                <input
                  v-model="editingProfile.thinkingEnabled"
                  type="checkbox"
                  class="toggle-input"
                />
              </label>
              <span class="form-hint">开启后模型先深度思考再回答，响应更慢但质量更高</span>
            </div>

            <div class="form-group">
              <label class="toggle-row">
                <span><Globe :size="14" /> 联网搜索</span>
                <input
                  v-model="editingProfile.enableWebSearch"
                  type="checkbox"
                  class="toggle-input"
                />
              </label>
              <span class="form-hint">允许模型搜索互联网获取最新信息</span>
            </div>

            <div class="form-group">
              <label>系统提示词</label>
              <textarea
                v-model="editingProfile.systemPrompt"
                class="form-textarea"
                placeholder="你是一个有帮助的AI助手。"
                rows="3"
              ></textarea>
              <span class="form-hint">定义 AI 的角色和行为方式</span>
            </div>

            <!-- 提示词模板 -->
            <div class="form-group">
              <label>📚 提示词模板</label>
              <select
                class="form-select"
                :value="selectedTemplateId"
                @change="applyTemplate(($event.target as HTMLSelectElement).value)"
              >
                <option value="" disabled>选择角色模板一键应用...</option>
                <option v-for="t in PROMPT_TEMPLATES" :key="t.id" :value="t.id">
                  {{ t.icon }} {{ t.name }} — {{ t.description }}
                </option>
              </select>
              <span class="form-hint">应用后会自动填充上方系统提示词，可直接修改</span>
            </div>

            <!-- Agent 工作区 -->
            <div class="form-group">
              <label><Folder :size="14" /> Agent 工作区</label>
              <input
                v-model="workspace"
                type="text"
                placeholder="/path/to/project"
                @blur="saveWorkspace"
                @keyup.enter="saveWorkspace"
              />
              <span class="form-hint">Agent 执行命令、读取文件的默认目录（空则不限定）</span>
            </div>

            <!-- 危险命令审批模式 -->
            <div class="form-group">
              <label class="form-label"><ShieldAlert :size="14" /> 危险命令审批模式</label>
              <div class="approval-modes">
                <button
                  v-for="m in APPROVAL_MODES"
                  :key="m.value"
                  :class="['approval-mode', { active: approvalMode === m.value }]"
                  @click="onApprovalModeChange(m.value)"
                >
                  <span class="approval-mode-name">{{ m.label }}</span>
                  <span class="approval-mode-desc">{{ m.desc }}</span>
                </button>
              </div>
              <span class="form-hint"
                >检测到危险命令（rm -rf / sudo / mkfs / dd 等）时的处理方式。</span
              >
            </div>

            <!-- 命令沙箱 -->
            <div class="form-group">
              <label class="form-label"
                ><ShieldAlert :size="14" /> 命令沙箱（macOS Seatbelt）</label
              >
              <div class="approval-modes">
                <button
                  v-for="m in SANDBOX_MODES"
                  :key="m.value"
                  :class="['approval-mode', { active: sandboxMode === m.value }]"
                  @click="onSandboxModeChange(m.value)"
                >
                  <span class="approval-mode-name">{{ m.label }}</span>
                  <span class="approval-mode-desc">{{ m.desc }}</span>
                </button>
              </div>
              <span class="form-hint">
                Agent 执行的命令（run_command / exec_command）与快捷键 /run 均受此限制；用户自己开的
                PTY 面板不受影响。“工作区可写”需先在「快捷键」页设置工作区目录；系统缺少
                sandbox-exec 时自动降级为不加沙箱（命令不会因此失败）。
              </span>
            </div>

            <!-- 辅助任务模型 -->
            <div class="form-group">
              <label class="form-label"><Puzzle :size="14" /> 辅助任务模型</label>
              <select :value="auxiliaryProfileId" class="form-select" @change="onAuxProfileChange">
                <option value="">跟随主模型</option>
                <option v-for="p in chatStore.profiles" :key="p.id" :value="p.id">
                  {{ p.name }}
                </option>
              </select>
              <span class="form-hint"
                >用于 Smart
                智能审批、子代理等辅助任务；可选更便宜/更快的模型，节省主模型额度。不配置则跟随主模型。</span
              >
            </div>

            <!-- P-A12 模型路由：按任务类型自动选模型 -->
            <div class="form-group">
              <label class="form-label"><GitBranch :size="14" /> 模型路由（按任务类型）</label>
              <label class="form-label" style="font-size: 12px; font-weight: 400"
                >摘要 / 记忆辅助模型</label
              >
              <select v-model="routeSummarize" class="form-select" @change="saveRouting">
                <option value="">跟随辅助/主模型</option>
                <option v-for="p in chatStore.profiles" :key="p.id" :value="p.id">
                  {{ p.name }}
                </option>
              </select>
              <label class="form-label" style="font-size: 12px; font-weight: 400; margin-top: 8px"
                >编程子代理模型</label
              >
              <select v-model="routeCoding" class="form-select" @change="saveRouting">
                <option value="">跟随辅助/主模型</option>
                <option v-for="p in chatStore.profiles" :key="p.id" :value="p.id">
                  {{ p.name }}
                </option>
              </select>
              <span class="form-hint"
                >摘要/记忆提取、编程子代理等任务可指定专门模型（如更便宜的或本地
                Ollama）；未配置则跟随「辅助任务模型」，再跟随主模型。</span
              >
            </div>
          </div>

          <!-- MCP 服务器管理 -->
          <div v-show="activeTab === 'mcp'"><McpSettings /></div>

          <!-- Ollama 本地视觉模型管理（状态存于全局 store，关闭界面不中断部署） -->
          <div v-show="activeTab === 'ollama'" class="ollama-panel">
            <h3><Cpu :size="17" /> 本地视觉模型（Ollama）</h3>
            <p class="ollama-desc">
              用于本地识别图片内容。模型完全在你电脑上运行，免费且隐私安全，无需联网。是否适合本地部署取决于硬件性能。
            </p>

            <!-- 运行时选择（llama.cpp / Ollama）：默认 Ollama 默认 5 分钟 keep_alive 会把 2.3GB 权重藕在内存里 -->
            <div class="runtime-card">
              <div class="runtime-card__title">⚙️ 本地运行时</div>
              <p class="runtime-card__hint">
                两者推理速度基本一致（实测同一张图 41.5s vs
                44.6s），差别在<strong>内存与常驻</strong>：llama.cpp 按需启动、空闲自动退出（空闲 0
                常驻），Ollama 默认会把权重藕 5 分钟。
              </p>
              <div class="runtime-card__row">
                <select v-model="localVisionRuntime" @change="saveLocalVisionRuntime">
                  <option value="auto">自动（推荐：llama.cpp 可用就用它）</option>
                  <option value="llamacpp">强制 llama.cpp</option>
                  <option value="ollama">强制 Ollama</option>
                </select>
                <span v-if="ollamaStore.status?.vision_backend" class="runtime-badge">
                  当前生效：{{
                    ollamaStore.status.vision_backend === "llamacpp" ? "llama.cpp" : "Ollama"
                  }}
                </span>
              </div>
              <div v-if="ollamaStore.runtime" class="runtime-card__grid">
                <div>
                  llama-server：{{
                    ollamaStore.runtime.bin_found ? "已安装" : "未安装（brew install llama.cpp）"
                  }}
                </div>
                <div>
                  已导入模型：{{ ollamaStore.runtime.active_model || "无"
                  }}{{ ollamaStore.runtime.has_projector ? "（含投影器）" : "" }}
                </div>
                <div>
                  服务状态：{{ ollamaStore.runtime.serving ? "运行中" : "未运行"
                  }}{{
                    ollamaStore.runtime.serving && ollamaStore.runtime.idle_secs != null
                      ? `（空闲 ${ollamaStore.runtime.idle_secs}s，${ollamaStore.runtime.idle_kill_secs}s 后自动停止）`
                      : ""
                  }}
                </div>
                <!-- 嵌入（语义检索）：一直是「装了才能用」，所以把状态摆到桌面上 -->
                <div>
                  语义检索（嵌入）：{{ ollamaStore.runtime.embed.model_found ? "可用" : "不可用"
                  }}{{
                    ollamaStore.runtime.embed.model_found
                      ? `（${ollamaStore.runtime.embed.model}，端口 ${ollamaStore.runtime.embed.port}）`
                      : "（需先 ollama pull nomic-embed-text 再点上方导入；未装时自动降级为关键词检索）"
                  }}{{ ollamaStore.runtime.embed.serving ? " · 嵌入服务运行中" : "" }}
                </div>
                <div class="runtime-card__path">目录：{{ ollamaStore.runtime.models_dir }}</div>
              </div>
              <div class="runtime-card__row">
                <button
                  class="btn-secondary"
                  :disabled="!ollamaStore.runtime?.bin_found"
                  @click="ollamaStore.importFromOllama()"
                >
                  从 Ollama 导入模型（硬链接，零下载）
                </button>
                <button class="btn-secondary" @click="ollamaStore.stopRuntime()">
                  立即停止运行时
                </button>
                <button class="btn-secondary" @click="ollamaStore.refreshRuntime()">刷新</button>
              </div>
              <p v-if="ollamaStore.runtimeMsg" class="runtime-card__msg">
                {{ ollamaStore.runtimeMsg }}
              </p>
            </div>

            <div v-if="ollamaStore.hw" class="hw-card">
              <div class="hw-card__title">
                <Monitor :size="15" /> 硬件评估
                <span class="hw-score">综合 {{ ollamaStore.hw.score }} 分</span>
              </div>
              <div class="hw-card__row">
                CPU：{{ ollamaStore.hw.cpu_cores }} 核{{
                  ollamaStore.hw.cpu_brand ? " · " + ollamaStore.hw.cpu_brand : ""
                }}
              </div>
              <div class="hw-card__row">内存：{{ ollamaStore.hw.memory_gb }} GB</div>
              <div class="hw-card__row">
                显卡：{{ ollamaStore.hw.gpu_name || "核显"
                }}{{
                  ollamaStore.hw.gpu_memory_mb ? " · " + ollamaStore.hw.gpu_memory_mb + " MB" : ""
                }}{{ ollamaStore.hw.has_metal ? " · Metal" : "" }}
              </div>
              <div class="hw-card__verdict" :class="'hw-card__verdict--' + ollamaStore.hw.verdict">
                {{ verdictText(ollamaStore.hw.verdict) }}
              </div>
              <p class="hw-card__msg">{{ ollamaStore.hw.message }}</p>
            </div>
            <div v-if="!ollamaStore.status" class="ollama-loading">正在检测 Ollama 环境...</div>
            <template v-else>
              <div class="ollama-status">
                <div class="ollama-item">
                  <span
                    class="ollama-dot"
                    :class="
                      ollamaStore.status.installed
                        ? 'green'
                        : ollamaStore.status.installing
                          ? 'yellow'
                          : 'red'
                    "
                  ></span>
                  Ollama 程序：{{
                    ollamaStore.status.installed
                      ? "已安装"
                      : ollamaStore.status.installing
                        ? "正在安装中..."
                        : "未安装"
                  }}
                </div>
                <div class="ollama-item">
                  <span
                    class="ollama-dot"
                    :class="ollamaStore.status.running ? 'green' : 'red'"
                  ></span>
                  Ollama 服务：{{ ollamaStore.status.running ? "运行中" : "未运行" }}
                </div>
                <div v-if="ollamaStore.status.running" class="ollama-item">
                  <span class="ollama-dot" :class="ollamaStore.hasLlava ? 'green' : 'red'"></span>
                  视觉模型 llava-phi3：{{ ollamaStore.hasLlava ? "已部署" : "未部署" }}
                </div>
                <div
                  v-if="ollamaStore.status.running && ollamaStore.status.models.length"
                  class="ollama-models"
                >
                  已部署模型：{{ ollamaStore.status.models.join(", ") }}
                </div>
              </div>
              <button
                v-if="ollamaStore.hw?.verdict === 'not_recommended'"
                class="btn-primary"
                @click="activeTab = 'api'"
              >
                配置线上视觉模型 API
              </button>
              <button
                v-else
                class="btn-primary"
                :disabled="ollamaStore.busy"
                @click="ollamaStore.deploy()"
              >
                {{
                  ollamaStore.busy
                    ? "部署中..."
                    : ollamaStore.status.installed && ollamaStore.hasLlava
                      ? "重新检测"
                      : "一键部署"
                }}
              </button>
              <p v-if="ollamaStore.hw?.verdict !== 'not_recommended'" class="ollama-hint">
                首次部署将安装 Ollama 并下载约 2GB
                模型，耗时较长；关闭此界面会继续在后台下载，可稍后回来查看进度。
              </p>
            </template>
            <div
              v-if="ollamaStore.percent !== null && ollamaStore.percent < 100"
              class="ollama-bar"
            >
              <div class="ollama-bar__fill" :style="{ width: ollamaStore.percent + '%' }"></div>
              <span class="ollama-bar__label">{{ Math.round(ollamaStore.percent) }}%</span>
            </div>
            <div v-if="ollamaStore.progress" class="ollama-progress">
              {{ ollamaStore.progress }}
            </div>
          </div>

          <!-- 用量统计 -->
          <div v-show="activeTab === 'stats'"><UsageStats /></div>

          <!-- 运行时诊断 -->
          <div v-show="activeTab === 'health'"><HealthPanel /></div>

          <!-- 定时任务 -->
          <div v-show="activeTab === 'tasks'"><ScheduledTasks /></div>

          <!-- 长期记忆 -->
          <div v-show="activeTab === 'memory'"><MemoryPanel /></div>

          <!-- 即时聊天（IM 网关：钉钉/飞书/企微） -->
          <div v-show="activeTab === 'im'"><ImGatewayPanel /></div>

          <!-- 审计：工具调用全记录（筛选/回放/导出） -->
          <div v-show="activeTab === 'audit'"><AuditPanel /></div>

          <!-- 撤销：文件操作回放（编辑/新建/删除快照，一键回滚） -->
          <div v-show="activeTab === 'undo'"><UndoPanel /></div>
          <div v-show="activeTab === 'pty'"><PtyPanel /></div>

          <!-- 知识库 RAG 自动注入 -->
          <div v-show="activeTab === 'kb'">
            <h3><Database :size="17" /> 知识库</h3>
            <p class="ollama-desc">
              RAG 知识库通过 Agent 工具（kb_create / kb_add /
              kb_search）建立；此处可开启「自动注入」：开启后每个会话首轮自动检索默认知识库的相关分块注入上下文，回答更贴合你的文档，无需手动检索。同一会话只注入一次，精细引用时仍可让
              Agent 手动 kb_search。
            </p>
            <div class="form-group approval-mode">
              <label
                class="memory-config__toggle"
                style="display: inline-flex; align-items: center; gap: 8px; cursor: pointer"
              >
                <input v-model="ragEnabled" type="checkbox" @change="saveRag" />
                <span>知识库自动注入（会话首轮 RAG）</span>
              </label>
              <span class="form-hint"
                >开启后，每个新会话的首条消息会自动检索「默认知识库」并将命中的分块作为上下文注入给模型。</span
              >
            </div>
            <div class="form-group">
              <label>默认知识库</label>
              <select v-model="ragKb" @change="saveRag">
                <option value="">— 未配置 —</option>
                <option v-for="k in kbList" :key="k.name" :value="k.name">
                  {{ k.name }}（{{ k.chunks }} 分块）
                </option>
              </select>
              <span class="form-hint"
                >选择后作为自动检索的知识库；可让 Agent 用 kb_create 新建知识库、kb_add
                录入文档。</span
              >
            </div>
            <div v-if="kbList.length === 0" class="form-hint">
              暂无知识库。可在对话中让 Agent 调用「创建知识库 / 添加文档」来建立。
            </div>
            <button class="btn-ghost" style="margin-top: 4px" @click="refreshKb">
              刷新知识库列表
            </button>
          </div>

          <!-- P-A7 权限矩阵：工具级开关 + 路径白名单 -->
          <div v-show="activeTab === 'permissions'">
            <h3><Shield :size="17" /> 权限矩阵</h3>
            <!-- P1-8 输出风格：与权限同页（都属于「约束模型行为」的设置） -->
            <div class="form-group">
              <label>回复风格</label>
              <div class="style-row">
                <button
                  v-for="s in OUTPUT_STYLES"
                  :key="s.id"
                  class="style-chip"
                  :class="{ 'style-chip--on': outputStyle === s.id }"
                  @click="((outputStyle = s.id), saveOutputStyle())"
                >
                  <b>{{ s.label }}</b>
                  <span>{{ s.hint }}</span>
                </button>
              </div>
              <span class="form-hint">
                写法会写进系统提示末尾（幂等替换，不会叠加）；切换后<b>下一轮</b>对话生效。
                「默认」= 不加额外约束，跟随模型自身风格。
              </span>
            </div>
            <p class="ollama-desc">
              工具级开关：被禁用的工具 Agent 无法调用；路径白名单：配置后 Agent
              的文件/命令类工具只能访问白名单内目录（写操作始终受主目录边界约束）。留空 = 不限制。
            </p>
            <div class="form-group approval-mode">
              <label
                class="memory-config__toggle"
                style="display: inline-flex; align-items: center; gap: 8px; cursor: pointer"
              >
                <input v-model="fileEditConfirm" type="checkbox" @change="saveEditConfirm" />
                <span>文件编辑需确认（Agent 改文件前先预览 diff，你确认后才写入）</span>
              </label>
              <span class="form-hint"
                >开启后，Agent 调用 replace_string / insert_string / delete_file 会先弹出
                diff/路径确认框，点「应用」才真正写盘；关闭则保持自动应用（可用「禁用工具」白名单保护文件）。</span
              >
            </div>
            <div class="form-group">
              <label>禁用工具（每行一个工具名）</label>
              <textarea
                v-model="disabledTools"
                rows="5"
                placeholder="如：write_file&#10;subagent_delegate&#10;puppeteer_screenshot"
                class="form-textarea"
                @change="savePermissions"
              ></textarea>
              <span class="form-hint"
                >在此列出的工具会被直接拦截（提示「已在权限矩阵中禁用」）。常见用途：禁用
                write_file/delete_file 防止 Agent 改文件、禁用浏览器工具防止弹窗。</span
              >
            </div>
            <!-- P1-4 声明式权限规则：有序，第一条命中即生效；可先 dry-run 再生效 -->
            <div class="form-group">
              <label>声明式权限规则（JSON 数组，有序；第一条命中即生效）</label>
              <textarea
                v-model="rulesText"
                rows="8"
                spellcheck="false"
                class="exec-rules-editor"
                placeholder='[
  {"id":"deny-rm","action":"deny","tool":"run_command","command":"rm -rf"},
  {"id":"test-ok","action":"allow","tool":"run_command","command":"^npm (test|run lint)\\b"},
  {"id":"code-ask","action":"ask","path":"~/op/**","reason":"改代码前确认"}
]'
              ></textarea>
              <span class="form-hint"
                >action：<code>allow</code>（免交互确认，仅本会话）· <code>deny</code>（硬拦截）·
                <code>ask</code>（每次都弹确认）。匹配条件：<code>tool</code>（工具名精确匹配）/
                <code>command</code>（命令正则）/ <code>path</code>（glob，<code>**</code> 跨目录、
                可用 <code>~/</code>）。<b>deny 建议写在 allow 前面</b>——第一条命中即生效。 allow
                只免「交互确认」，<b>不会绕过危险命令门禁</b>。未命中任何规则时按原有审批流程。</span
              >
              <div class="exec-rule-actions">
                <button class="btn-primary" @click="saveRules">保存并校验</button>
                <button class="btn-secondary" @click="dryRunRulesNow">
                  对最近 100 次真实调用试跑
                </button>
              </div>
              <ul v-if="rulesErrors.length" class="rules-errors">
                <li v-for="(e, i) in rulesErrors" :key="i">{{ e }}</li>
              </ul>
              <p v-if="dryCounts" class="form-hint">
                试跑结果：允许 {{ dryCounts.allow }} · 拒绝 {{ dryCounts.deny }} · 需确认
                {{ dryCounts.ask }} · 不涉及 {{ dryCounts.none }}
              </p>
              <div v-if="dryRows.length" class="rules-dry">
                <div v-for="(r, i) in dryRows" :key="i" class="rules-dry__row">
                  <span class="rules-dry__badge" :class="'rules-dry__badge--' + r.decision">{{
                    r.decision
                  }}</span>
                  <span class="rules-dry__detail">{{ r.detail }}</span>
                  <span class="rules-dry__matched">{{ r.matched }}</span>
                </div>
              </div>
            </div>
            <!-- P1-3 生命周期钩子：事件 → 动作（配置期就拦掉危险命令/内网地址） -->
            <div class="form-group">
              <label>生命周期钩子（JSON 数组）</label>
              <textarea
                v-model="hooksText"
                rows="8"
                spellcheck="false"
                class="exec-rules-editor"
                placeholder='[
  {"event":"turn_end","action":"notify","text":"一轮完成"},
  {"event":"tool_after","action":"shell","tool":"write_file","command":"npm run build"},
  {"event":"tool_after","action":"inject","when":"error","text":"上次调用失败了：{{error}}"}
]'
              ></textarea>
              <span v-pre class="form-hint">
                event：<code>turn_start</code> / <code>tool_before</code> /
                <code>tool_after</code> /
                <code>turn_end</code>。action：<code>notify</code>（系统通知）·
                <code>inject</code>（把文本注回下一轮上下文）· <code>block</code>（仅
                tool_before，拦下这次调用）· <code>shell</code>（执行命令）·
                <code>http</code>（发请求）。 可选过滤：<code>tool</code>（精确名或
                <code>prefix_*</code>）、<code>when</code>（success/error）。 占位符：<code>{{
                  tool
                }}</code>
                <code>{{ command }}</code> <code>{{ path }}</code> <code>{{ result }}</code>
                <code>{{ error }}</code>
                —— shell 里会自动单引号转义（模型内容无法拼接命令）。
                <b>安全边界</b>：禁止级命令直接拒绝入表，危险级需显式写
                <code>"allow_danger": true</code>； HTTP 只允许 http/https 且默认拒绝内网地址（需
                <code>"allow_private": true</code>）； 运行时 shell
                动作还会再受「声明式权限规则」约束。
              </span>
              <div class="exec-rule-actions">
                <button class="btn-primary" @click="saveHooks">保存并校验</button>
              </div>
              <ul v-if="hooksErrors.length" class="rules-errors">
                <li v-for="(e, i) in hooksErrors" :key="i">{{ e }}</li>
              </ul>
            </div>

            <div class="form-group">
              <label>路径白名单（每行一个目录）</label>
              <textarea
                v-model="allowedPaths"
                rows="5"
                placeholder="如：/Users/wanghuan/op&#10;~/Pictures"
                class="form-textarea"
                @change="savePermissions"
              ></textarea>
              <span class="form-hint"
                >配置后 Agent 的 list_dir / 文件编辑 / git / 测试 /
                项目分析等工具只能访问这些目录；留空 = 不限制。</span
              >
            </div>
            <div class="form-group">
              <label>命令执行策略（规则文件，持久化）</label>
              <textarea
                v-model="execRules"
                rows="10"
                spellcheck="false"
                class="exec-rules-editor"
                placeholder="allow | deny | prompt &lt;命令前缀&gt;&#10;如：allow git status&#10;    deny rm -rf"
              ></textarea>
              <div class="exec-rule-actions">
                <input
                  v-model="execTestCmd"
                  placeholder="输入命令测试决策，如：git push --force origin main"
                  @keyup.enter="testExecRule"
                />
                <button class="btn-secondary" @click="testExecRule">测试</button>
              </div>
              <p v-if="execTestResult" class="form-hint">{{ execTestResult }}</p>
              <div class="exec-rule-actions">
                <button class="btn-primary" @click="saveExecRules">保存</button>
                <button class="btn-secondary" @click="resetExecRules">恢复默认</button>
              </div>
              <span class="form-hint"
                >语法：<code>allow | deny | prompt &lt;命令前缀&gt;</code>（按 token
                前缀匹配，文件顺序优先、首条命中生效）。deny 直接拦截；allow
                直接放行（即使命中内置危险模式）；prompt 必须确认。示例：<code
                  >allow git status</code
                >
                不再确认、<code>deny rm -rf</code>
                直接拦截。未命中规则时按默认三档审批（manual/smart/yolo）。</span
              >
            </div>
          </div>

          <!-- 外观：主题偏好（跟随系统 / 深色 / 浅色） -->
          <div v-show="activeTab === 'appearance'">
            <h3><Palette :size="17" /> 外观</h3>
            <p class="ollama-desc">
              主题选择会立即生效并记住；选「跟随系统」时 macOS 切换浅色/深色，应用会
              <strong>立刻</strong>跟着变（不是只在启动时读一次）。
            </p>
            <div class="form-group">
              <label>主题</label>
              <div class="style-chips">
                <button
                  v-for="opt in THEME_OPTIONS"
                  :key="opt.value"
                  :class="['style-chip', { active: themePref === opt.value }]"
                  @click="setThemePref(opt.value as ThemePref)"
                >
                  {{ opt.label }}
                </button>
              </div>
              <span class="form-hint"
                >当前偏好：{{ themePrefLabel(themePref) }}（生效：{{
                  resolvedTheme === "dark" ? "深色" : "浅色"
                }}）· {{ themePrefHint(themePref, systemDark) }}</span
              >
            </div>
          </div>

          <!-- Phase 5 全局快捷键 -->
          <div v-show="activeTab === 'shortcuts'">
            <h3><Keyboard :size="17" /> 全局快捷键</h3>
            <p class="ollama-desc">
              全局快捷键在应用最小化/隐藏到后台时仍生效。格式：修饰键 + 键名（如
              CommandOrControl+Shift+Space）。仅支持单个非修饰键 + 修饰键组合。
            </p>
            <div class="form-group">
              <label>显示 / 隐藏主窗口（快速召唤）</label>
              <input
                v-model="shortcutToggle"
                placeholder="CommandOrControl+Shift+Space"
                @change="saveShortcuts"
              />
              <span class="form-hint"
                >macOS 用 Command / ⌘；Windows/Linux 用 Control /
                Ctrl。例：CommandOrControl+Shift+Space、CommandOrControl+Alt+D</span
              >
            </div>
            <div class="form-group">
              <label>新建对话</label>
              <input
                v-model="shortcutNewChat"
                placeholder="CommandOrControl+Shift+K"
                @change="saveShortcuts"
              />
              <span class="form-hint"
                >保存后立即生效（注销旧快捷键并按新配置重新注册）。若提示被占用，说明与其他应用冲突，请换一个组合。</span
              >
            </div>
            <button class="settings-reset-btn" @click="resetShortcuts">
              恢复默认（⌘⇧Space / ⌘⇧K）
            </button>

            <h3 style="margin-top: 22px"><Bell :size="17" /> 系统通知</h3>
            <p class="ollama-desc">
              任务完成或给出最终产物时发系统通知。仅当主窗口不在前台时才提醒（正在看着屏幕时
              不打扰），用户主动「停止生成」也不会误报为完成。
            </p>
            <div class="form-group">
              <label
                class="memory-config__toggle"
                style="display: inline-flex; align-items: center; gap: 8px; cursor: pointer"
              >
                <input v-model="notifyOnFinish" type="checkbox" @change="saveNotify" />
                <span>任务完成时发送系统通知</span>
              </label>
            </div>
            <div class="form-group">
              <label>系统通知权限</label>
              <span class="form-hint">
                {{
                  notifGranted === null
                    ? "状态未知（无法查询通知权限）"
                    : notifGranted
                      ? "✅ 已允许"
                      : "❌ 未允许"
                }}<template v-if="notifDiagnose">
                  ｜权限状态：{{ notifDiagnose.state }} ｜运行方式：{{
                    notifDiagnose.bundled ? "已打包 .app" : "开发模式（裸二进制）"
                  }}</template
                >
              </span>
              <p
                v-if="notifDiagnose"
                class="form-hint"
                :class="{ 'notif-warn': !notifDiagnose.bundled || !notifDiagnose.granted }"
              >
                {{ notifDiagnose.hint }}
              </p>
              <div style="display: flex; gap: 8px; margin-top: 8px">
                <button class="settings-reset-btn" @click="requestNotif">请求权限</button>
                <button class="settings-reset-btn" @click="testNotify">发送测试通知</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-dialog__footer">
        <!-- 删除/保存 只对「API 配置」页生效（针对正在编辑的模型配置），其余页只保留关闭 -->
        <button
          v-if="activeTab === 'api' && !isNew && chatStore.profiles.length > 1"
          class="btn-danger"
          @click="handleDelete"
        >
          删除此配置
        </button>
        <div class="settings-dialog__footer-spacer"></div>
        <button class="btn-secondary" @click="emit('close')">取消</button>
        <button v-if="activeTab === 'api'" class="btn-primary" @click="handleSave">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  animation: fadeIn 0.2s;
}

.settings-dialog {
  width: 640px;
  height: min(85vh, 720px);
  background: var(--bg-elevated);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl);
  overflow: hidden;
  animation: scaleIn 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
}

.settings-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}
.settings-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
}

/* 左侧菜单 */
.settings-nav {
  width: 168px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-color);
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  background: var(--bg-secondary);
}
/* 分组不再是一个个孤立的 tab，而是「一组回答一个问题」 */
.settings-nav__group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.settings-nav__group-title {
  padding: 8px 12px 3px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--text-secondary);
  opacity: 0.7;
  user-select: none;
}
.settings-nav__group:first-child .settings-nav__group-title {
  padding-top: 2px;
}
.settings-tab {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition: all 0.15s;
}
.settings-tab:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.settings-tab.active {
  background: var(--accent-bg);
  color: var(--accent-color);
  font-weight: 600;
}
.settings-tab__icon {
  width: 20px;
  text-align: center;
  flex-shrink: 0;
}

.btn-close {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.btn-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.settings-dialog__body {
  display: flex;
  flex-direction: row;
  gap: 0;
  overflow: hidden;
  flex: 1;
  min-height: 0;
  padding: 0;
}

/* 右侧内容区：各 panel 在此滚动 */
.settings-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.profile-tabs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.profile-tab {
  padding: 6px 16px;
  border: 1.5px solid var(--border-color);
  border-radius: 22px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 550;
  cursor: pointer;
  transition: all 0.2s;
}
.profile-tab:hover {
  border-color: var(--accent-color);
  color: var(--text-primary);
}
.profile-tab--active {
  background: var(--accent-color);
  border-color: var(--accent-color);
  color: #fff;
}
.profile-tab--add {
  font-size: 18px;
  padding: 4px 12px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.form-group label {
  font-size: 12px;
  font-weight: 650;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.form-group input {
  padding: 10px 14px;
  border: 1.5px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition: all 0.2s;
}
.form-group input:focus {
  border-color: var(--accent-color);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
}
.form-hint {
  font-size: 11px;
  color: var(--text-muted);
}
.settings-reset-btn {
  padding: 8px 14px;
  border: 1.5px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.settings-reset-btn:hover {
  border-color: var(--accent-color);
  color: var(--accent-color);
}
.approval-modes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 6px;
}
.approval-mode {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1.5px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition: all 0.15s;
}
.approval-mode:hover {
  border-color: var(--accent-color);
}
.approval-mode.active {
  border-color: var(--accent-color);
  background: color-mix(in srgb, var(--accent-color) 12%, transparent);
}
.approval-mode-name {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}
.approval-mode-desc {
  font-size: 11px;
  color: var(--text-muted);
}
.form-select {
  width: 100%;
} /* 背景/边框/hover/focus 统一走全局 select 样式（main.css） */
.form-textarea {
  padding: 10px 14px;
  border: 1.5px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  resize: vertical;
  transition: all 0.2s;
}
.form-textarea:focus {
  border-color: var(--accent-color);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
}
.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.model-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.model-select {
  position: relative;
  flex: 1;
  min-width: 0;
}
.model-select input {
  width: 100%;
  box-sizing: border-box;
}
.model-select__dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 240px;
  overflow-y: auto;
  z-index: 60;
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xl);
}
.model-select__option {
  padding: 8px 14px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-primary);
  transition: background 0.12s;
}
.model-select__option:hover {
  background: var(--bg-hover);
}
.model-select__option.on {
  color: var(--accent-color);
  font-weight: 600;
}
.btn-fetch {
  padding: 10px 14px;
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
}
.form-hint--error {
  color: #f87171;
}

.exec-rules-editor {
  width: 100%;
  box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  outline: none;
  resize: vertical;
  transition: all 0.2s;
}
.exec-rules-editor:focus {
  border-color: var(--accent-color);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
}
.exec-rule-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.exec-rule-actions input {
  flex: 1;
  padding: 8px 10px;
  font-size: 12px;
  min-width: 0;
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  outline: none;
}
.exec-rule-actions input:focus {
  border-color: var(--accent-color);
}
.exec-rule-actions .btn-primary,
.exec-rule-actions .btn-secondary {
  padding: 8px 16px;
}

/* P1-8 输出风格选择器 */
.style-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
}
.style-chip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  transition: all 0.15s;
}
.style-chip span {
  color: var(--text-secondary);
  font-size: 11px;
}
.style-chip:hover {
  background: var(--bg-hover);
}
.style-chip--on {
  border-color: var(--accent-color);
  box-shadow: 0 0 0 1px var(--accent-color) inset;
}

/* P1-4 权限规则：校验错误与试跑结果 */
.rules-errors {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--danger-color, #c62828);
  line-height: 1.6;
}
.rules-dry {
  margin-top: 6px;
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rules-dry__row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 11px;
}
.rules-dry__badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  color: #fff;
  background: var(--text-secondary, #888);
}
.rules-dry__badge--allow {
  background: #2e7d32;
}
.rules-dry__badge--deny {
  background: #c62828;
}
.rules-dry__badge--ask {
  background: #ef6c00;
}
.rules-dry__detail {
  font-family: ui-monospace, Menlo, monospace;
  color: var(--text-primary);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rules-dry__matched {
  color: var(--text-secondary, #888);
  flex-shrink: 0;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.form-group code {
  background: var(--bg-secondary);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12px;
}

.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
}
.toggle-input {
  width: 40px;
  height: 22px;
  appearance: none;
  -webkit-appearance: none;
  background: var(--border-color);
  border-radius: 12px;
  position: relative;
  cursor: pointer;
  transition: background 0.2s;
}
.toggle-input::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s;
}
.toggle-input:checked {
  background: var(--accent-color);
}
.toggle-input:checked::after {
  transform: translateX(18px);
}

.settings-dialog__footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 24px;
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
}
.settings-dialog__footer-spacer {
  flex: 1;
}

.btn-primary,
.btn-secondary,
.btn-danger {
  padding: 9px 22px;
  border: none;
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.btn-primary {
  background: var(--accent-color);
  color: #fff;
}
.btn-primary:hover {
  background: var(--accent-hover);
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
}
.btn-secondary {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}
.btn-secondary:hover {
  background: var(--bg-hover);
}
.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-ghost:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.btn-danger {
  background: var(--danger-bg);
  color: var(--danger-color);
}
.btn-danger:hover {
  background: rgba(239, 68, 68, 0.15);
}

/* P0-资源 本地运行时卡片（llama.cpp / Ollama 选择与状态） */
.runtime-card {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  margin: 10px 0;
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.runtime-card__title {
  font-size: 13px;
  font-weight: 650;
  color: var(--text-primary);
}
.runtime-card__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.runtime-card__row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.runtime-card__row select {
  padding: 6px 10px;
  border-radius: var(--radius-sm, 6px);
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
}
.runtime-card__row .btn-secondary {
  padding: 6px 12px;
  font-size: 12px;
}
.runtime-card__row .btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.runtime-card__grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}
.runtime-card__path {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  word-break: break-all;
  opacity: 0.85;
}
.runtime-card__msg {
  margin: 0;
  font-size: 12px;
  color: var(--text-primary);
}
.runtime-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-color);
  color: #fff;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes scaleIn {
  from {
    opacity: 0;
    transform: scale(0.94) translateY(8px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

/* --- Ollama 本地视觉模型面板 --- */
.ollama-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ollama-panel h3 {
  margin: 0;
  font-size: 16px;
}
.ollama-desc {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
}
.ollama-loading {
  color: var(--text-secondary);
  font-size: 13px;
  padding: 8px 0;
}
.ollama-status {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}
.ollama-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.ollama-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.ollama-dot.green {
  background: #22c55e;
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.5);
}
.ollama-dot.yellow {
  background: #f59e0b;
  box-shadow: 0 0 6px rgba(245, 158, 11, 0.5);
  animation: ollama-blink 1s ease-in-out infinite;
}
.ollama-dot.red {
  background: #ef4444;
}
@keyframes ollama-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
.ollama-models {
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
}
.ollama-panel .btn-primary {
  align-self: flex-start;
  margin-top: 4px;
}
.ollama-panel .btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.ollama-hint {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
}
.ollama-progress {
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.6;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  max-height: 200px;
  overflow-y: auto;
}
.ollama-bar {
  position: relative;
  height: 22px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
}
.ollama-bar__fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent-color), #22c55e);
  transition: width 0.3s ease;
}
.ollama-bar__label {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

/* 硬件评估卡片 */
.hw-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 13px;
}
.hw-card__title {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.hw-score {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-hover);
  padding: 1px 8px;
  border-radius: 10px;
}
.hw-card__row {
  color: var(--text-secondary);
}
.hw-card__verdict {
  font-weight: 600;
  margin-top: 4px;
}
.hw-card__verdict--recommended {
  color: #22c55e;
}
.hw-card__verdict--warning {
  color: #f59e0b;
}
.hw-card__verdict--not_recommended {
  color: #ef4444;
}
.hw-card__msg {
  margin: 0;
  color: var(--text-secondary);
  line-height: 1.6;
  border-top: 1px dashed var(--border-color);
  padding-top: 8px;
}
</style>
