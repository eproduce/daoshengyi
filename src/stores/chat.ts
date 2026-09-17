import { defineStore } from "pinia";
import { ref, computed, watch, reactive } from "vue";
import type {
  Conversation,
  ChatMessage,
  ChatTool,
  ApiConfig,
  ApiProfile,
  ImageAttachment,
  FileAttachment,
  MessageRole,
  PlanStepStatus,
  TaskPlan,
} from "@/types";
import { v4 as uuidv4 } from "./uuid";
import { formatSearchResults } from "@/api/search";
import { getPersona } from "@/data/personas-catalog";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSkillStore } from "./skill";
import { MCP_CATALOG } from "@/data/mcp-catalog";
import { useMcpStore, isBrowserServer } from "./mcp";
import { useMemorySystem } from "./memory";
import { estimateMessageTokens, estimateCost, modelContextWindowTokens } from "@/utils/tokens";
import {
  parseToolCall,
  stripToolJson,
  formatToolResultPreview,
  hasCompleteToolCall,
  hasToolCallIntent,
  visibleText,
  type ToolCall,
} from "@/utils/tool-call";
import { withBrowserLock } from "@/utils/browser-lock";
import { BUILTIN_TOOLS } from "@/data/builtin-tools";
// 融合 Codex（openai/codex）的 apply_patch：解析其补丁格式并翻译成既有 apply_edits 操作
import { parseCodexPatch, hunksToEdits, summarizePatch } from "@/utils/codex-patch";

/// 单轮（一次 API 请求）的 token 用量。usage 通常只在最后一个 chunk 到达一次。
interface RoundUsage {
  /** 输入 token（该轮 prompt） */
  prompt: number;
  /** 输出 token（该轮模型生成） */
  completion: number;
  /** 总 token（prompt + completion） */
  total: number;
}

/// 已知内置工具名集合：内置工具**永不**被路由到 MCP 服务器。/// 背景（AGENT_DIAGNOSIS 问题 4）：`fetch_page` 是内置工具，却被按名字匹配转发给某个
/// MCP 服务器，结果 `MCP error -32602: Tool fetch_page not found`（3/3 全失败）。
const BUILTIN_TOOL_NAMES = new Set(BUILTIN_TOOLS.map((t) => t.name));

/// view_image 读取的图片（data URL）暂存区：在下一轮请求前作为多模态 user 消息注入上下文，
/// 让视觉模型**原生看图**（融合 Codex 的 view_image；DeepSeek 等不支持图片的模型走本地描述兜底）。
const pendingViewImages: string[] = [];

/// 把暂存的 view_image 图片注入消息数组（在发起下一轮请求前调用）
function flushPendingViewImages(msgs: AgentMsg[]): void {
  if (pendingViewImages.length === 0) return;
  const imgs = pendingViewImages.splice(0, pendingViewImages.length);
  msgs.push({
    role: "user",
    content: [
      { type: "text", text: "（以下是 view_image 工具读取的图片，请直接查看）" },
      ...imgs.map((url) => ({ type: "image_url", image_url: { url, detail: "high" } })),
    ],
  });
}
import { getRoleById, roleAllowedToolNames } from "@/data/roles-catalog";
import { getModeById, isToolAllowedByMode, type AgentModeId } from "@/data/modes-catalog";
import { isToolDisabled, isPathAllowed, pathArgOf } from "@/utils/permissions";
import { routeProfileId } from "@/utils/model-routing";
import { shouldSkipAutoSearch } from "@/utils/search-gate";
import { askConfirm, notify } from "@/utils/dialog";
import { initSettings, updateSettings, getSettings, reloadSettings } from "@/api/appSettings";
import { discoverProjectInstructions } from "@/utils/agents-md";
import {
  executeWorkflow,
  validateWorkflowGraph,
  scoreTaskAgainstWorkflow,
  type WorkflowGraph,
} from "@/utils/workflow-engine";
import {
  buildMiningPrompt,
  minedWorkflowName,
  parseMinedGraph,
  shouldMineWorkflow,
  type MinedToolStep,
} from "@/utils/workflow-mining";
import { markExternalToolResult } from "@/utils/untrusted";
import { buildSkillRoutingTable, matchSkillsForMessage, collectSkillRequires } from "@/utils/skill-router";
import {
  buildNativeToolRegistry,
  activateCatalogTool,
  supportsNativeTools,
  parseNativeArguments,
  type OpenAIFunctionTool,
  type NativeToolRegistry,
} from "@/utils/tool-schema";
import { BM25Index, buildToolSearchText } from "@/utils/tool-search";
// 确定性工具集（融合自 DeepSeek Harness 生态的 dsh-toolkit）：算错了没人能发现，故下沉到代码
import { runDeterministicTool } from "@/utils/deterministic-tools";
// 工具结果进上下文前先脱敏（密钥绝不进上下文/日志/落盘）
import { redactSecrets } from "@/utils/secret-redact";
// 工具结果内容感知压缩（错误行优先保留，只丢冗余）
import { reduceToolResult } from "@/utils/tool-result-reduce";
// 危险命令分级判定（吸收自 DSH 生态 safety-net / risk-gate：分级 + 原因 + 误报抑制）
import { assessCommandRisk, describeRisk, type RiskVerdict } from "@/utils/danger-rules";
// 工具调用参数自愈（吸收自 DSH 生态 dsh-tool-normalizer：别名/类型/包裹层）
import { normalizeToolArgs } from "@/utils/tool-arg-normalize";
import { BUILTIN_PARAMETERS } from "@/data/builtin-params";
// 验证凭据（吸收自 DSH 生态 stalegreen / dsh-verification：声称「通过」必须有新鲜凭据）
import {
  MUTATION_TOOLS,
  classifyVerificationCommand,
  noteMutation,
  noteVerification,
  resetVerificationReceipts,
  evaluateVerificationClaims,
} from "@/utils/verify-receipts";
// P0-6 预算护栏：与 utils/goals.ts 的「目标 token 预算」互补——
// 那个是给模型的收尾提示（token），这个是给用户的花钱护栏（元）。
import { budgetNoticeKey, buildSpend, evaluateBudget } from "@/utils/budget";
// P1-2 行锚点（哈希锚定编辑）：拒绝过期锚点 + 用锚点给 old_text 消歧
import {
  annotateLines,
  hasAnchorPrefix,
  hashLine,
  occurrenceForAnchor,
  parseAnchor,
  stripAnchorPrefix,
  toLines,
  verifyAnchor,
} from "@/utils/line-anchor";
// P1-4 声明式权限规则（allow/deny/ask，有序、第一条命中）
import {
  evaluateRules,
  parseRules,
  type PermissionRule,
  type ToolCallContext,
} from "@/utils/permission-rules";
// P1-3 生命周期钩子（配置驱动；shell/http 动作的边界见 utils/hooks.ts）
import {
  parseHooks,
  planHooks,
  type HookContext,
  type HookRule,
  type PlannedAction,
} from "@/utils/hooks";
// P1-5 压缩阶梯（30/50/70/82）：早档无损预备，硬压缩时带上确定性产物
import {
  mergeDigestIntoSummary,
  pendingStages,
  prepareDigest,
  type PreparedDigest,
  type StageId,
} from "@/utils/compaction-ladder";
// P1-7 决策日志（DECISIONS.md）
import {
  countDecisions,
  decisionPath,
  mergeDecision,
  oneLine,
} from "@/utils/decision-log";
// P1-8 输出风格（结论先行/详细/教学/审阅）
import { applyOutputStyle } from "@/utils/output-styles";
// P1-9b 失败台账：同一工具同一错误重复失败 → 提醒模型别再原样重试
import { failureHint } from "@/utils/failure-ledger";
// read_file 分段读取（offset/length 曾被静默忽略，只能靠 awk 绕过）
import { sliceFileLines, isWholeFile } from "@/utils/file-slice";
// OCR 读到长数字串时提示用 image_inspect 交叉验证（等宽数字串 OCR 最不可靠）
import { ocrCrossCheckHint } from "@/utils/ocr-advice";
// P1-6 自动续跑规则表（按问题类型路由；带全套护栏，宁可放过不死循环）
import {
  planAutoContinue,
  type TurnSignals,
} from "@/utils/auto-continue";
import {
  addGoalUsage,
  budgetExceeded,
  budgetLine,
  getGoal,
  goalPrompt,
  isUnfinished,
  saveGoal,
  type Goal,
  type GoalStatus,
} from "@/utils/goals";

/** 原生 function calling：Rust resolve 后经 sse-tool-calls 回传的结构化调用 */
export interface NativeToolCallMsg {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** 发给 Rust 的消息：原生模式可携带 tool_calls（assistant）或 tool_call_id（tool 结果） */
export interface AgentMsg {
  role: string;
  content: unknown;
  tool_calls?: NativeToolCallMsg[];
  tool_call_id?: string;
}

/// 前端诊断日志（写 daoshengyi.log + 终端），排查工具循环等前端链路问题
async function dbg(msg: string): Promise<void> {
  try {
    await invoke("debug_log", { msg });
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/// 从模型输出中提取 JSON 对象文本（去 markdown 围栏；取首个 { 到末个 }）
function extractJsonBlock(s: string): string {
  const t = s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  return start >= 0 && end > start ? t.slice(start, end + 1) : t;
}

// --- MCP 工具辅助 ---
let mcpToolsCache: {
  server: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}[] = [];
let mcpToolsRefreshing: Promise<void> | null = null;

/// 当前会话的原生工具注册表（供 `tool_search` 检索并**激活**未直接声明的工具）。
/// 每次 sendMessage 重建注册表时刷新；其中 `tools` 是同一数组引用，激活后下一轮即生效。
let activeToolRegistry: NativeToolRegistry | null = null;
/// tool_search 的 BM25 索引（随注册表重建而重建）
let toolSearchState: { registry: NativeToolRegistry; index: BM25Index } | null = null;
/// 最近一轮请求的真实 prompt tokens（API usage 回报，最准的「上下文占用」信号）
let lastPromptTokens = 0;

/// 构建/复用 tool_search 索引（检索范围 = 全部工具目录，含未声明的延迟工具）
function ensureToolSearchIndex(reg: NativeToolRegistry): BM25Index {
  if (!toolSearchState || toolSearchState.registry !== reg) {
    const index = new BM25Index(
      reg.catalog.map((c) => ({
        id: c.name,
        text: buildToolSearchText(c.name, c.description, c.server),
      })),
    );
    toolSearchState = { registry: reg, index };
  }
  return toolSearchState.index;
}

/// 浏览器自动化（server-puppeteer）常用工具占位定义。
/// 原生 function calling 会话里，若浏览器服务器「已启用但未连接」，其工具不在 mcpToolsCache
/// → 注册表没有 puppeteer_* 函数名，模型发不出合法原生调用，只能退化成 osascript + screencapture
/// 全屏截图 + describe_image 等绕路（截到无关画面、本地视觉模型输出荒谬 → 卡在“渲染核验”）。
/// 这里把标准 puppeteer 工具预置进注册表；模型原生调用时 callMcpTool 命中「按需激活」分支
/// 自动连接真实浏览器服务器——与文本模式的按需激活流一致。
const BROWSER_TOOL_STUBS: { name: string; desc: string }[] = [
  {
    name: "puppeteer_navigate",
    desc: '在本地浏览器打开并加载一个网页（自动等待网络空闲 networkidle2）。参数 {"url": "http(s)://完整网址"}。本地生成的 HTML 可先 run_command 起本地 http.server 再访问。',
  },
  {
    name: "puppeteer_fill",
    desc: '在页面输入框填入文本（触发输入事件）。参数 {"selector": "CSS 选择器", "value": "要输入的文本"}。',
  },
  {
    name: "puppeteer_click",
    desc: '点击页面元素。参数 {"selector": "CSS 选择器"}。',
  },
  {
    name: "puppeteer_hover",
    desc: '悬停页面元素。参数 {"selector": "CSS 选择器"}。',
  },
  {
    name: "puppeteer_select",
    desc: '选择下拉框选项。参数 {"selector": "CSS 选择器", "value": "选项值"}。',
  },
  {
    name: "puppeteer_evaluate",
    desc: '在页面执行 JS 并返回结果（如 document.body.innerText 提取渲染后文本，最可靠）。参数 {"function": "JS 函数体字符串"}。',
  },
  {
    name: "puppeteer_screenshot",
    desc: "对当前页面截图并保存到本地，返回可点击的图片路径（用于视觉核验渲染效果）。",
  },
];
/** 存在“已启用但未连接”的浏览器服务器时，返回其未入缓存的 puppeteer 占位工具，
 *  供原生注册表预置，让模型能原生触发按需激活、真正驱动浏览器（而非绕路截屏）。 */
function browserStubTools(): {
  server: string;
  name: string;
  description: string;
  kind: "mcp";
}[] {
  const mcp = useMcpStore();
  const pending = mcp.servers.find(
    (s) => s.enabled && !s.connected && isBrowserServer(s.name, s.command),
  );
  if (!pending) return [];
  const cached = new Set(mcpToolsCache.map((t) => t.name));
  return BROWSER_TOOL_STUBS.filter((s) => !cached.has(s.name)).map((s) => ({
    server: pending.name,
    name: s.name,
    description: s.desc,
    kind: "mcp" as const,
  }));
}

// --- Agent 多模式（§3.11）：当前模式 id。模块级定义（供模块级 callMcpTool 做工具白名单拦截），
// store 内 setMode 同步写入 localStorage。模式=行为约束提示词 + 工具白名单（modes-catalog）。 ---
const MODE_KEY = "daoshengyi_mode";
const MODE_HIST_KEY = "daoshengyi_mode_hist";
function loadMode(): AgentModeId {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved && getModeById(saved)) return saved as AgentModeId;
  } catch {
    /* ignore */
  }
  // 模式记忆（§3.11 Phase B）：未显式保存时，用历史使用频次最高的模式（默认对话）
  try {
    const hist: Record<string, number> = JSON.parse(localStorage.getItem(MODE_HIST_KEY) || "{}");
    let best: AgentModeId = "chat";
    let bestN = 0;
    for (const [id, n] of Object.entries(hist)) {
      if (n > bestN && getModeById(id)) {
        best = id as AgentModeId;
        bestN = n;
      }
    }
    if (bestN > 0) return best;
  } catch {
    /* ignore */
  }
  return "chat";
}
const activeModeId = ref<AgentModeId>(loadMode());
/// 当前正在执行的工具标签（如 "read_file" / "github · create_issue"）。
/// 模块级：供系统托盘实时展示「当前上下文」；在 callMcpTool 中央漏斗写入，本轮结束清空。
const currentToolLabel = ref("");
/// 本轮开始时间戳（毫秒；0=空闲）。供托盘展示已耗时。
const turnStartedAt = ref(0);
/// 模式使用频次（供 UI 显示「常用」；不参与响应式，读取时解析 localStorage）
function readModeHist(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(MODE_HIST_KEY) || "{}");
  } catch {
    return {};
  }
}
function bumpModeHist(id: AgentModeId) {
  try {
    const hist = readModeHist();
    hist[id] = (hist[id] || 0) + 1;
    localStorage.setItem(MODE_HIST_KEY, JSON.stringify(hist));
  } catch {
    /* ignore */
  }
}

// --- 会话级权限记忆（§3.10 🟡）：本会话内已允许的操作（按工具名），减少重复确认。 ---
// 用户在某文件操作确认弹窗勾选「本会话内不再询问」后，该工具后续调用自动放行（仅本会话有效）。
const sessionPermits = reactive<Set<string>>(new Set());
function hasSessionPermit(tool: string): boolean {
  return sessionPermits.has(tool);
}
function rememberSessionPermit(tool: string): boolean {
  sessionPermits.add(tool);
  return true;
}
function clearSessionPermits() {
  sessionPermits.clear();
}

// --- P1-4 声明式权限规则：deny（硬拦截）/ ask（每次必须确认）/ allow（本会话免确认） ---
// 安全边界：allow 只免掉「交互确认」，**不免掉 danger/forbidden 命令门禁**（系统级保护）。
function permissionRules(): PermissionRule[] {
  return parseRules(getSettings().permissionRules ?? []).rules;
}
// 主目录（用于规则里 `~/…` 的展开）：Tauri path API，取一次缓存
let cachedHome = "";
async function userHome(): Promise<string> {
  if (cachedHome) return cachedHome;
  try {
    const h = await homeDir();
    cachedHome = h.replace(/\/+$/, "");
  } catch {
    cachedHome = "";
  }
  return cachedHome;
}
/**
 * 求值权限规则。返回字符串 = **应当直接返回给模型的结果**（命中 deny）；
 * 返回 true = 放行（allow 已记住会话免确认）；false = 未命中（走原有审批流程）。
 * `ask` 会在这里就地弹确认框，用户拒绝则返回拒绝文案。
 */
async function applyPermissionRules(tool: string, args: Record<string, unknown>): Promise<string | true | false> {
  const rules = permissionRules();
  if (!rules.length) return false;
  const ctx: ToolCallContext = {
    tool,
    command:
      typeof args.command === "string"
        ? args.command
        : typeof args.cmd === "string"
          ? args.cmd
          : undefined,
    path:
      typeof args.path === "string"
        ? args.path
        : typeof args.file_path === "string"
          ? args.file_path
          : undefined,
  };
  const v = evaluateRules(rules, ctx, await userHome());
  if (v.decision === "none") return false;
  if (v.decision === "deny") {
    dbg(`[rules] 拒绝 ${tool}：${v.message}`);
    return v.message;
  }
  if (v.decision === "ask") {
    const ok = await askConfirm(`${v.message}\n\n允许本次调用吗？`);
    if (!ok) return `⚠️ 用户拒绝了本次调用（${tool}）。请与用户确认后重试，或改用其它方式。`;
    return false; // 已确认过 → 不再走后续确认（避免同一动作连问两次）
  }
  // allow：记入本会话免确认（仅免交互确认，danger/forbidden 命令仍受门禁约束）
  dbg(`[rules] 放行 ${tool}：${v.message}`);
  rememberSessionPermit(tool);
  return true;
}

// --- P1-3 生命周期钩子运行器 ---
// 边界：① 命令只来自配置（占位符已在 renderTemplate 里 shell 转义）；
//       ② 配置期已用危险命令门禁校验（forbidden 拒入表、danger 需显式放行）；
//       ③ HTTP 走 Rust fetch_page（含 SSRF 策略）；
//       ④ shell 动作执行前再跑一遍 P1-4 权限规则（deny 放弃 / ask 确认）。
const hookInjections: string[] = [];

function hookRules(): HookRule[] {
  return parseHooks(getSettings().hooks ?? []).hooks;
}

/// 把待注入文本在下一轮开头回填（与 view_image 图片同一位置），并在回填后清空
function flushHookInjections(msgs: AgentMsg[]): void {
  if (!hookInjections.length) return;
  const text = hookInjections.splice(0).join("\n\n");
  msgs.push({
    role: "user",
    content: `【钩子注入】以下是外部钩子在本轮写入的上下文（供参考，不代表用户发言）：\n${text}`,
  });
  dbg(`[hook] 注入 ${text.length} 字符`);
}

/// 执行一条已渲染的动作（block 不在这里处理，它需要即时拦截）
async function runHookAction(a: PlannedAction): Promise<void> {
  const label = a.rule.id ?? `#${a.index + 1}`;
  try {
    if (a.kind === "notify") {
      invoke("notify_user", { title: "道生一 · 钩子", body: a.text, onlyWhenUnfocused: true }).catch(
        () => {},
      );
      return;
    }
    if (a.kind === "http") {
      // 复用 fetch_page：内含 SSRF 策略（内网/环回拦截）
      await invoke("fetch_page", { url: a.url });
      dbg(`[hook] ${label} http ${a.method} ${a.url} 完成`);
      return;
    }
    if (a.kind === "shell") {
      // 边界④：钩子的命令同样受权限规则约束
      const verdict = evaluateRules(permissionRules(), { tool: "run_command", command: a.command }, await userHome());
      if (verdict.decision === "deny") {
        dbg(`[hook] ${label} 命令被权限规则拒绝：${verdict.message}`);
        return;
      }
      if (verdict.decision === "ask") {
        const ok = await askConfirm(`${verdict.message}\n\n钩子「${label}」要执行：\n$ ${a.command}\n\n允许吗？`);
        if (!ok) {
          dbg(`[hook] ${label} 用户拒绝了钩子命令`);
          return;
        }
      }
      const res = await invoke<string>("run_command", {
        command: a.command,
        timeoutSecs: a.timeout,
      }).catch((e: unknown) => `钩子命令失败: ${e instanceof Error ? e.message : String(e)}`);
      dbg(`[hook] ${label} shell 完成：${String(res).slice(0, 200)}`);
    }
  } catch (e) {
    // 钩子失败不得影响主流程（记日志即可）
    dbg(`[hook] ${label} 执行异常：${e instanceof Error ? e.message : String(e)}`);
  }
}

/// 触发一个事件上的全部钩子；返回要即时拦截的文案（仅 tool_before 的 block）
async function fireHooks(ctx: HookContext): Promise<string | null> {
  const rules = hookRules();
  if (!rules.length) return null;
  const { actions, injections, skipped } = planHooks(rules, ctx);
  for (const s of skipped) dbg(`[hook] ${s}`);
  hookInjections.push(...injections);
  if (!actions.length && !injections.length) return null;
  // block：第一个命中的先生效（与行动作并发执行）
  const blockAction = actions.find((a) => a.kind === "block");
  for (const a of actions) {
    if (a.kind === "block") continue;
    void runHookAction(a);
  }
  return blockAction ? `⛔ 钩子拦截了本次调用：${blockAction.text}` : null;
}
export async function refreshMcpTools() {
  // 单飞（single-flight）：并发调用只执行一次、共享同一结果。并行子代理/主代理
  // 可能同时触发刷新，避免两次 refresh 交错清空 mcpToolsCache 导致读到空缓存。
  if (mcpToolsRefreshing) return mcpToolsRefreshing;
  mcpToolsRefreshing = (async () => {
    try {
      const servers =
        await invoke<
          [string, { name: string; description: string; inputSchema?: Record<string, unknown> }[]][]
        >("mcp_list_tools");
      mcpToolsCache = [];
      for (const [server, tools] of servers) {
        for (const t of tools)
          mcpToolsCache.push({
            server,
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          });
      }
    } catch {
      mcpToolsCache = [];
    }
  })();
  try {
    await mcpToolsRefreshing;
  } finally {
    mcpToolsRefreshing = null;
  }
}
/// 列出已启用但未连接的 MCP 服务器（如浏览器自动化），提示模型按需激活。
/// 浏览器等重服务器不会在日常对话中自动连接/弹窗，只有模型明确需要时才激活。
function pendingServersPrompt(): string {
  const pending = useMcpStore().servers.filter((s) => s.enabled && !s.connected);
  if (pending.length === 0) return "";
  const lines = pending.map((s) => {
    const cat = MCP_CATALOG.find(
      (c) => c.name === s.name || `${c.command} ${c.args}` === `${s.command} ${s.args}`,
    );
    return `- **${s.name}**（未连接）: ${cat ? cat.description : "可用的 MCP 服务器"}`;
  });
  return (
    "\n\n## 未连接服务器（按需激活，不占用资源、不弹窗）\n" +
    lines.join("\n") +
    "\n\n若任务需要上述服务器的能力，请先调用其激活指令，收到工具列表后再选择具体工具：\n" +
    pending
      .map(
        (s) =>
          `<tool_call>\n{"server":"${s.name}","tool":"__connect__","arguments":{}}\n</tool_call>`,
      )
      .join("\n")
  );
}

/// 子代理运行记录（供可视化面板展示）
export interface SubagentRecord {
  id: string;
  goal: string;
  status: "queued" | "running" | "completed" | "failed";
  startedAt: number;
  durationSec?: number;
  resultPreview?: string;
  error?: string;
}

// --- 停止请求信号：停止按钮 → 立即中断主代理工具循环 / 子代理循环 ---
// 之前 stopStreaming 只把 isStreaming 改为 false（隐藏按钮），正在跑的 chatOnce/
// 工具循环不会中断，导致「停止按钮无法停止子代理操作」。这里用可取消信号：
// 停止时触发所有 waitStopSignal() 等待方立即 resolve，配合 Promise.race 提前结束。
let stopRequested = false;
let stopWaiters: (() => void)[] = [];
/// 当前正在流式生成的 request_id（供停止时取消 Rust 端生成，实现「立刻停止」）
let activeStreamRequestId: string | null = null;
/// 已做过知识库 RAG 自动注入的会话 id 集合（同一会话只注入一次，避免每轮重复灌入）
const ragInjectedConvs = new Set<string>();
// S2 项目指令发现：每个工作区目录只注入一次（避免每轮重复灌入项目指令）
const projInjectedCwd = new Set<string>();
// O3 会话级工具集：正在后台执行中的子会话 id 集合（session_spawn 投递后标记，queue-turn-done/error 到达时清除）
const sessionBusy = new Set<string>();
function markSessionDone(cid: string) {
  sessionBusy.delete(cid);
}
function requestStop() {
  stopRequested = true;
  const ws = stopWaiters;
  stopWaiters = [];
  for (const w of ws) w();
}
function resetStop() {
  stopRequested = false;
  stopWaiters = [];
}
/// 返回 Promise：停止信号触发时 resolve（未触发则永久 pending，配合 Promise.race 提前中断）
function waitStopSignal(): Promise<void> {
  if (stopRequested) return Promise.resolve();
  return new Promise<void>((resolve) => {
    stopWaiters.push(resolve);
  });
}

/**
 * 执行工具但用户停止时立即中断：race waitStopSignal，点停止后不等当前工具跑完
 * 立即抛 AgentStoppedError，让工具循环马上退出——真正「立即停止 agent 行为」。
 * 注：后台 Rust 命令可能仍在执行（前端无法 kill 进程），但 agent 不再继续生成/调工具。
 */
async function callToolStoppable(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const hookCtx = {
    tool,
    command: typeof args.command === "string" ? args.command : undefined,
    path: typeof args.path === "string" ? args.path : undefined,
  };
  let raced: { kind: "ok" | "stop"; data: string | null };
  try {
    raced = await Promise.race([
      callMcpTool(server, tool, args).then((r) => ({ kind: "ok" as const, data: r })),
      waitStopSignal().then(() => ({ kind: "stop" as const, data: null })),
    ]);
  } catch (e) {
    // P1-6：本轮工具成败计数（供收尾规则表判断「是不是全军覆没」）
    turnToolFail++;
    turnFailedTools.push(tool);
    // P1-3：tool_after 钩子（失败分支）
    void fireHooks({
      ...hookCtx,
      event: "tool_after",
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    });
    // P1-9b：同一工具同一错误重复失败时，把提醒附在错误里（模型看得到错误文本）
    if (!(e instanceof AgentStoppedError)) {
      const hint = failureHint(tool, e instanceof Error ? e.message : String(e));
      if (hint) {
        const err = new Error(`${e instanceof Error ? e.message : String(e)}\n\n${hint}`);
        err.name = e instanceof Error ? e.name : "Error";
        throw err;
      }
    }
    throw e;
  }
  if (raced.kind === "stop" || stopRequested) throw new AgentStoppedError();
  const data = raced.data ?? "";
  // P1-6：工具以字符串形式报错（内置工具普遍返回 ⛔/❌ 开头）也要计入失败
  if (/^(?:\s*)(?:⛔|❌)/.test(data)) {
    turnToolFail++;
    turnFailedTools.push(tool);
    // P1-3：tool_after 钩子（字符串报错也算失败，与其他路径一致）
    void fireHooks({ ...hookCtx, event: "tool_after", status: "error", error: data });
    // P1-9b：重复失败提醒（附在结果末尾，下一轮模型能读到）
    const hint = failureHint(tool, data);
    return hint ? `${data}\n\n${hint}` : data;
  }
  turnToolOk++;
  // P1-3：tool_after 钩子（成功）——这是 agent 四条工具路径的共同出口
  void fireHooks({ ...hookCtx, event: "tool_after", status: "success", result: data });
  return data;
}/// 任务被用户停止时抛出的错误（子代理/工具循环捕获后优雅收尾）
class AgentStoppedError extends Error {
  constructor() {
    super("任务已由用户停止");
    this.name = "AgentStoppedError";
  }
}

// --- P1-6 自动续跑：本轮工具成败统计（每轮开始时重置） ---
let turnToolOk = 0;
let turnToolFail = 0;
let turnFailedTools: string[] = [];
function resetTurnToolStats(): void {
  turnToolOk = 0;
  turnToolFail = 0;
  turnFailedTools = [];
}

// --- P-A4 应用内 diff 确认：文件编辑类工具先预览 diff/路径，用户确认后才写盘 ---
// 开启「文件编辑需确认」设置后，replace_string/insert_string/delete_file 会先
// 挂起等待 DiffConfirmDialog 的用户确认（Promise resolve 机制），避免 Agent 静默改文件。
export interface EditConfirmRequest {
  kind: "edit" | "delete";
  path: string;
  diff?: string; // edit：unified diff 预览
  summary?: string; // edit：Rust 预览 summary
  edits?: Record<string, unknown>[]; // edit：待应用的编辑操作（确认后回传）
  tool: string;
  args: Record<string, unknown>;
  /** 会话级权限记忆：勾选后本会话内该工具不再确认的提示文案（可选） */
  rememberLabel?: string;
}
const editConfirm = ref<EditConfirmRequest | null>(null);
let editConfirmResolver: ((ok: boolean) => void) | null = null;
/** 触发一次文件编辑确认；返回 true=用户确认应用，false=用户拒绝。 */
function requestEditConfirm(req: EditConfirmRequest): Promise<boolean> {
  editConfirm.value = req;
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      editConfirm.value = null;
      editConfirmResolver = null;
      resolve(ok);
    };
    editConfirmResolver = done;
    // 用户点「停止」时自动按拒绝处理，避免工具循环挂死在确认弹窗上
    waitStopSignal().then(() => done(false));
  });
}
/** 供 DiffConfirmDialog 调用：用户点「应用」/「拒绝」后结束挂起 */
function resolveEditConfirm(ok: boolean) {
  if (editConfirmResolver) editConfirmResolver(ok);
}

// 融合 Codex 的 request_user_input：Agent 在长任务中途**向用户提问并等待回答**（不结束回合）。
// 同样用 Promise 挂起模式；用户点「跳过」或「停止」时返回 null，让 Agent 按假设继续。
export interface AskInputRequest {
  question: string;
  context?: string;
  placeholder?: string;
  defaultValue?: string;
  /** 可选快捷选项（点一下即提交） */
  choices?: string[];
}
const askInput = ref<AskInputRequest | null>(null);
let askInputResolver: ((answer: string | null) => void) | null = null;
/** 触发一次「问用户」：返回用户回答；用户跳过/停止 → null */
function requestAskInput(req: AskInputRequest): Promise<string | null> {
  askInput.value = req;
  return new Promise<string | null>((resolve) => {
    const done = (answer: string | null) => {
      askInput.value = null;
      askInputResolver = null;
      resolve(answer);
    };
    askInputResolver = done;
    waitStopSignal().then(() => done(null));
  });
}
/** 供 AskInputDialog 调用：提交回答（字符串）或跳过（null） */
function resolveAskInput(answer: string | null) {
  if (askInputResolver) askInputResolver(answer);
}

function getMcpToolsPrompt(): string {
  // 内置工具：如实描述特性/优势/适用场景，由大模型根据任务自行选择，不硬编码倾向
  // 通用输出要求：DeepSeek 思考模式易把详细分析留在 reasoning，正文只给简要结论 →
  // 强制要求完整答案呈现在正文
  const outputRule =
    "\n\n## 回答完整输出要求\n" +
    "无论你的思考（reasoning）过程多么详细，**最终答案必须完整、详细地呈现在回复正文中**：\n" +
    "用结构化 Markdown（标题/列表/表格）给出完整的结论、分析与要点，不要只给一句简短结论，也不要把主要内容只写在思考里。\n" +
    "**Markdown 表格规范**：① 列分隔符一律用**半角 `|`**（勿用全角 `｜`）；② 单元格内**禁止出现字面竖线 `|`**（是列分隔符，会导致错位截断）——需要绝对值/集合/范数竖线时用 `$...$` 公式（如 `$|x|$`、`$|G|$`、`$\\{x \\mid x \\in G\\}$`），或中文描述，绝不写 `|x|`；③ **所有数学内容一律用 `$...$` 包裹**（如 `$x^n$`、`$\\frac{1}{x}$`、`$\\int_0^1 x^2\\,dx$`），禁止裸写 `x^n`、`1/x`、`√x`；④ 单元格内**禁止换行**（一个单元格一行），公式再长也写在一行内。\n";
  // 工具调用唯一格式：模型误把历史消息里的 UI 卡片（### 🔧 调用工具 / <details>参数</details>）
  // 当成调用格式写在正文里，导致工具不执行、回复中断（日志：有闭合标记但解析失败/伪卡片）。
  const toolCallRule =
    "\n\n## 工具调用唯一格式（极重要）\n" +
    "需要调用工具时，**唯一方式**是在回复正文中输出工具调用标记：\n" +
    '<tool_call>{"server":"服务器名","tool":"工具名","arguments":{...}}</tool_call>\n' +
    "- **绝对禁止**在正文中写「### 🔧 调用工具」「<details>参数</details>」「✅ 工具结果」等卡片式文本假装已调用工具——那只是普通文本，工具不会执行，回复会中断。\n" +
    "- 也不要输出残缺的标签或裸 JSON；工具调用必须成对包含开/闭标记，JSON 必须是合法对象且含 tool/name 与 arguments。\n" +
    "- 系统会自动执行你的工具调用并把**真实结果**回填给你，你只需等结果返回后再继续回答，无需自己模拟结果。\n";
  const builtin =
    outputRule +
    toolCallRule +
    "\n\n## 内置工具（server 填 `app`）\n" +
    '- **fetch_page** (app): 抓取网页 HTML 并转为纯文本返回。特点：快、稳定、无需浏览器；适合获取静态网页正文（新闻、天气、文档、说明等）。**注意**：JS 动态渲染的页面（数据靠脚本加载）、需登录的页面、或遇到反爬拦截（如“安全验证”）时，fetch_page 拿不到内容——此时必须改用浏览器工具（`browser_navigate` 打开 → `browser_evaluate` 提取 / `browser_screenshot` 截图）。**本机环回地址（如 http://localhost:8765/preview.html）可以直接抓取**——用本地静态服务预览生成的页面时，可以直接用 fetch_page 读取内容（环回默认放行），不必因为本地地址而放弃。参数 {"url": "完整网址"}\n' +
    '- **web_search** (app): 网络搜索，返回相关网页标题/链接/摘要（前几条会自动附带正文片段）。特点：适合需要发现多个信息源、获取最新信息、或不确定具体网址时的探索。参数 {"query": "关键词"}。**仅当回答确实需要当前/外部信息，或用户明确要求搜索时才使用**——普通闲聊、纯知识/常识问答、写作、代码、本地文件与文档任务直接用自身知识回答，不要“先搜一遍再答”。**注意：搜索结果摘要常不完整，若需要具体数据/细节/数字，必须对相关结果用 fetch_page 抓取正文获取，禁止只罗列链接让用户自己点开。**\n' +
    '- **describe_image** (app): 用本地视觉模型描述图片内容。参数 {"path": "本地图片文件路径"}。用于理解截图/图片内容（可配合浏览器截图后使用）。\n' +
    '- **ocr_image** (app): 用本地 OCR（macOS Vision）提取图片中的文字。参数 {"path": "本地图片文件路径"}。用于从截图/图片提取文字。**注意**：OCR 对等宽数字串（尤其前导零）漏读率高，数位数/辨字形时要再用 image_inspect 交叉验证。\n' +
    '- **image_inspect** (app): 对图片做**确定性像素核验**（非 OCR）：列投影切出字符块 + 每个字形的墨迹量/封闭空洞数/宽高比 + ASCII 点阵。参数 {"path": "图片路径", "region": 可选 {left,top,width,height} 裁剪区, "threshold": 可选灰度阈值, "invert": 可选 true=浅色为字, "mode": "glyphs"|"info"}。**凡是数位数（证书编号/票据号/序列号/条码下方数字）或区分 0-O、1-l 这类相近字形，必须用它交叉验证**，不要只凭 ocr_image 的文本下结论；报告会给出宽度分布，"切出几块"就是几位。\n' +
    '- **subagent_delegate** (app): 委派**单个**子代理独立处理子任务（独立上下文、独立回答），返回其结论。参数 {"goal": "子任务目标", "context": "可选补充上下文", "allow_tools": true, "role": "可选角色 planner/executor/verifier/reviewer/researcher（角色=定位+工具集约束）"}。适合单个子任务研究/独立验证；**有多个相互独立的子任务时用 subagent_parallel 并行委派**。子代理结论会作为工具结果返回。' +
    '\n- **subagent_parallel** (app): **并行委派多个子代理**（多个子代理并发执行、互不等待，可视化面板同时显示各子代理进度）。参数 {"tasks": [{"goal": "子任务1", "context": "可选", "allow_tools": true, "role": "可选角色"}, ...], "concurrency": 可选并发数（默认最多 4）, "synth": 可选，true 时并行完成后用评审角色汇总仲裁}. **使用时机**：任务可拆分为多个**相互独立**的子任务（分头研究多个话题 / 分别验证多处代码 / 多角度调研）时，用本工具并行推进大幅节省时间；结果会按子任务顺序汇总返回。**注意**：①子任务必须真正独立（互不依赖彼此结论），否则不要并行；②浏览器自动化是单一实例，多个子任务同时操作浏览器会被自动串行化——若多个子任务都要操作不同网页，建议由主代理串行处理；③子代理一般不应继续递归并行委派，避免递归失控。' +
    '- **pdf_read** (app): 分段读取 PDF 文件内容（一次读一段，返回纯文本）。参数 {"path": "PDF 路径", "offset": 起始字符偏移, "length": 读取长度}。用于浏览长 PDF 时按需分段读取，避免一次性加载全部内容。' +
    '\n- **write_file** (app): **把内容写入本地文件（应用自身真实写盘并校验）**。参数 {"path": "目标文件绝对路径（或以 ~/ 开头）", "content": "文件内容"}。仅支持写入用户主目录内文件，可写 CSV/Excel 文本等任意文本格式。**写文件必须用本工具（server 填 app）**：返回真实绝对路径，回复用户时**必须原样引用**该路径，禁止改名、改目录或编造路径。**新建/整文件覆盖用本工具；修改已有文件优先用 replace_string / insert_string 精确编辑（见下）。** **产物目录规范**：演示文件/报告/导出物一律写到 `~/Documents/道生一产物/`（自动创建），**禁止写到主目录根**（如 `~/demo.svg`）——写到主目录根会被自动改写到产物目录并在结果里告知新路径。\n' +
    "**长文件/完整 HTML 严禁一次性塞进 content**（内容过长会超过单次输出长度限制，工具调用写到一半被截断、文件根本不会写入）：必须分段写入——先 write_file 写开头骨架，再用 insert_string 在末尾占位标记前逐段追加，详见「文件导出规范」的「长文件必须分段写入」。**追加务必批量**：一次塞多行/多条，别一条调一次，以免触达轮次上限留下半成品。**" +
    '\n- **replace_string** (app): **精确替换文件中一段文本（返回 unified diff 供你确认改动）**。参数 {"path": "文件绝对路径", "old_text": "要替换的原文（须与文件内容完全一致）", "new_text": "新文本（可为空=删除该段）", "occurrence": 可选，第几次出现（默认 1）}。**修改已有文件的推荐方式**：只替换需要改动的片段，不改动部分保持原样（比整体重写更精确、diff 更小、不易破坏文件）。文件里可能有多处相同文本时用 occurrence 指定第几次出现。' +
    '\n- **insert_string** (app): **在文件指定锚点文本前/后插入内容（返回 unified diff）**。参数 {"path": "文件绝对路径", "anchor": "锚点文本（须唯一且与文件内容完全一致）", "position": "before 之前 | after 之后（默认 before）", "new_text": "要插入的内容"}。适合在函数/代码块末尾、配置项列表中添加新条目。**写长表格/清单时把多行合并进同一次 new_text 批量追加（≤2500 字符），不要一行调一次**——控制调用轮次，避免半途被截断、留下半成品文件。' +
    '\n- **create_file** (app): **新建文件（仅当目标不存在，避免误覆盖）**。参数 {"path": "绝对路径或以 ~/ 开头", "content": "文件内容"}。文件已存在时不会覆盖，返回提示。' +
    '\n- **delete_file** (app): **删除文件（仅主目录内文件，不删除目录）**。参数 {"path": "文件绝对路径"}。删除前先确认用户确实要求删除该文件。' +
    '\n- **list_dir** (app): 列出本地目录内容（含子目录与文件）。参数 {"path": "目录绝对路径"}。用于查看磁盘上存在哪些文件、确认文件是否真实存在。' +
    '\n- **run_command** (app): **执行一条 shell 命令并把结果返回给你**（受「命令执行策略」门禁：deny 规则直接拦截、危险/破坏性命令需用户确认或智能审批——勿尝试绕过）。参数 {"command": "完整 shell 命令"}。**使用时机**：打开本机 App/文件/照片库（macOS `open -a 应用名` 或 `open 路径`）、运行构建/工具脚本、查询系统状态等专用工具覆盖不了时。能用专用工具（git/run_tests/list_dir/read_file/replace_string/workflow_*）就优先用专用工具，只读优先、慎用写/删/安装类。**辨析**：用户要「打开浏览器跳转到某网址/网页」时不要用 `open -a "<浏览器>" "<网址>"`（浏览器已在运行时**不会可靠跳转**，退出码 0 ≠ 已加载）；请改用内置浏览器工具 `browser_navigate` 真实打开加载；`open -a` 只用于纯启动应用/打开文件/文件夹。\n' +
    '\n- **exec_command** (app): **启动命令并持续交互（交互式/长驻进程专用，融合自 Codex）**：基于 PTY 执行，等待至多 `yield_time_ms`（默认 1000，最大 30000）后返回【本次新增输出 + session_id】；**进程不会因超时被杀**，用 `write_stdin` 继续喂输入/取输出。参数 {"command": "完整 shell 命令", "cwd": "可选工作目录", "yield_time_ms": 可选等待毫秒}。**使用时机**：① 交互式 CLI（`python3 -i`、`psql`、需要确认输入的命令）② 长驻服务（dev server、watch、`tail -f`）③ 需要分段观察输出的长任务。**与 run_command 的区别**：一次性短命令用 run_command（超时即终止）；需要交互或可能长时间运行 → 用本工具。同样受「命令执行策略」门禁；不需要时用 write_stdin 发 `\\u0003`（Ctrl-C）中断。\n' +
    '\n- **write_stdin** (app): **向运行中的 exec_command 会话写输入并取回新输出（融合自 Codex）**。参数 {"session_id": exec_command 返回的会话号, "input": "可选，要写入的字符（回车需自己写 \\n；中断用 \\u0003 = Ctrl-C）", "yield_time_ms": 可选等待毫秒（默认 1000）}。**input 省略 = 只等待并取回后续输出**（轮询长任务进度）；进程已结束时返回剩余输出与退出码。\n' +
    '\n- **list_mcp_resources** (app): **列出某个已连接 MCP 服务器暴露的资源与资源模板（融合自 Codex）**。参数 {"server": "MCP 服务器名"}。需要了解“这个插件内到底有什么可读的内容”时先用它，再用 read_mcp_resource 读具体 uri；服务器未实现资源能力会明确告知（不是错误）。\n' +
    '\n- **read_mcp_resource** (app): **读取 MCP 资源完整内容（融合自 Codex）**。参数 {"server": "MCP 服务器名", "uri": "资源 uri（先 list_mcp_resources 拿到）"}。内容过长会截断，需要全部时先让服务器分页/过滤或改用对应工具查。\n' +
    '\n- **request_user_input** (app): **向用户提问并等待回答（融合自 Codex）**。参数 {"question": "要问的问题", "context": 可选背景, "choices": 可选快捷选项数组, "default": 可选默认值}。**仅在关键信息缺失/歧义且猜错代价高时用**；能合理假设就先推进并标注假设。用户可点「跳过」，此时请按合理假设继续、不要反复追问。\n' +
    '\n- **request_permissions** (app): **主动申请会话级授权（融合自 Codex）**。参数 {"capability": "run_command | replace_string | insert_string | delete_file | apply_patch", "reason": "理由"}。得到授权后本会话同类操作不再逐次弹确认（仅本会话有效；命令策略的 deny 规则仍不可绕过）。预计要连续多次写操作/命令时先申请一次，比逐条触发弹窗更高效。\n' +
    '\n- **get_goal** (app): **查看当前会话的目标与 token 预算（融合自 Codex ext/goal）**。无参数。系统每轮会自动注入当前目标，无需频繁调用；长任务中不确定「要做到哪一步」时看一眼；预算接近用尽就尽快收尾。\n' +
    '\n- **create_goal** (app): **登记跨回合目标（融合自 Codex）**。参数 {"objective": "可验收的目标描述", "token_budget": 可选 token 上限}。**仅在用户/系统显式要求时创建**，不要从普通任务臆测；**已有未完成目标会拒绝**（改用 update_goal）。\n' +
    '\n- **update_goal** (app): **更新目标状态（融合自 Codex）**。参数 {"status": "active | complete | blocked | abandoned", "note": 可选备注}。达成→complete；卡在外部依赖→blocked；放弃→abandoned。不要用它改目标描述。\n' +
    '\n- **get_context_remaining** (app): **查询当前上下文占用与剩余预算（融合自 Codex）**。无参数。长任务中途、或准备把大段内容回填给模型前先看一眼；接近上限（≥85%）时先收尾（给结论+产物路径，未完成部分写文件/待办），必要时用 new_context_window 压缩历史。\n' +
    '\n- **new_context_window** (app): **压缩历史上下文（融合自 Codex）**：把较早历史压成交接摘要后继续。参数 {"keep_last_messages": 可选，保留最近几条（默认 6）}。**系统已自动压缩**（占用达 ~82% 自动做一次），通常无需主动调用；只影响发给模型的历史（界面仍保留全部），压缩掉的细节请从已落盘文件读取、不要臆测。\n' +
    '\n- **tool_search** (app): **检索并激活未直接列出的工具（融合自 Codex，BM25 检索）**。参数 {"query": "自然语言描述你要做的事或能力，中英文均可", "limit": 可选返回条数}。**使用时机**：你需要某类能力（如「数据库查询」「发消息」「抓股票数据」）但当前工具列表里**找不到对应工具**时——先搜一下；系统会把命中的工具立即加入可用工具。也可用于**确认某个工具的真实参数名**（不要靠猜）。不要用它做普通信息搜索（那用 web_search）。\n' +
    '\n- **git** (app): 在指定仓库目录执行 Git 操作（编程 Agent）。参数 {"cwd": "仓库目录绝对路径", "action": "status 状态 | diff 改动 | log 历史 | branch 分支 | add 暂存 | commit 提交 | pull 拉取 | push 推送 | checkout 切换 | rev-parse 解析", "args": [附加参数]}。**使用时机**：用户要求查看/提交/推送代码、对比改动、查看历史或分支时调用；提交用 action="commit" args=["-m","提交说明"]；先 status 看改动再 add+commit。只读操作（status/diff/log）安全；push/pull 会联网。' +
    '\n- **run_tests** (app): 在项目目录自动检测并运行测试（编程 Agent 验证循环）。参数 {"cwd": "项目目录绝对路径", "command": "可选，显式指定测试命令（如 pytest -q）", "args": [可选附加参数]}。自动识别：package.json→npm test、Cargo.toml→cargo test、pyproject/requirements→pytest。返回结构化结果（框架/命令/通过或失败/失败项列表），供你判断并迭代修复。**使用时机**：修改代码后必须运行测试验证；测试失败时分析失败项、修复、再运行直到通过（验证循环门禁）。' +
    '\n- **analyze_project** (app): 分析项目目录结构（编程 Agent 代码库理解）。参数 {"path": "项目目录绝对路径"}。返回：技术栈识别（Rust/TypeScript/Python/Vue 等）、清单文件信息（Cargo 包名/npm 包名+scripts）、源码文件按扩展名统计、顶层目录/文件结构（跳过 node_modules/.git/target 等大目录）。**使用时机**：用户要求分析/修改某项目前，先调用它快速建立项目认知（技术栈、结构、脚本），再深入读具体文件。' +
    '\n- **code_index** (app): 把项目代码目录**向量化索引**（P-A3 自然语言找代码；需本地 Ollama + nomic-embed-text，重建式）。参数 {"root": "项目目录绝对路径"}。**使用时机**：用户要求「在 XX 项目里找 XX 代码/功能」前，先 code_index 索引该项目（若 code_roots 未列出）。' +
    '\n- **code_search** (app): 在已索引项目里**按自然语言找代码**（语义向量检索，返回相关文件与代码片段）。参数 {"root": "项目目录绝对路径", "query": "自然语言描述要查的代码，如「处理用户登录」「解析配置文件」", "limit": 可选条数（默认 6）}。**使用时机**：用户要求找某功能/逻辑的代码实现时，先用自然语言描述检索；命中后用 read_file 精读相关文件。' +
    "\n- **code_roots** (app): 列出已索引的项目目录。参数 {}。**使用时机**：不确定哪些项目已建语义索引时调用。" +
    '\n- **kb_create** (app): **创建命名知识库**（在对话中建立一个知识库名，空库注册后即可被 kb_list 列出）。参数 {"kb_name": "知识库名，如「个人」"}。**使用时机**：用户要求「创建/新建一个叫 XX 的知识库」时，先调用本工具建库。' +
    '\n- **kb_add** (app): 向知识库**录入一段文本/文档内容**（自动分块 + 关键词索引；本地 Ollama embedding 可用时叠加语义向量）。参数 {"kb_name": "知识库名", "source": "来源/文档名（如 笔记.md）", "text": "要录入的完整文本内容"}。**使用时机**：用户给你一段文字/笔记要求「存进 XX 知识库」时调用；内容在文件里可先 read_file 读取再录入。' +
    '\n- **kb_index** (app): 把本地目录/项目**索引成知识库**（重建式，支持 md/txt/代码/PDF，自动分块；同名知识库会重新索引）。参数 {"kb_name": "知识库名", "path": "目录绝对路径"}。**使用时机**：用户要求基于某目录/文档集做知识问答时，先 kb_index 建立索引。' +
    '\n- **kb_search** (app): 在已索引的**知识库**中检索（关键词 + 中文分词；本地 Ollama embedding 可用时叠加语义向量）。参数 {"kb_name": "知识库名", "query": "检索词", "limit": 可选条数（默认 6）}。**使用时机**：问题涉及知识库内容时先检索再作答；检索不到可换关键词。' +
    "\n- **kb_list** (app): 列出已建立的知识库及分块数。参数 {}。**使用时机**：不确定有哪些知识库时调用。" +
    "\n\n## 知识库使用要点\n" +
    "- 用户说「创建/新建知识库 XX」→ 先 kb_create 建库；需要录入内容时用 kb_add（一段文本/文档）或 kb_index（整个目录）。\n" +
    "- 用户给了文件/文档路径要入库：先 read_file/list_dir 读取真实内容，再 kb_add 录入（source 填文件名），不要编造内容。\n" +
    "- 问题需要知识库背景：先 kb_search 检索相关分块，基于真实命中内容作答，不要凭印象编造。\n" +
    "- 知识库与长期记忆是两套体系：知识库存文档资料（按需检索），memory_save 存用户偏好/个人信息（自动注入）。\n" +
    "\n\n## 验证循环（编程任务强制要求）\n" +
    "- 你修改/生成代码后，**必须用 run_tests 运行测试验证**，不能假设改对了。\n" +
    "- 测试失败时：分析失败项/错误信息 → 修复代码 → **再次 run_tests**，如此循环直到测试通过（「通过才算完成」门禁）。\n" +
    "- 如果项目没有测试，用 run_tests 时显式 command（如 `python3 -m py_compile main.py` 或直接说明无测试）；不要编造测试结果。" +
    '\n- **memory_save** (app): 把用户明确告诉你的重要信息保存到长期记忆（跨会话生效，下次对话自动想起）。参数 {"fact": "要记住的内容", "fact_type": "preference" 偏好 | "info" 信息 | "decision" 决策 | "todo" 待办, "importance": 重要度 1-10}。**使用时机**：用户告知个人偏好（如「我喜欢简洁回答」）、重要个人信息（姓名/职业/所在地）、作出的决定、或叮嘱你要记住的待办事项时——主动调用记住，不要只放在本次回答里。\n' +
    '\n- **memory_recall** (app): 按关键词检索长期记忆，回忆以前会话中记住的信息。参数 {"query": "关键词", "limit": 条数}。**使用时机**：用户问「我之前说过…吗」「记得我上次…」或需要结合历史偏好/决策回答时，先调用回忆，再基于回忆内容回答（不要凭编造）。\n' +
    '\n- **memory_forget** (app): 用户要求「忘掉/删除某条记忆」时，按关键词检索并删除相关记忆。参数 {"query": "要遗忘的记忆关键词"}。\n' +
    '\n- **send_im** (app): 主动推送一条消息到飞书/企业微信/钉钉群机器人（只发不收，无代理直连）。参数 {"platform": "feishu" 或 "wecom" 或 "dingtalk", "text": "要推送的内容"}。用于用户要求把信息/提醒推送到聊天工具时。' +
    '\n- **list_agents** (app): **列出 Agent 开的后台子会话及状态（融合自 Codex）**。无参数。返回 id/标题/状态/运行时长/结果预览；开多个 session_spawn 后一眼看清谁在跑、谁已完成。取完整结果用 session_resume。\n' +
    '\n- **interrupt_agent** (app): **中断后台子会话（融合自 Codex）**。参数 {"session_id": "session_spawn 返回的 id", "reason": 可选}。后台是单次非流式请求，已发出的调用会跑完但**结果被丢弃**（不写进会话），省不下这次 token——只在方向错/不再需要时用。\n' +
    "\n- **workflow_list** (app): 列出已保存的工作流（名称 + id）。参数 {}。**使用时机**：接到多步骤/可复用任务时，先查是否已有匹配的工作流。" +
    '\n- **workflow_run** (app): **按名称或 id 执行已保存的工作流**（复用可视化工作流引擎：text/llm/tool/condition/code/end 节点按拓扑执行；LLM 节点用模型、工具节点调内置工具）。参数 {"name": "工作流名称或 id", "input": "可选外部输入（节点里以 {{user}} 引用）"}。返回节点日志与最终输出。**使用时机**：用户需求与已沉淀的工作流同类（同一流程复用）时，先 workflow_list 查匹配，命中直接 workflow_run。' +
    '\n- **workflow_create** (app): **把多步骤/可复用任务抽象成工作流并保存**。参数 {"name": "工作流名称", "graph": {"nodes": [{"id":"n1","type":"text|llm|tool|condition|code|end","label":"节点名","config":{...}}], "edges": [{"id":"e1","source":"n1","target":"n2"}]}}。节点 config：text→{text} 字面量；llm→{prompt} 提示词（可用 {{上游nodeId}} 引用上游输出）；tool→{tool:工具名, toolArgs:参数模板}；condition→{expression} 布尔表达式，出边带 label true/false 分支；code→{code} JS 函数体（入参 input/outputs）；end 收尾。**使用时机**：用户要做的事多步骤且以后可能重复时，先抽象成工作流保存，同类任务后续直接 workflow_run 复用。' +
    '\n- **workflow_improve** (app): **基于该工作流最近运行历史（含失败节点轨迹）自动优化并保存新版本**。参数 {"name": "工作流名称或 id", "note": "可选改进诉求"}。模型分析最近运行（失败/被跳过/慢节点）修复问题（换工具/加分支/细化提示词）；判定无需改动则保留原样。保存后建议 workflow_run 验证。**使用时机**：用户反馈某工作流结果不佳/报错，或你看到 workflow_run 返回里有失败节点时。' +
    '\n- **workflow_suggest** (app): **按任务文本在已保存工作流中做相关度建议**（关键词打分，返回候选与流程链）。参数 {"task": "任务描述", "limit": "可选条数默认 3"}。**使用时机**：接到任务先判断是否已有同类可复用工作流时调用；命中则 workflow_run，未命中且会重复则 workflow_create + workflow_remember。' +
    '\n- **workflow_remember** (app): **沉淀处理模式记忆：把「某类任务 → 已沉淀工作流」记住**（存长期记忆 type=workflow，跨会话自动注入）。参数 {"task_type": "任务类型描述如 月度研究/日报生成", "workflow_name": "工作流名"}。**使用时机**：你 workflow_create 固化了一个会重复的流程后，调用本工具记住映射，以后同类任务会自动想起并 workflow_run 复用。' +
    '\n- **plan_task** (app): **创建/替换任务计划（进度卡片实时显示在对话区顶部）**。参数 {"title": "任务标题", "steps": ["子任务1", "子任务2", ...]}。**使用时机**：用户下达**多步骤/多文件/多研究点**的复杂任务时，先分解为子任务并调用本工具，让用户看到计划与进度；简单任务（1-2 步）不必用。**【任务模式】下几乎必用**：把用户目标拆成有序子步骤后立即调用本工具建立计划，再逐步执行。' +
    '\n- **plan_update** (app): **更新任务计划某一步骤的进度**。参数 {"step": 步骤序号(从1开始), "status": "doing" 进行中 | "done" 已完成 | "failed" 失败}。**使用时机**：开始执行某步时标记 doing、完成后标记 done、某步失败标记 failed 并调整后续计划；配合 plan_task 实现 Plan→Act→Observe→修正 循环。' +
    '\n- **session_spawn** (app): **创建后台子会话并异步投递任务，不阻塞当前对话**。参数 {"prompt": "后台任务的完整指令", "name": "可选子会话名（默认 子任务）"}。返回 session_id。适合耗时/独立的后续工作（长研究、批量抓取、多步改造），spawn 后当前对话可继续做别的；子会话以 🧵 前缀出现在左侧历史、可点击查看/续聊。**注意**：子会话后台运行且消耗 LLM 额度，完成后不会自动回填当前对话，需主动 resume。' +
    '\n- **session_status** (app): **查询后台子会话的执行进度/最近结果**。参数 {"session_id": "session_spawn 返回的 id"}。返回 执行中/已完成 + 消息数 + 最近结果前 600 字。' +
    '\n- **session_resume** (app): **等待后台子会话完成并把完整结果取回当前对话继续分析**。参数 {"session_id": "session_spawn 返回的 id"}。轮询等待（最长约 4 分钟，用户可随时停止）；子会话仍在执行时阻塞至完成，完成后返回其最终回复全文，据此继续作答。' +
    "\n\n## 后台子会话使用要点\n" +
    "- 用户需要**长时间/独立**的任务（如长研究、批量抓取、多步代码改造）且不想阻塞当前对话时，可用 session_spawn 投到后台执行。\n" +
    "- spawn 后 session_status 查进度；需要结果时 session_resume（会等待完成并取回全文）。若子会话结果与主任务无关，也可不 resume，直接告知用户子会话已就绪、可点击查看。\n" +
    "- 子会话与主会话相互独立（各自上下文）；需要基于子会话结果继续时务必 resume 取回，不要凭猜测描述其结果。" +
    "\n\n## 工作流使用要点\n" +
    "- 多步骤且**可能重复**的任务（同一流程还要做几遍，如每月研究简报、批量报告、常规文档处理）→ 先抽象成可复用工作流：workflow_create 保存，之后 workflow_run 一键复用；不确定有没有现成的先 workflow_list。\n" +
    "- workflow_run 适合「流程固定、输入变化」的任务；一次性的独特任务不必建工作流，直接逐步执行即可。\n" +
    "- 工作流运行不理想/有失败节点 → 用 workflow_improve 基于运行历史自动优化（会分析失败/被跳过节点并出改进版）。\n" +
    "- 复杂任务先用 plan_task 展示步骤给用户；流程稳定后可用 workflow_create 固化为工作流，让同类任务执行更快更稳。\n" +
    "- 接任务先判断是否命中处理模式：记忆里有「某类任务→工作流」或 workflow_suggest 命中 → 直接 workflow_run 复用；全新但以后会重复的流程 → 完成后 workflow_create 固化 + workflow_remember 记住映射。\n" +
    "\n## 长期记忆使用要点\n" +
    "- **主动记忆**：用户明确告知偏好/个人信息/决定/待办时，调用 memory_save 记住（不要只当次回答）。\n" +
    "- **回忆优先**：涉及用户历史信息、上次讨论、个人偏好时，先 memory_recall 检索，再基于真实记忆回答，不要编造。\n" +
    "- **遗忘**：用户要求删除某条记忆时调用 memory_forget。\n" +
    "- 记忆跨会话自动注入：系统也会在每次对话前自动检索相关记忆注入上下文，无需你手动调用；memory_recall 用于更精确的主动查证。" +
    "\n\n## 命令执行与打开本机应用（run_command）\n" +
    "- **你具备本机命令行能力**：调用 run_command 可执行 shell 命令（受命令执行策略门禁；危险/破坏性命令会被拦截或需用户确认，勿尝试绕过）。\n" +
    '- 用户要「打开/启动某应用、文件夹或文件」时**不要声称做不到**——macOS 用 run_command 执行 `open -a "应用名"`（例：照片→`open -a Photos`、访达→`open .`）或 `open "文件/文件夹/照片库路径"`（例：`open "/Users/wanghuan/Pictures/Photos Library.photoslibrary"` 会打开「照片」）。\n' +
    '\n- **「打开浏览器访问某网址」≠「启动应用」**：用户说「打开 XX 浏览器」「打开浏览器跳转某页 / 去某网站」时，目标是浏览器**真实打开并加载该网址**——请用内置浏览器工具 `browser_navigate`（会启动本地内核并真实加载，返回标题与正文供你确认）；**不要**用 `open -a "<浏览器>" "<网址>"`：浏览器已在运行时该命令**不会可靠跳转**（退出码 0 只代表命令执行成功，不代表已加载目标页），且无法回读页面确认——**禁止仅凭退出码 0 就回报「已打开并跳转」**。`open -a` 只用于**纯启动应用 / 打开文件/文件夹**（不带网址）。\n' +
    "- 能用专用工具（git / run_tests / list_dir / read_file / replace_string / workflow_*）完成的优先用专用工具；run_command 用于其余命令（GUI 启动、构建脚本、brew、系统查询等）。只读优先，慎用写/删/安装类。";
  // 强制约束：实时/时效信息必须真实获取，严禁编造。防止模型凭训练数据"发挥"（如编造天气）。
  const realtime =
    "\n\n## 联网搜索使用纪律（重要）\n" +
    "**不要默认联网**：普通闲聊、纯知识/常识问答、写作/翻译/润色、代码、数学、本地文件与文档处理等，直接凭自身知识与本地工具作答即可，**不需要也不应**为了“保险”去 web_search / fetch_page。\n" +
    "仅当**回答依赖无法从既有知识确定的当前/外部信息**（新闻、天气、实时行情/价格、汇率、比分、最新政策、他人网站的具体内容、用户明确要求搜索/查证等）时，才调用 web_search 或 fetch_page 获取真实数据；**严禁**凭记忆编造此类温度、数值、价格、事件或新闻。\n" +
    "若工具确实拿不到数据（搜索无结果、页面无法访问），请明确告知用户「无法获取」，不要编造。";
  // 搜索/查证类回复格式规范：整理成人类可读，禁止原样粘贴工具输出
  const searchFormat =
    "\n\n## 搜索/查证类回复规范\n" +
    "使用 web_search / fetch_page 后，**必须把结果整理成人类可读、格式美观的中文回答**，禁止原样粘贴工具返回的原始条目。\n" +
    "回答须满足：\n" +
    "1. **先给结论**：开头明确说明「共找到 N 条有用信息」或「未找到可靠的公开信息」，不要含糊。\n" +
    "2. **结构化呈现**：用 markdown 编号列表逐条给出 **信息主体 + 关键摘要 + 来源链接**，每条独立成行、条理清晰。\n" +
    "3. **查企业/实体时**：尽量给出 名称、类型/所在地、主营业务/简介、成立时间 等关键事实，并附**官方或权威来源链接**（官网、百科、工商信息等）；不同来源信息冲突时标注各来源。\n" +
    "4. **未找到**：明确说「未找到可靠的公开信息」，说明可能原因（如反爬、无公开资料），并给出可进一步核实的途径；**严禁编造**企业名、数据或来源。\n" +
    "5. **不要堆砌**：删除重复/低价值条目，按相关度排序，每条摘要控制在 1-2 行。\n" +
    "6. **来源链接必须原样完整复制**：引用来源时，必须逐字原样复制搜索结果/工具返回中给出的**完整 URL**（如 `链接: https://...` 冒号后的整个地址），**禁止**截断路径、删改扩展名（如 `.shtml`/`.html`/`.pdf`）、缩写域名、自行拼接或凭空编造链接；每条引用的链接都必须是可直接打开访问的完整网址。\n" +
    "7. **禁止『口头承诺』式回复**：不要只写『我将访问 XX 官网获取信息』『接下来我去查询』『搜索与问题无关，我直接…』这类过程声明就结束回复——以过程声明代替实际内容 = 未完成任务。要么**立即输出工具调用**（web_search / fetch_page）真正获取数据，要么**直接给出基于已有信息的完整、结构化答案**（结论 / 步骤 / 要点）。";
  // 任务规划规范：复杂任务先分解、逐步推进并更新进度（P-A5 Plan 模式）
  const planRule =
    "\n\n## 任务规划规范（复杂任务时）\n" +
    "- 用户下达**多步骤复杂任务**（如多文件修改、多步骤研究、需多轮验证的编程任务）时：**先调用 plan_task 把任务分解为有序子步骤**，让用户在进度卡片看到完整计划。\n" +
    "- 执行过程中**逐步更新进度**：开始某步前 plan_update 标记 doing，完成后标记 done，某步失败标记 failed 并说明原因、调整计划后继续（Plan→Act→Observe→修正）。\n" +
    "- 每一步的实际工作（搜索/读文件/编辑/验证）照常调用对应工具完成，plan 工具只负责**进度可视化**，不要用 plan 工具代替实际工作。\n" +
    "- **全部步骤 done 后**，在正文给出完整、结构化、可执行的最终回答（结论 / 具体改动 / 结果 / 下一步建议）。\n" +
    "- **收尾前**：当实际工作全部完成、即将给出最终回答时，把计划中还处于 **待办/进行中** 的步骤**逐一** plan_update 标记为 done（不要遗漏最后几步）；确有关键步骤失败的保留 failed 并说明原因。\n" +
    "- 简单任务（1-2 步）不要使用 plan 工具，避免冗余，**但【任务模式】除外**：任务模式下用户给出的目标是需交付的任务，即使看似简单，也先 plan_task 建计划再执行。\n" +
    "- **【任务模式】硬性要求**：把用户请求视为目标；需多步/多工具/有交付物就必须先 plan_task，再逐步执行（plan_update 标记进度），并**自主连续执行到全部完成**，不要中途停下征求确认（应用层权限确认除外）。";
  // P-M4：多子代理结果冲突时必须仲裁而非任取其一
  const orchestrateRule =
    "\n\n## 多子代理结果仲裁规范\n" +
    "当你使用 subagent_parallel（含 synth=true）或多个子代理得到的结果**互相冲突**时，不要任取一个或含糊带过：\n" +
    "1. **明确指出冲突点**（哪些结论、来自哪个子任务）；\n" +
    "2. **评估依据**：对比各方的证据/来源/可信度（谁有实测/官方来源，谁只是推断）；\n" +
    "3. **给出判定**：采纳哪方、或说明信息不足无法判定并建议核实途径；\n" +
    "4. **统一呈现**：把各子任务要点整合成一份自洽的最终回答（结论 / 要点 / 遗留问题）。\n" +
    "若已用 synth=true 拿到仲裁结论，直接采用并呈现，可补充你的补充判断。";
  // 文件编辑规范：修改已有文件优先精确编辑（replace_string/insert_string），返回 diff 需展示
  const editRule =
    "\n\n## 文件编辑规范（编程/改文件时）\n" +
    "- **修改已有文件优先用精确编辑**：小改动用 replace_string / insert_string（只改目标片段、返回 unified diff 显示改动）；只有新建文件或整体重写才用 write_file / create_file。\n" +
    "- 编辑前若不确定文件内容，先用 list_dir 确认路径、read_file 读取相关片段，再精确编辑（old_text/anchor 必须与文件内容**逐字一致**，含缩进/标点）。\n" +
    "- **同一段文本可能出现多次 / 要连改多处 / 文件本轮已被改过时**：先用 `read_file` 带 `with_anchors: true` 拿行锚点，编辑时带 `\"anchor_line\": 行号, \"anchor_hash\": \"哈希\"`——锚点会自动消歧「改第几处」，且**文件已变动时直接拒绝执行**并告知新行号（比默默改错位置安全）。锚点前缀不要抄进 old_text。\n" +
    "- 每次编辑会返回 **unified diff**（@@ 头 + 改动行）：编辑后**必须在最终回复中说明改了什么**（列出新增/修改/删除的关键行），让用户看到确切改动；不要只说『已修改』。\n" +
    "- 修改代码后**必须用 run_tests 验证**（验证循环门禁），不能假设改对了。\n" +
    "- **非显然的技术决策要留痕**：换运行时/改架构/选依赖/定接口/否掉某个方案时，用 `log_decision` 写进项目 `DECISIONS.md`（做了什么 / 为什么 / 排除了什么）。琐碎改动不记；理由与排除方案才是它的价值——将来接手的人和新会话的你都靠它，不靠记忆。\n" +
    "- 编辑失败（未找到文本）时，用 read_file 读取实际内容核对后重试，不要盲目重复相同编辑。";
  // 文件导出规范：必须用内置可信 write_file，禁止在正文模拟工具调用、编造路径
  const fileRule =
    "\n\n## 文件导出规范（重要）\n" +
    "需要把内容保存为本地文件（如 CSV 考勤表、报告、脚本等）时，**必须真实调用内置 write_file 工具（server 填 `app`）**，由应用真实写盘并校验。\n" +
    '- **调用方式只有一种**：在回复中输出 `<tool_call>{"server":"app","tool":"write_file","arguments":{"path":"...","content":"..."}}</tool_call>`。\n' +
    "- **严禁在回复正文中模拟工具调用过程**：禁止以 `### 🔧 调用工具`、`<details>参数</details>`、`✅ 工具结果` 等卡片形式假装已调用工具或已写入文件——那只是文本，不会真正写盘。\n" +
    "- **只有 write_file 真实返回的路径才可引用**：最终回复**必须原样引用**工具返回的真实绝对路径，禁止改写文件名、目录或编造路径。\n" +
    "- **若未真实调用并成功写入，禁止给出任何文件路径**，也不要声称「已写入」或「已导出」，可如实说明无法保存文件。\n" +
    "- **如实报告文件数量**：生成了几个文件就引用几个（每个都是 write_file 真实返回的路径）；**禁止声称「已生成 N 份 / 两个版本」除非确实写入了 N 个文件**。若确实写了多个文件（如 HTML 版 + CSV 版），必须把每个文件的真实路径都列出来，不能只说一份。\n" +
    "- **表格文档格式（排版必须正确）**：用户要「表格文档 / Excel / 表格 / CSV」时，用 write_file 生成 **CSV**（Excel/WPS 可直接打开，行列最稳）或 **HTML 表格**（浏览器打开可打印），并在回复中说明文件格式。\n" +
    '- **HTML 表格必须行列对齐**：每一行 `<tr>` 内的单元格数量必须与表头**完全一致**（表头 5 列则每行都恰好 5 个 `<td>`/`<th>`），**禁止行内单元格数不齐**（浏览器会错位显示、排版错乱）；需要跨列/跨行时用 `colspan`/`rowspan` 显式声明并保持总列数不变。最小结构示例：`<table border="1" cellpadding="6" cellspacing="0"><thead><tr><th>列1</th><th>列2</th></tr></thead><tbody><tr><td>值</td><td>值</td></tr></tbody></table>`。\n' +
    '- **CSV 单元格规范**：含逗号、换行或中文标点的单元格用双引号包裹（如 `"某,单位"`），每行列数一致；文件用 UTF-8 编码。\n' +
    "- 当前无法直接生成二进制 .xlsx/.docx，**不要假装生成了 Excel/Word 文件**，如实说明已生成 CSV/HTML 及打开方式。\n" +
    "- **长文件/完整 HTML 必须分段写入（防止工具调用被截断）**：完整 HTML / 长报告 / 长脚本**禁止一次性塞进单个 write_file 的 content**——内容过长会超过单次输出长度限制，`<tool_call>` 写到一半被截断、`</tool_call>` 不完整，工具根本不会执行、文件不会写入；再次重试同样会被截断。正确做法（**分段写入**）：\n" +
    "  ① 先用 `write_file` 写文件**开头部分**（含根结构，末尾放一个唯一占位标记如 `<!--MORE-->`；HTML 的 `<html>`/`</html>` 根标签必须在本段内完整闭合，保证文件始终合法）；\n" +
    '  ② 再用 `insert_string` **逐段追加**：参数 `{"path": 同一路径, "anchor": "<!--MORE-->", "position": "before", "new_text": "<下一段内容>\\n<!--MORE-->"}`——把下一段插到占位标记前，并在段尾重新放一个 `<!--MORE-->` 占位；\n' +
    "  ③ 重复 ② 直到内容写完，**最后一次 `new_text` 不要留 `<!--MORE-->` 占位**，让文件以完整内容收尾。\n" +
    "  每次工具调用的内容控制在 **≤ 2500 字符**；宁可多分几段，也不要一次塞完整份文件。\n" +
    "- **批量追加（关键，控制调用次数）**：当内容是**表格/清单等多条目**时，把**多行/多条**合并进**同一次** `insert_string` 的 `new_text`（在 ≤2500 字符内尽量填满），例如把 `<tbody>` 里的多行 `<tr>` 一起追加；**不要一行/一条调用一次**（否则会快速触达工具循环的轮次上限，留下只写了一半的文件、只能“下轮再补”）。目标是用**少量（通常 ≤5 次）** `insert_string` 写完整个文件。\n" +
    "- 禁止使用社区 filesystem MCP 服务器的写入类工具（write_file / write_text_file 等）。";
  const pending = pendingServersPrompt();

  if (mcpToolsCache.length === 0) {
    return (
      builtin +
      realtime +
      searchFormat +
      planRule +
      orchestrateRule +
      editRule +
      fileRule +
      pending +
      '\n\n需要工具时只回复以下格式：\n<tool_call>\n{"server":"app","tool":"工具名","arguments":{...}}\n</tool_call>'
    );
  }

  return (
    builtin +
    realtime +
    searchFormat +
    planRule +
    orchestrateRule +
    editRule +
    fileRule +
    "\n\n## MCP 服务器工具（特性各异，请按需选择）\n" +
    mcpToolsCache.map((t) => `- **${t.name}** (${t.server}): ${t.description}`).join("\n") +
    pending +
    "\n\n工具选择由你根据任务自行判断：静态网页正文用 fetch_page；需要打开浏览器、点击/输入/截图或抓取动态渲染内容用浏览器工具；本地文件读写用文件系统；回忆历史信息用记忆。先判断问题是否依赖**当前/外部信息**：确实需要（新闻/实时/价格/最新政策/用户明确要求搜索）才 web_search / fetch_page；纯知识问答直接作答，**不要把搜索当成默认第一步**。" +
    "\n\n## 文件系统使用要点\n" +
    "- 查看目录**优先用 list_dir 只列一层**（能看到该目录下的子目录/文件清单），不要用 directory_tree 递归列整个目录树。\n" +
    "- directory_tree 会递归展开全部子目录（含 .git、node_modules、target、build 等海量文件），结果巨大且会被截断，无法完整看到；禁止对含这些大目录的项目用它。\n" +
    "- 正确做法：先 list_dir 看顶层 → 针对需要的子目录再用 list_dir 逐层深入 → 读关键文件用 read_file。\n" +
    "- 分析用户本地目录/项目时，这些就是本地文件系统操作（server 填 app，用内置 list_dir / read_file / write_file / replace_string），不要联网搜索。\n" +
    "\n## 浏览器自动化使用要点（内置 browser_* 工具，无需安装插件）\n" +
    "- **你具备内置浏览器能力**：`browser_navigate`（打开网址，返回标题+最终地址+正文前 4000 字）、`browser_evaluate`（执行 JS 取值）、`browser_screenshot`（截图存证）、`browser_click`（点击元素）、`browser_fill`（填输入框）。用户要求打开网页、跳转某网址、搜索、点击或操作页面时（含「打开 XX 浏览器去某网站/首页」这类带浏览器名的说法）——**必须实际调用这些工具完成**；**禁止声称「无法打开浏览器 / 纯文本环境 / 不具备图形界面」**，也不要让用户自己去操作。\n" +
    '- **验证本地生成的 HTML/网页渲染**：先 `run_command` 起本地静态服务（如 `python3 -m http.server 8000`，在文件所在目录）或直接用 `file://` 路径，再用 `browser_navigate` 打开 → `browser_evaluate` 读 `document.body.innerText` / `browser_screenshot` 截图核对渲染。**严禁把 `file://` 路径或本地磁盘路径当作网页 URL 交给 `fetch_page`**——fetch_page 只抓取 HTTP(S) 网页并做 SSRF 防护，对本地文件会直接报错；本地文件内容用 `read_file` 读取。\n' +
    "- **不要再用 `puppeteer_*` 插件工具**（即便装过「浏览器自动化」插件也应优先内置 `browser_*`）：内置浏览器直连 CDP，无 Node/npx 依赖，实测失败率显著更低。\n" +
    "- **操作顺序**：先用 `browser_navigate` 打开目标页面 → 再 `browser_fill` 输入 / `browser_click` 点击 / `browser_evaluate` 提取 / `browser_screenshot` 截图。**不要跳过导航直接尝试输入或点击**（会返回未打开页面的错误）。\n" +
    "- **优先图形化操作（通用，适配任意站点/搜索引擎）**：搜索、输入用 `browser_fill` 填输入框（内部已触发 input/change 事件，兼容 React 受控组件）+ `browser_click` 点提交按钮。仅当页面确实无法图形化交互时，才兜底用带查询参数的 URL 直达（如 `https://www.baidu.com/s?wd=关键词`）。\n" +
    "- 获取渲染后的页面文本，优先用 **`browser_evaluate`** 执行 `document.body.innerText`（最可靠），不要只依赖截图。\n" +
    "- `browser_screenshot` 截图仅用于视觉确认；保存路径以系统返回为准，回复中**必须原样引用**（禁止改写/声称移动到其它路径）。若截图空白，说明页面尚未渲染或需登录，改用 `browser_evaluate` 提取文本判断。\n" +
    "- **不要用 screencapture 全屏截图来核验网页**（会截到无关画面）；渲染核验用 `browser_screenshot`。本地视觉模型（describe_image/ocr_image）对复杂页面截图偶尔会输出与图片无关的乱码/幻觉描述——**不要仅凭一段离谱的描述就判定渲染失败**；应以截图路径给用户查看为准，必要时用 `browser_evaluate` 读 `document.body.innerText` 交叉验证。\n" +
    "- 需要登录、或有验证码/反爬的页面（如爱企查、官方公示系统）可能无法自动获取，如实告知用户，不要编造数据。\n" +
    '\n需要工具时只回复以下格式：\n<tool_call>\n{"server":"服务器名","tool":"工具名","arguments":{...}}\n</tool_call>' +
    "\n\n完成任务后无需手动关闭浏览器：任务结束系统会自动断开浏览器（释放资源）。"
  );
}

/// 任务完成后关闭浏览器，形成使用闭环。
/// server-puppeteer 无 puppeteer_close 工具，只能通过断开 MCP 连接
/// （kill 服务器进程，kill_on_drop）使浏览器窗口随之关闭。
async function closeBrowserIfOpen(): Promise<void> {
  // 内置浏览器（CDP 直连）：进程常驻，收尾时显式关闭，避免残留内核进程
  try {
    await invoke<string>("browser_close");
  } catch {
    /* 未运行或不可用：忽略 */
  }
  const browserServers = new Set(
    mcpToolsCache.filter((t) => /^puppeteer_/i.test(t.name)).map((t) => t.server),
  );
  for (const server of browserServers) {
    try {
      await invoke("mcp_disconnect", { name: server });
    } catch {
      /* 忽略 */
    }
  }
  if (browserServers.size > 0) {
    // 同步清空工具缓存，并把 mcp store 中的服务器标记为未连接
    try {
      await refreshMcpTools();
    } catch {
      /* 忽略 */
    }
    try {
      const { useMcpStore } = await import("./mcp");
      useMcpStore().markDisconnected([...browserServers]);
    } catch {
      /* 忽略 */
    }
  }
}
/// 本次消息会话内是否已用浏览器打开过网页（拦截未导航就 fill/click）。
/// 内置 `browser_navigate` 与插件 `puppeteer_navigate` 都算。每次新消息重置。
let browserNavigated = false;
/// P-A5 防假完成：当前任务计划是否已执行过**实际工作**工具（plan_task/plan_update 不算）。
/// plan_task 建计划时重置为 false；调用实际工具（callMcpTool 非 plan_*）时置 true。
/// 供 plan_update 拒绝「还没干活就把待办步骤标完成」——杜绝计划卡片秒变全部完成。
let planRealWork = false;
/// P-A6 步骤健康护栏：记录“正在执行哪一步”（plan_update doing 后）及该步内真实工作工具
/// 的成败，供 plan_update 拒绝「该步工具全部失败却标 done」——防止工具失败后假装完成。
let curStepForTools = -1; // 0-based；-1 = 未在执行任何具体步骤
const stepToolOk = new Map<number, number>();
const stepToolFail = new Map<number, number>();
/** 真实工作工具执行结果计入当前执行步骤的健康计数（plan_* 可视化不算） */
function noteToolOutcome(tool: string, ok: boolean) {
  if (curStepForTools < 0 || !isRealWorkTool(tool)) return;
  const map = ok ? stepToolOk : stepToolFail;
  map.set(curStepForTools, (map.get(curStepForTools) ?? 0) + 1);
}
/** 某步开始执行（doing）：清空该步历史成败并设为当前步骤 */
function beginStepHealth(step: number) {
  curStepForTools = step;
  stepToolOk.delete(step);
  stepToolFail.delete(step);
}
/** 某步结束（done/failed）：退出该步执行窗口并清其计数 */
function endStepHealth(step: number) {
  stepToolOk.delete(step);
  stepToolFail.delete(step);
  if (curStepForTools === step) curStepForTools = -1;
}
/** 新计划 / 清空计划：复位步骤健康 */
function resetPlanHealth() {
  curStepForTools = -1;
  stepToolOk.clear();
  stepToolFail.clear();
}
/** 该步执行过真实工具但全部失败（成功 0 次、失败 ≥1 次） */
function stepToolsAllFailed(step: number): boolean {
  return (stepToolOk.get(step) ?? 0) === 0 && (stepToolFail.get(step) ?? 0) > 0;
}
/// 浏览器尚未导航就执行页面操作（fill/click/…）时抛出的错误——在浏览器串行锁内判定，
/// 由 callMcpTool 捕获转成友好提示返回（保持原有行为，只是把判定移进锁内，以正确看到
/// 队列中前一个 navigate 执行后的真实状态，避免并行子代理时误判「未打开网页」）。
class BrowserNotNavigatedError extends Error {
  constructor() {
    super("尚未打开网页");
    this.name = "BrowserNotNavigatedError";
  }
}

/// 解析工具调用的目标服务器：模型常省略 server 字段或写 "default"/"app"/"builtin"，
/// 但 puppeteer_* 等 MCP/浏览器工具若被路由到 "app" 会误报「未知内置工具: xxx」。
/// 容错规则（仅当 server 是 app/builtin/缺省时）:
///   1. puppeteer_* 与 __connect__：优先用已连接工具缓存，其次找已启用的浏览器服务器
///      （即使未连接也路由过去，由 callMcpTool 触发按需激活连接），避免误报未知内置工具；
///   2. 其余工具：在已连接 MCP 工具缓存中按工具名匹配真实服务器；
///   3. 匹配不到则保持默认（内置工具 → "app"）。
function resolveToolServer(server: string | undefined, tool: string): string {
  const s = server && server !== "default" ? server : "app";
  if (s === "app" || s === "builtin") {
    // 内置工具名一律留给内置实现：即便某个 MCP 服务器也提供同名工具，按名字转发
    // 会让内置工具「失踪」（曾观测 fetch_page → MCP error -32602: Tool not found）。
    if (BUILTIN_TOOL_NAMES.has(tool) && !/^puppeteer_/i.test(tool)) return "app";
    if (/^puppeteer_/i.test(tool) || tool === "__connect__") {
      const fromCache = mcpToolsCache.find(
        (t) => t.name === tool && t.server !== "app" && t.server !== "builtin",
      );
      if (fromCache) return fromCache.server;
      const browserServer = useMcpStore().servers.find(
        (srv) => srv.enabled && isBrowserServer(srv.name, srv.command),
      );
      if (browserServer) return browserServer.name;
    } else {
      const match = mcpToolsCache.find(
        (t) => t.name === tool && t.server !== "app" && t.server !== "builtin",
      );
      if (match) return match.server;
    }
  }
  return s;
}

export async function callMcpTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  // 托盘「当前上下文」：记录正在执行的工具（本轮结束清空）
  currentToolLabel.value =
    server === "app" || server === "builtin" ? tool : `${server} · ${tool}`;
  // P-A7 权限矩阵：工具级开关——被禁用的工具直接拦截（覆盖内置 + MCP 所有工具）
  if (isToolDisabled(tool, getSettings().disabledTools ?? [])) {
    return `⛔ 工具「${tool}」已在权限矩阵中禁用。请改用其它工具，或在「设置 → 权限」中重新启用。`;
  }
  // P1-4 声明式权限规则（deny 硬拦截 / ask 每次确认 / allow 记会话免确认）
  const ruleVerdict = await applyPermissionRules(tool, args);
  if (typeof ruleVerdict === "string") return ruleVerdict;
  // P1-3：tool_before 钩子（可 block 拦下这次调用；注入/shell/http/notify 也会在这里触发）
  const hookBlocked = await fireHooks({
    event: "tool_before",
    tool,
    command: typeof args.command === "string" ? args.command : undefined,
    path: typeof args.path === "string" ? args.path : undefined,
  });
  if (hookBlocked) return hookBlocked;
  // §3.11 Agent 多模式：模式工具白名单（如速答模式禁用全部工具）
  const mode = getModeById(activeModeId.value);
  if (!isToolAllowedByMode(mode, tool)) {
    return `⛔ 当前「${mode?.name || "速答"}」模式不允许调用工具「${tool}」。请直接作答，或切换到其他模式后再调用工具。`;
  }
  // P-A5 防假完成：记录“当前计划已发生实际工作”（plan_task/plan_update 不算），
  // 供 plan_update 拒绝「还没干活就把待办步骤标完成」。
  if (isRealWorkTool(tool)) planRealWork = true;
  // 内置工具（应用自带，无需 MCP 服务器）。容错：模型常把 MCP/浏览器工具（如 puppeteer_*）
  // 误填 server 为 app/builtin 或缺省——若工具名能在已连接 MCP 工具缓存中找到，转发到其
  // 真实服务器，避免误报「未知内置工具: xxx」。
  if (server === "app" || server === "builtin") {
    const routed = resolveToolServer(server, tool);
    if (routed !== server) return callMcpTool(routed, tool, args);
    const res = await callBuiltinTool(tool, args);
    // P0-5 验证凭据：成功的文件改动会使此前的「测试通过」结论过期（stale）
    if (MUTATION_TOOLS.has(tool) && !/^(?:⛔|❌)/.test(res.trim())) noteMutation();
    return res;
  }

  // 拦截 directory_tree：它会递归列整个目录树（含 .git/node_modules/target 等海量文件），
  // 实测对 daoshengyi 返回 1300 万字符、耗时 6 秒+且被截断——强制引导改用 list_directory
  // 逐层查看，避免上下文爆炸与超时。
  if (tool === "directory_tree") {
    return "⚠️ directory_tree 会递归列整个目录树（含 .git/node_modules/target 等海量文件），结果超长会被截断且浪费大量时间。请改用 **list_directory** 只列一层，逐层查看需要的子目录。";
  }

  // 按需激活：模型请求 __connect__，或调用了未连接服务器的工具（未先激活）时，
  // 连接该服务器后返回工具列表，让模型重选具体工具。浏览器服务器借此才真正启动。
  const mcp = useMcpStore();

  // 关键守卫：写入类工具一律转发到内置可信 write_file（应用自身写盘+校验+返回真实绝对路径）。
  // 目的：确保文件真实落盘、并让模型拿到唯一的真实路径原样引用（防止它在回复时改写/编造路径，导致链接打不开）。
  if (/^(write_file|write_text_file|writeFile|create_file|save_file)$/i.test(tool)) {
    const path = String((args as Record<string, unknown>)?.path ?? "");
    const content = String((args as Record<string, unknown>)?.content ?? "");
    if (path) {
      try {
        // create_file 转发到内置非覆盖版（已存在则拒绝），其余转发到内置 write_file（覆盖）
        const isCreate = /^create_file$/i.test(tool);
        const res = await callBuiltinTool(isCreate ? "create_file" : "write_file", { path, content });
        // P0-5：写盘成功 = 一次改动（使之前的验证凭据过期）
        if (!/^(?:⛔|❌)/.test(res.trim())) noteMutation();
        return res;
      } catch (e) {
        return `【文件写入被内置工具接管，但执行失败】${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  const target =
    mcp.servers.find((s) => s.name === server) ??
    mcp.servers.find((s) => s.enabled && !s.connected);
  if (
    tool === "__connect__" ||
    (target && target.enabled && !target.connected && target.name === server)
  ) {
    if (!target) {
      return `未找到可激活的服务器「${server}」。可用工具：${mcpToolsCache.map((t) => `${t.name}(${t.server})`).join(", ") || "无"}`;
    }
    if (target.connected) {
      return `服务器「${target.name}」已连接。可用工具：${
        mcpToolsCache
          .filter((t) => t.server === target.name)
          .map((t) => t.name)
          .join(", ") || "（暂无工具）"
      }。请选择合适的工具继续。`;
    }
    try {
      const toolNames = await mcp.connectByName(target.name);
      await refreshMcpTools();
      return `已按需连接服务器「${target.name}」，可用工具：${toolNames.join(", ")}。\n请根据工具列表选择合适的工具继续任务。`;
    } catch (e: unknown) {
      return `连接服务器「${target.name}」失败: ${e instanceof Error ? e.message : String(e)}。`;
    }
  }

  // LLM 填的 server 名可能与实际配置不一致（省略/偏差），映射到已连接服务器
  const knownServers = new Set(mcpToolsCache.map((t) => t.server));
  const effectiveServer = knownServers.has(server) ? server : (mcpToolsCache[0]?.server ?? server);

  // 浏览器操作（puppeteer_*）全部串行执行（P-M2 并行子代理安全）：
  // server-puppeteer 是单一浏览器实例，并行子代理/主代理并发 navigate/fill/click
  // 会互相干扰（两个导航竞争、browserNavigated 标记被并发读写）。用 withBrowserLock
  // 串行队列保证同一时刻只有一个浏览器操作；非浏览器工具（fetch_page、文件系统、
  // git/编辑等）不受影响、可并行。导航判定也移进锁内：能看到队列中前一个 navigate
  // 执行后的真实状态，避免并行时误判「未打开网页」。
  const isPuppeteer = /^puppeteer_/i.test(tool);
  let screenshotUserPath: string | null = null;
  const execute = async (): Promise<{
    content: { type: string; text?: string; data?: string }[];
    isError?: boolean;
  }> => {
    if (isPuppeteer) {
      // 增强浏览器自动化：navigate 时若模型未指定 waitUntil，默认等待网络空闲，
      // 确保 JS 动态渲染完成，避免紧跟的 screenshot 截到空白页面。
      if (
        tool === "puppeteer_navigate" &&
        args &&
        typeof args === "object" &&
        !(args as Record<string, unknown>).waitUntil
      ) {
        (args as Record<string, unknown>).waitUntil = "networkidle2";
      }
      // 拦截浏览器页面操作：必须先 navigate 打开过网页，否则无从输入/点击/截图。
      // 防止 agent 跳过导航就直接 fill/click（页面都没打开谈何操作）。
      if (
        (/^puppeteer_(fill|click|select|hover|screenshot|evaluate)$/.test(tool) ||
          /^browser_(fill|click|screenshot|evaluate)$/.test(tool)) &&
        !browserNavigated
      ) {
        throw new BrowserNotNavigatedError();
      }
      if (tool === "puppeteer_navigate" || tool === "browser_navigate") {
        browserNavigated = true;
      }
      // puppeteer_screenshot 拦截：①用户/模型可通过 path / savePath 指定保存位置
      // （自定义参数，剥掉不传给 server）；②server 端会用 width??800/height??600
      // 重置页面视口，模型未显式指定大小时补齐与浏览器窗口一致的视口，保持页面占满窗口。
      if (tool === "puppeteer_screenshot" && args && typeof args === "object") {
        const a = args as Record<string, unknown>;
        const sp = a.path ?? a.savePath;
        if (typeof sp === "string" && sp.trim()) screenshotUserPath = sp.trim();
        delete a.path;
        delete a.savePath;
        if (a.width === undefined || a.height === undefined) {
          const vp = puppeteerViewport();
          if (a.width === undefined) a.width = vp.width;
          if (a.height === undefined) a.height = vp.height;
        }
      }
    }
    return invoke<{ content: { type: string; text?: string; data?: string }[]; isError?: boolean }>(
      "mcp_call_tool",
      {
        server: effectiveServer,
        toolName: tool,
        arguments: args,
      },
    );
  };
  let result: { content: { type: string; text?: string; data?: string }[]; isError?: boolean };
  if (isPuppeteer) {
    try {
      result = await withBrowserLock(execute);
    } catch (e) {
      if (e instanceof BrowserNotNavigatedError) {
        return "⚠️ 尚未打开任何网页，无法执行该操作。请先用 **puppeteer_navigate** 打开目标页面（如 `https://www.baidu.com`），确认页面加载后再输入/点击/提取。";
      }
      throw e;
    }
  } else {
    result = await execute();
  }
  const text = result.content.map((c) => c.text || "").join("\n");
  // 若返回了图片数据（如 puppeteer_screenshot 截图），保存到临时文件，
  // 并提示大模型可用 describe_image / ocr_image 分析该截图
  const images = result.content.filter((c) => c.type === "image" && c.data);
  let out = text;
  for (const img of images) {
    try {
      // 用户指定了保存路径则用之，否则保存到持久目录 ~/Pictures/道生一截图/
      const p = await invoke<string>("save_temp_image", {
        data: img.data,
        path: screenshotUserPath,
      });
      out += `\n\n截图已保存到: ${p}\n（如需理解截图内容，可调用内置工具 describe_image 描述图片 或 ocr_image 提取文字，参数 path 填该路径）`;
    } catch {
      /* 保存失败忽略 */
    }
  }
  return out;
}

/// 工具结果回填到上下文前截断：防止超大结果（如 directory_tree 列整个目录树、
/// 大文件全文）撑爆模型上下文（如 DeepSeek 1M token 上限）。
/// 超长保留开头并明确提示模型已截断，可缩小范围重查。
/// 读取 puppeteer 浏览器配置的页面视口（PUPPETEER_LAUNCH_OPTIONS.defaultViewport），
/// 用于截图时保持页面视口与窗口一致；读不到时回退 1440x900。
function puppeteerViewport(): { width: number; height: number } {
  try {
    const srv = useMcpStore().servers.find((s) => s.env?.PUPPETEER_LAUNCH_OPTIONS);
    const raw = srv?.env?.PUPPETEER_LAUNCH_OPTIONS;
    if (raw) {
      const opts = JSON.parse(raw) as { defaultViewport?: { width?: number; height?: number } };
      const w = opts.defaultViewport?.width;
      const h = opts.defaultViewport?.height;
      if (w && h) return { width: w, height: h };
    }
  } catch {
    /* 忽略 */
  }
  return { width: 1440, height: 900 };
}

/// 判定一段正文是否为「空洞的过程声明」——模型口头承诺要做某事但未执行、也未给出实质内容，
/// 如「搜索与问题无关，我直接访问官网获取办事指南」。用于工具循环/收尾轮判定：
/// 正文空洞时强制模型真正调用工具或给出完整答案，避免「只有工具卡片 + 一句意图声明」的断头回复。
function isVagueBody(s: string): boolean {
  const sc = s.trim();
  if (sc.length === 0) return true; // 空正文
  if (/^###\s*(🔧|🌐)/.test(sc)) return true; // 仍被工具卡片/占位占用
  if (sc.length > 120) return false; // 长正文视为已有实质内容
  // 有列表/编号/冒号/表格/代码块等结构 → 视为有内容。
  // 注意：仅换行不算（agent 常只写个标题如「**检查页面元素**」就结束，仍是空洞）
  if (/^\s*[-•*]\s|\d+[.、]\s|[：]|:\s|\|.+\||```/.test(sc)) return false;
  // 短正文 + 第一人称/过渡词/延续词引导的「过程声明」（我/将/直接/继续/尝试/再…
  // 访问/获取/查…）或「结果无关」→ 空洞。纯建议（如「可访问官网查看最新政策」无
  // 引导词）不算空洞。
  return (
    /(我|将|准备|接下来|让我|直接|先|去|继续|尝试|再|重新).{0,12}(访问|获取|查看|打开|查询|搜索|查|输出|写|写入|整理|生成|拼|创建|保存|补全|重新输出)/.test(
      sc,
    ) || /无关|与问题不相关/.test(sc)
  );
}

// ── 系统通知：任务完成 / 最终产物就绪 ─────────────────────────────────────
/// 把 Markdown 正文压成适合通知展示的一小段纯文本（去代码块/标记符号，压平空白）
function plainTextForNotice(md: string, max = 140): string {
  const t = md
    .replace(/```[\s\S]*?```/g, " ") // 代码块整体去掉（通知里读不出意义）
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接只留文字
    .replace(/^\s{0,3}#{1,6}\s*/gm, "") // 标题标记
    .replace(/^\s{0,3}>\s?/gm, "") // 引用
    .replace(/^\s*[-*+]\s+/gm, "") // 列表符号
    .replace(/[*_`~]/g, "") // 强调符号
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/// 本轮正常结束时发系统通知（窗口未聚焦时才打扰；Rust 侧判聚焦）
function notifyTurnFinished(content: string, toolCount: number): void {
  try {
    if (stopRequested) return; // 用户主动停止 ≠ 完成，不误报
    if (!getSettings().notifyOnFinish) return;
    const body = plainTextForNotice(content);
    if (!body) return; // 空正文（如本地命令/空洞回复）不打扰
    const plan = useChatStore().taskPlan;
    const planAllDone =
      !!plan && plan.steps.length > 0 && plan.steps.every((s) => s.status === "done");
    const title = planAllDone
      ? "✅ 任务完成"
      : toolCount > 0
        ? "✅ 执行完成"
        : "💬 回复完成";
    const suffix = plan
      ? `（${plan.steps.filter((s) => s.status === "done").length}/${plan.steps.length} 步）`
      : "";
    invoke("notify_user", {
      title,
      body: suffix ? `${body}\n${suffix}` : body,
      onlyWhenUnfocused: true,
    }).catch(() => {
      /* 通知失败不影响主流程（未授权/系统未打包等） */
    });
  } catch {
    /* 通知为增值功能，任何异常都不打断本轮 */
  }
}

// ── Phase 3 收尾：会话轨迹 → 可复用工作流（自动沉淀）──────────────────────────
/// 把「本轮成功完成的工具序列」交给辅助模型抽象成工作流并保存。
/// 返回给用户看的一行说明（成功沉淀时）；未沉淀/失败返回 null。
/// 门控严格（实际工作工具 ≥3、无失败、工具种类 ≥2），产出必须通过 validateWorkflowGraph
/// 校验才会写库；全程静默失败（任何异常都不影响主流程与已生成的回复）。
async function mineWorkflowFromTurn(goal: string, cards: ChatTool[]): Promise<string | null> {
  const steps: MinedToolStep[] = cards.map((c) => ({
    name: c.name,
    server: c.server,
    argsPreview: c.argsPreview,
    resultPreview: c.resultPreview,
    status: c.status,
  }));
  const gate = shouldMineWorkflow(steps);
  if (!gate.ok) {
    dbg(`[mine] 跳过工作流沉淀：${gate.reason}`);
    return null;
  }
  const store = useChatStore();
  const config = store.getRoutedAuxConfig("summarize");
  if (!config.baseUrl || !config.apiKey) return null;
  try {
    const data = await invoke<{ content?: string }>("chat_once", {
      config: {
        base_url: config.baseUrl,
        api_key: config.apiKey,
        model: config.model,
        max_tokens: 4000,
        temperature: 0.2,
        thinking_enabled: false,
        reasoning_effort: "low",
        system_prompt:
          "你是严谨的工作流抽象器，只输出合法 JSON（工作流图），不要任何解释或 markdown 代码块。",
        enable_web_search: false,
      },
      messages: [{ role: "user", content: buildMiningPrompt(goal, steps) }],
    });
    const graph = parseMinedGraph(data?.content || "");
    if (!graph) {
      dbg("[mine] 模型未返回可解析的工作流 JSON，跳过");
      return null;
    }
    const verr = validateWorkflowGraph(graph);
    if (verr) {
      dbg(`[mine] 生成的工作流不合法（未保存）：${verr}`);
      return null;
    }
    const name = minedWorkflowName(goal);
    await invoke<number>("workflow_save", { name, graph: JSON.stringify(graph) });
    // 同步沉淀「任务类型 → 工作流」记忆（与 workflow_remember 同语义；重要度 6 不进用户画像）
    try {
      const fact = `任务类型「${(goal || "").slice(0, 60)}」可复用已沉淀工作流「${name}」，同类任务直接用 workflow_run 执行`;
      await invoke("save_fact", {
        fact: {
          id: uuidv4(),
          conversation_id: null,
          fact,
          fact_type: "workflow",
          importance: 6,
          access_count: 0,
          last_accessed: null,
          created_at: Date.now(),
        },
      });
    } catch {
      /* 记忆沉淀失败不影响工作流保存 */
    }
    dbg(`[mine] 已沉淀工作流「${name}」（${graph.nodes.length} 个节点）`);
    return `💾 本次流程已沉淀为可复用工作流「${name}」（${graph.nodes.length} 个节点）——可在「工具 → 可视化工作流」查看/编辑，同类任务下次会自动想起并复用。`;
  } catch (e) {
    dbg(`[mine] 工作流沉淀失败（忽略）: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/// 任务收尾兜底：把「确实已开始执行」的进行中步骤标记为 done，
/// 但**绝不把「从未执行」的待办步骤标成 done**（避免「啥也没干却全部标完成」的假完成）。
/// failed 步骤保留，便于复盘。
function markTaskPlanDoneIfPending(): void {
  // 用户已停止（stopRequested）：打断 ≠ 完成——绝不把“正在做/没做完”的步骤强制标 done，
  // 保留原状态让用户看到任务实际未完成，而不是“点停止后反而显示全部完成”。
  if (stopRequested) return;
  const chat = useChatStore();
  const plan = chat.taskPlan;
  if (!plan) return;
  let changed = false;
  const steps = plan.steps.map((s) => {
    if (s.status === "doing") {
      changed = true;
      return { ...s, status: "done" as const };
    }
    return s;
  });
  if (changed) chat.setTaskPlan({ ...plan, steps });
}

/// 用户终止任务：把「正在执行中」的步骤标记为已终止（terminated），与成功/失败区分——
/// 点停止后任务卡显示「已终止」而不是仍在“进行中”转圈（此前只 stopRequested 不标 done，
/// 导致 doing 步骤一直转，观感像“剩下的任务还在跑”）。done 保留（确实完成）、
/// pending 保留（未执行），仅 doing → terminated。
function markTaskPlanTerminated(): void {
  const chat = useChatStore();
  const plan = chat.taskPlan;
  if (!plan) return;
  if (plan.steps.some((s) => s.status === "doing")) {
    const steps = plan.steps.map((s) =>
      s.status === "doing" ? ({ ...s, status: "terminated" } as const) : s,
    );
    chat.setTaskPlan({ ...plan, steps });
  }
}

/// 任务计划是否已全部完成（存在计划且所有步骤均为 done）。
function isTaskPlanAllDone(): boolean {
  const plan = useChatStore().taskPlan;
  return !!plan && plan.steps.length > 0 && plan.steps.every((s) => s.status === "done");
}

/// 当前是否处于【任务模式】。
function isTaskModeActive(): boolean {
  return getModeById(activeModeId.value)?.id === "task";
}

/// 是否为「实际工作」类工具（会产生真实副作用/数据）；
/// plan_task / plan_update 只是计划可视化，不算是真正干活。
function isRealWorkTool(tool: string): boolean {
  return tool !== "plan_task" && tool !== "plan_update";
}

/// 确保 MCP 服务器已连接（资源类工具用）：未连接则先按需连接；失败不抛错，
/// 交给 Rust 命令返回「未连接」的明确提示，避免前端中断工具循环。
async function ensureMcpServerConnected(server: string): Promise<void> {
  try {
    const { useMcpStore } = await import("./mcp");
    const mcp = useMcpStore();
    const s = mcp.servers.find((x) => x.name === server);
    if (s && s.enabled && !s.connected) {
      await mcp.connectByName(server);
      await refreshMcpTools();
    }
  } catch {
    /* 忽略：后续 invoke 会给出明确错误 */
  }
}

/// 渲染 MCP 资源列表（resources + templates）；为空时给出可操作建议而不是空话
function formatMcpResources(
  server: string,
  data: { resources?: unknown; templates?: unknown },
): string {
  const asList = (v: unknown, key: string): Record<string, unknown>[] => {
    const inner = (v as Record<string, unknown> | null)?.[key];
    return Array.isArray(inner) ? (inner as Record<string, unknown>[]) : [];
  };
  const resources = asList(data.resources, "resources");
  const templates = asList(data.templates, "resourceTemplates");
  if (resources.length === 0 && templates.length === 0) {
    return `服务器「${server}」未暴露任何资源（它可能只提供工具——直接用它的工具即可）。`;
  }
  const lines: string[] = [
    `服务器「${server}」共 ${resources.length} 个资源、${templates.length} 个模板：`,
  ];
  for (const r of resources.slice(0, 40)) {
    const meta = [
      r.name ? `（${r.name}）` : "",
      r.mimeType ? ` [${r.mimeType}]` : "",
      r.description ? ` — ${String(r.description).slice(0, 120)}` : "",
    ].join("");
    lines.push(`- ${r.uri}${meta}`);
  }
  if (resources.length > 40) lines.push(`…（还有 ${resources.length - 40} 个未列出）`);
  for (const t of templates.slice(0, 20)) {
    lines.push(`- 模板 ${t.uriTemplate}${t.name ? `（${t.name}）` : ""} — 按模板填参后作为 uri 读取`);
  }
  lines.push("\n用 read_mcp_resource(server, uri) 读取具体资源。");
  return lines.join("\n");
}

const MAX_TOOL_RESULT_CHARS = 6000;
/// 折叠后保留的首/尾字符数（中间省略，完整内容落盘）
const TOOL_RESULT_HEAD = 4000;
const TOOL_RESULT_TAIL = 1200;

/// 同步版截断（子代理循环等不便 await 的场景）：同样先脱敏，避免密钥进入子代理上下文
function truncateToolResult(result: string): string {
  const safe = redactSecrets(result).text;
  if (safe.length <= MAX_TOOL_RESULT_CHARS) return safe;
  return (
    `${safe.slice(0, MAX_TOOL_RESULT_CHARS)}` +
    `\n\n…[工具结果过长已截断（原 ${safe.length} 字符，仅保留前 ${MAX_TOOL_RESULT_CHARS} 字符）。` +
    `如确需完整内容，请缩小查询范围或用更精准的参数重新调用工具]`
  );
}

/// 超长工具结果处理（诊断报告②：单轮上下文预算）：**先脱敏 → 再内容感知压缩 → 最后才考虑落盘**：
/// ① 脱敏：网页/命令输出常夹带密钥（吸收自 DSH 生态的 secret-guard / dsh-mask），绝不进上下文、日志与落盘；
/// ② 压缩：折叠重复行/栈帧/通过用例、采样超大 JSON 与表格（吸收自 dsh-funnel / toolshrink 思路），
///    错误与失败行优先保留，并把「丢了什么」写进说明；
/// ③ 仍超预算：把**脱敏后的完整原文**落盘（`save_tool_output`），回填只留「首 + 尾 + 路径」，
///    模型可用 read_file（offset/length）分段取回。既不膨胀上下文，也不丢信息。
async function foldToolResult(tool: string, result: string): Promise<string> {
  const safe = redactSecrets(result).text;
  const reduced = reduceToolResult(tool, safe);
  const reduceNote = reduced.notes.length
    ? `\n\n…[工具结果已压缩：${reduced.notes.join("；")}。上面看到的是压缩视图，需要中间细节请用更精确的参数重查]`
    : "";
  if (reduced.text.length <= MAX_TOOL_RESULT_CHARS) {
    return reduced.text + reduceNote;
  }
  let savedPath = "";
  try {
    savedPath = await invoke<string>("save_tool_output", { tool, content: safe });
  } catch {
    /* 落盘失败 → 退化为压缩 + 截断（绝不因落盘问题打断工具循环） */
  }
  const head = reduced.text.slice(0, TOOL_RESULT_HEAD);
  const tail = reduced.text.slice(-TOOL_RESULT_TAIL);
  const omitted = reduced.text.length - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL;
  const note = savedPath
    ? `\n\n…[结果过长已折叠：压缩后 ${reduced.text.length} 字符，中间省略 ${omitted} 字符。**完整内容已保存**：${savedPath}\n` +
      `需要中间细节时用 read_file（path=${savedPath}，可配合 offset/length 分段读取）取回；不要凭首尾片段臆测中间内容]`
    : `\n\n…[工具结果过长已裁剪（压缩后 ${reduced.text.length} 字符；完整内容落盘失败），如需完整内容请缩小查询范围]`;
  return `${head}\n\n………\n\n${tail}${note}${reduceNote}`;
}

/// 上下文总长保护阈值（字符）：工具结果持续回填会让 messages 逼近模型上限
/// （DeepSeek 1M token ≈ 200 万字符），超过阈值停止继续调工具，留足余量避免 [400]。
const MAX_CONTEXT_CHARS = 1_500_000;
// S3 技能渐进披露阈值：启用技能数 > 此值 且 指令总字符 > 此值 → 进入「路由清单 + 按需命中注入」
const SKILL_DIRECT_INJECT_MAX_SKILLS = 2;
const SKILL_DIRECT_INJECT_CHARS = 2000;
const SKILL_MATCH_MAX_HITS = 2;
function totalMsgChars(msgs: { role: string; content: unknown }[]): number {
  return msgs.reduce((sum, m) => {
    const t = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return sum + t.length;
  }, 0);
}

/** 调用应用内置工具（fetch_page 网页抓取、web_search 搜索） */
/// 从用户提问中提取搜索关键词（去标点、去常见请求/疑问/分析词），提升自动搜索相关度。
/// 自动搜索在发送前执行、无法先让模型给关键词，只能做轻量启发式清洗；
/// 清洗后为空则退回原始提问。
/// 注意：**不要**删单字「查」（会把「检查/查看/查询」误删成「检 」），只删叠词/短语；
/// 疑问词「是什么/有哪些/哪些/呢」等一并清掉，避免查询残缺导致搜索无关结果。
function extractSearchKeywords(text: string): string {
  // 清洗要点：
  // 1) 去标点
  // 2) 去请求/疑问/分析词（含「什么是/为啥/怎么样/介绍一下」等口语，方向无所谓）
  // 3) 去「说说/讲讲/介绍/解释/分析/总结」这类请求动词（保留后面的实体/主题词）
  // 4) 收紧为 12 字以内核心词（长句查询搜索引擎质量差）
  // 5) 清洗后为空则退回原始提问的前 12 字
  const cleaned = text
    .replace(/[，。！？、；：""''（）【】《》…—·,.!?;:'"()\[\]{}<>]/g, " ") // eslint-disable-line no-useless-escape
    .replace(
      /(请|帮我|麻烦|请问|我想要|我想|给我|推荐|介绍下|介绍一下|说说|讲讲|帮我查|帮我找|查一下|查查|看看|分析|解释|说明|总结|简述|告诉我|我想知道|为什么|是什么|什么是|怎么样|怎么样才|如何|怎么用|怎么|怎样|为啥|啥|一下|的话|有没有|有哪些|哪些|是什么意思|如何理解|区别|区别是什么|是做什么的|是干什么的|做什么用|干什么用|是干嘛的|干嘛的|是什么样)\s*/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim()
    // 去掉末尾疑问/修饰残留（如「是做什么」「的最新」），保留核心实体
    .replace(/是做什么$|做什么$|的最新$|的最新$|的情况$|的消息$|怎么样$|什么样$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12);
  return cleaned || text.trim().slice(0, 12);
}
// 文件写/删操作成功后触发：通知 UndoBubble 刷新可撤销列表（会话内撤销）
function notifyUndoChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("undo-changed"));
}

// --- O3 会话级工具集：后台子会话（复用 S4 queue_turn 后台执行 + ensure_conversation_cmd） ---

/// Agent 自主开的后台子会话登记（id → 元信息）；重启即清空（会话本身仍在历史里）
const agentSessions = new Map<string, { title: string; startedAt: number; interrupted: boolean }>();

/** session_spawn：建后台子会话并投递任务（不切换当前会话） */
async function toolSessionSpawn(args: Record<string, unknown>): Promise<string> {
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) return "❌ session_spawn 需要 prompt 参数（后台任务的完整指令）。";
  const chat = useChatStore();
  const name = String(args.name ?? "子任务").slice(0, 40);
  const id = uuidv4();
  const now = Date.now();
  const conv = {
    id,
    title: `🧵 ${name}`,
    messages: [],
    createdAt: now,
    updatedAt: now,
    model: (chat.currentConfig as { model?: string } | undefined)?.model ?? "",
  } as (typeof chat.conversations)[number];
  chat.conversations.unshift(conv);
  // 确保后端有会话行（queue_turn 后台写消息依赖该行，否则子会话不会出现在列表）
  try {
    await invoke("ensure_conversation_cmd", { id, title: conv.title, model: conv.model });
  } catch {
    /* 已存在/失败忽略 */
  }
  sessionBusy.add(id);
  agentSessions.set(id, { title: conv.title, startedAt: now, interrupted: false });
  try {
    await invoke("queue_turn", { conversationId: id, text: prompt });
  } catch (e) {
    sessionBusy.delete(id);
    return `❌ session_spawn 投递失败：${e}。子会话仍保留在左侧列表（${conv.title}），可点击手动继续。`;
  }
  return (
    `✅ 已创建后台子会话「${conv.title}」并投递任务。\n` +
    `- session_id: ${id}\n` +
    "- 它独立执行、不阻塞当前对话；完成后结果自动写入该会话（左侧历史可见，可点击查看/续聊）。\n" +
    `- 查询进度：session_status，参数 {"session_id": "${id}"}\n` +
    `- 把结果取回本对话继续分析：session_resume，参数 {"session_id": "${id}"}（会等待完成）`
  );
}

/** session_status：查询子会话执行进度/最近结果 */
async function toolSessionStatus(id: string): Promise<string> {
  const chat = useChatStore();
  try {
    await chat.refreshConversation(id);
  } catch {
    /* 会话可能已删除 */
  }
  const conv = chat.conversations.find((c) => c.id === id);
  if (!conv) return `❌ 找不到会话 ${id}（可能已被删除）。`;
  const msgs = conv.messages;
  const last = msgs[msgs.length - 1];
  const done = !!last && last.role === "assistant";
  const running = sessionBusy.has(id) || (!done && msgs.length > 0);
  const state = running ? "⏳ 执行中…" : done ? "✅ 已完成" : "已创建（尚未产出回复）";
  const lastText = done && typeof last.content === "string" ? last.content.slice(0, 600) : "";
  return (
    `子会话「${conv.title}」状态：${state}\n` +
    `- session_id: ${id}\n` +
    `- 消息数：${msgs.length}\n` +
    (done ? `- 最近结果（前 600 字）：\n${lastText}` : "- 尚无可用结果")
  );
}

/** session_resume：等待子会话完成并把完整结果取回（最长约 4 分钟，用户可随时停止） */
async function toolSessionResume(id: string): Promise<string> {
  const chat = useChatStore();
  const deadline = Date.now() + 240_000;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    if (stopRequested) throw new AgentStoppedError();
    try {
      await chat.refreshConversation(id);
    } catch {
      /* 忽略 */
    }
    const conv = chat.conversations.find((c) => c.id === id);
    if (!conv) return `❌ 找不到会话 ${id}（可能已被删除），无法取回结果。`;
    const last = conv.messages[conv.messages.length - 1];
    if (
      last &&
      last.role === "assistant" &&
      typeof last.content === "string" &&
      last.content.trim().length > 0
    ) {
      return `【子会话「${conv.title}」结果】\n${last.content}`;
    }
    if (Date.now() > deadline) {
      return "⏱️ 等待子会话完成超时（4 分钟）。子会话仍在后台继续执行，可用 session_status 查询进度，稍后再次 session_resume 取回结果。";
    }
    await pause(1500);
  }
}

/** list_agents：列出 Agent 开的后台子会话及其状态（融合自 Codex 的 list_agents） */
async function toolListAgents(): Promise<string> {
  if (agentSessions.size === 0) {
    return "（本应用运行期间 Agent 还没有创建后台子会话；需要后台并行工作用 session_spawn 或 subagent_parallel）";
  }
  const chat = useChatStore();
  const lines: string[] = [];
  for (const [id, meta] of agentSessions) {
    try {
      await chat.refreshConversation(id);
    } catch {
      /* 已删除 */
    }
    const conv = chat.conversations.find((c) => c.id === id);
    const last = conv?.messages[conv.messages.length - 1];
    const done = !!last && last.role === "assistant" && String(last.content || "").trim().length > 0;
    const state = meta.interrupted
      ? "⛔ 已中断"
      : done
        ? "✅ 已完成"
        : sessionBusy.has(id)
          ? "⏳ 执行中"
          : "⏸ 未产出回复";
    const mins = Math.round((Date.now() - meta.startedAt) / 60000);
    lines.push(
      `- ${id}｜${meta.title}｜${state}｜已运行约 ${mins} 分钟｜消息 ${conv?.messages.length ?? 0} 条` +
        (done ? `\n  结果预览：${String(last!.content).slice(0, 160)}` : ""),
    );
  }
  return `Agent 后台子会话（共 ${agentSessions.size} 个）：\n${lines.join("\n")}\n\n取完整结果用 session_resume；不要了用 interrupt_agent。`;
}

/** interrupt_agent：中断后台子会话（融合自 Codex；结果丢弃不写入会话） */
async function toolInterruptAgent(id: string, reason: string): Promise<string> {
  const meta = agentSessions.get(id);
  try {
    await invoke<boolean>("cancel_queued_turn", { conversationId: id });
  } catch (e: unknown) {
    return `取消失败：${e instanceof Error ? e.message : String(e)}`;
  }
  sessionBusy.delete(id);
  if (meta) meta.interrupted = true;
  return (
    `已请求中断子会话 ${id}${meta ? `「${meta.title}」` : ""}${reason ? `（原因：${reason}）` : ""}。\n` +
    "注意：后台是单次非流式请求，**已发出的这次调用会跑完但结果被丢弃**（不会写进该会话）。"
  );
}

// ── 上下文压缩（吸收自 Codex 的 compaction）────────────────────────────────
// Codex 侧有三件套：① 自动触发（阈值/触发标记）② `prompts/templates/compact/prompt.md`
// 的 handoff 摘要模板 ③ 压缩后作为新上下文继续（checkpoint）。我们对应：
// ① maybeAutoCompact（占用 ≥ 阈值自动压）② 下方 HANDOFF_SUMMARY_PROMPT ③ compactBefore/Summary。
// 另：完成**任何自足交接**——接续者看不到原始消息，摘要必须包含路径/命令/待办。
const HANDOFF_SUMMARY_PROMPT =
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n" +
  "请按以下四段结构输出（中文，纯摘要，不要前言/解释/代码块围栏）：\n" +
  "1) 当前进度与已完成的关键决策（含已排除的方案及原因）\n" +
  "2) 重要上下文与约束（用户偏好/要求/禁止事项、环境限制）\n" +
  "3) 尚未完成的事项与明确的下一步\n" +
  "4) 继续所需的关键数据：文件路径、命令、参数、结论数字（**原样保留，不要改写**）\n" +
  "不要编造；接续者看不到原始对话，摘要必须自足。";

/// 自动压缩阈值：上下文占用达窗口的 82% 即自动压缩（Codex 亦有自动触发）
/// 注：P1-5 把它接入压缩阶梯的 `hard` 档（`utils/compaction-ladder.ts` 的 HARD_RATIO，同值）
const AUTO_COMPACT_RATIO = 0.82;
/// P1-5：阶梯 hard 档阈值（与 AUTO_COMPACT_RATIO 同值，单独命名以便阅读时知道对应关系）
const HARD_RATIO = AUTO_COMPACT_RATIO;
/// 自动压缩保留的最近原始消息条数
const AUTO_COMPACT_KEEP = 6;
/// 压缩冷却（同一会话 60s 内不重复触发，避免连环压缩）
const AUTO_COMPACT_COOLDOWN_MS = 60_000;
let lastAutoCompactAt = 0;

/// 可压缩会话的最小结构（与 store 的 Conversation 结构兼容）
interface CompactableConv {
  id?: string;
  messages: ChatMessage[];
  compactBefore?: number;
  compactSummary?: string;
  updatedAt: number;
}

// P1-5 压缩阶梯运行时状态：
// - `appliedStages`：每个会话已走过的档位（单调，不回头）
// - `preparedDigest`：50%/70% 档在内存里备好的确定性产物（关键词索引/关键事实，**不占上下文**），
//   等硬压缩时一并拼进摘要 → 摘要 = 模型语义摘要 + 确定性字面事实
const appliedStages = new Map<string, Set<StageId>>();
const preparedDigest = new Map<string, PreparedDigest>();

/// 把会话中较早的历史压缩成 handoff 摘要，写回 compactBefore/compactSummary。
/// 供 `new_context_window` 工具与自动压缩共用。失败返回 reason（不抛异常）。
async function compressConversation(
  store: ReturnType<typeof useChatStore>,
  conv: CompactableConv,
  keep: number,
): Promise<{ ok: boolean; compressed: number; chars: number; reason?: string }> {
  const hist = conv.messages.filter((m) => m.role !== "system" && !m.streaming);
  const cut = hist.length - keep;
  const already = conv.compactBefore ?? 0;
  if (cut <= already + 1) return { ok: false, compressed: 0, chars: 0, reason: "历史很短，无需压缩" };
  const aux = store.getRoutedAuxConfig("summarize");
  if (!aux.baseUrl || !aux.apiKey) {
    return { ok: false, compressed: 0, chars: 0, reason: "未配置可用的摘要模型/API Key" };
  }
  const transcript = hist
    .slice(already, cut)
    .map((m) => `${m.role}: ${(m.content || "").slice(0, 600)}`)
    .join("\n")
    .slice(0, 60000);
  const data = await invoke<{ content?: string }>("chat_once", {
    config: {
      base_url: aux.baseUrl,
      api_key: aux.apiKey,
      model: aux.model,
      max_tokens: 1200,
      temperature: 0.2,
      thinking_enabled: false,
      reasoning_effort: "low",
      system_prompt: HANDOFF_SUMMARY_PROMPT,
      enable_web_search: false,
    },
    messages: [{ role: "user", content: transcript }],
  });
  const summary = (data?.content || "").trim();
  if (!summary) return { ok: false, compressed: 0, chars: 0, reason: "模型未返回摘要" };
  // P1-5：把阶梯早档备好的确定性产物拼进摘要（幂等，重复压缩不会叠第二份）
  const digest = preparedDigest.get(conv.id ?? "") ?? {};
  const merged = mergeDigestIntoSummary(summary, digest);
  conv.compactBefore = cut;
  conv.compactSummary = merged;
  conv.updatedAt = Date.now(); // 触发深监听 → 自动落库
  return { ok: true, compressed: cut - already, chars: merged.length };
}

/// 自动压缩（每次发送前调用）：占用 ≥ AUTO_COMPACT_RATIO 且不在冷却期 → 压缩。
/// 返回本次压缩掉的消息数（0 = 未压缩），失败不抛错（不阻塞主流程）。
async function maybeAutoCompact(
  conv: CompactableConv,
  config: { baseUrl?: string; model?: string; maxContextMessages?: number },
): Promise<number> {
  const window = modelContextWindowTokens(config.baseUrl || "", config.model);
  const maxCtx = config.maxContextMessages || 50;
  const hist = conv.messages
    .filter((m) => m.role !== "system" && !m.streaming)
    .slice(-maxCtx);
  const est = hist.reduce(
    (s, m) => s + estimateMessageTokens(m.content || "", m.reasoning_content),
    0,
  );
  const used = Math.max(lastPromptTokens, est);
  const ratio = used / window;
  // P1-5 压缩阶梯：早档（30/50/70）一律**无损且零上下文成本**，只在内存里备料
  const convKey = conv.id ?? "current";
  const applied = appliedStages.get(convKey) ?? new Set<StageId>();
  appliedStages.set(convKey, applied);
  for (const stage of pendingStages(ratio, [...applied])) {
    if (stage.id === "hard") continue; // 硬压缩走下方原有流程（含冷却与摘要模型校验）
    applied.add(stage.id);
    if (stage.id === "note") {
      await dbg(`[ladder] 占用 ${Math.round(ratio * 100)}% → ${stage.label}`);
    } else {
      // index / trim：对「即将被摘要覆盖的老消息」备料（droppable）
      const histAll = conv.messages.filter((m) => m.role !== "system" && !m.streaming);
      const cut = Math.max(0, histAll.length - AUTO_COMPACT_KEEP);
      const droppable = histAll.slice(0, cut).map((m) => ({ role: m.role, content: m.content || "" }));
      const prev = preparedDigest.get(convKey) ?? {};
      preparedDigest.set(convKey, { ...prev, ...prepareDigest(droppable) });
      await dbg(
        `[ladder] 占用 ${Math.round(ratio * 100)}% → ${stage.label}（备料 ${droppable.length} 条老消息）`,
      );
    }
  }
  if (ratio < HARD_RATIO) return 0;
  if (Date.now() - lastAutoCompactAt < AUTO_COMPACT_COOLDOWN_MS) return 0;
  try {
    const r = await compressConversation(useChatStore(), conv, AUTO_COMPACT_KEEP);
    lastAutoCompactAt = Date.now();
    if (!r.ok) {
      await dbg(`[compact] 自动压缩未执行：${r.reason}`);
      return 0;
    }
    await dbg(
      `[compact] 自动压缩完成：${r.compressed} 条历史 → ${r.chars} 字交接摘要（占用 ${Math.round((used / window) * 100)}%）`,
    );
    return r.compressed;
  } catch (e: unknown) {
    await dbg(`[compact] 自动压缩异常：${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

async function callBuiltinTool(tool: string, args: Record<string, unknown>): Promise<string> {
  // P1-1 工具调用自愈（吸收自 DSH 生态的 dsh-tool-normalizer）：
  // 模型常把 file_path/filepath 当 path、把 "5" 当 number、把参数包进 arguments 里 ——
  // 在分发前就地修正，**只在规范参数缺失或类型明显不符时**生效（绝不覆盖模型给对的值）。
  const normalized = normalizeToolArgs(args, BUILTIN_PARAMETERS[tool]);
  args = normalized.args;
  if (normalized.notes.length) {
    await dbg(`[tool-normalize] ${tool}：${normalized.notes.join("；")}`);
  }
  // P-A7 权限矩阵：工具级开关（内置工具兜底，主入口 callMcpTool 已拦一次）
  if (isToolDisabled(tool, getSettings().disabledTools ?? [])) {
    return `⛔ 工具「${tool}」已在权限矩阵中禁用。请改用其它工具，或在「设置 → 权限」中重新启用。`;
  }
  // P-A7 权限矩阵：路径白名单——配置了 allowedPaths 时，文件/命令类工具只能访问白名单目录
  const allowedPaths = getSettings().allowedPaths ?? [];
  if (allowedPaths.length > 0) {
    const p = pathArgOf(args);
    if (p && !isPathAllowed(p, allowedPaths)) {
      return `⛔ 路径「${p}」不在权限白名单内（允许：${allowedPaths.join("、")}）。请使用白名单内的路径。`;
    }
  }
  switch (tool) {
    // ---- 确定性工具集（融合自 DSH 生态：零依赖、不联网、结果可复现）----
    // 统一由一个 case 组分发：这些工具互相独立、无需各自展开分支。
    case "calc":
    case "convert_unit":
    case "time_convert":
    case "csv_query":
    case "json_query":
    case "regex_test":
    case "hash_encode":
    case "stats_describe":
    case "diff_text":
    case "schema_validate": {
      return await runDeterministicTool(tool, args, {
        readTextFile: (p) => invoke<string>("read_file", { path: p }),
      });
    }
    // ---- 内置浏览器（CDP 直连）----
    case "browser_navigate": {
      const url = String(args.url || args.URL || "");
      if (!url) throw new Error("browser_navigate 需要 url 参数");
      return await invoke<string>("browser_navigate", { url });
    }
    case "browser_evaluate": {
      const script = String(args.script || args.expression || "");
      if (!script) throw new Error("browser_evaluate 需要 script 参数");
      return await invoke<string>("browser_evaluate", { script });
    }
    case "browser_screenshot": {
      const path = args.path ? String(args.path) : null;
      return await invoke<string>("browser_screenshot", { path });
    }
    case "browser_click": {
      const selector = String(args.selector || "");
      if (!selector) throw new Error("browser_click 需要 selector 参数");
      return await invoke<string>("browser_click", { selector });
    }
    case "browser_fill": {
      const selector = String(args.selector || "");
      const value = String(args.value ?? "");
      if (!selector) throw new Error("browser_fill 需要 selector 参数");
      return await invoke<string>("browser_fill", { selector, value });
    }
    case "browser_close":
      return await invoke<string>("browser_close");
    case "fetch_page": {
      const url = String(args.url || "");
      if (!url) throw new Error("fetch_page 需要 url 参数");
      const res = await invoke<{ title: string; text: string; url: string }>("fetch_page", { url });
      let out = `【${res.title}】\n${res.text.slice(0, 4000)}`;
      // JS 动态渲染/反爬识别：内容过少或命中拦截词时，提示模型改用浏览器自动化（Puppeteer）
      const short = (res.text || "").trim().length < 300;
      const blocked = /安全验证|验证码|captcha|访问验证|请输入验证码|滑动验证|人机验证/i.test(
        `${res.title} ${res.text}`,
      );
      if (short || blocked) {
        out +=
          `\n\n⚠️ 页面内容过少${blocked ? "（疑似被反爬拦截）" : ""}，很可能是 JS 动态渲染、需登录或需等待加载。` +
          `请改用浏览器自动化工具获取动态内容：先调用 puppeteer_navigate 打开该 URL（可传 waitUntil: "networkidle0" 等待渲染完成），` +
          `再用 puppeteer_evaluate 执行 JS 提取页面数据（如 document.body.innerText），或 puppeteer_screenshot 截图分析。不要重复 fetch_page。`;
      }
      return out;
    }
    case "web_search": {
      const query = String(args.query || "");
      if (!query) throw new Error("web_search 需要 query 参数");
      const results = await invoke<{ title: string; url: string; snippet: string }[]>(
        "web_search",
        { query },
      );
      if (!results.length) return "（搜索无结果，请在回复中明确告知用户未找到可靠信息，不要编造）";
      // 搜索引擎摘要常被截断、不含具体信息 → 对最相关的前 2 个结果自动抓取正文片段，
      // 让模型能基于具体内容回答，而不是只罗列链接让用户自己点开。抓取失败/正文过短则跳过。
      const enriched: { title: string; url: string; snippet: string; body?: string }[] =
        await Promise.all(
          results.slice(0, 2).map(async (r) => {
            try {
              const res = await invoke<{ title: string; text: string; url: string }>("fetch_page", {
                url: r.url,
              });
              const text = (res.text || "").replace(/\s+/g, " ").trim();
              if (text.length < 150) return r; // 正文过少（动态渲染/反爬），跳过
              return { ...r, body: text.slice(0, 600) };
            } catch {
              return r;
            }
          }),
        );
      return (
        "以下是搜索结果（对最相关的前几条已自动抓取正文片段，可直接引用其中具体信息作答）。" +
        "**若现有信息仍不足以回答用户问题，对未抓取或信息不足的链接，必须继续用 fetch_page 抓取正文获取具体信息后再作答，严禁只罗列链接让用户自己点开**。" +
        "请整理成清晰的中文回答（先说明找到几条，再逐条列要点+来源，不要原样粘贴）。" +
        "**引用来源时逐字原样复制「链接: 」后的完整 URL，禁止截断路径/删改扩展名/自行拼接或编造链接**：\n\n" +
        enriched
          .map(
            (r, i) =>
              `[${i + 1}] ${r.title}\n    链接: ${r.url}\n    摘要: ${r.snippet}${r.body ? `\n    正文: ${r.body}` : ""}`,
          )
          .join("\n\n")
      );
    }
    case "send_im": {
      // 主动推送消息到飞书/企业微信/钉钉群机器人（只发不收，无代理直连）
      const platform = String(args.platform || "").toLowerCase();
      const text = String(args.text || "");
      if (!text) throw new Error("send_im 需要 text 参数（要推送的内容）");
      const isWecom =
        platform.includes("wecom") || platform.includes("企业") || platform.includes("weixin");
      const isFeishu =
        platform.includes("feishu") || platform.includes("飞书") || platform.includes("lark");
      const isDingtalk =
        platform.includes("dingtalk") || platform.includes("钉钉") || platform.includes("dingding");
      if (!isWecom && !isFeishu && !isDingtalk)
        throw new Error(
          "send_im 需要 platform 参数：feishu（飞书）/ wecom（企业微信）/ dingtalk（钉钉）",
        );
      const cfg = getSettings();
      const plat = isWecom ? "wecom" : isFeishu ? "feishu" : "dingtalk";
      // Webhook 统一从 IM 配置读取（旧版平铺字段仅作过渡期回退）
      const imCfg = (cfg.imConfig || {}) as Record<string, unknown>;
      const legacy = isWecom
        ? cfg.wecomWebhook
        : isFeishu
          ? cfg.feishuWebhook
          : cfg.dingtalkWebhook;
      const webhookKey = isWecom
        ? "wecom_webhook"
        : isFeishu
          ? "feishu_webhook"
          : "dingtalk_webhook";
      const webhook = (imCfg[webhookKey] as string) || legacy || "";
      if (!webhook) {
        throw new Error(
          `未配置${isWecom ? "企业微信" : isFeishu ? "飞书" : "钉钉"} Webhook，请先在「设置 → 即时聊天」中填写群机器人 Webhook 地址。`,
        );
      }
      const secret =
        plat === "dingtalk" ? (imCfg["dingtalk_secret"] as string) || cfg.dingtalkSecret || "" : "";
      const result = await invoke<string>("send_im_message", {
        platform: plat,
        text,
        webhook,
        secret,
      });
      return result;
    }
    case "workflow_list": {
      const list = await invoke<{ id: number; name: string }[]>("workflow_list");
      if (!list.length)
        return "（暂无已保存的工作流。可让用户在可视化工作流编辑器里搭建，或用 workflow_create 直接生成。）";
      return "已保存的工作流：\n" + list.map((w) => `- ${w.name}（id=${w.id}）`).join("\n");
    }
    case "workflow_create": {
      // 让 agent 把多步骤/可复用任务抽象成工作流并保存（引擎校验环/悬空引用/缺配置后落库）
      const name = String(args.name || "").trim();
      if (!name) throw new Error("workflow_create 需要 name 参数（工作流名称）");
      let graph: WorkflowGraph;
      if (typeof args.graph === "string") {
        try {
          graph = JSON.parse(args.graph) as WorkflowGraph;
        } catch {
          throw new Error("graph 必须是合法 JSON");
        }
      } else if (args.graph && typeof args.graph === "object") {
        graph = args.graph as WorkflowGraph;
      } else {
        throw new Error("workflow_create 需要 graph 参数（含 nodes 与 edges 的工作流对象）");
      }
      const verr = validateWorkflowGraph(graph);
      if (verr) throw new Error(`工作流不合法：${verr}`);
      const id = await invoke<number>("workflow_save", { name, graph: JSON.stringify(graph) });
      return `✅ 已保存工作流「${name}」（id=${id}）：${graph.nodes.length} 节点 / ${graph.edges.length} 连线。同类任务之后可用 workflow_run 按名称执行。`;
    }
    case "workflow_run": {
      // 让 agent 按名称/ id 执行已保存工作流（与可视化编辑器一致的运行时：LLM→chat_once、工具→callMcpTool）
      const nameOrId = String(args.name ?? args.id ?? "").trim();
      if (!nameOrId) throw new Error("workflow_run 需要 name 参数（工作流名称或 id）");
      let wf: { id: number; name: string; graph: string } | null = null;
      if (/^\d+$/.test(nameOrId)) {
        wf = await invoke<{ id: number; name: string; graph: string } | null>("workflow_get", {
          id: Number(nameOrId),
        });
      } else {
        const list = await invoke<{ id: number; name: string }[]>("workflow_list");
        const hit = list.find((x) => x.name === nameOrId);
        if (hit)
          wf = await invoke<{ id: number; name: string; graph: string } | null>("workflow_get", {
            id: hit.id,
          });
      }
      if (!wf)
        throw new Error(
          `未找到工作流「${nameOrId}」，可先 workflow_list 查看已有工作流，或 workflow_create 新建`,
        );
      let graph: WorkflowGraph;
      try {
        graph = JSON.parse(wf.graph) as WorkflowGraph;
      } catch {
        throw new Error("工作流数据损坏，无法解析");
      }
      const verr = validateWorkflowGraph(graph);
      if (verr) throw new Error(`工作流「${wf.name}」不合法：${verr}`);
      const external: Record<string, string> = {};
      const input = args.input ?? args.user;
      if (input !== undefined && input !== null && String(input).trim())
        external["user"] = String(input);
      const { useChatStore } = await import("./chat");
      const store = useChatStore();
      const config = store.getAuxConfig();
      if (!config.baseUrl || !config.apiKey)
        throw new Error("未配置 API 地址/Key，无法执行工作流 LLM 节点");
      const startedAt = Date.now();
      // 2026-09-15 修复（AGENT_DIAGNOSIS 问题 5「工作流假成功」）：
      // LLM 节点返回空内容时，过去把占位串「（模型未返回内容）」当正常输出返回，
      // failed 判定又只看日志里有没有 ❌ → 运行记录被标成 success，用户以为成功却没产出。
      // 现在：正文空→退回思考内容（与 WorkflowDialog 行为一致）；仍空则置空输出标记 → 记为失败。
      let emptyLlmOutput = false;
      const res = await executeWorkflow(graph, external, {
        llmCall: async (prompt, opts) => {
          const data = await invoke<{ content?: string; reasoning_content?: string }>(
            "chat_once",
            {
              config: {
                base_url: config.baseUrl,
                api_key: config.apiKey,
                model: opts?.model || config.model,
                max_tokens: config.maxTokens,
                temperature: 0.3,
                thinking_enabled: config.thinkingEnabled ?? false,
                reasoning_effort: config.reasoningEffort ?? "low",
                system_prompt:
                  "你是道生一工作流中的一个处理节点，根据输入上下文直接给出结果。",
                enable_web_search: false,
              },
              messages: [{ role: "user", content: prompt }],
            },
          );
          const body = (data?.content || "").trim();
          if (body) return body;
          // 思考兜底：思考型模型偶尔把结果只写在 reasoning 里
          const think = (data?.reasoning_content || "").trim();
          if (think) {
            dbg("[workflow] LLM 节点正文为空，已退回思考内容作为输出");
            return think;
          }
          emptyLlmOutput = true;
          dbg("[workflow] LLM 节点返回空内容（该次运行将标记为失败）");
          return "（模型未返回内容）";
        },
        toolCall: async (tool, toolArgs) => callMcpTool("app", tool, toolArgs),
      });
      const failed =
        emptyLlmOutput || res.log.some((l) => l.startsWith("❌") || l.includes("执行失败"));
      const traceStr = JSON.stringify(
        (res.trace || []).map((t) => ({ ...t, output: (t.output || "").slice(0, 400) })),
      );
      try {
        const summary =
          (res.outputs.length
            ? res.outputs
                .slice(0, 2)
                .map((o) => `[${o.label}] ${o.value.slice(0, 80)}`)
                .join("；")
            : (res.log[0] || "").slice(0, 160)) || "（无输出）";
        await invoke("workflow_run_add", {
          wfId: wf.id,
          wfName: wf.name,
          status: failed ? "failed" : "success",
          startedAt,
          finishedAt: Date.now(),
          summary: summary.slice(0, 200),
          trace: traceStr,
        });
      } catch {
        /* 记录运行历史失败不影响执行 */
      }
      const logTail = res.log.slice(-10).join("\n");
      const outText = res.outputs.map((o) => `[${o.label}] ${o.value}`).join("\n\n---\n\n");
      return `【工作流「${wf.name}」${failed ? "执行完成（存在失败节点，请查看日志）" : "执行成功"}】\n${logTail}${outText ? `\n\n—— 最终输出 ——\n${outText}` : ""}`;
    }
    case "workflow_improve": {
      // Phase 2：基于该工作流最近运行历史（含失败节点轨迹）让 LLM 产出改进图，校验后保存新版本
      const nameOrId = String(args.name ?? args.id ?? "").trim();
      if (!nameOrId) throw new Error("workflow_improve 需要 name 参数（工作流名称或 id）");
      let wf: { id: number; name: string; graph: string } | null = null;
      if (/^\d+$/.test(nameOrId)) {
        wf = await invoke<{ id: number; name: string; graph: string } | null>("workflow_get", {
          id: Number(nameOrId),
        });
      } else {
        const list = await invoke<{ id: number; name: string }[]>("workflow_list");
        const hit = list.find((x) => x.name === nameOrId);
        if (hit)
          wf = await invoke<{ id: number; name: string; graph: string } | null>("workflow_get", {
            id: hit.id,
          });
      }
      if (!wf) throw new Error(`未找到工作流「${nameOrId}」`);
      let graph: WorkflowGraph;
      try {
        graph = JSON.parse(wf.graph) as WorkflowGraph;
      } catch {
        throw new Error("工作流数据损坏");
      }
      const note = String(args.note ?? "").trim();
      // 读取最近运行历史（含失败轨迹）
      let runsText = "（暂无运行记录）";
      try {
        const runs = await invoke<
          { status: string; started_at: number; summary: string; trace: string }[]
        >("workflow_runs_for", { wfId: wf.id, limit: 6 });
        if (runs.length) {
          runsText = runs
            .map((r) => {
              let line = `- [${r.status}] ${new Date(r.started_at).toLocaleString("zh-CN")} ${(r.summary || "").slice(0, 200)}`;
              if (r.trace) {
                try {
                  const arr = JSON.parse(r.trace) as {
                    nodeId?: string;
                    type?: string;
                    status?: string;
                  }[];
                  const bad = (Array.isArray(arr) ? arr : []).filter(
                    (x) => x.status === "error" || x.status === "skipped",
                  );
                  if (bad.length)
                    line += ` | 问题节点：${bad.map((x) => `${x.nodeId}(${x.type}:${x.status})`).join(", ")}`;
                } catch {
                  /* 轨迹解析失败忽略 */
                }
              }
              return line;
            })
            .join("\n");
        }
      } catch {
        /* 读历史失败不影响优化 */
      }
      const { useChatStore } = await import("./chat");
      const store = useChatStore();
      const config = store.getRoutedAuxConfig("coding");
      if (!config.baseUrl || !config.apiKey) throw new Error("未配置 API 地址/Key，无法优化工作流");
      const prompt =
        "你是「道生一」的工作流优化器。请基于最近几次运行记录改进下面的工作流（有向无环图）。\n" +
        `【当前工作流 JSON】\n${JSON.stringify(graph)}\n\n` +
        `【最近运行记录】\n${runsText}\n\n` +
        (note ? `【用户改进诉求】\n${note}\n\n` : "") +
        "要求：\n" +
        "1. 节点类型 text/llm/tool/condition/code/end；节点 id 用小写字母数字（如 n1、n2）；上游输出用 {{节点id}} 引用；LLM 节点提示词与 tool 节点参数可含 {{上游id}}。\n" +
        "2. 针对失败/被跳过的节点修复：工具反复失败就换工具或改参数、加条件分支容错；LLM 输出不稳就拆细节点或给更明确提示词。\n" +
        "3. 不要为改而改：若最近运行全部成功且无明显问题，或你判断无法可靠改进，就原样返回当前 JSON。\n" +
        "4. **只输出改进后的工作流 JSON**（不要 markdown 代码块、不要解释、不要注释）。";
      const data = await invoke<{ content?: string }>("chat_once", {
        config: {
          base_url: config.baseUrl,
          api_key: config.apiKey,
          model: config.model,
          max_tokens: 6000,
          temperature: 0.2,
          thinking_enabled: false,
          reasoning_effort: "low",
          system_prompt: "你是严谨的工程 Agent。只按用户要求输出合法 JSON，不要附加任何说明。",
          enable_web_search: false,
        },
        messages: [{ role: "user", content: prompt }],
      });
      const raw = (data?.content || "").trim();
      let improved: WorkflowGraph;
      try {
        improved = JSON.parse(extractJsonBlock(raw)) as WorkflowGraph;
      } catch {
        throw new Error("模型未返回合法 JSON，未做改动：\n" + raw.slice(0, 300));
      }
      const verr = validateWorkflowGraph(improved);
      if (verr) throw new Error(`改进后的工作流不合法（未保存）：${verr}`);
      if (JSON.stringify(improved) === JSON.stringify(graph)) {
        return `【工作流优化】「${wf.name}」无需改动（模型判定当前版本已合适或运行正常）。`;
      }
      const newId = await invoke<number>("workflow_save", {
        name: wf.name,
        graph: JSON.stringify(improved),
      });
      const oldLabels = new Set(graph.nodes.map((n) => n.label));
      const newLabels = new Set(improved.nodes.map((n) => n.label));
      const added = improved.nodes
        .filter((n) => !oldLabels.has(n.label))
        .map((n) => `${n.type}「${n.label}」`);
      const removed = graph.nodes
        .filter((n) => !newLabels.has(n.label))
        .map((n) => `${n.type}「${n.label}」`);
      try {
        const summary = `自优化：${graph.nodes.length}→${improved.nodes.length} 节点${added.length ? `；新增 ${added.slice(0, 4).join("、")}` : ""}${removed.length ? `；移除 ${removed.slice(0, 4).join("、")}` : ""}`;
        await invoke("workflow_run_add", {
          wfId: newId,
          wfName: wf.name,
          status: "improved",
          startedAt: Date.now(),
          finishedAt: Date.now(),
          summary: summary.slice(0, 200),
          trace: "",
        });
      } catch {
        /* 记录失败不影响 */
      }
      const diff: string[] = [];
      if (added.length) diff.push(`新增节点：${added.slice(0, 6).join("、")}`);
      if (removed.length) diff.push(`移除节点：${removed.slice(0, 6).join("、")}`);
      if (!diff.length) diff.push("结构未变（连线/参数级调整）");
      return `【工作流优化】「${wf.name}」已保存新版本（${graph.nodes.length} → ${improved.nodes.length} 节点）：\n- ${diff.join("\n- ")}\n建议用 workflow_run 运行一次验证效果。`;
    }
    case "workflow_suggest": {
      // Phase 3：按任务文本在已保存工作流中做相关度建议（关键词打分，供复用/沉淀判断）
      const task = String(args.task || args.query || "").trim();
      if (!task) throw new Error("workflow_suggest 需要 task 参数（要匹配的任务描述）");
      const list = await invoke<{ id: number; name: string; graph: string }[]>("workflow_list");
      if (!list.length) return "（暂无已保存的工作流，可用 workflow_create 抽象沉淀首个流程）";
      const scored = list
        .map((w) => {
          let g: WorkflowGraph | null = null;
          try {
            g = JSON.parse(w.graph) as WorkflowGraph;
          } catch {
            /* 忽略坏数据 */
          }
          return { w, g, score: g ? scoreTaskAgainstWorkflow(g, task) : 0 };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(Number(args.limit ?? 3) || 3, 5));
      if (!scored.length)
        return "（未找到与当前任务相关的工作流——若是全新且以后会重复的流程，可 workflow_create 抽象后 workflow_remember 记住）";
      return (
        "可按需复用的相关工作流（相关度从高到低）：\n" +
        scored
          .map((s, i) => {
            const labels = (s.g?.nodes || []).map((n) => n.label).filter(Boolean);
            const chain = labels.slice(0, 6).join(" → ");
            return `${i + 1}. ${s.w.name}（id=${s.w.id}，相关度 ${(s.score * 100).toFixed(0)}%）${chain ? `\n   流程：${chain}${labels.length > 6 ? " …" : ""}` : ""}`;
          })
          .join("\n")
      );
    }
    case "workflow_remember": {
      // Phase 3：把「某类任务 → 已沉淀工作流」沉淀为记忆（type=workflow，跨会话自动注入）
      const taskType = String(args.task_type ?? args.taskType ?? "").trim();
      const workflowName = String(args.workflow_name ?? args.workflowName ?? "").trim();
      if (!taskType || !workflowName)
        throw new Error(
          "workflow_remember 需要 task_type（任务类型描述）与 workflow_name（工作流名）",
        );
      const list = await invoke<{ id: number; name: string }[]>("workflow_list");
      const hit = list.find((w) => w.name === workflowName);
      if (!hit) throw new Error(`工作流「${workflowName}」不存在，先用 workflow_create 创建再记住`);
      const fact = `任务类型「${taskType}」可复用已沉淀工作流「${workflowName}」（id=${hit.id}），同类任务直接用 workflow_run 执行`;
      const row = {
        id: uuidv4(),
        conversation_id: null,
        fact,
        fact_type: "workflow",
        importance: 6,
        access_count: 0,
        last_accessed: null,
        created_at: Date.now(),
      };
      const res = await invoke<string>("save_fact", { fact: row });
      return res.startsWith("merged:")
        ? `✅ 已更新处理模式记忆（并入已有条目）。以后遇到「${taskType}」类任务会自动想起工作流「${workflowName}」。`
        : `✅ 已记住处理模式：${taskType} → 工作流「${workflowName}」。以后同类任务会自动想起，直接 workflow_run 复用。`;
    }
    case "list_mcp_resources": {
      // 融合 Codex 的 list_mcp_resources / list_mcp_resource_templates：
      // MCP 资源是插件的一等公民（文件、schema、日志…），以前只能调工具、读不到资源。
      const server = String(args.server ?? "").trim();
      if (!server) throw new Error("list_mcp_resources 需要 server 参数（MCP 服务器名）");
      await ensureMcpServerConnected(server);
      try {
        const data = await invoke<{ resources?: unknown; templates?: unknown }>(
          "mcp_list_resources",
          { server },
        );
        return formatMcpResources(server, data);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `（服务器「${server}」未提供资源列表：${msg}）——这不影响用 callMcpTool 调用它的**工具**；若该插件确实应提供资源，请提醒用户确认插件已连接。`;
      }
    }
    case "read_mcp_resource": {
      const server = String(args.server ?? "").trim();
      const uri = String(args.uri ?? "").trim();
      if (!server || !uri) throw new Error("read_mcp_resource 需要 server 与 uri 参数");
      await ensureMcpServerConnected(server);
      try {
        const data = await invoke<unknown>("mcp_read_resource", { server, uri });
        const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
        return text.length > 20000 ? `${text.slice(0, 20000)}\n\n…（内容过长已截断，共 ${text.length} 字符）` : text;
      } catch (e: unknown) {
        return `读取资源失败：${e instanceof Error ? e.message : String(e)}`;
      }
    }
    case "request_user_input": {
      // 融合 Codex 的 request_user_input：长任务中途向用户提问并等回答（不结束回合）
      const question = String(args.question ?? args.prompt ?? "").trim();
      if (!question) throw new Error("request_user_input 需要 question 参数（要问用户的问题）");
      const choices = Array.isArray(args.choices)
        ? (args.choices as unknown[]).map((c) => String(c)).filter(Boolean).slice(0, 6)
        : undefined;
      const answer = await requestAskInput({
        question,
        context: args.context ? String(args.context) : undefined,
        placeholder: args.placeholder ? String(args.placeholder) : undefined,
        defaultValue: args.default ? String(args.default) : undefined,
        choices,
      });
      if (answer === null) {
        return "（用户跳过了这个问题）——请基于现有信息做合理假设继续推进，并在最终回复里**明确标注你的假设**；不要反复追问同一个问题。";
      }
      return `用户回答：${answer}`;
    }
    case "request_permissions": {
      // 融合 Codex 的 request_permissions：让模型**主动申请**会话级授权，而不是撞上弹窗才问。
      // 授权仅在本会话内有效（不落盘）；execpolicy 的 deny 规则任何情况下不可绕过。
      const cap = String(args.capability ?? args.cap ?? "").trim();
      const known = new Set([
        "run_command",
        "replace_string",
        "insert_string",
        "delete_file",
        "apply_patch",
      ]);
      if (!cap) {
        return `需要 capability 参数，可选：${[...known].join(" / ")}`;
      }
      if (!known.has(cap)) {
        return `未知授权项「${cap}」；可选：${[...known].join(" / ")}`;
      }
      if (hasSessionPermit(cap)) {
        return `（本会话已获得「${cap}」授权，无需重复申请）`;
      }
      const reason = args.reason ? String(args.reason) : "";
      const label: Record<string, string> = {
        run_command: "执行命令行（含危险命令不再逐条确认）",
        replace_string: "精确修改文件",
        insert_string: "向文件插入内容",
        delete_file: "删除文件",
        apply_patch: "批量应用补丁（多文件修改）",
      };
      const ok = await askConfirm(
        `⚙️ Agent 申请**本会话内**授权：${label[cap]}\n\n理由：${reason || "（未说明）"}\n\n同意后本会话不再逐次弹确认（仅本会话有效，重启即失效；命令执行策略里的 deny 规则仍不可绕过）。同意吗？`,
      );
      if (!ok) return "（用户拒绝了本次授权申请）——请改用更安全的方式，或逐次请求确认。";
      rememberSessionPermit(cap);
      return `✅ 已获得本会话「${cap}」授权：${label[cap]}（后续同类操作不再弹确认）。`;
    }
    case "get_context_remaining": {
      // 融合 Codex 的 get_context_remaining：报告上下文占用/剩余，让模型自己把握收尾时机
      const cfg = useChatStore().currentConfig;
      const window = modelContextWindowTokens(cfg.baseUrl || "", cfg.model);
      const conv = useChatStore().activeConversation;
      const maxCtx = cfg.maxContextMessages || 50;
      const hist = (conv?.messages ?? [])
        .filter((m) => m.role !== "system" && !m.streaming)
        .slice(-maxCtx);
      const est = hist.reduce(
        (s, m) => s + estimateMessageTokens(m.content || "", m.reasoning_content),
        0,
      );
      const used = Math.max(lastPromptTokens, est);
      const remain = Math.max(0, window - used);
      const pct = Math.min(100, Math.round((used / window) * 1000) / 10);
      const advice =
        pct >= 85
          ? "⚠️ 已接近上限：请立刻收尾——先给用户**当前阶段的结论与产物路径**，把未完成部分写进文件或待办，必要时用 new_context_window 压缩历史或建议用户开新对话。"
          : pct >= 60
            ? "已过半：不要让工具输出继续堆积，长内容写文件、只回填摘要，尽快推进到收尾。"
            : "预算充足，可继续正常工作。";
      return (
        `上下文占用：约 ${used.toLocaleString()} / ${window.toLocaleString()} tokens（${pct}%），剩余约 ${remain.toLocaleString()} tokens。\n` +
        `口径：上轮请求真实 prompt tokens（${lastPromptTokens.toLocaleString()}）与本地估算（${est.toLocaleString()}）取大者；窗口按模型推断。\n` +
        `本次将发送 ${hist.length} 条历史消息（上限 ${maxCtx} 条）。\n建议：${advice}`
      );
    }
    case "get_goal": {
      // 吸收自 Codex ext/goal：让模型看到**跨回合**的当前目标与预算（防跑题/防忘）
      const goal = getGoal(useChatStore().activeConversationId || "");
      if (!goal) {
        return "（当前会话没有目标。如用户明确要求「完成某件可验收的事」且需要跨多轮推进，可用 create_goal 登记；普通任务不要建目标。）";
      }
      return `【当前目标｜${goal.status}】${goal.objective}\n${budgetLine(goal)}${goal.note ? `\n备注：${goal.note}` : ""}${budgetExceeded(goal) ? "\n⚠️ 预算已用尽：立即收尾（给结论与产物路径，剩余工作写文件/待办）。" : ""}`;
    }
    case "create_goal": {
      // 对齐 Codex：仅当用户/系统**显式要求**时创建；已有未完成目标时拒绝（改用 update_goal）
      const objective = String(args.objective ?? "").trim();
      if (!objective) throw new Error("create_goal 需要 objective 参数（可验收的目标描述）");
      const convId = useChatStore().activeConversationId || "";
      if (!convId) return "（当前没有活动会话，无法登记目标）";
      const cur = getGoal(convId);
      if (isUnfinished(cur)) {
        return `已有未完成目标（${cur!.status}）：「${cur!.objective}」。**不能重复创建**——要改状态请用 update_goal（complete/blocked/abandoned）；确实要换目标先把它置为 abandoned。`;
      }
      const budgetRaw = Number(args.token_budget ?? args.tokenBudget ?? 0);
      const tokenBudget = Number.isFinite(budgetRaw) && budgetRaw > 0 ? Math.round(budgetRaw) : null;
      const now = Date.now();
      const goal: Goal = {
        objective,
        status: "active",
        tokenBudget,
        tokensUsed: 0,
        createdAt: now,
        updatedAt: now,
      };
      saveGoal(convId, goal);
      return (
        `✅ 已登记目标：「${objective}」\n${budgetLine(goal)}\n` +
        "此后每轮都会把该目标注入上下文；你应持续推进直到达成，达成后调用 update_goal(status=\"complete\")。" +
        (tokenBudget === null ? "（未设预算：如需限定消耗，可在创建时给 token_budget）" : "")
      );
    }
    case "update_goal": {
      const convId = useChatStore().activeConversationId || "";
      const goal = getGoal(convId);
      if (!goal) return "（当前会话没有目标可更新）";
      const raw = String(args.status ?? "").trim() as GoalStatus;
      const statuses: GoalStatus[] = ["active", "complete", "blocked", "abandoned"];
      if (raw && !statuses.includes(raw)) {
        return `未知状态「${raw}」；可用：${statuses.join(" / ")}`;
      }
      const next: Goal = {
        ...goal,
        status: raw || goal.status,
        note: args.note ? String(args.note).slice(0, 300) : goal.note,
        updatedAt: Date.now(),
      };
      saveGoal(convId, next);
      return `已更新目标状态：${goal.status} → ${next.status}\n${budgetLine(next)}${next.note ? `\n备注：${next.note}` : ""}`;
    }
    case "new_context_window": {
      // 融合 Codex 的 new_context_window：把较早历史压缩成 handoff 摘要后继续。
      // 只影响「发给模型的历史」，界面仍完整保留原始消息。
      const store = useChatStore();
      const conv = store.activeConversation;
      if (!conv) return "（当前没有活动会话，无法压缩）";
      const keep = Math.min(Math.max(Number(args.keep_last_messages ?? 6) || 6, 2), 20);
      try {
        const r = await compressConversation(store, conv, keep);
        if (!r.ok) {
          return `（未压缩：${r.reason}）当前上下文占用约 ${lastPromptTokens.toLocaleString()} tokens；历史 ${conv.messages.length} 条。`;
        }
        return (
          `✅ 已压缩 ${r.compressed} 条历史为交接摘要（${r.chars} 字），后续请求只发送【摘要 + 最近 ${keep} 条消息】。\n` +
          "界面仍完整保留原始消息；需要中间细节时请从已落盘的工具输出/产物文件读取。"
        );
      } catch (e: unknown) {
        return `（压缩失败：${e instanceof Error ? e.message : String(e)}）`;
      }
    }
    case "tool_search": {
      // 融合 Codex 的 tool_search：BM25 检索工具目录，命中未声明的工具则**立即激活**
      // （推入注册表 tools/byName → 同一数组引用，下一轮请求模型就能直接调用）。
      const query = String(args.query ?? args.q ?? "").trim();
      if (!query) throw new Error("tool_search 需要 query 参数（要查找的能力/工具描述）");
      const limit = Math.min(Math.max(Number(args.limit ?? 8) || 8, 1), 20);
      // 文本工具模式（未启用原生）时也尽量可用：临时用「内置 + 当前 MCP 缓存」建一份目录，
      // 只告诉模型真实名字与服务器（无法动态激活）。
      const reg =
        activeToolRegistry ??
        buildNativeToolRegistry({
          builtins: BUILTIN_TOOLS.map((t) => ({ name: t.name, desc: t.desc })),
          mcp: mcpToolsCache.map((t) => ({
            server: t.server,
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            kind: "mcp" as const,
          })),
        });
      const index = ensureToolSearchIndex(reg);
      const hits = index.search(query, limit);
      if (hits.length === 0) {
        return `未找到与「${query}」匹配的工具。可换更通用的说法再试（如「数据库」「网页」「发消息」「日历」）；若确信该能力应由插件提供，请提醒用户到「插件」面板确认插件已连接。`;
      }
      const entryByName = new Map(reg.catalog.map((c) => [c.name, c]));
      const activated: string[] = [];
      const lines: string[] = [];
      for (const hit of hits) {
        const e = entryByName.get(hit.id);
        if (!e) continue;
        if (e.deferred && activateCatalogTool(reg, e.name)) activated.push(e.name);
        const desc = e.description.length > 200 ? `${e.description.slice(0, 200)}…` : e.description;
        lines.push(
          `- **${e.name}**（${e.kind === "mcp" ? `MCP「${e.server}」` : "内置"}）：${desc}`,
        );
      }
      const head =
        activated.length > 0
          ? `✅ 已激活 ${activated.length} 个工具（**下一轮即可直接调用**）：${activated.join("、")}`
          : "（命中的工具均已在你的可用列表中）";
      return `${head}\n\n检索「${query}」命中 ${lines.length} 个：\n${lines.join("\n")}`;
    }
    case "run_command": {
      // 模型可调命令：与 /run 同款 execpolicy / 危险审批门禁；结果以字符串返回给模型
      const command = String(args.command ?? args.cmd ?? "").trim();
      if (!command) throw new Error("run_command 需要 command 参数（要执行的 shell 命令）");
      const { useChatStore } = await import("./chat");
      return useChatStore().agentRunCommand(command);
    }
    case "exec_command": {
      // 融合 Codex 的 exec_command：PTY 启动 + 可续写（交互式 / 长驻进程）
      const command = String(args.command ?? args.cmd ?? "").trim();
      if (!command) throw new Error("exec_command 需要 command 参数（要执行的 shell 命令）");
      const cwd = args.cwd ? String(args.cwd) : "";
      const yieldMs = Number(args.yield_time_ms ?? args.yieldTimeMs ?? 1000);
      const { useChatStore } = await import("./chat");
      return useChatStore().agentExecCommand(command, cwd, yieldMs);
    }
    case "write_stdin": {
      // 融合 Codex 的 write_stdin：向运行中的会话写输入 / 取回新增输出
      const id = Number(args.session_id ?? args.sessionId ?? args.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new Error("write_stdin 需要 session_id 参数（exec_command 返回的会话号）");
      }
      const input = String(args.input ?? args.chars ?? "");
      const yieldMs = Number(args.yield_time_ms ?? args.yieldTimeMs ?? 1000);
      const { useChatStore } = await import("./chat");
      return useChatStore().agentWriteStdin(id, input, yieldMs);
    }
    case "describe_image": {
      const path = String(args.path || "");
      if (!path) throw new Error("describe_image 需要 path 参数（本地图片文件路径）");
      const desc = await invoke<string>("ollama_describe_image", { images: [`file://${path}`] });
      return desc || "（本地视觉模型无法识别该图片）";
    }
    case "ocr_image": {
      const path = String(args.path || "");
      if (!path) throw new Error("ocr_image 需要 path 参数（本地图片文件路径）");
      const ocr = await invoke<string>("ocr_image_file", { path });
      if (!ocr) return "（未识别到文字）";
      // 读到长数字串时顺手要求交叉验证：位数错一位，整份结论就错（真实踩过）
      const hint = ocrCrossCheckHint(ocr, path);
      return hint ? `${ocr}\n\n${hint}` : ocr;
    }
    case "image_inspect": {
      // 确定性像素核验：数字符个数 / 字形空洞 / 点阵 —— 补 OCR 在等宽数字串上漏读前导零的短板
      const path = String(args.path || "");
      if (!path) throw new Error("image_inspect 需要 path 参数（图片文件路径）");
      const region = (args.region ?? {}) as Record<string, unknown>;
      const num = (v: unknown): number | undefined => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.floor(n) : undefined;
      };
      const hasRegion =
        args.region != null && ["left", "top", "width", "height"].every((k) => region[k] != null);
      return await invoke<string>("image_inspect", {
        path,
        region: hasRegion
          ? {
              left: num(region.left) ?? 0,
              top: num(region.top) ?? 0,
              width: num(region.width) ?? 0,
              height: num(region.height) ?? 0,
            }
          : null,
        threshold: num(args.threshold) ?? null,
        invert: args.invert === true,
        mode: typeof args.mode === "string" ? args.mode : null,
        ascii_width: num(args.ascii_width) ?? null,
        max_glyphs: num(args.max_glyphs) ?? null,
        min_glyph_width: num(args.min_glyph_width) ?? null,
        max_gap: num(args.max_gap) ?? null,
      });
    }
    // ---- 融合 Codex 的工具（openai/codex，其工具形态经大量用户检验）----
    case "apply_patch": {
      // Codex 的 apply_patch：一次调用完成多文件/多片段编辑（GPT-5 专门训练过该格式）。
      // 这里解析成既有的 apply_edits 操作，从而复用 diff 预览、用户确认（P-A4）、撤销快照。
      const patch = String(args.patch ?? args.input ?? "");
      if (!patch.trim()) {
        throw new Error(
          "apply_patch 需要 patch 参数（Codex 格式补丁文本：*** Begin Patch / *** Update File: <path> / @@ / -旧行 +新行 / *** End Patch）",
        );
      }
      let parsed: ReturnType<typeof parseCodexPatch>;
      try {
        parsed = parseCodexPatch(patch);
      } catch (e) {
        return `⚠️ 补丁解析失败（未改动任何文件）：${e instanceof Error ? e.message : String(e)}`;
      }
      // 预校验：先确认所有路径状态正确，避免「改到一半才发现路径不对」
      for (const f of parsed.files) {
        const exists = await invoke<boolean>("file_exists", { path: f.path });
        if (f.op === "add" && exists) {
          return `⚠️ *** Add File 的目标已存在：${f.path}（为避免误覆盖，本次未执行任何改动；要改内容请用 *** Update File）`;
        }
        if (f.op !== "add" && !exists) {
          return `⚠️ *** ${f.op === "delete" ? "Delete" : "Update"} File 的文件不存在：${f.path}（本次未执行任何改动）`;
        }
      }
      const out: string[] = [];
      for (const f of parsed.files) {
        if (f.op === "add") {
          const real = await invoke<string>("write_file_agent", {
            path: f.path,
            content: f.content ?? "",
          });
          notifyUndoChanged();
          out.push(`✅ 新增文件 ${real}`);
          continue;
        }
        if (f.op === "delete") {
          const del = await invoke<string>("delete_file_agent", { path: f.path });
          notifyUndoChanged();
          out.push(`✅ ${del}`);
          continue;
        }
        const edits = hunksToEdits(f.hunks);
        // 与 replace_string 相同的人工确认路径（开启「文件编辑需确认」时逐文件预览 diff）
        if (getSettings().fileEditConfirm && !hasSessionPermit("apply_patch")) {
          const preview = await invoke<{ diff: string; summary: string }>("apply_edits", {
            path: f.path,
            edits,
            preview: true,
          });
          const ok = await requestEditConfirm({
            kind: "edit",
            path: f.path,
            diff: preview.diff,
            summary: preview.summary,
            edits,
            tool: "apply_patch",
            args: { path: f.path, edits },
            rememberLabel: "本会话内不再询问 apply_patch",
          });
          if (!ok) {
            out.push(`⚠️ 用户拒绝了 ${f.path} 的修改（该文件未改动）`);
            break; // 用户已拒绝：不再继续后续文件，避免连环打扰
          }
        }
        const res = await invoke<{ path: string; summary: string }>("apply_edits", {
          path: f.path,
          edits,
          preview: false,
        });
        notifyUndoChanged();
        out.push(`✅ ${res.path}（${f.hunks.length} 处片段）`);
      }
      const warn = parsed.warnings.length > 0 ? `\n\n注意：\n- ${parsed.warnings.join("\n- ")}` : "";
      return `已应用补丁：${summarizePatch(parsed)}\n${out.join("\n")}${warn}`;
    }
    case "current_time": {
      // 融合自 Codex 的 current_time：模型自行取时间，避免凭训练数据猜日期/星期
      const now = new Date();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "未知时区";
      const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];
      const offsetMin = -now.getTimezoneOffset();
      const sign = offsetMin >= 0 ? "+" : "-";
      const abs = Math.abs(offsetMin);
      const off = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
      return [
        `现在时间：${now.toLocaleString("zh-CN", { hour12: false })}（${week}）`,
        `ISO 8601：${now.toISOString()}`,
        `时区：${tz}（${off}）`,
      ].join("\n");
    }
    case "sleep": {
      // 融合自 Codex 的 sleep：等待外部进程/服务就绪（有上限，避免把 agent 循环卡死）
      const seconds = Math.min(Math.max(Number(args.seconds ?? 1) || 0, 0), 60);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      return `已等待 ${seconds} 秒`;
    }
    case "view_image": {
      // 融合自 Codex 的 view_image：把图片**直接放进模型上下文**（视觉模型原生看图），
      // 而不是只依赖本地视觉模型的文字描述（描述可能失真/幻觉，见浏览器指引里的教训）。
      const path = String(args.path || "");
      if (!path) throw new Error("view_image 需要 path 参数（本地图片文件路径）");
      const store = useChatStore();
      const cfg = store.currentConfig;
      const isDeepSeek = ((cfg?.baseUrl || "") + (cfg?.model || "")).toLowerCase().includes("deepseek");
      if (!isDeepSeek) {
        const dataUrl = await invoke<string>("read_image_data_url", { path });
        pendingViewImages.push(dataUrl);
        return `✅ 已把图片加入上下文（${path}）：你将在**下一轮**直接看到该图，无需再调用 describe_image/ocr_image 猜内容。`;
      }
      // 非多模态模型（DeepSeek 等）看不到图：优先用**已配置的云端视觉档**（非 DeepSeek 且有 Key）——快且准
      const vision = store.profiles.find((p) => p.apiKey && !p.baseUrl.includes("deepseek"));
      if (vision) {
        try {
          const dataUrl = await invoke<string>("read_image_data_url", { path });
          const desc = await Promise.race([
            (async () => {
              const resp = await fetch(`${vision.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${vision.apiKey}`,
                },
                body: JSON.stringify({
                  model: vision.model,
                  messages: [
                    {
                      role: "user",
                      content: [
                        {
                          type: "text",
                          text: "请描述这张图片的内容。如果图片中有文字，请逐字转录。用中文，简洁准确。",
                        },
                        { type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
                      ],
                    },
                  ],
                  max_tokens: 500,
                }),
              });
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const data = await resp.json();
              return String(data?.choices?.[0]?.message?.content || "");
            })(),
            new Promise<string>((_, rej) =>
              setTimeout(() => rej(new Error("云端视觉模型 60 秒超时")), 60000),
            ),
          ]);
          if (desc) return `（当前模型不支持图片输入，以下为 ${vision.model} 的识图结果）\n${desc}`;
        } catch (e) {
          console.warn("[道生一] view_image 云端识图失败，改用替代方案提示:", e);
        }
      }
      // 兜底：**快速失败**并给出可执行的替代方案。
      // 实测（本机 Intel 无 GPU）：本地 llava-phi3 处理 1440×900 截图需 >70 秒，且输出常与图无关（幻觉）。
      // 绝不能静默阻塞整个回合——把选择权交回模型（要文字就 OCR，要画面才付时间成本）。
      return (
        `⚠️ 当前模型（${cfg?.model || "未知"}）不支持图片输入，无法直接看图。可用替代方案（按推荐顺序）：\n` +
        `1. ocr_image（path=${path}）：macOS 原生 OCR，秒级返回，读截图里的文字最可靠；\n` +
        `2. browser_evaluate：读 document.body.innerText，核验页面文本内容；\n` +
        `3. describe_image（path=${path}）：本地视觉模型，**实测 30–120 秒**且可能描述失真/幻觉，确需画面描述时才用。\n` +
        `图片已保存：${path}（用户可自行查看）。不要凭猜测断言渲染是否正常。`
      );
    }
    case "subagent_delegate": {
      const goal = String(args.goal || "");
      if (!goal) throw new Error("subagent_delegate 需要 goal 参数");
      const context = String(args.context || "");
      // P-M1：子代理默认可调用内置工具（allow_tools=false 可关，纯对话子代理）
      const allowTools = args.allow_tools !== false;
      // P-M3：可选角色（planner/executor/verifier/reviewer/researcher）→ 角色提示 + 工具集约束
      const roleId = args.role ? String(args.role) : undefined;
      if (roleId && !getRoleById(roleId)) {
        throw new Error(
          `未知角色: ${roleId}（可选 planner/executor/verifier/reviewer/researcher）`,
        );
      }
      const allowedTools = roleId ? roleAllowedToolNames(roleId) : undefined;
      // 动态获取 chat store，避免模块循环依赖；子代理用独立上下文跑工具循环
      const { useChatStore } = await import("./chat");
      const store = useChatStore();
      // P-A12 多模型路由：编程类子代理走 coding 路由（配置了专门的编程模型则用之，否则辅助/主模型）
      const config = store.getRoutedAuxConfig("coding");
      if (!config.baseUrl || !config.apiKey)
        throw new Error("请先配置 API 地址和 Key 再委派子代理");
      // 登记子代理记录（可视化面板实时显示；带角色则前缀标注）
      const rec = store.spawnSubagent(`${roleId ? `[${getRoleById(roleId)!.name}] ` : ""}${goal}`);
      const sys = buildSubagentSysPrompt(context, allowTools, roleId);
      let finalText = "";
      try {
        finalText = await runSubagentLoop(config, withMathRule(withCurrentDate(sys)), goal, {
          allowTools,
          ...(allowedTools ? { allowedTools } : {}),
        });
        store.completeSubagent(rec.id, finalText);
      } catch (e) {
        if (e instanceof AgentStoppedError) {
          // 用户点停止：优雅标记子代理已停止，不再向主代理抛错（主代理工具循环会自行 break）
          store.failSubagent(rec.id, "已由用户停止");
          return "（子代理已由用户停止，不再继续）";
        }
        store.failSubagent(rec.id, e instanceof Error ? e.message : String(e));
        throw e;
      }
      // 子代理若也返回工具调用 JSON，则剥离展示
      const visible =
        finalText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim() || "（子代理未返回内容）";
      return `【子代理结论】\n${visible}`;
    }
    case "subagent_parallel": {
      // P-M2：并行子代理——多个 runSubagentLoop 并发执行（信号量并发池，等价 Promise.all）。
      // 主代理把任务分解为多个相互独立的子任务后并行收集结果；每个子任务登记独立的
      // SubagentRecord（可视化面板同时显示各子代理进度）。并发浏览器操作由 withBrowserLock
      // 自动串行，避免单一浏览器实例互相干扰。
      // P-M3：每个任务可指定 role（角色提示 + 工具集约束）；P-M4：synth=true 时并行完成后
      // 用评审角色做汇总仲裁（冲突消解/交叉验证/统一呈现）。
      const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
      const tasks: {
        idx: number;
        goal: string;
        context: string;
        allowTools: boolean;
        role?: string;
        allowedTools?: string[];
      }[] = rawTasks
        .map((t, i) => {
          const o = (t ?? {}) as Record<string, unknown>;
          const role = o.role ? String(o.role) : undefined;
          if (role && !getRoleById(role)) {
            throw new Error(
              `未知角色: ${role}（可选 planner/executor/verifier/reviewer/researcher）`,
            );
          }
          return {
            idx: i,
            goal: String(o.goal ?? o.task ?? "").trim(),
            context: String(o.context ?? ""),
            allowTools: o.allow_tools !== false,
            role,
            ...(role ? { allowedTools: roleAllowedToolNames(role) } : {}),
          };
        })
        .filter((t) => t.goal);
      if (!tasks.length) {
        throw new Error(
          "subagent_parallel 需要 tasks 参数（子任务数组 [{goal, context?, allow_tools?, role?}]，至少 1 项）",
        );
      }
      const concurrency = Math.max(
        1,
        Math.min(4, Number(args.concurrency ?? tasks.length) || tasks.length),
      );
      const { useChatStore } = await import("./chat");
      const store = useChatStore();
      // P-A12 多模型路由：编程类子代理走 coding 路由
      const config = store.getRoutedAuxConfig("coding");
      if (!config.baseUrl || !config.apiKey)
        throw new Error("请先配置 API 地址和 Key 再并行委派子代理");

      // 信号量并发池：最多 concurrency 个 worker 从共享任务队列取任务并行执行
      const results: { idx: number; ok: boolean; goal: string; text: string }[] = [];
      let cursor = 0;
      const workerCount = Math.min(concurrency, tasks.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < tasks.length) {
          const task = tasks[cursor++];
          const rec = store.spawnSubagent(
            `${task.role ? `[${getRoleById(task.role)!.name}] ` : ""}${task.goal}`,
          );
          const sys = buildSubagentSysPrompt(task.context, task.allowTools, task.role);
          try {
            const text = await runSubagentLoop(
              config,
              withMathRule(withCurrentDate(sys)),
              task.goal,
              {
                allowTools: task.allowTools,
                ...(task.allowedTools ? { allowedTools: task.allowedTools } : {}),
              },
            );
            store.completeSubagent(rec.id, text);
            results.push({ idx: task.idx, ok: true, goal: task.goal, text });
          } catch (e) {
            if (e instanceof AgentStoppedError) {
              store.failSubagent(rec.id, "已由用户停止");
              results.push({
                idx: task.idx,
                ok: false,
                goal: task.goal,
                text: "（子代理已由用户停止）",
              });
            } else {
              const msg = e instanceof Error ? e.message : String(e);
              store.failSubagent(rec.id, msg);
              results.push({
                idx: task.idx,
                ok: false,
                goal: task.goal,
                text: `（子代理失败: ${msg}）`,
              });
            }
          }
        }
      });
      await Promise.all(workers);

      // P-M4：synth=true → 用评审角色把各子任务结果做汇总仲裁（冲突消解、交叉验证、统一呈现）
      if (args.synth === true) {
        const synthRec = store.spawnSubagent("汇总仲裁各子任务结果");
        try {
          const sorted = [...results].sort((a, b) => a.idx - b.idx);
          const findings = sorted
            .map(
              (r, i) =>
                `### 子任务 ${i + 1}：${r.goal}\n${r.ok ? "✅ 完成" : "❌ 失败"}\n\n${r.text}`,
            )
            .join("\n\n");
          // 评审角色提示（含角色指令 + 允许工具列表）作为仲裁者基础系统提示，
          // 与 allowedTools 执行侧约束配套（提示词展示 + 执行兜底双保险）
          const sys = buildSubagentSysPrompt("", true, "reviewer");
          const synthPrompt =
            withCurrentDate(
              "你是道生一的**汇总仲裁者**，负责把多个子代理的结果整合成一份统一、自洽的最终结论。\n" +
                "要求：\n" +
                "1. **汇总**：归纳各子任务要点，去重、归类；\n" +
                "2. **冲突消解**：不同子任务结论冲突时，明确指出冲突点、评估各方证据/可信度、给出你的判定与理由；\n" +
                "3. **交叉验证**：相互印证的信息标注为一致，互相矛盾的信息说明取舍依据；\n" +
                "4. **统一呈现**：结构化输出——最终结论 / 要点 / 遗留问题 / 建议。",
            ) +
            "\n\n---\n\n" +
            sys +
            `\n\n以下是各子任务的结果（可能相互独立或冲突）：\n\n${findings}\n\n请给出汇总仲裁结论。`;
          const synthText = await runSubagentLoop(config, withMathRule(synthPrompt), "汇总仲裁", {
            allowTools: true,
            maxRounds: 6,
            allowedTools: roleAllowedToolNames("reviewer"),
          });
          store.completeSubagent(synthRec.id, synthText);
          const visible =
            synthText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim() ||
            "（仲裁未返回内容）";
          return `【并行子代理汇总仲裁】\n${visible}`;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          store.failSubagent(synthRec.id, msg);
          // 仲裁失败回退普通汇总
          return (
            formatParallelResults(results, workerCount) +
            `\n\n> ⚠️ 汇总仲裁失败（${msg}），以上为原始汇总。`
          );
        }
      }

      // 按原始任务顺序汇总（不依赖完成顺序，输出稳定）
      return formatParallelResults(results, workerCount);
    }
    case "pdf_read": {
      const path = String(args.path || "");
      if (!path) throw new Error("pdf_read 需要 path 参数");
      const offset = Number(args.offset || 0);
      const length = Number(args.length || 4000);
      const text = await invoke<string>("read_pdf_part", { path, offset, length });
      return text || "（该段落无文本，可能已到文件末尾）";
    }
    case "write_file": {
      const path = String(args.path || "");
      const content = String(args.content ?? "");
      if (!path) throw new Error("write_file 需要 path 参数");
      if (!content) throw new Error("write_file 需要 content 参数");
      // 由应用自身写盘并校验真实存在，返回真实绝对路径
      const real = await invoke<string>("write_file_agent", { path, content });
      notifyUndoChanged(); // 可撤销（编辑覆盖/新建）
      return real;
    }
    case "log_decision": {
      // P1-7 决策日志：把「做了什么决定、为什么、排除了什么」写进项目 DECISIONS.md
      // 幂等：同一标题原地更新，不会堆重复条目（由 utils/decision-log.ts 保证）
      const title = String(args.title ?? "").trim();
      const decision = String(args.decision ?? "").trim();
      const rationale = String(args.rationale ?? "").trim();
      if (!title) throw new Error("log_decision 需要 title 参数（一句话标题）");
      if (!decision) throw new Error("log_decision 需要 decision 参数（决定了什么）");
      if (!rationale)
        throw new Error("log_decision 需要 rationale 参数（为什么）——没有理由的决策不值得记录");
      // 目标目录：显式 dir → 工作区目录；都没有则落到产物目录，避免污染主目录根
      const explicitDir = String(args.dir ?? "").trim();
      const workspaceDir = String(getSettings().workspace ?? "").trim();
      const targetDir = explicitDir || workspaceDir || "~/Documents/道生一产物";
      const path = decisionPath(targetDir);
      let existing = "";
      try {
        existing = await invoke<string>("read_file", { path });
      } catch {
        existing = ""; // 首次记录（文件不存在）
      }
      const merged = mergeDecision(existing, {
        at: Date.now(),
        title,
        decision,
        rationale,
        alternatives: Array.isArray(args.alternatives)
          ? args.alternatives.map((x) => String(x))
          : undefined,
        files: Array.isArray(args.files) ? args.files.map((x) => String(x)) : undefined,
        session: useChatStore().activeConversationId ?? undefined,
      });
      const real = await invoke<string>("write_file_agent", { path, content: merged });
      notifyUndoChanged();
      const total = countDecisions(merged);
      return `📌 已记录决策（${total} 条总计）：${oneLine(title)}\n文件：${real}`;
    }
    case "replace_string": {
      // 精确编辑：替换文件中一段文本（occurrence 指定第几次出现，默认第 1 次），返回 unified diff
      const path = String(args.path || "");
      // P1-2：模型常把锚点前缀一起抄进 old_text → 先剔除（否则永远匹配不上）
      const rawOld = String(args.old_text ?? args.old ?? "");
      const oldText = hasAnchorPrefix(rawOld) ? stripAnchorPrefix(rawOld) : rawOld;
      const newText = String(args.new_text ?? args.new ?? "");
      if (!path) throw new Error("replace_string 需要 path 参数");
      if (!oldText) throw new Error("replace_string 需要 old_text 参数（要替换的原文）");
      // P1-2 哈希锚定：带锚点时先校验「文件没被改过」，并用锚点给 old_text 消歧
      let occurrence = args.occurrence ? Number(args.occurrence) : undefined;
      const anchorStr = args.line_anchor ?? args.anchor_line_only ?? "";
      const anchor =
        parseAnchor(anchorStr) ??
        (Number(args.anchor_line) > 0 && args.anchor_hash
          ? { line: Number(args.anchor_line), hash: String(args.anchor_hash).toLowerCase() }
          : null);
      if (anchor) {
        const fileText = await invoke<string>("read_file", { path });
        const lines = toLines(fileText);
        const verdict = verifyAnchor(lines, anchor);
        if (!verdict.ok) {
          // 拒绝执行（不猜、不自动改位置）：把精确原因交回模型重试
          return `⛔ ${verdict.message}`;
        }
        const idx = occurrenceForAnchor(lines, verdict.line - 1, oldText);
        if (idx && idx !== occurrence) {
          dbg(`[anchor] 锚点第 ${verdict.line} 行 → old_text 第 ${idx} 次出现（原 occurrence=${occurrence ?? 1}）`);
          occurrence = idx;
        } else if (!idx && !occurrence) {
          return (
            `⛔ 锚点有效（第 ${verdict.line} 行 #${hashLine(lines[verdict.line - 1])}），但 old_text 在当前文件中不存在——` +
            "请核对 old_text 是否与文件内容完全一致（含缩进），或用 with_anchors 重新读取后再改。"
          );
        }
      }
      const edits: Record<string, unknown>[] = [
        {
          op: "replace",
          old: oldText,
          new: newText,
          ...(occurrence ? { occurrence } : {}),
        },
      ];
      // P-A4：开启「文件编辑需确认」时先预览 diff，用户确认后才写盘（会话内已允许则直接放行）
      if (getSettings().fileEditConfirm && !hasSessionPermit("replace_string")) {
        const preview = await invoke<{
          path: string;
          diff: string;
          new_len: number;
          summary: string;
        }>("apply_edits", { path, edits, preview: true });
        const ok = await requestEditConfirm({
          kind: "edit",
          path,
          diff: preview.diff,
          summary: preview.summary,
          edits,
          tool: "replace_string",
          args: { ...args },
          rememberLabel: "本会话内不再询问 replace_string",
        });
        if (!ok)
          return `⚠️ 用户拒绝了本次文件编辑（${path}），文件未改动。请与用户确认后再尝试，或改用其它方式。`;
      }
      const res = await invoke<{ path: string; diff: string; new_len: number; summary: string }>(
        "apply_edits",
        { path, edits, preview: false },
      );
      notifyUndoChanged(); // 可撤销（编辑）
      return res.summary;
    }
    case "insert_string": {
      // 精确编辑：在锚点文本前（before，默认）或后（after）插入一段文本，返回 unified diff
      const path = String(args.path || "");
      const anchor = String(args.anchor || "");
      const text = String(args.new_text ?? args.text ?? "");
      if (!path) throw new Error("insert_string 需要 path 参数");
      if (!anchor) throw new Error("insert_string 需要 anchor 参数（插入位置的锚点文本）");
      if (!text) throw new Error("insert_string 需要 new_text 参数（要插入的内容）");
      // P1-2：给文本锚点加一道「行锚点」校验——锚点出现在多处/内容已变时先拦下
      const lineAnchor = parseAnchor(args.line_anchor ?? "");
      if (lineAnchor) {
        const fileText = await invoke<string>("read_file", { path });
        const lines = toLines(fileText);
        const verdict = verifyAnchor(lines, lineAnchor);
        if (!verdict.ok) return `⛔ ${verdict.message}`;
      }
      const position = String(args.position || "before");
      const edits: Record<string, unknown>[] = [{ op: "insert", anchor, position, text }];
      // P-A4：开启「文件编辑需确认」时先预览 diff，用户确认后才写盘（会话内已允许则直接放行）
      if (getSettings().fileEditConfirm && !hasSessionPermit("insert_string")) {
        const preview = await invoke<{
          path: string;
          diff: string;
          new_len: number;
          summary: string;
        }>("apply_edits", { path, edits, preview: true });
        const ok = await requestEditConfirm({
          kind: "edit",
          path,
          diff: preview.diff,
          summary: preview.summary,
          edits,
          tool: "insert_string",
          args: { ...args },
          rememberLabel: "本会话内不再询问 insert_string",
        });
        if (!ok)
          return `⚠️ 用户拒绝了本次文件编辑（${path}），文件未改动。请与用户确认后再尝试，或改用其它方式。`;
      }
      const res = await invoke<{ path: string; diff: string; new_len: number; summary: string }>(
        "apply_edits",
        { path, edits, preview: false },
      );
      notifyUndoChanged(); // 可撤销（编辑）
      return res.summary;
    }
    case "create_file": {
      // 新建文件：仅当目标文件不存在时创建（避免误覆盖），成功后返回真实路径
      const path = String(args.path || "");
      const content = String(args.content ?? "");
      if (!path) throw new Error("create_file 需要 path 参数");
      if (!content) throw new Error("create_file 需要 content 参数");
      const exists = await invoke<boolean>("file_exists", { path });
      if (exists) {
        return `⚠️ 文件已存在（${path}），为避免误覆盖未创建。若要修改请用 replace_string / insert_string 精确编辑，或先 delete_file 再重建。`;
      }
      const real = await invoke<string>("write_file_agent", { path, content });
      notifyUndoChanged(); // 可撤销（新建）
      return real;
    }
    case "delete_file": {
      // 删除文件（仅主目录内文件，不删除目录）
      // P0-4b：实际是**移入回收站**（保留 30 天、可 trash_restore 还原），不是永久抹除。
      const path = String(args.path || "");
      if (!path) throw new Error("delete_file 需要 path 参数");
      // P-A4：开启「文件编辑需确认」时先确认路径，用户确认后才删除（会话内已允许则直接放行）
      if (getSettings().fileEditConfirm && !hasSessionPermit("delete_file")) {
        const ok = await requestEditConfirm({
          kind: "delete",
          path,
          tool: "delete_file",
          args: { ...args },
          rememberLabel: "本会话内不再询问 delete_file",
        });
        if (!ok) return `⚠️ 用户拒绝了删除文件（${path}），文件未删除。`;
      }
      const del = await invoke<string>("delete_file_agent", { path });
      notifyUndoChanged(); // 可撤销（删除）
      return del;
    }
    case "trash_list": {
      // P0-4b 回收站：列出可恢复的删除（供用户找回文件）
      const rows = await invoke<
        { id: string; name: string; original: string; size: number; deleted_at: number }[]
      >("trash_list");
      const limit = Number(args.limit) > 0 ? Number(args.limit) : 20;
      if (!rows.length) return "回收站是空的（没有可恢复的删除）。";
      const lines = rows.slice(0, limit).map((r) => {
        const when = new Date(r.deleted_at * 1000).toLocaleString();
        const size = r.size >= 1048576
          ? `${(r.size / 1048576).toFixed(1)} MB`
          : `${Math.max(1, Math.round(r.size / 1024))} KB`;
        return `- ${r.name}｜${size}｜${when}\n  原位置：${r.original || "（记录缺失，只能手动取出）"}\n  条目 ID：${r.id}`;
      });
      return `回收站共 ${rows.length} 项（显示 ${Math.min(rows.length, limit)} 项，按删除时间倒序）：\n${lines.join(
        "\n",
      )}\n\n还原用 trash_restore（id 填「条目 ID」）。`;
    }
    case "trash_restore": {
      // P0-4b：还原到原位置（目标已存在时拒绝覆盖）
      const id = String(args.id || args.entry_id || "");
      if (!id) throw new Error("trash_restore 需要 id 参数（条目 ID，可从 trash_list 获取）");
      const msg = await invoke<string>("trash_restore", { id });
      notifyUndoChanged();
      return msg;
    }
    case "trash_empty": {      // P0-4b：清空回收站（永久删除，不可恢复）——先确认，避免误清
      const ok = await askConfirm(
        "⚠️ 清空回收站会**永久删除**里面所有文件（无法恢复）。确定继续吗？",
      );
      if (!ok) return "用户取消了清空回收站，回收站内容未变动。";
      const n = await invoke<number>("trash_empty");
      notifyUndoChanged();
      return `已清空回收站（永久删除 ${n} 个文件）。`;
    }
    case "plan_task": {
      // P-A5 Plan 模式：创建/替换当前任务计划（对话区顶部进度卡片实时更新）
      const chat = useChatStore();
      const title = String(args.title || args.task || "任务计划");
      const rawSteps = Array.isArray(args.steps) ? args.steps.map((s) => String(s)) : [];
      if (!rawSteps.length)
        throw new Error("plan_task 需要 steps 参数（子任务字符串数组，至少 1 项）");
      const plan: TaskPlan = {
        id: uuidv4(),
        title,
        steps: rawSteps.map((t) => ({ text: t, status: "pending" as const })),
        createdAt: Date.now(),
      };
      planRealWork = false; // 新计划刚建立，尚未执行任何实际操作
      resetPlanHealth(); // 新计划：清空上一计划的步骤健康状态
      chat.setTaskPlan(plan);
      return (
        "✅ 已创建任务计划「" +
        title +
        "」，进度卡片已显示，共 " +
        plan.steps.length +
        " 步：\n" +
        plan.steps.map((s, i) => `${i + 1}. [待办] ${s.text}`).join("\n") +
        "\n执行规范：每步开始前用 plan_update 标记 doing，完成后标记 done，失败标记 failed（可调整计划）；全部步骤完成后在正文给出完整最终回答。任务模式下：请立即开始执行，不要停下来征求确认（应用层权限确认除外），自主把整条链路跑完。"
      );
    }
    case "plan_update": {
      // P-A5 Plan 模式：更新某一步骤的进度状态（doing/done/failed）
      const chat = useChatStore();
      const plan = chat.taskPlan;
      if (!plan) throw new Error("plan_update 需要先创建任务计划（先调用 plan_task）");
      const stepIdx = Math.max(0, (Number(args.step ?? args.index ?? 0) || 1) - 1);
      const status = String(args.status || "done");
      if (!plan.steps[stepIdx]) {
        throw new Error(`plan_update 步骤序号超出范围（当前共 ${plan.steps.length} 步）`);
      }
      if (!["pending", "doing", "done", "failed", "terminated"].includes(status)) {
        throw new Error("plan_update 的 status 必须是 pending/doing/done/failed");
      }
      // P-A5 防假完成：本计划还没执行任何**实际操作**（planRealWork=false），就标记任何
      // 步骤完成 = 假装完成（用户看到“卡片一出来就全 done”）。必须先真正调用实际工具
      // 干活（或先标 doing 表示开始执行）——完成该步后（或已做过实际工作后）才能标 done。
      // 注意这里不区分当前 pending/doing：模型先 doing 再 done、但全程没真干活的绕过同样拦截。
      if (status === "done" && !planRealWork) {
        throw new Error(
          `plan_update 想把第 ${stepIdx + 1} 步「${plan.steps[stepIdx].text}」标记完成，` +
            "但本计划还没有执行任何实际操作（不能“没干活就标完成”）。\n" +
            "请先真正执行该步骤：开始时用 plan_update 把该步标记为 doing，调用实际工具" +
            "（如 list_dir/read_file/write_file/run_command/web_search 等）完成对应工作后，" +
            "再把它标记为 done。",
        );
      }
      // P-A6 步骤健康护栏：该步工具**全部执行失败**（成功 0 次）却要标 done → 拒绝，
      // 防「工具失败后把步骤标完成」的假完成（例如验证截图没做成仍宣称该步完成）
      if (status === "done" && stepToolsAllFailed(stepIdx)) {
        throw new Error(
          `plan_update 想把第 ${stepIdx + 1} 步「${plan.steps[stepIdx].text}」标记完成，` +
            "但该步骤调用的工具全部执行失败（成功 0 次），说明工作并未真正完成，不能标 done。\n" +
            "请先用 plan_update 把该步标回 doing，修正参数/换用正确工具真正执行成功后，再把它标为 done" +
            "（提示：本地页面渲染验证用浏览器自动化 puppeteer_* 打开后 puppeteer_screenshot 截图；" +
            "读取本地文件用 read_file；fetch_page 只能抓取 http(s) 网页）。若该步确实无法完成，请标 failed 并说明原因。",
        );
      }
      // 执行窗口：doing = 开始记录该步内工具成败；done/failed = 退出该步窗口（清计数）
      if (status === "doing") {
        beginStepHealth(stepIdx);
      } else if (status === "done" || status === "failed") {
        endStepHealth(stepIdx);
      }
      plan.steps[stepIdx].status = status as PlanStepStatus;
      chat.setTaskPlan({ ...plan }); // 触发响应式更新
      const done = plan.steps.filter((s) => s.status === "done").length;
      const label: Record<string, string> = {
        pending: "待办",
        doing: "进行中",
        done: "已完成",
        failed: "失败",
      };
      return (
        `📋 计划进度更新：步骤 ${stepIdx + 1}「${plan.steps[stepIdx].text.slice(0, 30)}」→ ${label[status] || status}` +
        `（${done}/${plan.steps.length} 完成）`
      );
    }
    case "session_spawn": {
      return await toolSessionSpawn(args);
    }
    case "session_status": {
      const id = String(args.session_id ?? "");
      if (!id) throw new Error("session_status 需要 session_id 参数（session_spawn 返回的 id）");
      return await toolSessionStatus(id);
    }
    case "session_resume": {
      const id = String(args.session_id ?? "");
      if (!id) throw new Error("session_resume 需要 session_id 参数（session_spawn 返回的 id）");
      return await toolSessionResume(id);
    }
    case "list_agents": {
      return await toolListAgents();
    }
    case "interrupt_agent": {
      const id = String(args.session_id ?? args.id ?? "");
      if (!id) throw new Error("interrupt_agent 需要 session_id 参数");
      return await toolInterruptAgent(id, args.reason ? String(args.reason) : "");
    }
    case "list_dir":
    case "list_directory": {
      // list_directory 是 filesystem MCP 风格名：模型常按提示词用它调内置列目录，
      // 这里作为 list_dir 的兼容别名（同一实现）。
      const path = String(args.path || "");
      if (!path) throw new Error("list_dir 需要 path 参数");
      // Rust read_file：传入目录时返回格式化字符串（以「【目录】」开头，含 📁/📄 图标）；
      // 传入文件时返回文件文本内容。list_dir 需要的是目录列表 → 直接原样返回 Rust 结果。
      const res = await invoke<string>("read_file", { path });
      if (typeof res === "string") {
        // 兼容旧协议：若未来 Rust 返回结构化数组字符串（JSON），此处统一按字符串展示
        return res.startsWith("【目录】") || res === "（空目录）"
          ? res
          : `（${path} 不是目录，或读取失败：${res.slice(0, 200)}）`;
      }
      // 兼容：若返回结构化数组（旧协议）则格式化
      if (Array.isArray(res)) {
        const arr = res as unknown as { dir: boolean; path: string; name: string; size?: number }[];
        return (
          `目录 ${path} 内容（${arr.length} 项）：\n` +
          arr
            .map((r) =>
              r.dir
                ? `📁 ${r.name}/`
                : `📄 ${r.name}${r.size !== undefined ? ` (${r.size} 字节)` : ""}`,
            )
            .join("\n")
        );
      }
      return `（${path} 读取失败）`;
    }
    case "read_file": {
      // 读取单个文本文件（filesystem MCP 风格名兼容；复用 Rust read_file，P-A8 沙箱生效）
      const path = String(args.path || args.file || "");
      if (!path) throw new Error("read_file 需要 path 参数");
      const res = await invoke<string>("read_file", { path });
      if (typeof res !== "string" || res.startsWith("【目录】") || res === "（空目录）") {
        return `（${path} 是目录，请用 list_dir/list_directory 查看目录内容）`;
      }
      if (!res) return `📄 ${path}（空文件，0 字节）`;
      // 分段读取：schema 早就声明了 offset/length，但过去实现里被**静默忽略**
      // （只做 slice(0,12000)），模型只能改用 awk/sed 绕 —— 真实使用暴露的缺陷。
      // 现在真按行号取段，且越界/截断都明确说出来，不假装「读到了」。
      const slice = sliceFileLines(res, {
        offset: args.offset ?? args.start_line ?? args.from_line,
        length: args.length ?? args.lines,
      });
      if (slice.outOfRange) return slice.note;
      const scope = isWholeFile(slice)
        ? `共 ${slice.totalLines} 行`
        : `第 ${slice.startLine}–${slice.endLine} 行 / 共 ${slice.totalLines} 行`;
      const tail = slice.note ? `\n${slice.note}` : "";
      // P1-2：可选行锚点输出（`行号#哈希| 内容`）——行号必须是**文件真实行号**，
      // 否则分段读出的锚点会指向错误位置（比没锚点更危险）
      const wantAnchors = args.with_anchors === true || args.anchors === true;
      if (wantAnchors) {
        return (
          `📄 ${path}（带行锚点，${scope}）${tail}\n\n\`\`\`\n${annotateLines(slice.text, slice.startLine)}\n\`\`\`\n\n` +
          `锚点格式：\`行号#哈希| 内容\`。改文件时把要改的那一行写成 \`"anchor_line": 行号, "anchor_hash": "哈希"\`（内容不要抄源锚点前缀）——` +
          `若文件已被改动，replace_string 会**拒绝执行**并告知新行号（比默默改错位置安全）。`
        );
      }
      return `📄 ${path}（${scope}）${tail}\n\n\`\`\`\n${slice.text}\n\`\`\``;
    }
    case "read_multiple_files": {
      // 批量读取多个文件（filesystem MCP 风格名兼容；参数 paths 数组或 path 单个）
      const paths = Array.isArray(args.paths)
        ? args.paths.map(String)
        : Array.isArray(args.files)
          ? args.files.map(String)
          : args.path
            ? [String(args.path)]
            : [];
      if (!paths.length) throw new Error("read_multiple_files 需要 paths 数组参数");
      const parts: string[] = [];
      for (const p of paths) {
        try {
          const res = await invoke<string>("read_file", { path: p });
          parts.push(
            typeof res !== "string" || res.startsWith("【目录】") || res === "（空目录）"
              ? `（${p} 是目录）`
              : `📄 ${p}\n\`\`\`\n${res.slice(0, 8000)}\n\`\`\``,
          );
        } catch (e: unknown) {
          parts.push(`📄 ${p}\n❌ 读取失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return parts.join("\n\n---\n\n");
    }
    case "memory_save": {
      // 主动记忆：Agent 记住用户明确给出的重要信息/偏好/决策/待办（跨会话生效）
      const fact = String(args.fact || args.content || "").trim();
      if (!fact) throw new Error("memory_save 需要 fact 参数（要记住的内容）");
      const factType = String(args.fact_type || args.type || "info").trim();
      const importance = Math.max(1, Math.min(10, Number(args.importance ?? 5) || 5));
      const row = {
        id: uuidv4(),
        conversation_id: null,
        fact,
        fact_type: factType,
        importance,
        access_count: 0,
        last_accessed: null,
        created_at: Date.now(),
      };
      const res = await invoke<string>("save_fact", { fact: row });
      return res.startsWith("merged:")
        ? `✅ 已把这条信息并入已有记忆（${factType}，重要度 ${importance}）。以后跨会话对话我会记得。`
        : `✅ 已记住：${fact}（${factType}，重要度 ${importance}）。以后跨会话对话我会记得。`;
    }
    case "memory_recall": {
      // 主动回忆：按关键词检索长期记忆（跨会话），供 Agent 需要时查证历史事实
      const query = String(args.query || args.q || "").trim();
      if (!query) throw new Error("memory_recall 需要 query 参数（要回忆的关键词）");
      const limit = Math.max(1, Math.min(20, Number(args.limit ?? 5) || 5));
      const facts = await invoke<
        { id: string; fact: string; fact_type: string; importance: number; access_count: number }[]
      >("search_facts", { query, limit });
      if (!facts.length) return "（未找到相关记忆）";
      const labels: Record<string, string> = {
        preference: "偏好",
        info: "信息",
        decision: "决策",
        todo: "待办",
      };
      return (
        "相关记忆：\n" +
        facts
          .map(
            (f, i) =>
              `${i + 1}. [${labels[f.fact_type] || f.fact_type}] ${f.fact}（重要度 ${f.importance}）`,
          )
          .join("\n")
      );
    }
    case "memory_forget": {
      // 主动遗忘：用户要求删除某条记忆时，按内容关键词检索并删除
      const query = String(args.query || args.fact || "").trim();
      if (!query) throw new Error("memory_forget 需要 query 参数（要遗忘的记忆关键词）");
      const facts = await invoke<{ id: string; fact: string; fact_type: string }[]>(
        "search_facts",
        { query, limit: 5 },
      );
      if (!facts.length) return "（未找到需要遗忘的相关记忆）";
      const deleted: string[] = [];
      for (const f of facts) {
        await invoke("delete_fact_cmd", { id: f.id }).catch(() => {});
        deleted.push(f.fact);
      }
      return (
        `✅ 已遗忘 ${deleted.length} 条记忆：\n` +
        deleted.map((d, i) => `${i + 1}. ${d}`).join("\n")
      );
    }
    case "git": {
      // Git 操作（编程 Agent）：在指定仓库目录执行 git 子命令
      const cwd = String(args.cwd || args.path || args.dir || "").trim();
      const action = String(args.action || args.subcommand || "").trim();
      const gitArgs = Array.isArray(args.args) ? args.args.map(String) : [];
      if (!cwd) throw new Error("git 需要 cwd 参数（仓库目录绝对路径）");
      if (!action)
        throw new Error(
          "git 需要 action 参数（如 status / diff / log / commit / push / pull / add / checkout / branch）",
        );
      const res = await invoke<{
        stdout: string;
        stderr: string;
        exit_code: number;
        timed_out: boolean;
      }>("git_operation", {
        cwd,
        action,
        args: gitArgs,
        timeoutSecs: 60,
      });
      const out = res.stdout || res.stderr || "";
      const head = out.length > 6000 ? out.slice(0, 6000) + "\n…（输出过长已截断）" : out;
      const status =
        res.exit_code === 0 ? "" : `\n（退出码 ${res.exit_code}${res.timed_out ? "，超时" : ""}）`;
      return `git ${action} ${gitArgs.join(" ")}\n${head}${status}`;
    }
    case "run_tests": {
      // 验证循环：在项目目录自动检测并运行测试，返回结构化结果供迭代修复
      const cwd = String(args.cwd || args.path || args.dir || "").trim();
      if (!cwd) throw new Error("run_tests 需要 cwd 参数（项目目录绝对路径）");
      const command = String(args.command || "").trim() || undefined;
      const testArgs = Array.isArray(args.args) ? args.args.map(String) : [];
      const res = await invoke<{
        framework: string;
        command: string;
        stdout: string;
        stderr: string;
        exit_code: number;
        timed_out: boolean;
      }>("run_tests", {
        cwd,
        command: command ?? null,
        args: testArgs,
        timeoutSecs: 300,
      });
      const out = (res.stdout || res.stderr || "").trim();
      const head = out.length > 6000 ? out.slice(0, 6000) + "\n…（输出过长已截断）" : out;
      const pass = res.exit_code === 0;
      // P0-5 验证凭据：run_tests 是「测试通过」断言最直接的凭据来源
      noteVerification(classifyVerificationCommand(res.command) ?? "test", pass, res.command);
      // 结构化返回：明确成功/失败 + 失败摘要，供 Agent 判断并迭代修复
      const failLines = res.stdout
        .split("\n")
        .filter((l) => /FAILED|failed|✗|Error|error:|panicked/i.test(l))
        .slice(0, 15)
        .join("\n");
      return `【测试结果】框架=${res.framework} 命令=${res.command} 状态=${pass ? "✅ 通过" : "❌ 失败"}（退出码 ${res.exit_code}${res.timed_out ? "，超时" : ""}）\n${head}${!pass && failLines ? `\n\n失败项/错误：\n${failLines}` : ""}`;
    }
    case "analyze_project": {
      // 代码库理解：扫描项目结构，识别技术栈/清单脚本/源码分布
      const path = String(args.path || args.cwd || args.dir || "").trim();
      if (!path) throw new Error("analyze_project 需要 path 参数（项目目录绝对路径）");
      const a = await invoke<{
        root: string;
        stack: string;
        manifest_hint: string;
        top_level: string[];
        by_ext: string[];
        source_files: number;
      }>("analyze_project", { root: path });
      return (
        `【项目分析】${a.root}\n` +
        `- 技术栈: ${a.stack || "未知"}\n` +
        (a.manifest_hint ? `- ${a.manifest_hint}\n` : "") +
        `- 源码文件: ${a.source_files} 个（${a.by_ext.join(", ")}）\n` +
        `- 顶层结构:\n${a.top_level.map((x) => `  ${x}`).join("\n")}`
      );
    }
    case "kb_index": {
      // Phase 3 知识库 RAG：把本地目录索引成知识库（重建式）
      const kbName = String(args.kb_name || "").trim();
      const path = String(args.path || "");
      if (!kbName) throw new Error("kb_index 需要 kb_name 参数（知识库名）");
      if (!path) throw new Error("kb_index 需要 path 参数（目录绝对路径）");
      return await invoke<string>("kb_index", { kbName, path });
    }
    case "kb_search": {
      // Phase 3 知识库 RAG：检索已索引知识库
      const kbName = String(args.kb_name || "").trim();
      const query = String(args.query || "").trim();
      if (!kbName) throw new Error("kb_search 需要 kb_name 参数（知识库名）");
      if (!query) throw new Error("kb_search 需要 query 参数（检索词）");
      const limit = args.limit ? Number(args.limit) : null;
      const hits = await invoke<
        {
          id: number;
          kb_name: string;
          file: string;
          chunk: string;
          chunk_idx: number;
          created_at: number;
        }[]
      >("kb_search", { kbName, query, limit });
      if (!hits.length)
        return `（知识库「${kbName}」未检索到与「${query}」相关的内容，可换关键词或先 kb_index 索引目录）`;
      const out = hits
        .map((h, i) => `[${i + 1}] ${h.file}#${h.chunk_idx}\n${h.chunk.slice(0, 500)}`)
        .join("\n\n");
      return `【知识库「${kbName}」检索「${query}」】命中 ${hits.length} 条：\n\n${out}`;
    }
    case "kb_list": {
      // Phase 3 知识库 RAG：列出已建知识库（含空库）
      const list = await invoke<{ name: string; chunks: number }[]>("kb_list");
      if (!list.length)
        return "（尚未建立知识库，可用 kb_create 创建命名知识库或 kb_index 索引本地目录）";
      return "已建立知识库：\n" + list.map((k) => `- ${k.name}（${k.chunks} 分块）`).join("\n");
    }
    case "kb_create": {
      // 创建命名知识库（空库注册，之后可 kb_add 录入 / kb_index 索引）
      const kbName = String(args.kb_name || "").trim();
      if (!kbName) throw new Error("kb_create 需要 kb_name 参数（知识库名）");
      return await invoke<string>("kb_create", { kbName });
    }
    case "kb_add": {
      // 向知识库录入一段文本/文档（自动分块 + FTS 索引 + 可选语义向量）
      const kbName = String(args.kb_name || "").trim();
      const source = String(args.source || "").trim();
      const text = String(args.text || "").trim();
      if (!kbName) throw new Error("kb_add 需要 kb_name 参数（知识库名）");
      if (!text) throw new Error("kb_add 需要 text 参数（要录入的文本/文档内容）");
      return await invoke<string>("kb_add", { kbName, source, text });
    }
    case "code_index": {
      // P-A3 项目语义索引：扫描项目代码文件并向量化（自然语言找代码的地基，重建式）
      const root = String(args.root || args.path || "").trim();
      if (!root) throw new Error("code_index 需要 root 参数（项目目录绝对路径）");
      return await invoke<string>("code_index", { rootPath: root });
    }
    case "code_search": {
      // P-A3 自然语言找代码：语义检索已索引项目的代码分块
      const root = String(args.root || args.path || "").trim();
      const query = String(args.query || "").trim();
      if (!root) throw new Error("code_search 需要 root 参数（项目目录绝对路径）");
      if (!query)
        throw new Error(
          "code_search 需要 query 参数（自然语言描述要查的代码，如「处理用户登录」）",
        );
      const limit = args.limit ? Number(args.limit) : null;
      const hits = await invoke<
        {
          id: number;
          root: string;
          file: string;
          chunk: string;
          chunk_idx: number;
          created_at: number;
          start_line: number;
        }[]
      >("code_search", { rootPath: root, query, limit });
      if (!hits.length)
        return `（项目「${root}」未检索到与「${query}」相关的代码。若尚未索引，先调 code_index 索引该项目；也可换更贴近代码语义的描述）`;
      // 符号跳转：命中结果带 `文件:行号`（可点击打开文件并定位到该行）
      const out = hits
        .map(
          (h, i) =>
            `[${i + 1}] ${h.file}:${h.start_line || 1}\n\`\`\`\n${h.chunk.slice(0, 600)}\n\`\`\``,
        )
        .join("\n\n");
      return `【项目「${root}」语义检索「${query}」】相关代码 ${hits.length} 处（按相似度）：\n\n${out}`;
    }
    case "code_roots": {
      // P-A3 列出已索引项目
      const roots = await invoke<string[]>("code_roots");
      if (!roots.length) return "（尚未索引任何项目，可用 code_index 索引项目目录）";
      return "已索引的项目：\n" + roots.map((r) => `- ${r}`).join("\n");
    }
    case "code_stats": {
      // P-A3 查看项目索引统计
      const root = String(args.root || args.path || "").trim();
      if (!root) throw new Error("code_stats 需要 root 参数（项目目录绝对路径）");
      const [files, chunks] = await invoke<[number, number]>("code_stats", { rootPath: root });
      return `项目「${root}」语义索引：${files} 个文件 / ${chunks} 个分块`;
    }
    case "code_delete": {
      // P-A3 删除某项目语义索引
      const root = String(args.root || args.path || "").trim();
      if (!root) throw new Error("code_delete 需要 root 参数（项目目录绝对路径）");
      return await invoke<string>("code_delete", { rootPath: root });
    }
    default:
      throw new Error(`未知内置工具: ${tool}`);
  }
}

/** 在系统提示开头注入当前日期，避免模型日期幻觉。
 *  注意用"天"粒度而非分钟：分钟级时间每次提问都会变，会打断 DeepSeek 前缀缓存
 *  导致命中率趋近 0；精确时间由调用方放进"本次补充上下文"（最新用户消息）里。 */
function withCurrentDate(sp: string): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const weekday = now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", weekday: "long" });
  return (
    `【系统当前日期】今天是 ${y}年${m}月${d}日 ${weekday}（${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}）。\n` +
    `这是唯一可信的日期来源。回答任何涉及日期/时间的问题前，请先核对上面的日期；严禁使用或编造训练数据中的日期（你的训练数据已过时）。\n\n` +
    sp
  );
}

/// 数学公式书写规范：注入系统提示，从源头减少模型输出的残缺/裸公式等格式问题
/// 注意：避免在规范中显式提及易被模型模仿的字符（如 >），防止提示词反向诱导
const MATH_FORMAT_RULE = `【数学公式书写规范】回复含数学公式时，务必遵守：
1. 所有数学公式（含单个字母变量）必须用美元符成对包裹：行内公式用一个美元符包住，独立公式用两个美元符换行包裹。例如"设 G 是有限群"应写为"设 $G$ 是有限群"。
2. 美元符必须成对且正确闭合，不要把公式与中文文字混在同一个美元符对里，公式前后可留空格。
3. 公式直接写在正文中即可，无需任何额外的引用或装饰符号包裹。
4. 使用 LaTeX 语法：幂用 ^（如 $n=a^2+b^2+c^2+d^2$）、乘法用 \\cdot（如 $|G|=|H|\\cdot[G:H]$）、分数用 \\frac、根号用 \\sqrt。`;

function withMathRule(sp: string): string {
  return `${sp}\n\n${MATH_FORMAT_RULE}`;
}

/// 原生 function calling 的系统提示覆盖说明：当 tools 走 API（tool_choice=auto）时，
/// 提示词里「唯一方式是输出 <tool_call> JSON」的文本引导已不适用 → 追加覆盖说明，
/// 让模型改用原生结构化 tool_calls（文本解析仍作为兜底保留）。主代理与子代理共用。
const NATIVE_TOOLS_NOTE =
  "\n\n## 原生工具调用（本会话生效，覆盖上文文本标记说明）\n" +
  "本会话通过 **原生 function calling**（API `tools` 参数）提供全部工具。**需要调用工具时请直接返回模型原生 tool_calls**（结构化调用），系统会自动执行并把你需要的结果作为 tool 消息回填；你不必、也不要在回复正文中手写 `<tool_call>…</tool_call>`、DSML 标记或“### 🔧 调用工具”卡片。\n" +
  "正文（content）只用于输出最终回答、过程说明或总结；调用工具请用原生 tool_calls。";

/// 非流式模型请求（chat_once）带前端超时兜底：
/// 网络/服务端偶尔会无响应，超时返回 null，避免子代理循环一直等待导致任务卡死为空
/// `tools`：可选 OpenAI 风格 function schema 数组 → Rust chat_once 启用原生 function
/// calling，返回 message.tool_calls。
const CHAT_ONCE_TIMEOUT_MS = 60000;
async function chatOnce(
  config: ApiConfig,
  convo: AgentMsg[],
  tools?: OpenAIFunctionTool[] | null,
) {
  return Promise.race([
    invoke<{
      content: string;
      reasoning_content?: string;
      cache_hit?: number;
      cache_miss?: number;
      tool_calls?: NativeToolCallMsg[];
    }>("chat_once", {
      config: {
        base_url: config.baseUrl,
        api_key: config.apiKey,
        model: config.model || "deepseek-v4-flash",
        max_tokens: config.maxTokens,
        temperature: 0.3, // 工具决策用低温更稳定
        thinking_enabled: config.thinkingEnabled,
        reasoning_effort: config.reasoningEffort,
        system_prompt: withMathRule(
          withCurrentDate(config.systemPrompt || "你是道生一，一个AI桌面助手。"),
        ),
        enable_web_search: config.enableWebSearch,
      },
      messages: convo,
      ...(tools && tools.length ? { tools } : {}),
    }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), CHAT_ONCE_TIMEOUT_MS)),
  ]);
}

/// P-M4：把并行子代理结果按原始顺序格式化成汇总文本（纯函数，可测试）。
function formatParallelResults(
  results: { idx: number; ok: boolean; goal: string; text: string }[],
  workerCount?: number,
): string {
  const sorted = [...results].sort((a, b) => a.idx - b.idx);
  const body = sorted
    .map((r, i) => `## 子任务 ${i + 1}：${r.goal}\n${r.ok ? "✅ 完成" : "❌ 失败"}\n\n${r.text}`)
    .join("\n\n---\n\n");
  return `【并行子代理汇总】共 ${sorted.length} 个子代理${workerCount ? `（并发 ${workerCount}）` : ""}\n\n${body}`;
}

/// P-M3 角色工具提示：只展示角色允许的内置工具（不注入 MCP/浏览器/文件系统大段），
/// 提示词侧过滤 + runSubagentLoop 的 allowedTools 执行侧强制约束（双保险）。
function getRoleToolsPrompt(allowed: string[]): string {
  const allowSet = new Set(allowed);
  const lines = BUILTIN_TOOLS.filter((t) => allowSet.has(t.name))
    .map((t) => `- **${t.name}** (app): ${t.desc}`)
    .join("\n");
  return (
    "\n\n## 回答完整输出要求\n" +
    "无论你的思考（reasoning）过程多么详细，**最终答案必须完整、详细地呈现在回复正文中**：用结构化 Markdown（标题/列表/表格）给出完整的结论、分析与要点，不要只给一句简短结论。\n" +
    "\n## 工具调用唯一格式（极重要）\n" +
    "需要调用工具时，**唯一方式**是在回复正文中输出工具调用标记：\n" +
    '<tool_call>{"server":"app","tool":"工具名","arguments":{...}}</tool_call>\n' +
    "- **绝对禁止**写「### 🔧 调用工具」等卡片文本假装已调用工具——那只是文本，不会执行。\n" +
    "- 工具调用必须成对包含开/闭标记，JSON 必须是合法对象且含 tool 与 arguments；系统会自动执行并把**真实结果**回填给你。\n" +
    "\n## 你被允许使用的内置工具（server 填 `app`）\n" +
    (lines || "- （本角色暂无可用工具，请直接基于推理给出结论，不要调用其它工具）") +
    '\n\n需要工具时只回复以下格式：\n<tool_call>\n{"server":"app","tool":"工具名","arguments":{...}}\n</tool_call>'
  );
}

/// 构造子代理系统提示（P-M1 起子代理可调内置工具；allowTools=false 则纯对话；
/// P-M3 起支持角色 roleId → 角色指令 + 按角色过滤工具列表）。
function buildSubagentSysPrompt(context: string, allowTools: boolean, roleId?: string): string {
  const base =
    "你是道生一的子代理，负责独立完成一个子任务。" + (context ? `\n补充上下文：${context}` : "");
  if (!allowTools) {
    return (
      base +
      "\n请聚焦完成该子任务并直接给出结论。不要提问、不要编造数据或来源；拿不到的信息请明确说明无法获取。"
    );
  }
  // P-M3 角色：注入角色定位/指令，并只展示该角色允许的工具（提示词侧约束）
  const role = roleId ? getRoleById(roleId) : undefined;
  const rolePart = role
    ? `\n\n## 你的角色：${role.emoji} ${role.name}（${role.desc}）\n${role.sysPrompt}`
    : "";
  const toolsPrompt = role ? getRoleToolsPrompt(role.tools) : getMcpToolsPrompt();
  // 子代理输出纪律（角色分支的 getRoleToolsPrompt 不含主提示词的 outputRule，必须补）:
  // DeepSeek 思考模式易把分析全留在 reasoning、正文 content 很小 → 强制结论写正文 +
  // 探索型任务及时收敛，避免无限逐文件探索耗尽轮次（实测“深度调研”子代理 content≈0
  // 一直读文件到 maxRounds 上限、只返回一句占位文本）。
  const outputDiscipline =
    "\n\n## 输出纪律\n" +
    "1. 无论你的思考多么详细，**最终结论必须完整、详细地呈现在回复正文**（结构化 Markdown：目录/结论/要点），不要只给一句短结论，更不要只写在思考里。\n" +
    "2. 探索型任务（分析目录/源码/文档）：用少量批量读取获取足够信息后**及时收敛**，直接输出完整报告；不要为“全面”逐文件无限探索。\n" +
    "3. 需要调用工具时用原生 tool_calls 或 <tool_call>{...}</tool_call>，系统会执行并回填结果；完成后直接给出结论。";
  return base + rolePart + outputDiscipline + "\n\n" + toolsPrompt;
}

/// 子代理接近轮次上限时的收尾引导（附加在工具结果末尾）
const SUBAGENT_WIND_DOWN_HINT =
  "\n\n⚠️ 轮次已接近上限：若已获取足够信息，请在**下一轮直接输出完整结论**（正文），" +
  "不要再探索新文件、不要再调用工具；确实还差一个关键文件时才最多再读 1 次。";

/// P-M1：子代理带工具循环。子代理不仅能对话，还能调内置工具（git/编辑/测试/搜索/记忆），
/// 独立上下文 + 独立工具结果回填，为多 agent 协作打基础。
/// 与主代理差异：非流式（chat_once）+ 无 UI 流式副作用（后台任务，面板只显示状态）。
/// opts.allowTools 可关闭（纯对话子代理）；返回最终结论文本。
/// Stage3：allowTools 且端点支持时走原生 function calling（结构化 tools/tool_calls）；
/// 文本 <tool_call> 解析保留为兜底（与主代理一致）。
async function runSubagentLoop(
  config: ApiConfig,
  sysPrompt: string,
  goal: string,
  opts: { allowTools?: boolean; maxRounds?: number; allowedTools?: string[] } = {},
): Promise<string> {
  const allowTools = opts.allowTools !== false;
  // 探索型调研（读目录/源码）需要较多轮次；显式传 maxRounds 的调用方（如 synth=6）覆盖
  const maxRounds = opts.maxRounds || 20;
  // P-M3 角色工具集强制约束：非空时只允许调用这些工具（提示词过滤只是引导，这里是兜底）
  const allowed = opts.allowedTools && opts.allowedTools.length ? new Set(opts.allowedTools) : null;

  // 原生 function calling 注册表：allowTools + 端点支持 + 未被强制关闭 → 启用。
  // 有角色限定时只注册该角色放行的内置工具；无角色限定则内置 + MCP 全量（与主代理一致）。
  let subNativeDisabled = false;
  try {
    subNativeDisabled = localStorage.getItem("daoshengyi_native_tools") === "0";
  } catch {
    /* ignore */
  }
  let subRegistry: NativeToolRegistry | null = null;
  if (allowTools && !subNativeDisabled && supportsNativeTools(config.baseUrl || "")) {
    let builtins = BUILTIN_TOOLS.map((t) => ({ name: t.name, desc: t.desc }));
    if (allowed) builtins = builtins.filter((b) => allowed.has(b.name));
    subRegistry = buildNativeToolRegistry({
      builtins,
      mcp: allowed
        ? []
        : mcpToolsCache.map((t) => ({
            server: t.server,
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            kind: "mcp" as const,
          })),
    });
  }
  const subTools: OpenAIFunctionTool[] | null =
    subRegistry && subRegistry.tools.length > 0 ? subRegistry.tools : null;
  // 原生模式：给子代理系统提示也追加「原生 tool_calls」覆盖说明（压制文本 <tool_call> 引导）
  const effectiveSys = subTools ? `${sysPrompt}${NATIVE_TOOLS_NOTE}` : sysPrompt;

  const msgs: AgentMsg[] = [
    { role: "system", content: effectiveSys },
    { role: "user", content: `子任务：${goal}` },
  ];
  for (let round = 0; round < maxRounds; round++) {
    if (stopRequested) throw new AgentStoppedError();
    // 每轮 chatOnce（原生模式带 tools）与停止信号 race：点停止后立即抛 AgentStoppedError，
    // 不等 60s 超时。用 kind 标记而非 .then(throw)，避免 race 已结算后停止信号才触发
    // 导致 unhandled rejection。
    const raced = await Promise.race([
      chatOnce(config, msgs, subTools).then((d) => ({ kind: "ok" as const, data: d })),
      waitStopSignal().then(() => ({ kind: "stop" as const, data: null })),
    ]);
    if (raced.kind === "stop" || stopRequested) throw new AgentStoppedError();
    if (raced.data === null) throw new Error("子代理执行超时或失败");
    const data = raced.data;
    const content = data.content || "";

    // 原生优先：模型返回结构化 tool_calls（可多个）→ 回填 assistant.tool_calls 并逐个执行
    if (data.tool_calls && data.tool_calls.length > 0) {
      const normCalls: NativeToolCallMsg[] = data.tool_calls.map((c) => ({
        id: c.id || `call_${uuidv4()}`,
        type: "function",
        function: {
          name: c.function?.name || "",
          arguments: c.function?.arguments || "{}",
        },
      }));
      msgs.push({
        role: "assistant",
        content:
          stripToolJson(content).trim() ||
          `（调用工具 ${normCalls
            .map((x) => x.function?.name)
            .filter(Boolean)
            .join("/")}）`,
        tool_calls: normCalls,
      });
      for (const call of normCalls) {
        if (stopRequested) throw new AgentStoppedError(); // 执行工具前
        const fnName = call.function?.name || "";
        const ref = subRegistry?.byName.get(fnName) ?? null;
        if (!ref) {
          // 未知函数名 → 错误回填 role:tool，让它改用正确的工具
          msgs.push({
            role: "tool",
            tool_call_id: call.id,
            content: `错误: 未知工具「${fnName}」：不在本会话可用工具列表中，请从系统给出的函数列表选择正确的工具名。`,
          });
          continue;
        }
        // P-M3 角色工具集约束：不允许的工具不执行，回填提示改用允许工具
        if (allowed && !allowed.has(ref.tool)) {
          msgs.push({
            role: "tool",
            tool_call_id: call.id,
            content: `⚠️ 你当前角色不允许调用工具「${ref.tool}」。本角色允许的工具：${opts.allowedTools!.join("、")}。请改用允许的工具继续，或基于已有信息直接给出结论。`,
          });
          continue;
        }
        const args = parseNativeArguments(call.function?.arguments);
        let result: string;
        try {
          result = await callToolStoppable(ref.server, ref.tool, args);
        } catch (e) {
          if (e instanceof AgentStoppedError) throw e; // 用户停止 → 立即中断子代理
          result = `错误: ${e instanceof Error ? e.message : String(e)}`;
        }
        if (stopRequested) throw new AgentStoppedError(); // 工具返回后
        const windDown = round >= maxRounds - 3 ? SUBAGENT_WIND_DOWN_HINT : "";
        msgs.push({
          role: "tool",
          tool_call_id: call.id,
          content:
            truncateToolResult(markExternalToolResult(ref.tool, result)) + windDown,
        });
      }
      continue; // 结果已回填，继续下一轮
    }

    // 文本兜底：模型仍输出文本 <tool_call>（或未启用原生）→ 沿用原文本解析执行
    const tc = parseToolCall(content);
    if (tc && allowTools) {
      const server = resolveToolServer(tc.server, tc.tool);
      msgs.push({
        role: "assistant",
        content: stripToolJson(content).trim() || `（调用工具 ${tc.tool}）`,
      });
      // P-M3 角色工具集约束：不允许的工具不执行，回填提示让子代理改用允许工具
      if (allowed && !allowed.has(tc.tool)) {
        msgs.push({
          role: "user",
          content: `<tool_result>\n⚠️ 你当前角色不允许调用工具「${tc.tool}」。本角色允许的工具：${opts.allowedTools!.join("、")}。请改用允许的工具继续，或基于已有信息直接给出结论。\n</tool_result>`,
        });
        continue;
      }
      if (stopRequested) throw new AgentStoppedError(); // 执行工具前
      let result: string;
      try {
        result = await callToolStoppable(server, tc.tool, tc.arguments);
      } catch (e) {
        if (e instanceof AgentStoppedError) throw e; // 用户停止 → 立即中断子代理
        result = `错误: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (stopRequested) throw new AgentStoppedError(); // 工具返回后
      const windDown = round >= maxRounds - 3 ? SUBAGENT_WIND_DOWN_HINT : "";
      msgs.push({
        role: "user",
        content: `<tool_result>\n${truncateToolResult(markExternalToolResult(tc.tool, result))}\n</tool_result>\n\n请基于工具结果继续完成子任务，不要重复调用同一工具。${windDown}`,
      });
      continue;
    }
    return stripToolJson(content).trim() || "（子代理未返回内容）";
  }
  // 达到轮次上限仍无最终文本（多为探索型任务 content 一直很小）：追加一轮“收尾总结”
  // ——强制模型基于已获取的工具结果直接输出完整结论（该轮不带 tools、禁止再调工具），
  // 避免只返回一句“达到轮次上限”占位文本当结论（实测：content≈0 的探索循环撞上限）。
  if (stopRequested) throw new AgentStoppedError();
  msgs.push({
    role: "user",
    content:
      "⚠️ 子代理工具调用已达轮次上限。请**立即**基于以上已获取的工具结果与文件内容，" +
      "在回复正文直接输出**完整、结构化**的最终结论（结构梳理 + 关键点 + 结论）。" +
      "不要再调用任何工具、不要再读取新文件；若确有关键信息未能覆盖，请如实说明。",
  });
  const finRaced = await Promise.race([
    chatOnce(config, msgs).then((d) => ({ kind: "ok" as const, data: d })),
    waitStopSignal().then(() => ({ kind: "stop" as const, data: null })),
  ]);
  if (finRaced.kind === "stop" || stopRequested) throw new AgentStoppedError();
  if (finRaced.data) {
    const fin = stripToolJson(finRaced.data.content || "").trim();
    if (fin) return fin;
  }
  return "（子代理达到工具轮次上限，且收尾总结未生成正文内容）";
}

const DEFAULT_PROFILES: ApiProfile[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-v4-flash",
    maxTokens: 8192,
    temperature: 0.7,
    thinkingEnabled: true,
    reasoningEffort: "high",
    systemPrompt:
      "你是道生一，一个AI桌面助手。你运行在用户的本地设备上。请用简洁、准确的中文回答。",
    enableWebSearch: false,
    maxContextMessages: 50,
  },
];

export const useChatStore = defineStore("chat", () => {
  // --- Rust SQLite 持久化 ---
  async function initFromDb() {
    // 等 Tauri API 就绪
    if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
      setTimeout(initFromDb, 100);
      return;
    }
    try {
      const convs =
        await invoke<
          { id: string; title: string; model: string; created_at: number; updated_at: number }[]
        >("load_conversations");
      for (const c of convs) {
        const msgs = await invoke<
          {
            id: string;
            conversation_id: string;
            role: string;
            content: string;
            reasoning_content?: string;
            images?: string;
            attachments?: string;
            timestamp: number;
            tokens?: number;
            duration?: number;
            cost?: number;
          }[]
        >("get_messages", { conversationId: c.id });
        conversations.value.push({
          id: c.id,
          title: c.title,
          model: c.model,
          createdAt: c.created_at,
          updatedAt: c.updated_at,
          messages: msgs.map((m) => ({
            id: m.id,
            role: m.role as MessageRole,
            content: m.content,
            reasoning_content: m.reasoning_content,
            images: m.images ? (JSON.parse(m.images) as ImageAttachment[]) : undefined,
            attachments: m.attachments
              ? (JSON.parse(m.attachments) as FileAttachment[])
              : undefined,
            timestamp: m.timestamp,
            tokens: m.tokens,
            duration: m.duration,
            cost: m.cost,
          })),
        });
      }
      // 优先从 Rust 设置读活跃对话，回退 localStorage 旧数据
      let activeId: string | null = null;
      try {
        const settings = await initSettings();
        activeId = settings.activeConversationId;
      } catch {
        /* ignore */
      }
      if (!activeId) activeId = localStorage.getItem("daoshengyi_activeConv");
      if (activeId && conversations.value.some((c) => c.id === activeId)) {
        activeConversationId.value = activeId;
      }
      // 加载用量历史累计（跨会话保留）
      await refreshUsageAgg();
    } catch (e) {
      console.warn("[道生一] 数据库加载失败，使用空数据:", e);
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleSave() {
    if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const conv = activeConversation.value;
        if (!conv) return;
        await invoke("save_conversation", {
          conv: {
            id: conv.id,
            title: conv.title,
            model: conv.model,
            created_at: conv.createdAt,
            updated_at: conv.updatedAt,
          },
          messages: conv.messages.map((m) => ({
            id: m.id,
            conversation_id: conv.id,
            role: m.role,
            content: m.content,
            reasoning_content: m.reasoning_content || null,
            images: m.images ? JSON.stringify(m.images) : null,
            attachments: m.attachments ? JSON.stringify(m.attachments) : null,
            timestamp: m.timestamp,
            tokens: m.tokens || null,
            duration: m.duration || null,
            cost: m.cost || null,
          })),
        });
      } catch (e) {
        console.warn("[道生一] 保存失败:", e);
      }
    }, 500);
  }

  // 会话加载完成的信号：启动兜底逻辑（ensureActiveConversation）**必须**等它结束，
  // 否则会在「还没读完 SQLite」时误判为没有会话，直接新建空会话并把上次会话的 activeId 覆盖掉
  // ——这正是「每次重启都开新会话」的根因（App.vue onMounted 与异步加载竞态）。
  const dbLoaded = initFromDb();

  // --- 状态 ---
  const conversations = ref<Conversation[]>([]);
  const activeConversationId = ref<string | null>(null);
  // 已归档会话 ID 集合（localStorage 持久化；归档仅从主列表隐藏，数据仍在 SQLite）
  const ARCHIVE_KEY = "daoshengyi_archived_convs";
  function loadArchivedIds(): string[] {
    try {
      const s = localStorage.getItem(ARCHIVE_KEY);
      return s ? (JSON.parse(s) as string[]) : [];
    } catch {
      return [];
    }
  }
  const archivedIds = ref<Set<string>>(new Set(loadArchivedIds()));
  function persistArchived() {
    try {
      localStorage.setItem(ARCHIVE_KEY, JSON.stringify([...archivedIds.value]));
    } catch {
      /* ignore */
    }
  }
  const profiles = ref<ApiProfile[]>(loadProfilesLegacy());
  const activeProfileId = ref<string>(profiles.value[0]?.id ?? "default");
  const isStreaming = ref(false);
  const streamingContent = ref("");
  const streamingReasoning = ref("");

  // 消息排队（类 harness 队列）：agent 正在生成/执行（isStreaming）时用户仍可发送——
  // 新消息先进队列，当前轮彻底结束后自动逐条发出（串行不打断）。Esc/停止会清空队列。
  interface PendingTurn {
    cid: string;
    text: string;
    images?: ImageAttachment[];
    files?: FileAttachment[];
  }
  const pendingTurns = ref<PendingTurn[]>([]);
  const pendingCount = computed(() => pendingTurns.value.length);
  /** 当前已空闲且队列非空时取出队首自动发送（fromQueue 绕过忙碌守卫） */
  function drainQueue() {
    if (pendingTurns.value.length === 0 || isStreaming.value) return;
    const next = pendingTurns.value.shift()!;
    dbg(`[queue] 回复结束，取出排队消息自动发送（剩余 ${pendingTurns.value.length} 条）`);
    void sendMessage(next.text, next.images, next.files, true);
  }
  // 切换会话：清空旧会话的排队消息，避免串话到别的会话
  watch(activeConversationId, () => {
    if (pendingTurns.value.length > 0) {
      dbg(`[queue] 会话切换，清空 ${pendingTurns.value.length} 条排队消息`);
      pendingTurns.value = [];
    }
  });

  // 任务计划（P-A5 Plan 模式）：复杂任务分解的实时进度，plan_task 创建、plan_update 更新
  const taskPlan = ref<TaskPlan | null>(null);
  function setTaskPlan(plan: TaskPlan | null) {
    taskPlan.value = plan;
    if (!plan) resetPlanHealth(); // 清空计划：同时复位步骤健康状态（P-A6）
  }

  // 缓存命中统计（DeepSeek usage.prompt_cache_hit/miss_tokens）
  const cacheHitTotal = ref(0);
  const cacheMissTotal = ref(0);
  const cacheHitRate = computed<number | null>(() => {
    const total = cacheHitTotal.value + cacheMissTotal.value;
    return total > 0 ? (cacheHitTotal.value / total) * 100 : null;
  });

  // 用量历史累计（跨会话保留、删除会话不清零；数据来自后端 usage_agg 表）
  // 注意：后端 get_usage_agg 返回 { total: UsageAggRow, daily: [...] }，累计值在 total 下
  const usageAgg = ref<{
    total: { total_tokens: number; total_cost: number; total_duration: number; total_msgs: number };
    daily: { date: string; tokens: number; cost: number; msgs: number }[];
  } | null>(null);
  async function refreshUsageAgg() {
    try {
      usageAgg.value = await invoke("get_usage_agg");
    } catch {
      /* 忽略 */
    }
  }

  // 异步加载 Rust 端配置（优先于 localStorage 旧数据）
  initSettingsFromRust();
  // --- 计算属性 ---
  const activeConversation = computed(
    () => conversations.value.find((c) => c.id === activeConversationId.value) ?? null,
  );

  const sortedConversations = computed(() =>
    [...conversations.value].sort((a, b) => b.updatedAt - a.updatedAt),
  );

  // 归档过滤：主列表只显示未归档会话；归档会话单独列出（可在归档视图恢复/删除）
  const visibleConversations = computed(() =>
    sortedConversations.value.filter((c) => !archivedIds.value.has(c.id)),
  );
  const archivedConversations = computed(() =>
    sortedConversations.value.filter((c) => archivedIds.value.has(c.id)),
  );

  // 当前对话统计（总 token、总费用）
  const conversationStats = computed(() => {
    const conv = activeConversation.value;
    if (!conv) return { tokens: 0, cost: 0 };
    let tokens = 0;
    let cost = 0;
    for (const m of conv.messages) {
      if (m.role === "assistant") {
        if (m.tokens) tokens += m.tokens;
        if (m.cost) cost += m.cost;
      }
    }
    return { tokens, cost };
  });

  // 历史累计统计（后端 usage_agg，跨会话保留、含已删除会话）；fallback 当前对话
  const usageAggTotal = computed(
    () => usageAgg.value?.total?.total_tokens ?? conversationStats.value.tokens,
  );
  const usageAggCost = computed(
    () => usageAgg.value?.total?.total_cost ?? conversationStats.value.cost,
  );

  // P0-6 预算护栏：会话档 = 当前对话累计，日/月档 = 后端按天累计表（跨日/跨月自动重置）
  // 设计：未设置预算的档位不出现在结果里 → 完全不影响「没有设预算」的用户
  const budgetVerdict = computed(() => {
    const s = getSettings();
    const limits = {
      session: s.budgetSession ?? 0,
      daily: s.budgetDaily ?? 0,
      monthly: s.budgetMonthly ?? 0,
    };
    const spend = buildSpend({
      sessionCost: conversationStats.value.cost,
      daily: usageAgg.value?.daily ?? null,
    });
    return evaluateBudget(spend, limits);
  });

  // 预警去重：同一档位 + 同一等级 + 同一天只提示一次（否则每轮都弹 = 噪音）
  const budgetWarned = new Set<string>();

  // 对话变更时自动保存 + 标记活跃对话
  watch(conversations, scheduleSave, { deep: true });
  watch(activeConversationId, (id) => {
    // 只持久化**真实存在**的会话：新建但还没落库的空会话不得覆盖「上次会话」的记录，
    // 否则重启时读到的是一个 DB 里不存在的 id → 恢复失败 → 表现为每次都开新会话。
    if (id && conversations.value.some((c) => c.id === id)) {
      updateSettings({ activeConversationId: id });
    }
  });

  /// 启动兜底（App 挂载后调用一次）：等会话加载完成，再决定当前会话——
  /// ① 已从设置恢复（initFromDb 里按 activeConversationId 命中）→ 保持不动；
  /// ② 没恢复但有历史会话 → 选中**最近更新**的那个（而不是新建）；
  /// ③ 真的一个会话都没有 → 才新建空会话。
  /// 返回是否恢复/选中的会话 id（未恢复且新建时返回新会话 id）。
  async function ensureActiveConversation(): Promise<string> {
    try {
      await dbLoaded;
    } catch {
      /* 加载失败也继续走兜底 */
    }
    const cur = activeConversation.value;
    if (cur) return cur.id; // ① 已恢复上次会话
    const recent = visibleConversations.value[0]; // 已按 updatedAt 倒序
    if (recent) {
      activeConversationId.value = recent.id; // ② 退回最近一次会话
      return recent.id;
    }
    return createConversation(); // ③ 首次使用才新建
  }

  const activeProfile = computed(
    () => profiles.value.find((p) => p.id === activeProfileId.value) ?? profiles.value[0],
  );

  const currentConfig = computed<ApiConfig>(() => {
    const p = activeProfile.value;
    return {
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.model,
      maxTokens: p.maxTokens,
      temperature: p.temperature,
      thinkingEnabled: p.thinkingEnabled ?? false,
      reasoningEffort: p.reasoningEffort ?? "high",
      systemPrompt: p.systemPrompt ?? "",
      enableWebSearch: p.enableWebSearch ?? false,
      maxContextMessages: p.maxContextMessages ?? 50,
    };
  });

  // --- Persona 人格（角色/对话风格，全局偏好） ---
  const PERSONA_KEY = "daoshengyi_persona";
  const activePersonaId = ref(localStorage.getItem(PERSONA_KEY) || "");
  function setPersona(id: string) {
    activePersonaId.value = id;
    try {
      localStorage.setItem(PERSONA_KEY, id);
    } catch {
      /* ignore */
    }
  }

  // --- Agent 多模式（§3.11）：切换运行模式（对话/任务/办公/研究/编码/速答） ---
  function setMode(id: AgentModeId) {
    activeModeId.value = id;
    try {
      localStorage.setItem(MODE_KEY, id);
    } catch {
      /* ignore */
    }
    bumpModeHist(id); // 模式记忆：记录使用频次
  }

  /// 辅助任务使用的模型配置：配置了 auxiliaryProfileId 则用对应 Profile，否则跟随主模型
  function getAuxConfig(): ApiConfig {
    const auxId = getSettings().auxiliaryProfileId;
    const p = auxId ? profiles.value.find((x) => x.id === auxId) : undefined;
    if (p && p.baseUrl) {
      return {
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: p.model,
        maxTokens: p.maxTokens,
        temperature: p.temperature,
        thinkingEnabled: p.thinkingEnabled ?? false,
        reasoningEffort: p.reasoningEffort ?? "high",
        systemPrompt: p.systemPrompt ?? "",
        enableWebSearch: false,
        maxContextMessages: 20,
      };
    }
    return currentConfig.value;
  }

  /// P-A12 多模型路由：按任务类型选模型配置（routing[taskType] → 辅助模型 → 主模型）。
  /// taskType: chat / coding / summarize / search（model-routing.ts 的 TaskType）。
  function getRoutedAuxConfig(taskType: string): ApiConfig {
    const st = getSettings();
    const id = routeProfileId(taskType, st.modelRouting || {}, st.auxiliaryProfileId || "");
    const p = id ? profiles.value.find((x) => x.id === id) : undefined;
    if (p && p.baseUrl) {
      return {
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: p.model,
        maxTokens: p.maxTokens,
        temperature: p.temperature,
        thinkingEnabled: p.thinkingEnabled ?? false,
        reasoningEffort: p.reasoningEffort ?? "high",
        systemPrompt: p.systemPrompt ?? "",
        enableWebSearch: false,
        maxContextMessages: 20,
      };
    }
    return getAuxConfig();
  }

  // --- 子代理可视化（记录运行中的子代理，供面板展示） ---
  const subagents = ref<SubagentRecord[]>([]);
  function spawnSubagent(goal: string): SubagentRecord {
    const rec: SubagentRecord = { id: uuidv4(), goal, status: "running", startedAt: Date.now() };
    subagents.value.push(rec);
    return rec;
  }
  function completeSubagent(id: string, resultText: string) {
    const r = subagents.value.find((x) => x.id === id);
    if (r) {
      r.status = "completed";
      r.durationSec = Number(((Date.now() - r.startedAt) / 1000).toFixed(1));
      r.resultPreview = resultText
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
        .trim()
        .slice(0, 220);
    }
  }
  function failSubagent(id: string, err: string) {
    const r = subagents.value.find((x) => x.id === id);
    if (r) {
      r.status = "failed";
      r.durationSec = Number(((Date.now() - r.startedAt) / 1000).toFixed(1));
      r.error = err.slice(0, 220);
    }
  }
  function clearFinishedSubagents() {
    subagents.value = subagents.value.filter((x) => x.status === "running");
  }

  // --- 配置组持久化（Rust 端 SQLite + 加密 API Key） ---
  // 同步兜底：先读 localStorage 旧数据（作为迁移源）
  // 移除历史代码生成的默认 OpenAI 占位配置（未填 Key）
  function stripDefaultOpenAI(list: ApiProfile[]): ApiProfile[] {
    const filtered = list.filter((p) => !(p.id === "default" && p.name === "OpenAI" && !p.apiKey));
    if (filtered.length === 0) return [...DEFAULT_PROFILES];
    return filtered;
  }

  function loadProfilesLegacy(): ApiProfile[] {
    try {
      const saved = localStorage.getItem("daoshengyi_profiles");
      if (saved) {
        const parsed = JSON.parse(saved) as ApiProfile[];
        // 迁移：旧数据没有 thinkingEnabled 字段，重置为默认
        if (parsed.length > 0 && parsed[0].thinkingEnabled === undefined) {
          localStorage.removeItem("daoshengyi_profiles");
          localStorage.removeItem("daoshengyi_activeProfile");
          return [...DEFAULT_PROFILES];
        }
        return stripDefaultOpenAI(parsed);
      }
    } catch {
      /* ignore */
    }
    return [...DEFAULT_PROFILES];
  }

  function saveProfiles() {
    updateSettings({
      profiles: profiles.value,
      activeProfileId: activeProfileId.value,
    });
  }

  // 从 Rust 加载配置；无 Rust 数据但有 localStorage 旧数据时执行迁移
  async function initSettingsFromRust() {
    if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return;
    try {
      const legacy = localStorage.getItem("daoshengyi_profiles");
      const settings = await initSettings();
      if (settings.profiles.length > 0) {
        profiles.value = stripDefaultOpenAI(settings.profiles);
        if (
          settings.activeProfileId &&
          profiles.value.some((p) => p.id === settings.activeProfileId)
        ) {
          activeProfileId.value = settings.activeProfileId;
        } else if (profiles.value.length > 0) {
          activeProfileId.value = profiles.value[0].id;
        }
        if (legacy) {
          localStorage.removeItem("daoshengyi_profiles");
          localStorage.removeItem("daoshengyi_activeProfile");
        }
      } else if (legacy) {
        // Rust 无数据，迁移 localStorage 旧数据
        saveProfiles();
        localStorage.removeItem("daoshengyi_profiles");
        localStorage.removeItem("daoshengyi_activeProfile");
      }
    } catch (e) {
      console.warn("[道生一] 从 Rust 加载配置失败，回退 localStorage:", e);
    }
  }

  // 一键部署后刷新配置（Rust 端可能已自动添加/切换为本地 Ollama）
  async function reloadProfilesFromRust() {
    try {
      const settings = await reloadSettings();
      if (settings.profiles.length > 0) {
        profiles.value = stripDefaultOpenAI(settings.profiles);
        // 保持用户当前的文本主模型（如 DeepSeek）——本地 Ollama 只作为图片识别的视觉辅助，
        // 不因一键部署而切换主模型
        if (
          settings.activeProfileId &&
          profiles.value.some((p) => p.id === settings.activeProfileId)
        ) {
          activeProfileId.value = settings.activeProfileId;
        } else if (profiles.value.length > 0) {
          activeProfileId.value = profiles.value[0].id;
        }
      }
    } catch (e) {
      console.warn("[道生一] 刷新配置失败:", e);
    }
  }

  // 自动保存
  watch(profiles, saveProfiles, { deep: true });
  watch(activeProfileId, (id) => {
    updateSettings({ activeProfileId: id });
  });

  /// 切换 Profile 时是否显示“切换中”提示
  const profileSwitching = ref(false);
  function switchProfile(id: string) {
    if (!profiles.value.some((p) => p.id === id)) return;
    if (id === activeProfileId.value) return;
    // 优雅切换：停止进行中的流式生成，避免旧配置的请求中断报错刷屏（借鉴 Hermes profile 切换 overlay）
    if (isStreaming.value) stopStreaming();
    activeProfileId.value = id;
    profileSwitching.value = true;
    setTimeout(() => {
      profileSwitching.value = false;
    }, 800);
  }

  function updateProfile(id: string, partial: Partial<ApiProfile>) {
    const p = profiles.value.find((p) => p.id === id);
    if (p) Object.assign(p, partial);
  }

  function addProfile(profile: ApiProfile) {
    profiles.value.push(profile);
  }

  function deleteProfile(id: string) {
    if (profiles.value.length <= 1) return;
    const idx = profiles.value.findIndex((p) => p.id === id);
    if (idx === -1) return;
    profiles.value.splice(idx, 1);
    if (activeProfileId.value === id) {
      activeProfileId.value = profiles.value[0].id;
    }
  }

  // --- 对话管理 ---
  function createConversation(title?: string): string {
    const id = uuidv4();
    const now = Date.now();
    conversations.value.push({
      id,
      title: title || "新对话",
      messages: [],
      createdAt: now,
      updatedAt: now,
      model: currentConfig.value.model,
    });
    activeConversationId.value = id;
    return id;
  }

  function deleteConversation(id: string) {
    const idx = conversations.value.findIndex((c) => c.id === id);
    if (idx === -1) return;
    conversations.value.splice(idx, 1);
    invoke("delete_conversation_cmd", { id }).catch(() => {});
    if (activeConversationId.value === id) {
      activeConversationId.value = conversations.value[0]?.id ?? null;
    }
  }

  // S4 会话分支：把会话复制为新会话并切换到它（atMessageId 可选——指定则只保留到该消息，形成「从此分支」）
  async function forkConversation(id: string, atMessageId?: string) {
    const src = conversations.value.find((c) => c.id === id);
    if (!src) return null;
    const newId = uuidv4();
    const newTitle = `${src.title}（分支）`;
    try {
      await invoke("fork_conversation_cmd", {
        id,
        atMessageId: atMessageId ?? null,
        newId,
        newTitle,
      });
      const msgs = await invoke<
        {
          id: string;
          conversation_id: string;
          role: string;
          content: string;
          reasoning_content?: string;
          images?: string;
          attachments?: string;
          timestamp: number;
          tokens?: number;
          duration?: number;
          cost?: number;
        }[]
      >("get_messages", { conversationId: newId });
      conversations.value.push({
        id: newId,
        title: newTitle,
        model: src.model,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: msgs.map((m) => ({
          id: m.id,
          role: m.role as MessageRole,
          content: m.content,
          reasoning_content: m.reasoning_content,
          images: m.images ? (JSON.parse(m.images) as ImageAttachment[]) : undefined,
          attachments: m.attachments ? (JSON.parse(m.attachments) as FileAttachment[]) : undefined,
          timestamp: m.timestamp,
          tokens: m.tokens,
          duration: m.duration,
          cost: m.cost,
        })),
      });
      activeConversationId.value = newId;
      return newId;
    } catch (e) {
      notify(`分支失败：${e}`);
      return null;
    }
  }

  // S4 queue：向历史会话投递任务，后台执行完成后自动刷新该会话
  async function queueTurn(convId: string, text: string) {
    try {
      const msg = await invoke<string>("queue_turn", { conversationId: convId, text });
      notify(msg, "info");
      return true;
    } catch (e) {
      notify(`投递失败：${e}`);
      return false;
    }
  }

  // 重新从后端加载某会话的全部消息（queue 后台回复落地后刷新用）
  async function refreshConversation(convId: string) {
    try {
      const msgs = await invoke<
        {
          id: string;
          conversation_id: string;
          role: string;
          content: string;
          reasoning_content?: string;
          images?: string;
          attachments?: string;
          timestamp: number;
          tokens?: number;
          duration?: number;
          cost?: number;
        }[]
      >("get_messages", { conversationId: convId });
      const conv = conversations.value.find((c) => c.id === convId);
      if (conv) {
        conv.messages = msgs.map((m) => ({
          id: m.id,
          role: m.role as MessageRole,
          content: m.content,
          reasoning_content: m.reasoning_content,
          images: m.images ? (JSON.parse(m.images) as ImageAttachment[]) : undefined,
          attachments: m.attachments ? (JSON.parse(m.attachments) as FileAttachment[]) : undefined,
          timestamp: m.timestamp,
          tokens: m.tokens,
          duration: m.duration,
          cost: m.cost,
        }));
        conv.updatedAt = Date.now();
      }
    } catch {
      /* 忽略 */
    }
  }

  function selectConversation(id: string) {
    if (conversations.value.some((c) => c.id === id)) {
      activeConversationId.value = id;
    }
  }

  // --- 会话归档（localStorage 记录；归档=隐藏，数据保留） ---
  function archiveConversation(id: string) {
    archivedIds.value.add(id);
    persistArchived();
    // 归档当前活跃会话时，切换到最近一个未归档会话
    if (activeConversationId.value === id) {
      activeConversationId.value = visibleConversations.value[0]?.id ?? null;
    }
  }
  function unarchiveConversation(id: string) {
    archivedIds.value.delete(id);
    persistArchived();
  }
  /** 从归档中彻底删除（连同 SQLite 数据） */
  function deleteArchived(id: string) {
    unarchiveConversation(id);
    deleteConversation(id);
  }

  // --- 消息管理 ---
  function addUserMessage(
    convId: string,
    text: string,
    images?: ImageAttachment[],
    attachments?: FileAttachment[],
  ): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: "user",
      content: text,
      images: images && images.length > 0 ? images : undefined,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      timestamp: Date.now(),
    };
    const conv = conversations.value.find((c) => c.id === convId);
    if (conv) {
      conv.messages.push(msg);
      conv.updatedAt = Date.now();
      if (conv.title === "新对话" && conv.messages.length === 1) {
        const titleText =
          text || (images?.length ? "[图片]" : "") || (attachments?.length ? "[附件]" : "");
        conv.title = titleText.slice(0, 30) + (titleText.length > 30 ? "..." : "");
      }
    }
    return msg;
  }

  // --- 图片预处理：用视觉模型描述图片（图片→文字描述→交给文本大模型） ---
  // 长任务期间防止系统休眠（macOS caffeinate；非 macOS/失败静默忽略）
  async function setPreventSleep(active: boolean): Promise<void> {
    try {
      await invoke("set_prevent_sleep", { active });
    } catch {
      /* ignore */
    }
  }
  async function describeImages(images: ImageAttachment[]): Promise<string> {
    const b64s = images.map((img) => img.base64);
    // 1) OCR：macOS 系统 Vision 提取文字（准确、快、离线；非 macOS 返回空）
    let ocrText = "";
    try {
      // OCR 30 秒超时兜底，避免本地 OCR 卡住阻塞图片识别
      ocrText = await Promise.race([
        invoke<string>("ocr_extract_image_text", { images: b64s }),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), 30000)),
      ]);
    } catch {
      /* 非 macOS 或无 OCR 工具时忽略 */
    }

    // 2) 语义描述：本地视觉模型（跨平台通用；Intel 无 GPU 约 1 分钟）
    let semantic = "";
    try {
      // 110 秒兜底：本地推理慢，但避免异常导致前端永久挂起
      semantic = await Promise.race([
        invoke<string>("ollama_describe_image", { images: b64s }),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), 110000)),
      ]);
    } catch {
      /* 视觉模型不可用时忽略 */
    }

    // 合并 OCR 文字 + 语义描述
    const parts: string[] = [];
    if (ocrText) parts.push(`[图片中的文字（OCR）：]\n${ocrText}`);
    if (semantic) parts.push(`[图片内容描述：]\n${semantic}`);
    if (parts.length > 0) return parts.join("\n\n");

    // 3) 回退：找一个有视觉能力的 API（非 DeepSeek，已配 Key）
    const visionProfile = profiles.value.find((p) => p.apiKey && !p.baseUrl.includes("deepseek"));
    if (!visionProfile) return "";

    const baseUrl = visionProfile.baseUrl.replace(/\/+$/, "");
    const fbParts: string[] = [];
    for (const img of images) {
      try {
        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${visionProfile.apiKey}`,
          },
          body: JSON.stringify({
            model: visionProfile.model,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "请详细描述这张图片的内容。如果图片中有文字，请逐字转录。用中文回答，简洁准确。",
                  },
                  { type: "image_url", image_url: { url: img.base64, detail: "auto" } },
                ],
              },
            ],
            max_tokens: 500,
          }),
        });
        if (resp.ok) {
          const data = await resp.json();
          const desc = data.choices?.[0]?.message?.content || "";
          if (desc) fbParts.push(`[图片: ${img.fileName || "附件"}] ${desc}`);
        }
      } catch {
        /* 单张失败不影响其他 */
      }
    }
    return fbParts.join("\n\n");
  }

  // --- 终端命令执行（/run 指令） ---
  // 解析命令行（支持引号）
  function parseCommandLine(input: string): { command: string; args: string[] } {
    const tokens = input.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
    const clean = tokens.map((t) => t.replace(/^["']|["']$/g, ""));
    return { command: clean[0] || "", args: clean.slice(1) };
  }

  // 危险命令判定（吸收自 DSH 生态的 safety-net / risk-gate / perm-guard 分级思路）：
  //   forbidden = 绝不执行（删根/格盘/fork bomb/关机）
  //   danger    = 必须人工确认（强推、git reset --hard、提权、curl|sh、递归删非构建目录…）
  //   caution   = 放行但提示（--force-with-lease、全局装包、chmod 777…）
  // 规则、原因与「误报抑制」（如 rm -rf node_modules 不升级为危险）见 utils/danger-rules.ts
  function riskOf(cmdStr: string): RiskVerdict {
    return assessCommandRisk(cmdStr);
  }

  function isDangerous(cmdStr: string): boolean {
    const level = riskOf(cmdStr).level;
    return level === "danger" || level === "forbidden";
  }

  /// Smart 智能审批：用当前模型判断危险命令是否可安全自动执行。
  /// 判断失败或无法调用时保守返回 false（走手动确认）。
  async function judgeCommandSafety(cmdStr: string): Promise<boolean> {
    const config = getAuxConfig();
    if (!config || !config.baseUrl || !config.apiKey) return false;
    const sys =
      "你是命令安全审查器，判断一条 shell 命令是否可以安全自动执行。\n" +
      "安全标准：不删除用户数据/系统文件（删除 /tmp 或明确临时目录且路径安全可视为安全）、不破坏系统、" +
      "不泄露敏感信息、不下载并执行不可信脚本、不关闭/重启系统、不改权限到危险状态。\n" +
      '只回答 JSON：{"safe": true 或 false, "reason": "10字内中文理由"}，不要输出其他内容。';
    try {
      const data = await chatOnce(config, [
        { role: "system", content: sys },
        { role: "user", content: `命令：${cmdStr}` },
      ]);
      const text = (data?.content || "").trim();
      const m = text.match(/\{\s*"safe"\s*:\s*(true|false)/i);
      if (m) return m[1].toLowerCase() === "true";
    } catch {
      /* 判断失败走保守确认 */
    }
    return false;
  }

  /// 退出码 → 人类可读状态（0=成功，常见非 0 有含义，其余标注错误）
  function exitStatusLabel(code: number): string {
    if (code === 0) return "✅ 执行成功";
    const map: Record<number, string> = {
      1: "一般错误",
      2: "误用 shell 命令/参数",
      126: "命令存在但不可执行",
      127: "命令未找到",
      130: "被 Ctrl+C 中断",
      137: "被强制终止（OOM 或 kill）",
    };
    return `❌ 执行失败（退出码 ${code}${map[code] ? `：${map[code]}` : ""}）`;
  }

  async function runCommand(raw: string) {
    // 输入法容错：全角波浪号 ～（U+FF5E）→ 半角 ~（U+007E）——shell 只认半角 ~ 做 HOME 展开，
    // 中文输入法下输入 ~ 常被转成全角 ～ 导致 `～/l.txt` 找不到。这里统一归一化后再执行与展示。
    const cmdStr = raw.replace(/～/g, "~");
    const { command } = parseCommandLine(cmdStr); // 整条命令执行，args 不需拆
    if (!command) return;

    // S1 命令执行策略引擎：先查规则文件（deny 拦截 / allow 放行 / prompt 或未命中走现有三档审批）
    let policy: { decision: string; matched: string | null } | null = null;
    try {
      policy = await invoke<{ decision: string; matched: string | null }>("check_command_policy", {
        command: cmdStr,
      });
    } catch {
      /* 策略查询失败 → 按未命中处理（原有行为兜底） */
    }
    const policyDecision = policy?.decision ?? "none";
    if (policyDecision === "deny") {
      notify(
        `⛔ 命令被「命令执行策略」拦截：\n\n$ ${cmdStr}\n\n命中规则：\`${policy?.matched ?? "?"}\`\n\n可在 设置→权限→命令执行策略 中调整规则。`,
      );
      return;
    }
    // 危险命令审批：策略命中 allow 直接放行；prompt 或未命中但命中内置危险模式 → 走
    // manual 手动确认（默认）/ smart 辅助模型智能判断 / yolo 全部自动批准
    // 例外：用户已通过 request_permissions 在本会话授权「命令执行」→ 不再重复弹确认
    //（execpolicy 的 deny / prompt 规则仍优先，不会被会话授权绕过）
    const needsConfirm =
      policyDecision === "prompt" ||
      (isDangerous(cmdStr) && policyDecision !== "allow" && !hasSessionPermit("run_command"));
    if (needsConfirm) {
      const st = getSettings();
      const mode: "manual" | "smart" | "yolo" | "on-failure" =
        st.approvalMode || (st.yoloMode ? "yolo" : "manual");
      // on-failure（吸收自 Codex 的 ApprovalMode::OnFailure）：先执行，失败后才升级询问
      // ——此处直接放行，失败分支在 agentRunCommand / agentExecCommand 里处理。
      if (mode === "manual") {
        const ok = await askConfirm(`⚠️ 检测到危险命令：\n\n$ ${cmdStr}\n\n确定要执行吗？`);
        if (!ok) return;
      } else if (mode === "smart") {
        const safe = await judgeCommandSafety(cmdStr);
        if (!safe) {
          const ok = await askConfirm(
            `⚠️ 智能审批判定该命令存在风险：\n\n$ ${cmdStr}\n\n确定仍要执行吗？`,
          );
          if (!ok) return;
        }
        // 判定安全 → 自动放行
      }
      // yolo → 自动放行
    }

    let convId = activeConversationId.value;
    if (!convId) convId = createConversation();
    addUserMessage(convId, `/run ${cmdStr}`);

    const conv = conversations.value.find((c) => c.id === convId)!;
    const assistantMsg = reactive<ChatMessage>({
      id: uuidv4(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      streaming: true,
    });
    conv.messages.push(assistantMsg);
    conv.updatedAt = Date.now();
    isStreaming.value = true;
    streamingContent.value = `$ ${cmdStr}\n⏳ 执行中...`;

    const startTime = Date.now();
    // 命令执行期间防止系统休眠（长任务可能超 30 秒）
    await setPreventSleep(true);
    try {
      // 整条命令交给后端 shell（/bin/sh -c）执行，支持 ~ 展开/管道/&& 等 shell 语法；
      // parseCommandLine 只用于判空与展示，不再拆分传参（拆分会丢失引号与 shell 语义）
      const result = await invoke<{
        stdout: string;
        stderr: string;
        exit_code: number;
        timed_out: boolean;
        created_files?: string[];
      }>("execute_command", {
        command: cmdStr,
        args: [] as string[],
        cwd: getSettings().workspace || null,
        timeoutSecs: 30,
        sandboxMode: getSettings().sandboxMode || "off",
        workspace: getSettings().workspace || null,
      });
      const out = result.stdout.trimEnd();
      const err = result.stderr.trimEnd();
      let content = `$ ${cmdStr}\n`;
      if (out) content += `\n${out}\n`;
      if (err) content += `\n[stderr]\n${err}\n`;
      content += `\n${result.timed_out ? "⏰ 执行超时，已终止" : exitStatusLabel(result.exit_code)}`;
      // 命令重定向生成的文件：展示为可点击路径（ChatMessage 会自动把绝对路径链接化并校验存在）
      const created = result.created_files || [];
      if (created.length > 0) {
        content += `\n\n📄 本次命令生成的文件：\n` + created.map((f) => `- ${f}`).join("\n");
      }
      assistantMsg.content = content;
    } catch (e: unknown) {
      assistantMsg.content = `$ ${cmdStr}\n\n❌ 执行失败: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      await setPreventSleep(false);
      assistantMsg.streaming = false;
      assistantMsg.duration = Number(((Date.now() - startTime) / 1000).toFixed(1));
      assistantMsg.tokens = estimateMessageTokens(assistantMsg.content);
      assistantMsg.cost = 0;
      streamingContent.value = "";
      isStreaming.value = false;
      conv.updatedAt = Date.now();
      scheduleSave();
      // /run 结束：续跑排队消息
      drainQueue();
    }
  }

  /// Agent 命令安全门禁（`run_command` / `exec_command` 共用同一管线）：
  /// execpolicy deny 直接拦截；prompt 或内置危险模式按审批模式（manual/smart/yolo）处理。
  /// 返回 `null` = 放行；返回字符串 = 拒绝原因（直接作为工具结果返回给模型）。
  async function gateAgentCommand(cmdStr: string): Promise<string | null> {
    // execpolicy：deny 直接拦截返回（不让模型重试绕行）；allow / prompt / 未命中继续
    let policy: { decision: string; matched: string | null } | null = null;
    try {
      policy = await invoke<{ decision: string; matched: string | null }>("check_command_policy", {
        command: cmdStr,
      });
    } catch {
      /* 策略查询失败按未命中处理（原有兜底） */
    }
    const policyDecision = policy?.decision ?? "none";
    if (policyDecision === "deny") {
      return `⛔ 命令被「命令执行策略」拦截（命中：\`${policy?.matched ?? "?"}\`）：$ ${cmdStr}\n此类破坏性命令不允许 Agent 执行；若确需，请让用户手动输入 /run 或调整 设置→权限→命令执行策略。`;
    }
    // 语义门禁（二次防护）：forbidden 级命令直接拒绝，并说明原因与替代方案（让模型学会改法）
    const risk = riskOf(cmdStr);
    if (risk.level === "forbidden") {
      return `${describeRisk(risk, cmdStr)}\n\n（该命令不会被执行。请改用安全替代方案，或由用户手动执行。）`;
    }
    // 危险命令按审批模式放行；未获批准则返回说明，让模型改用安全命令或请用户手动执行。
    // 例外：用户已通过 request_permissions 在本会话授权「命令执行」→ 不再重复弹确认
    //（execpolicy 的 deny / prompt 规则仍优先，不会被会话授权绕过）。
    const needsConfirm =
      policyDecision === "prompt" ||
      (isDangerous(cmdStr) && policyDecision !== "allow" && !hasSessionPermit("run_command"));
    if (!needsConfirm) return null;
    const riskLine =
      risk.level === "danger"
        ? `\n\n风险项：${risk.title}\n原因：${risk.reason}${risk.suggestion ? `\n建议：${risk.suggestion}` : ""}`
        : "";
    const st = getSettings();
    const mode: "manual" | "smart" | "yolo" | "on-failure" =
      st.approvalMode || (st.yoloMode ? "yolo" : "manual");
    if (mode === "manual") {
      const ok = await askConfirm(
        `⚠️ Agent 想执行一条危险命令，请确认：\n\n$ ${cmdStr}${riskLine}\n\n（拒绝后 Agent 会改用更安全的方式）`,
      );
      if (!ok)
        return `（未获授权：危险命令 $ ${cmdStr} 被用户拒绝${risk.level === "danger" ? `（风险项：${risk.title}）` : ""}，请改用更安全的命令，或请用户手动执行）`;
    } else if (mode === "smart") {
      const safe = await judgeCommandSafety(cmdStr);
      if (!safe) {
        const ok = await askConfirm(
          `⚠️ 智能审批判定该命令有风险，Agent 请求执行：\n\n$ ${cmdStr}${riskLine}\n\n是否仍允许？`,
        );
        if (!ok) return `（未获授权：危险命令 $ ${cmdStr} 被拒绝）`;
      }
    }
    // yolo → 自动放行
    return null;
  }

  /// on-failure 模式专用（吸收自 Codex 的 ApprovalMode::OnFailure）：命令先跑，
  /// **失败后**再请求用户授权重试——把打断从「执行前」挪到「真出错时」，少一半弹窗。
  /// 用户同意 → 记入会话许可（后续危险命令不再逐条确认）。
  async function escalateOnFailure(cmdStr: string, detail: string): Promise<string> {
    const ok = await askConfirm(
      `⚠️ 命令执行失败（审批模式：失败后再问）：\n\n$ ${cmdStr}\n\n${detail}\n\n` +
        "是否允许 Agent 换用更高权限/更强的方式重试？（同意后本会话内危险命令不再逐条确认）",
    );
    if (!ok) {
      return `（用户选择不再重试：$ ${cmdStr} 执行失败（${detail}）。请改用更安全的方式，或直接向用户说明结论，不要重复重试。）`;
    }
    rememberSessionPermit("run_command");
    return `（用户已授权本会话内的命令执行权限，可以换参数/方式重试：${detail}。若仍失败请给出结论，避免无限重试。）`;
  }

  /// 模型可调的 run_command 实现：与 /run 同一安全管线（execpolicy deny / 危险审批），
  /// 但只把执行结果作为字符串返回给模型（不写对话消息），供 Agent 完成专用工具覆盖不了的
  /// 命令任务（打开本机 App、运行构建/工具脚本、系统查询等）。
  async function agentRunCommand(raw: string): Promise<string> {
    const cmdStr = String(raw || "")
      .replace(/～/g, "~")
      .trim();
    if (!cmdStr) throw new Error("run_command 需要 command 参数（要执行的 shell 命令）");
    // execpolicy：deny 直接拦截返回（不让模型重试绕行）；allow / prompt / 未命中继续
    await setPreventSleep(true);
    try {
      const result = await invoke<{
        stdout: string;
        stderr: string;
        exit_code: number;
        timed_out: boolean;
        created_files?: string[];
      }>("execute_command", {
        command: cmdStr,
        args: [] as string[],
        cwd: getSettings().workspace || null,
        timeoutSecs: 60,
        sandboxMode: getSettings().sandboxMode || "off",
        workspace: getSettings().workspace || null,
      });
      const out = result.stdout.trimEnd();
      const err = result.stderr.trimEnd();
      let content = `$ ${cmdStr}\n`;
      if (out) content += `\n${out}\n`;
      if (err) content += `\n[stderr]\n${err}\n`;
      content += `\n${result.timed_out ? "⏰ 执行超时，已终止" : exitStatusLabel(result.exit_code)}`;
      const created = result.created_files || [];
      if (created.length > 0)
        content += `\n\n📄 生成的文件：\n` + created.map((f) => `- ${f}`).join("\n");
      // P0-5 验证凭据：验证类命令的真实退出码是「通过/失败」断言的唯一依据
      noteVerification(
        classifyVerificationCommand(cmdStr),
        result.exit_code === 0 && !result.timed_out,
        cmdStr,
      );
      // on-failure：失败后才升级请求授权（Codex ApprovalMode::OnFailure 语义）
      if (
        getSettings().approvalMode === "on-failure" &&
        (result.timed_out || result.exit_code !== 0)
      ) {
        content += `\n\n${await escalateOnFailure(
          cmdStr,
          result.timed_out ? "命令超时被终止" : `退出码 ${result.exit_code}`,
        )}`;
      }
      return content;
    } catch (e: unknown) {
      return `❌ 命令执行失败: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      await setPreventSleep(false);
    }
  }

  /// Rust 侧 exec 结果（形状对齐 Codex 的 exec_command / write_stdin）
  interface AgentExecResult {
    session_id: number;
    output: string;
    running: boolean;
    exit_code: number | null;
    truncated: boolean;
  }

  /// 统一渲染 exec/write_stdin 结果：新增输出 + 运行/退出状态 + 下一步指引
  function formatExecResult(r: AgentExecResult, header?: string): string {
    let out = header ? `${header}\n` : "";
    out += (r.output || "").trimEnd() || "（本次没有新输出）";
    if (r.truncated) {
      out +=
        "\n\n…（输出过长已截断；需要完整日志请把命令重定向到文件，再用 read_file 分段读）";
    }
    out += r.running
      ? `\n\n⏳ 进程仍在运行（session_id=${r.session_id}）。继续交互用 write_stdin（session_id=${r.session_id}；只取新输出可省略 input；输入需以 \\n 结尾；中断用 input="\\u0003" 即 Ctrl-C）。`
      : `\n\n✅ 进程已结束（session_id=${r.session_id}，退出码 ${r.exit_code ?? "未知"}）`;
    return out;
  }

  /// 融合 Codex 的 exec_command：PTY 启动命令 + 等待 yieldMs 后返回【新增输出 + 会话号】。
  /// 与 run_command 共用安全门禁；关键区别：**超时不杀进程**，可由 write_stdin 继续交互。
  async function agentExecCommand(raw: string, cwd: string, yieldMs: number): Promise<string> {
    const cmdStr = String(raw || "").replace(/～/g, "~").trim();
    if (!cmdStr) throw new Error("exec_command 需要 command 参数（要执行的 shell 命令）");
    const denied = await gateAgentCommand(cmdStr);
    if (denied) return denied;
    const wait = Math.min(Math.max(Number(yieldMs) || 1000, 200), 30000);
    await setPreventSleep(true);
    try {
      const r = await invoke<AgentExecResult>("exec_command_agent", {
        command: cmdStr,
        cwd: cwd || getSettings().workspace || null,
        yieldMs: wait,
        sandboxMode: getSettings().sandboxMode || "off",
        workspace: getSettings().workspace || null,
      });
      const rendered = formatExecResult(r, `$ ${cmdStr}`);
      // P0-5 验证凭据：进程已结束时记录真实退出码
      if (!r.running && r.exit_code !== null) {
        noteVerification(classifyVerificationCommand(cmdStr), r.exit_code === 0, cmdStr);
      }
      // on-failure：进程已结束且非 0 退出 → 升级请求授权重试
      if (
        getSettings().approvalMode === "on-failure" &&
        !r.running &&
        r.exit_code !== null &&
        r.exit_code !== 0
      ) {
        return `${rendered}\n\n${await escalateOnFailure(cmdStr, `退出码 ${r.exit_code}`)}`;
      }
      return rendered;
    } catch (e: unknown) {
      return `❌ 命令执行失败: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      await setPreventSleep(false);
    }
  }

  /// 融合 Codex 的 write_stdin：向运行中的会话写输入（可省略=只等待）并取回新增输出。
  async function agentWriteStdin(id: number, input: string, yieldMs: number): Promise<string> {
    const wait = Math.min(Math.max(Number(yieldMs) || 1000, 200), 30000);
    await setPreventSleep(true);
    try {
      const r = await invoke<AgentExecResult>("write_stdin_agent", {
        id,
        input: input || null,
        yieldMs: wait,
      });
      return formatExecResult(r);
    } catch (e: unknown) {
      return `❌ 会话操作失败: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      await setPreventSleep(false);
    }
  }

  // 读取文件（/read 指令，借鉴 DeepSeek Harness 的文件能力）
  async function runRead(filePath: string) {
    let convId = activeConversationId.value;
    if (!convId) convId = createConversation();
    addUserMessage(convId, `/read ${filePath}`);

    const conv = conversations.value.find((c) => c.id === convId)!;
    const assistantMsg = reactive<ChatMessage>({
      id: uuidv4(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      streaming: true,
    });
    conv.messages.push(assistantMsg);
    conv.updatedAt = Date.now();
    isStreaming.value = true;
    streamingContent.value = `📄 正在读取 ${filePath}...`;

    const startTime = Date.now();
    try {
      const content = await invoke<string>("read_file", { path: filePath });
      assistantMsg.content = `📄 **${filePath}**\n\n\`\`\`\n${content.slice(0, 12000)}\n\`\`\``;
    } catch (e: unknown) {
      assistantMsg.content = `📄 **${filePath}**\n\n❌ 读取失败: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      assistantMsg.streaming = false;
      assistantMsg.duration = Number(((Date.now() - startTime) / 1000).toFixed(1));
      assistantMsg.tokens = estimateMessageTokens(assistantMsg.content);
      assistantMsg.cost = 0;
      streamingContent.value = "";
      isStreaming.value = false;
      conv.updatedAt = Date.now();
      scheduleSave();
      // /read 结束：续跑排队消息
      drainQueue();
    }
  }

  // --- 流式发送 ---
  async function sendMessage(
    text: string,
    images?: ImageAttachment[],
    attachments?: FileAttachment[],
    fromQueue = false,
  ) {
    // 忙时（上一轮仍在生成/执行）用户发来的新消息：入队，等当前轮结束后自动发送
    if (isStreaming.value && !fromQueue) {
      pendingTurns.value.push({
        cid: activeConversationId.value ?? "",
        text,
        images,
        files: attachments,
      });
      dbg(`[queue] 忙中收到新消息，已入队（队列 ${pendingTurns.value.length} 条）`);
      return;
    }
    // 新消息：重置浏览器「已打开页面」标记（上一任务的浏览器已断开，需重新导航）
    browserNavigated = false;
    // 命令执行指令：/run <命令>
    if (text.trim().startsWith("/run ")) {
      await runCommand(text.trim().slice(5).trim());
      return;
    }
    // 文件读取指令：/read <路径>
    if (text.trim().startsWith("/read ")) {
      await runRead(text.trim().slice(6).trim());
      return;
    }
    // 新建对话：/new
    if (text.trim() === "/new") {
      createConversation();
      return;
    }
    // 清空当前对话：/clear
    if (text.trim() === "/clear") {
      clearCurrentConversation();
      return;
    }
    // 帮助：/help
    if (text.trim() === "/help") {
      const hcId = activeConversationId.value || createConversation();
      addUserMessage(hcId, "/help");
      const helpText =
        "**可用命令：**\n" +
        "- `/run <命令>`：执行终端命令\n" +
        "- `/read <路径>`：读取本地文件\n" +
        "- `/new`：新建对话\n" +
        "- `/clear`：清空当前对话\n\n" +
        "输入 `/` 可弹出命令面板。";
      const hc = conversations.value.find((c) => c.id === hcId);
      if (hc) {
        const m = reactive<ChatMessage>({
          id: uuidv4(),
          role: "assistant",
          content: helpText,
          timestamp: Date.now(),
          streaming: false,
        });
        hc.messages.push(m);
        hc.updatedAt = Date.now();
        scheduleSave();
      }
      return;
    }

    // P0-6 预算护栏（发送前拦截）：
    // - 100%：默认**拦下**并让用户确认（可继续，但不支持「默默烧完」）
    // - 80%：预警一次（同档/同级/同天只提示一次，避免变成噪音）
    // - 未设预算：verdict.level = "ok" 且 notice 为空 → 完全不打扰
    {
      const verdict = budgetVerdict.value;
      if (verdict.level === "blocked") {
        await refreshUsageAgg(); // 用最新累计值判定，避免拿旧数据拦人
        const fresh = budgetVerdict.value;
        if (fresh.level === "blocked") {
          dbg(`[budget] 超预算：${fresh.notice.replace(/\n/g, " | ")}`);
          const ok = await askConfirm(
            `${fresh.notice}\n\n仍要继续这次对话吗？（建议先调高预算或换更便宜的模型）`,
          );
          if (!ok) return;
        }
      } else if (verdict.level === "warn") {
        const key = budgetNoticeKey(verdict);
        if (key && !budgetWarned.has(key)) {
          budgetWarned.add(key);
          void notify(verdict.notice, "warning");
        }
      }
    }

    let convId = activeConversationId.value;
    if (!convId) {
      convId = createConversation();
    }
    addUserMessage(convId, text, images, attachments);
    // P1-3：turn_start 钩子（失败不影响主流程；注入内容在下一轮回填）
    void fireHooks({ event: "turn_start" });

    // 用 reactive 创建，保证 push 后对 tokens/cost 等的赋值能触发响应式更新
    const assistantMsg = reactive<ChatMessage>({
      id: uuidv4(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      streaming: true,
    });
    const conv = conversations.value.find((c) => c.id === convId)!;

    // 先 push 占位消息 + 标记流式状态：界面立即显示"正在分析图片..."，
    // 避免 await 图片识别期间无任何反馈，看起来像卡死
    conv.messages.push(assistantMsg);
    conv.updatedAt = Date.now();
    resetStop(); // 新消息重置停止信号
    isStreaming.value = true;
    streamingContent.value = "";
    streamingReasoning.value = "";
    const startTime = Date.now();
    // turn_timing（吸收自 Codex 的 turn_timing：Sampling / Compaction / ToolBlocking 分段计时）：
    // 工具与压缩显式计时，采样（模型推理）用「总时长 - 工具 - 压缩」推导——不必逐个包住
    // 主循环/续写轮/收尾轮的调用点，测量口径仍清晰。轮末写一条结构化日志便于定位瓶颈。
    const turnTiming = { compaction: 0 };
    // 托盘进度：标记本轮开始（供展示已耗时），并清空上一轮的工具标签
    turnStartedAt.value = startTime;
    currentToolLabel.value = "";
    // 计费口径（AGENT_DIAGNOSIS 问题 1）：按轮累加真实输入/输出 token。
    // 旧实现直接把每轮的 total_tokens（含巨大 prompt）写进消息，且多轮时被最后一轮覆盖，
    // 导致「379 字回复 = 28240 tokens」这类不可解释的数值与虚高费用。
    // 注意：必须声明在 try 之外——finally（落库/计费）也要读它。
    const usageSum: RoundUsage = { prompt: 0, completion: 0, total: 0 };
    const addUsage = (u?: RoundUsage) => {
      if (!u) return;
      usageSum.prompt += u.prompt;
      usageSum.completion += u.completion;
      usageSum.total += u.total;
      // 最近一轮的 prompt 规模 = 当前上下文占用（get_context_remaining 用真实值而非估算）
      if (u.prompt > 0) lastPromptTokens = u.prompt;
    };

    // 图片预处理：主模型非视觉（如 DeepSeek）→ 先用本地 Ollama 识别图片转成文字描述。
    // 描述作为上下文注入 system（模型可见），不写入用户消息，避免"分析内容"污染用户对话。
    const isDS = (currentConfig.value.baseUrl || "").includes("deepseek");
    let descCtx = "";
    let ocrFailed = false;
    if (isDS && images && images.length > 0) {
      // 流式消息渲染读的是 chatStore.streamingContent（不是 message.content），
      // 写这里界面才会在 agent 气泡立即显示"正在分析图片..."，否则会一直显示"思考中..."
      streamingContent.value = "🔍 正在用本地视觉模型分析图片（首次较慢，约 1 分钟）...\n\n";
      // 用 try-catch 包住识别调用：若本地视觉模型异常（invoke 报错、参数问题等），
      // 走 ocrFailed 分支进入主流程的错误兜底，绝不让异常绕过 try/catch/finally
      // 导致气泡停留为空内容（assistantMsg.content 永不赋值）。
      // 识别可能耗时（本地推理最多约 140 秒），期间防止系统休眠。
      let desc = "";
      await setPreventSleep(true);
      try {
        desc = await describeImages(images);
      } catch (e) {
        console.warn("[道生一] 图片识别异常:", e);
      } finally {
        await setPreventSleep(false);
      }
      if (desc) {
        descCtx = `[用户上传了图片，经本地视觉模型识别，图片内容如下：]\n${desc}`;
        images = undefined;
      } else {
        ocrFailed = true;
      }
      streamingContent.value = ""; // 清空占位，交由后续流式回复填充
    }

    const unlistenFns: UnlistenFn[] = [];
    let inputTokens = 0;
    const memory = useMemorySystem();
    // 方案 B：流式工具循环的展示记录（工具卡片逐段累积，最终拼进 assistantMsg.content）
    const toolChain: string[] = [];
    const toolCards: ChatTool[] = [];

    try {
      // 本地图片识别失败/超时：明确报错，避免静默降级成空回复
      if (ocrFailed) {
        throw new Error(
          "本地图片识别失败或超时（请确认 Ollama 服务正常运行、llava-phi3 模型已下载）后重试",
        );
      }
      const config = currentConfig.value;
      if (!config.baseUrl || !config.apiKey) throw new Error("请先在设置中配置 API 地址和 Key");

      // 每次发送前都刷新 MCP 工具缓存（不只缓存为空时）——
      // 避免启动早期只拿到部分服务器的工具（如缺文件系统），导致模型误以为没有该工具。
      // 连接失败不阻塞发送：按需连接失败时用已有工具兜底。
      const mcpSettings = getSettings().mcpServers ?? [];
      if (mcpSettings.some((s) => s.enabled)) {
        // 按需连接：对话开始时连接启用的 MCP 服务器（启动不全连、用完即断），再刷新工具缓存
        try {
          await useMcpStore().connectEnabled();
        } catch {
          /* 连接失败不阻塞 */
        }
        try {
          await refreshMcpTools();
        } catch {
          /* 忽略 */
        }
      }

      // ---- 原生 function calling（Stage 2）：构建本会话的 OpenAI tools 注册表 ----
      // 把「内置工具 + MCP 工具」映射成唯一函数名发给模型；模型以结构化 tool_calls 返回，
      // 取代脆弱的文本 <tool_call> 解析。仅对明确支持原生 tools 的端点启用；
      // 可用 localStorage "daoshengyi_native_tools"="0" 强制关闭（回退文本模式）。
      let nativeDisabled = false;
      try {
        nativeDisabled = localStorage.getItem("daoshengyi_native_tools") === "0";
      } catch {
        /* ignore */
      }
      let nativeRegistry: NativeToolRegistry | null = null;
      if (!nativeDisabled && supportsNativeTools(config.baseUrl || "")) {
        nativeRegistry = buildNativeToolRegistry({
          builtins: BUILTIN_TOOLS.map((t) => ({ name: t.name, desc: t.desc })),
          // 已连接 MCP 工具 + 已启用但未连接浏览器的 puppeteer 占位（保证原生能看到
          // 浏览器自动化函数名，调用时按需激活连接）
          mcp: [
            ...mcpToolsCache.map((t) => ({
              server: t.server,
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              kind: "mcp" as const,
            })),
            ...browserStubTools(),
          ],
        });
      }
      // 传入 streamRound 的 tools 数组（null=关闭原生，走文本 <tool_call>）——注意是**同一数组引用**，
      // tool_search 激活新工具时直接 push，后续轮次自然可见。
      let nativeToolsOn: OpenAIFunctionTool[] | null =
        nativeRegistry && nativeRegistry.tools.length > 0 ? nativeRegistry.tools : null;
      // 交给 tool_search：命中未直接声明的工具时立即激活
      activeToolRegistry = nativeRegistry;
      toolSearchState = null; // 注册表已更新 → 检索索引下次使用时重建

      // 注入当前日期（防止日期幻觉），作为系统提示基础。
      // 用"天"粒度：每天只变一次，system 前缀稳定 → 历史消息可整段命中缓存。
      let spBase = config.systemPrompt || "你是道生一，一个AI桌面助手。";
      // Persona 人格：作为角色前缀注入（与技能库互补）
      const persona = getPersona(activePersonaId.value);
      if (persona) spBase = `${persona.prompt}\n\n${spBase}`;
      let sp = withMathRule(withCurrentDate(spBase));
      // §3.11 Agent 多模式：行为约束注入（人格管"我是谁"，模式管"怎么做"）
      const mode = getModeById(activeModeId.value);
      if (mode?.prompt) sp = `${sp}\n\n【当前模式：${mode.name}】\n${mode.prompt}`;
      // 命令沙箱提示（吸收自 Codex 的 SandboxMode）：开启时告知模型「写哪里会失败」，
      // 避免它反复试错或误判为工具坏了。
      {
        const sb = getSettings().sandboxMode;
        if (sb && sb !== "off") {
          const ws = getSettings().workspace || "（未设置工作区）";
          sp +=
            sb === "read-only"
              ? "\n\n【命令沙箱：只读】当前环境下命令**无法写入文件**（仅 /tmp 可写）。需要产出文件时请改用内置文件工具（write_file/apply_patch 等，不受沙箱限制），或先向用户申请关闭沙箱。"
              : `\n\n【命令沙箱：工作区可写】命令只能写入工作区目录：${ws}（/tmp 除外）。写到其它路径会被系统拒绝（不是权限/工具故障）——需要写到别处请改用内置文件工具，或向用户说明。`;
        }
      }
      // 工具发现提示：有未直接声明的工具时，告诉模型可用 tool_search 找（融合 Codex 做法）
      const deferredToolCount = nativeRegistry?.catalog.filter((c) => c.deferred).length ?? 0;
      if (deferredToolCount > 0) {
        sp +=
          `\n\n【工具发现】当前另有 ${deferredToolCount} 个工具**未直接列出**（长尾/MCP 工具）。` +
          "当你需要某类能力、但可用工具里找不到对应工具时，先调用 `tool_search` 用自然语言检索" +
          "（如 tool_search(\"数据库查询\")）——命中的工具会立即加入你的可用工具，下一轮即可直接调用。" +
          "不要因为「列表里没有」就放弃、改用别的方式凑，或编造结果。";
      }

      // ---- 稳定上下文：进 system（跨消息不变，保证前缀可缓存） ----
      // 注入技能（S3 渐进披露）：技能少/指令短 → 全量注入保持简单直接；
      // 技能多 → system 只放「路由清单」（体积小、稳定 → 前缀可缓存），
      // 完整正文按「当前请求命中」随本轮 volatileCtx 注入（见下 volatileCtx 区）。
      const skillStore = useSkillStore();
      const enabledSkillList = skillStore.enabledSkills();
      const skillTotalChars = enabledSkillList.reduce((n, s) => n + (s.prompt?.length || 0), 0);
      const skillProgressive =
        enabledSkillList.length > SKILL_DIRECT_INJECT_MAX_SKILLS &&
        skillTotalChars > SKILL_DIRECT_INJECT_CHARS;
      if (enabledSkillList.length > 0) {
        const skillBlock = skillProgressive
          ? `【可用技能路由】（与当前请求相关时其完整指令会自动随本轮注入，无需记忆全文）\n${buildSkillRoutingTable(enabledSkillList)}`
          : skillStore.enabledPrompts();
        sp = sp ? `${sp}\n\n---\n\n${skillBlock}` : skillBlock;
      }

      // 注入 MCP 工具（工具描述相对稳定）
      const mcpPrompt = getMcpToolsPrompt();
      if (mcpPrompt) sp = sp ? `${sp}\n\n${mcpPrompt}` : mcpPrompt;

      // P1-8 输出风格：在末尾追加风格段（幂等替换；默认/未知风格会剥掉旧风格段）
      sp = applyOutputStyle(sp, getSettings().outputStyle);

      // 原生 function calling：当 tools 走 API（tool_choice=auto）时，上文文本模式
      // 的「唯一方式是输出 <tool_call> JSON」引导已不适用 → 追加覆盖说明（共享常量，
      // 与子代理一致），让模型改用原生结构化 tool_calls（文本解析仍保留作兜底）。
      if (nativeToolsOn) {
        sp = `${sp}${NATIVE_TOOLS_NOTE}`;
      }

      // ---- 易变上下文：每次提问都不同 → 追加到最新用户消息末尾，不进 system ----
      // 若放进 system，每次提问 system 都变，会从 system 开始打断前缀缓存；
      // 放进最新 user 消息后，system+历史前缀保持不变，可整段命中缓存。
      const volatileCtx: string[] = [];
      // 精确时间（分钟级，放进本次上下文不伤缓存，模型仍能答"现在几点"）。
      // 补全完整日期：系统提示的天粒度日期对"今天"有效，但用户消息里再带一份
      // 完整日期+星期+时刻，双保险，进一步压低日期/时间幻觉。
      const nowDt = new Date();
      const todayStr = `${nowDt.getFullYear()}年${nowDt.getMonth() + 1}月${nowDt.getDate()}日 ${nowDt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", weekday: "long" })}`;
      volatileCtx.push(
        `【当前时间】现在是 ${todayStr} ${nowDt.toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })}（Asia/Shanghai）。`,
      );
      // 图片描述作为上下文（不展示在对话里，但模型可见）
      if (descCtx) volatileCtx.push(descCtx);
      // 注入文件上下文（PDF 走"分次浏览"：只给概要预览 + pdf_read 工具提示，按需分段读取）
      if (attachments && attachments.length > 0) {
        const fileCtx = attachments
          .map((f) => {
            const isPdf = f.mimeType === "application/pdf" || /\.pdf$/i.test(f.name);
            if (isPdf && f.path) {
              return (
                `\n--- PDF 文件: ${f.name}（共 ${f.content.length} 字符）---\n` +
                `[内容较长，先展示开头预览]\n${f.content.slice(0, 2500)}\n` +
                `[如需完整内容，请调用 pdf_read 工具分段读取：参数 path="${f.path}", offset 从 0 起按 4000 逐段]`
              );
            }
            return `\n--- 文件: ${f.name} ---\n${f.content.slice(0, 30000)}`;
          })
          .join("");
        volatileCtx.push(`[用户提供的文件上下文]\n${fileCtx}`);
      }
      // 联网搜索结果（enableWebSearch 开关 → 发送前自动搜索并可视化展示；非工具调用）
      // 跳过自动搜索：本地文件系统类（含本地路径/目录词）+ 文档/附件处理类（转表格/生成
      // 文档/整理/解读等，基于已给内容本地即可完成），例如「列出 /Users/xx 目录下的项目」
      // 「op目录」「转成清晰表格文档」都不应联网搜索；含明确联网意图词（新闻/最新/政策等）仍搜索
      const isLocalFsQuery = shouldSkipAutoSearch(text);
      if (config.enableWebSearch && text.trim() && !isLocalFsQuery) {
        // 先展示"正在联网搜索"，让用户看到搜索过程（与图片识别占位同理）
        const autoQuery = extractSearchKeywords(text.trim());
        streamingContent.value = `🌐 正在联网搜索：${autoQuery.slice(0, 24)}...`;
        try {
          const results = await invoke<{ title: string; url: string; snippet: string }[]>(
            "web_search",
            { query: autoQuery },
          );
          if (results.length > 0) {
            volatileCtx.push(formatSearchResults(autoQuery, results));
            // 搜索结果做成可见卡片（进 toolChain，随最终答案一起展示在气泡里）
            // URL 用 <url> autolink（而非 [t](url)），避免 URL 含 ) 等特殊字符时
            // markdown 链接被截断导致“地址不完整”
            const list = results
              .slice(0, 5)
              .map((r) => `- **${r.title}**\n  <${r.url}>\n  ${r.snippet}`)
              .join("\n");
            toolChain.push(
              `### 🌐 联网搜索\n\n**查询**：\`${autoQuery}\`\n\n` +
                `<details><summary>共 ${results.length} 条结果</summary>\n\n${list}\n\n</details>`,
            );
          } else {
            streamingContent.value = `🌐 联网搜索「${autoQuery}」未找到结果，继续回答...`;
          }
        } catch {
          /* 搜索暂不可用 */
        }
        streamingContent.value = ""; // 清空占位，交由流式回复填充
      }
      // 注入用户画像（跨会话沉淀的偏好/身份/环境，每次对话稳定带上）——5 秒超时兜底
      const profileText = await Promise.race([
        memory.getUserProfile(),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), 5000)),
      ]);
      if (profileText) volatileCtx.push(profileText);
      // 注入相关记忆（语义 + 关键词混合检索）——15 秒超时兜底，避免阻塞主对话
      const memText = await Promise.race([
        memory.retrieveMemories(text, config),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), 15000)),
      ]);
      if (memText) volatileCtx.push(memText);
      // S3 技能渐进披露：命中当前请求的技能 → 本轮注入其完整指令 + references
      // （system 里只放了路由清单；正文按需加载，避免技能一多全量注入挤爆上下文）
      if (skillProgressive && text.trim()) {
        const hitSkills = matchSkillsForMessage(text, enabledSkillList, SKILL_MATCH_MAX_HITS);
        if (hitSkills.length > 0) {
          // 技能 requires：命中即**自动激活所需工具 / 连接所需 MCP 服务器**
          // （与 tool_search 的延迟加载配套）；不可用的能力明确告知模型，不静默降级。
          const reqs = collectSkillRequires(hitSkills);
          const unavailable: string[] = [];
          for (const t of reqs.tools) {
            const entry = activeToolRegistry?.catalog.find((c) => c.tool === t || c.name === t);
            if (!entry) {
              unavailable.push(`工具 ${t}`);
              continue;
            }
            if (entry.deferred) activateCatalogTool(activeToolRegistry!, entry.name);
          }
          for (const s of reqs.servers) {
            try {
              await ensureMcpServerConnected(s);
            } catch {
              unavailable.push(`插件 ${s}`);
            }
          }
          const reqNote =
            reqs.tools.length > 0 || reqs.servers.length > 0
              ? `\n\n【本技能所需能力】` +
                (reqs.tools.length ? `工具：${reqs.tools.join("、")} ` : "") +
                (reqs.servers.length ? `插件：${reqs.servers.join("、")}` : "") +
                (unavailable.length
                  ? `\n⚠️ 当前不可用：${unavailable.join("、")}——请先用 tool_search 检索，或明确告知用户需要开启对应插件，不要静默用其它方式凑。`
                  : "（已就绪）")
              : "";
          const blocks = hitSkills.map((sk) => {
            const refs = (sk.references || [])
              .map((r) => `- ${r.title}：${r.content.slice(0, 1500)}`)
              .join("\n");
            return (
              `### 技能：${sk.name}` +
              (sk.whenToUse ? `\n适用场景：${sk.whenToUse}` : "") +
              `\n` +
              sk.prompt +
              (refs ? `\n\n【参考资料】\n${refs}` : "")
            );
          });
          volatileCtx.push(
            `[已加载与当前请求相关的技能完整指令，请遵循]\n\n${blocks.join("\n\n")}${reqNote}`,
          );
        }
      }
      // 知识库 RAG 自动注入：开启且配置默认知识库时，会话首轮自动检索相关分块注入上下文
      // （同一会话只注入一次，避免每轮重复灌入膨胀上下文；精细引用时模型可再手动 kb_search）——5 秒超时兜底
      if (!ragInjectedConvs.has(convId)) {
        const st = getSettings();
        if (st.ragEnabled && st.ragKb) {
          ragInjectedConvs.add(convId);
          const ragText = await Promise.race([
            (async () => {
              const hits = await invoke<
                {
                  id: number;
                  kb_name: string;
                  file: string;
                  chunk: string;
                  chunk_idx: number;
                  created_at: number;
                }[]
              >("kb_search", { kbName: st.ragKb, query: (text || "").slice(0, 60), limit: 4 });
              if (!hits || !hits.length) return "";
              return (
                `[知识库「${st.ragKb}」相关上下文（自动检索，供回答参考，非必须逐条引用）]\n` +
                hits.map((h) => `- ${h.file}：${h.chunk.slice(0, 400)}`).join("\n")
              );
            })(),
            new Promise<string>((resolve) => setTimeout(() => resolve(""), 5000)),
          ]);
          if (ragText) volatileCtx.push(ragText);
        }
      }
      // S2 项目指令发现：会话内每个工作区目录只注入一次 AGENTS.md/道生一.md 内容（4 秒超时兜底）
      const projCwd = getSettings().workspace;
      if (projCwd && !projInjectedCwd.has(projCwd)) {
        projInjectedCwd.add(projCwd);
        const projInstr = await Promise.race([
          discoverProjectInstructions(projCwd),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
        ]);
        if (projInstr) {
          volatileCtx.push(
            `【项目指令】（来源 ${projInstr.path}，自动发现注入）\n${projInstr.content}\n` +
              `[项目指令代表该项目的约定（编码规范/测试命令/目录说明），除非与用户当前明确指示冲突，否则应优先遵守。]`,
          );
        }
      }
      // 自动摘要旧消息——30 秒超时兜底，避免阻塞主对话
      const summaries = await Promise.race([
        memory.maybeSummarize(convId, conv.messages, config),
        new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 30000)),
      ]);
      for (const s of summaries) volatileCtx.push(`对话摘要: ${s}`);

      // 构建 Rust 格式消息
      // 目标注入（吸收自 Codex ext/goal）：跨回合目标 + token 预算，防跑题/防忘；
      // 目标完成（complete/abandoned）后不再注入。
      try {
        const g = getGoal(convId);
        if (g && g.status !== "complete" && g.status !== "abandoned") {
          volatileCtx.push(goalPrompt(g));
        }
      } catch {
        /* 忽略 */
      }
      // 自动压缩（吸收自 Codex 的自动 compaction）：占用达阈值时先把较早历史压成交接摘要，
      // 再装配历史 —— 不依赖模型自己想起来调 new_context_window。
      {
        const tCompact = Date.now();
        await maybeAutoCompact(conv, config);
        turnTiming.compaction += Date.now() - tCompact;
      }
      const maxCtx = config.maxContextMessages || 50;
      const histAll = conv.messages.filter((m) => m.role !== "system" && !m.streaming);
      const histStart = Math.max(0, histAll.length - maxCtx);
      const hist = histAll.slice(histStart);
      const rustMsgs: AgentMsg[] = [];
      // O1 智能上下文压缩：记录每条历史对应的原始会话消息序号（用于定位已被摘要覆盖的最老段）
      const rustOrig: (number | null)[] = [];
      if (sp) {
        rustMsgs.push({ role: "system", content: sp });
        rustOrig.push(null);
      }
      // 上下文压缩（融合 Codex 的 new_context_window）：被压缩掉的老历史不再逐条发送，
      // 改为先注入一段摘要（界面仍保留全部消息，只影响模型可见上下文）。
      const compactBefore = conv.compactBefore ?? 0;
      const compactSummary = conv.compactSummary ?? "";
      if (compactBefore > 0 && compactSummary) {
        rustMsgs.push({
          role: "user",
          content: `[已压缩的历史对话摘要（原始消息已从本次请求移除；需要细节可 read_file 已落盘产物）]\n${compactSummary}`,
        });
        rustOrig.push(null);
      }
      hist.forEach((m, i) => {
        if (compactBefore > 0 && histStart + i < compactBefore) return; // 已被摘要覆盖，跳过
        rustOrig.push(histStart + i);
        // DeepSeek 不支持图片：所有带图片的消息（含历史残留的图片消息）一律只发文本，
        // 避免收到 image_url 报 400；支持图片的模型才发送多模态。
        if (m.images?.length && !isDS) {
          rustMsgs.push({
            role: m.role,
            content: [
              { type: "text", text: m.content },
              ...m.images.map((img) => ({
                type: "image_url",
                image_url: { url: img.base64, detail: "auto" },
              })),
            ],
          });
        } else {
          rustMsgs.push({ role: m.role, content: m.content });
        }
      });

      // 把本次易变上下文追加到最新一条用户消息末尾（不进 system，保证 system+历史前缀稳定可缓存）
      if (volatileCtx.length > 0) {
        const lastUser = [...rustMsgs].reverse().find((m) => m.role === "user");
        if (lastUser && typeof lastUser.content === "string") {
          lastUser.content = `${lastUser.content}\n\n[本次补充上下文]\n${volatileCtx.join("\n\n")}`;
        } else {
          rustMsgs.push({ role: "user", content: `[本次补充上下文]\n${volatileCtx.join("\n\n")}` });
        }
      }

      // 发送前上下文总长保护 + O1 智能上下文压缩：历史里若残留超大消息
      //（如早期 directory_tree 全量结果被持久化进 SQLite），先尝试删除
      //「已被自动摘要覆盖（compaction）」的最老段——摘要已作为【对话摘要】
      // 注入本次补充上下文作补偿，避免粗暴砍掉还有价值的原文；仍不够再回退
      // 粗暴裁剪（保底不超模型上限，不因总长超限 break 导致回复中断）。
      const MAX_SEND_CHARS = 1_200_000;
      if (totalMsgChars(rustMsgs) > MAX_SEND_CHARS) {
        // 收集已被摘要覆盖的原始消息序号（summaries 表：会话自动摘要，落库复用、不重算）
        const covered = new Set<number>();
        try {
          const sums = await invoke<{ msg_range_start: number; msg_range_end: number }[]>(
            "get_summaries",
            { convId },
          ).catch(() => [] as { msg_range_start: number; msg_range_end: number }[]);
          for (const s of sums)
            for (let i = s.msg_range_start; i <= s.msg_range_end; i++) covered.add(i);
        } catch {
          /* 忽略 */
        }
        // 优先删除已被摘要覆盖的最老段（摘要已在 volatileCtx 补偿，保留其余原文）
        let pruned = true;
        while (totalMsgChars(rustMsgs) > MAX_SEND_CHARS && pruned && rustMsgs.length > 2) {
          pruned = false;
          for (let i = 1; i < rustMsgs.length; i++) {
            // 0 是 system，保留
            if (covered.has(rustOrig[i] as number)) {
              rustMsgs.splice(i, 1);
              rustOrig.splice(i, 1);
              pruned = true;
              break;
            }
          }
        }
        // 覆盖段删尽仍超长 → 回退粗暴裁剪（从最早非 system 删，保底不超限）
        while (totalMsgChars(rustMsgs) > MAX_SEND_CHARS && rustMsgs.length > 2) {
          const idx = rustMsgs.findIndex((m) => m.role !== "system");
          if (idx === -1) break;
          rustMsgs.splice(idx, 1);
          rustOrig.splice(idx, 1);
        }
      }
      // 裁剪后重算输入 token（用于费用计算）
      inputTokens = rustMsgs.reduce((sum, m) => {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return sum + estimateMessageTokens(text);
      }, 0);

      const rustCfg = {
        base_url: config.baseUrl,
        api_key: config.apiKey,
        model: config.model || "deepseek-v4-flash",
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        thinking_enabled: config.thinkingEnabled,
        reasoning_effort: config.reasoningEffort,
        system_prompt: sp,
        enable_web_search: config.enableWebSearch,
      };

      // ---- 方案 B：流式优先 + <tool_call> 流式检测工具循环 ----
      // 全程走 send_message 流式（思考过程与内容都逐字输出）；
      // 流式中一旦出现完整 <tool_call>...</tool_call> 标记，则停止本轮流式、
      // 执行工具、把结果塞回上下文、再发起新一轮流式，直到模型给出最终答案。
      // 不再使用 ReAct 非流式循环（chat_once），彻底恢复"逐字输出"体验。
      // DeepSeek 思考模式把工具调用写在 reasoning，且一次只规划一个工具、逐目录探索，
      // 轮次需求高（本次 list_directory×2 + read_multiple_files×2 就到 7 轮）——上限过低
      // 会导致最后一个工具被丢弃、无最终答案。故提高到 20 并在接近上限时提示收尾。
      // 2026-09-10：32→48。实测长任务（生成大报告：write_file + 分段 insert_string×N +
      // replace_string×N + 验证 run_command）第 31 轮仍在写正文就被上限掐断 → 模型没机会
      // 输出「plan_update 标末步 done + 最终汇报」，收尾轮又因不执行工具而正文空 →
      // markTaskPlanDoneIfPending 把 doing 兜底标 done，出现「计划全完成却无正文输出」。
      // 上限放大到 48 让收尾动作有足够轮次；MAX_CONTEXT_CHARS 仍会兜底防上下文失控。
      const MAX_TOOL_ROUNDS = 48;

      // 一轮流式：实时逐字输出思考/内容；检测到完整工具调用标记则立即结束本轮并返回工具调用。
      // - 传入 tools（原生 function calling）时：模型以结构化 tool_calls 返回工具调用，
      //   经 sse-tool-calls 事件捕获；文本 <tool_call> 检测仅作兜底（延迟到轮末解析）。
      // - 返回 toolCall 非空 → 文本模式工具调用（需执行后继续）；
      // - 返回 nativeCalls 非空 → 原生模式工具调用（一个或多个）；
      // - 两者都空 → 最终答案。
      async function streamRound(
        msgs: AgentMsg[],
        tools?: OpenAIFunctionTool[] | null,
      ): Promise<{
        toolCall: ToolCall | null;
        content: string;
        nativeCalls?: NativeToolCallMsg[] | null;
        finishReason?: string | null;
        /** 本轮 token 用量（usage 每轮只到一次；由主循环在轮末累加） */
        usage?: RoundUsage;
      }> {
        const nativeToolsActive = !!tools && tools.length > 0;
        streamingContent.value = ""; // 只清正文；思考过程跨轮累积（多轮思考链完整展示）
        const requestId = uuidv4(); // 本轮请求唯一 id：事件过滤，避免旧请求的 sse-delta/done 串扰新一轮
        activeStreamRequestId = requestId; // 暴露给 stopStreaming，用于取消 Rust 端生成
        let resolveDone!: () => void;
        let rejectDone!: (e: Error) => void;
        const doneP = new Promise<void>((resolve, reject) => {
          resolveDone = resolve;
          rejectDone = reject;
        });
        const roundUnlisten: UnlistenFn[] = [];
        let toolCall: ToolCall | null = null;
        let nativeCalls: NativeToolCallMsg[] | null = null;
        let roundFinish: string | null = null; // 本轮结束原因（stop/length/…），length=被 max_tokens 截断
        let toolBuffer = ""; // 累积本轮 content（含 tool_call 原始标记），供解析与回填
        let reasoningBuffer = ""; // 累积本轮 reasoning（DeepSeek 思考模式常把工具调用计划写在 reasoning 而非 content）
        let roundUsage: RoundUsage | undefined; // 本轮 usage（见下方 sse-delta 处理）
        let parseFailLogged = false; // 「有闭合标记但解析失败」每轮只记一次，避免每 chunk 刷屏日志

        // 空闲超时（替代旧的“固定总时长 120s”）：旧实现从请求发起算 120 秒总时长，
        // 长思考/大输出（单轮十几万 token 思考 + 持续推流）会超 120s 被误杀，
        // 表现就是反复“回复生成中断: 模型回复超时（120 秒）”。
        // 现在改为：只有「连续 IDLE_TIMEOUT_MS 收不到任何本轮数据」才判超时——
        // 模型在正常吐 token / 返回工具调用就永不中断；真卡死（网络停摆/服务端无响应）仍能兜底。
        const IDLE_TIMEOUT_MS = 120000;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const armIdleTimeout = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            rejectDone(new Error(`模型回复超时（${IDLE_TIMEOUT_MS / 1000} 秒无响应）`));
          }, IDLE_TIMEOUT_MS);
        };

        // 流式 UI 更新节流（性能优化）：sse chunk 毫秒级高频到达，若每 chunk 直接
        // 写 streamingReasoning/streamingContent，Vue 每 chunk 全量重渲染超长文本
        // （思考累积几十万字符 → 掉帧卡顿）。累积到 requestAnimationFrame
        // （≤1 次/帧）批量 flush；reasoningBuffer/toolBuffer 仍即时累积（供工具
        // 检测与解析），不依赖 UI 显示，不受节流影响。
        let uiRafPending = false;
        let uiReasoningAppend = "";
        let uiContentDirty = false;
        const flushStreamUI = () => {
          uiRafPending = false;
          if (uiReasoningAppend) {
            streamingReasoning.value += uiReasoningAppend;
            uiReasoningAppend = "";
          }
          if (uiContentDirty) {
            streamingContent.value = visibleText(toolBuffer);
            uiContentDirty = false;
          }
        };
        const scheduleStreamUI = () => {
          if (uiRafPending) return;
          uiRafPending = true;
          requestAnimationFrame(flushStreamUI);
        };

        roundUnlisten.push(
          await listen<{
            request_id?: string;
            reasoning_content?: string;
            content?: string;
            /** 该轮总 token（prompt + completion；仅诊断用） */
            tokens?: number;
            /** 该轮输入 token */
            prompt_tokens?: number;
            /** 该轮输出 token（真正的回复产出） */
            completion_tokens?: number;
            cache_hit?: number;
            cache_miss?: number;
          }>("sse-delta", (e) => {
            if (e.payload.request_id && e.payload.request_id !== requestId) return; // 忽略其他请求的事件
            const d = e.payload;
            // 有数据到达 → 模型活跃，重置空闲超时（避免长回复被“总时长”误杀）
            if (d.reasoning_content || d.content) armIdleTimeout();
            if (d.reasoning_content) {
              // UI 更新并入 rAF 节流（reasoningBuffer 仍即时累积，供工具检测/解析）
              uiReasoningAppend += d.reasoning_content;
              reasoningBuffer += d.reasoning_content;
              scheduleStreamUI();
              // DeepSeek 思考模式把工具调用计划（<tool_call>{JSON}</tool_call>）写在
              // reasoning（隐藏思考）里、content 只留简短正文 → 必须也从 reasoning 检测，
              // 否则工具永不执行、回复中断（现象：思考很长但正文只有一句话"断了"）。
              // 原生 function calling 模式下禁用此检测：思考里手写的 <tool_call> 只是计划文本，
              // 真实工具调用以结构化 tool_calls 返回，绝不能因推理文本提前结束本轮。
              if (!nativeToolsActive && !toolCall && hasCompleteToolCall(reasoningBuffer)) {
                const parsed = parseToolCall(reasoningBuffer);
                if (parsed) {
                  toolCall = parsed;
                  dbg(
                    `[round ${requestId.slice(0, 8)}] 思考中发现工具调用 ${parsed.server}/${parsed.tool}`,
                  );
                  resolveDone();
                }
              }
            }
            if (d.content) {
              toolBuffer += d.content;
              // 实时显示"可见正文"（统一在 rAF flush 里重算）：剔除工具调用标记
              // （含未闭合的半截），避免模型连续输出多个工具调用时
              // <｜DSML｜tool_call｜> 原始标记闪现成乱码
              uiContentDirty = true;
              scheduleStreamUI();
              // 检测到完整的工具调用闭合标记才解析（避免把流式中途的半截 JSON 当工具调用）；
              // 兼容标准 </tool_call> 与 DeepSeek DSML </｜DSML｜tool_call｜> 闭合标记，
              // 解析成功 → 提前结束本轮流式，转去执行工具。
              // 原生模式禁用提前解析：正文如出现标记文本，留到轮末作为兜底统一解析。
              if (!nativeToolsActive && !toolCall && hasCompleteToolCall(toolBuffer)) {
                const parsed = parseToolCall(toolBuffer);
                if (parsed) {
                  toolCall = parsed;
                  dbg(
                    `[round ${requestId.slice(0, 8)}] 检测到工具调用 ${parsed.server}/${parsed.tool}，buffer长度=${toolBuffer.length}`,
                  );
                  resolveDone();
                } else if (!parseFailLogged) {
                  // 每轮只记一次：该检测在每个 chunk 都会跑，逐次打印曾把日志撑到百万行
                  parseFailLogged = true;
                  dbg(
                    `[round ${requestId.slice(0, 8)}] 有闭合标记但解析失败（后续同轮不再记录），buffer=${toolBuffer.slice(-200)}`,
                  );
                }
              }
            }
            // 计费口径（AGENT_DIAGNOSIS 问题 1 修复）：usage 每轮只到一次，分开记录输入/输出，
            // 由主循环在轮末累加。绝不能把 total_tokens 当成「回复 token」——它含巨大 prompt。
            if (d.prompt_tokens != null || d.completion_tokens != null || d.tokens) {
              const prompt = d.prompt_tokens ?? 0;
              const completion = d.completion_tokens ?? 0;
              roundUsage = {
                prompt,
                completion,
                total: d.tokens ?? prompt + completion,
              };
              if (d.cache_hit) cacheHitTotal.value += d.cache_hit;
              if (d.cache_miss) cacheMissTotal.value += d.cache_miss;
            }
          }),
          // 原生 function calling：Rust 在流式结束时（sse-done 前）把整轮累积的
          // tool_calls 分片合并成结构化调用发来 → 捕获后交给主循环执行。
          await listen<{
            request_id?: string;
            tool_calls?: NativeToolCallMsg[];
          }>("sse-tool-calls", (e) => {
            if (e.payload.request_id && e.payload.request_id !== requestId) return;
            armIdleTimeout(); // 收到模型返回的工具调用 → 仍活跃，重置空闲超时
            if (e.payload.tool_calls && e.payload.tool_calls.length > 0) {
              nativeCalls = e.payload.tool_calls;
              dbg(
                `[round ${requestId.slice(0, 8)}] 收到原生 tool_calls ${e.payload.tool_calls.length} 个`,
              );
            }
          }),
          await listen<{ request_id?: string; error?: string }>("sse-error", (e) => {
            if (e.payload.request_id && e.payload.request_id !== requestId) return;
            rejectDone(new Error(e.payload.error || "模型流式错误"));
          }),
          await listen<string | { request_id?: string; finish_reason?: string }>(
            "sse-done",
            (e) => {
              const p = e.payload;
              // 兼容两种载荷：取消路径直接发 request_id 字符串；正常结束发 {request_id, finish_reason}
              if (typeof p === "string") {
                if (p && p !== requestId) return;
              } else if (p) {
                if (p.request_id && p.request_id !== requestId) return;
                if (p.finish_reason) roundFinish = p.finish_reason;
              }
              resolveDone();
            },
          ),
        );

        // 发起流式（不 await）。注意：stream_chat 失败（网络/Key/模型名错误）时 Rust 直接
        // return Err 而不会 emit sse-error，必须把 invoke 的真实错误也交给 rejectDone，
        // 否则前端只会干等到 120 秒超时；正常路径 invoke resolve、重复 reject 无害。
        dbg(
          `[round ${requestId.slice(0, 8)}] 发起 send_message，messages=${msgs.length}，原生tools=${nativeToolsActive}`,
        );
        invoke("send_message", {
          requestId,
          config: rustCfg,
          messages: msgs,
          ...(tools && tools.length ? { tools } : {}),
        }).catch((e) => {
          dbg(
            `[round ${requestId.slice(0, 8)}] invoke send_message 错误: ${e instanceof Error ? e.message : String(e)}`,
          );
          rejectDone(e instanceof Error ? e : new Error(String(e)));
        });

        // doneP 加超时兜底：若 Rust 流式一直不返回（网络卡死），超时抛错进入外层 catch，
        // 确保 finally 一定执行、气泡不会卡死成空泡泡；
        // 无论正常结束还是抛错，都要移除本轮监听，避免事件监听泄漏
        // 首次武装空闲超时：真正“卡死无响应”（从发起起连续 IDLE 秒一个字节都没有）
        // 才会中断；此后每收到一个 delta/tool_calls 都会重置 → 正常长回复永不误杀。
        armIdleTimeout();
        try {
          await Promise.race([
            doneP,
            waitStopSignal(), // 用户停止 → 提前结束本轮流式（工具循环随后 break）
          ]);
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
          flushStreamUI(); // 轮末强制落盘剩余 UI 缓冲（不等下一帧），保证不丢尾部
          roundUnlisten.forEach((f) => f());
        }
        // 原生模式兜底：模型若没走原生 tool_calls、却在正文手写了完整 <tool_call>
        // （可能仍遵循文本指令），轮末统一按文本解析执行，避免“写了不执行”。
        if (nativeToolsActive && !nativeCalls && !toolCall && hasCompleteToolCall(toolBuffer)) {
          const parsed = parseToolCall(toolBuffer);
          if (parsed) {
            toolCall = parsed;
            dbg(
              `[round ${requestId.slice(0, 8)}] 原生模式正文文本工具调用兜底 ${parsed.server}/${parsed.tool}`,
            );
          }
        }
        return { toolCall, content: toolBuffer, nativeCalls, finishReason: roundFinish, usage: roundUsage };
      }

      // 原生 function calling：执行一轮返回的结构化工具调用（一个或多个）。
      // 流程：把 assistant 消息（含 tool_calls）回填 → 逐个执行 → 每个结果以
      // role:"tool" + tool_call_id 回填 → 主循环继续下一轮。
      async function handleNativeRound(
        calls: NativeToolCallMsg[],
        roundContent: string,
      ): Promise<void> {
        const normCalls: NativeToolCallMsg[] = calls.map((c) => ({
          id: c.id || `call_${uuidv4()}`,
          type: "function",
          function: {
            name: c.function?.name || "",
            arguments: c.function?.arguments || "{}",
          },
        }));
        // assistant 消息带 tool_calls 原样回填（OpenAI/DeepSeek 续接必需）
        rustMsgs.push({
          role: "assistant",
          content: visibleText(roundContent),
          tool_calls: normCalls,
        });
        dbg(`[tool-native] 本轮 ${normCalls.length} 个原生工具调用`);
        for (const call of normCalls) {
          if (stopRequested) break;
          const fnName = call.function?.name || "";
          const ref = nativeRegistry?.byName.get(fnName) ?? null;
          const args = parseNativeArguments(call.function?.arguments);
          const startTool = Date.now();
          const argsStr = JSON.stringify(args, null, 2);
          if (!ref) {
            // 模型返回了未注册函数名：把错误作为 tool 结果反馈，让它换正确的工具
            const err = `未知工具「${fnName}」：不在本会话可用工具列表中。请从系统给出的函数列表选择正确的工具名（不要臆造）。`;
            dbg(`[tool-native] 未知工具 ${fnName}`);
            toolChain.push(`> ❌ 工具调用失败: \`${err}\``);
            toolCards.push({
              name: fnName,
              server: "?",
              status: "error",
              durationMs: Date.now() - startTool,
              argsPreview: argsStr.slice(0, 300),
              error: err.slice(0, 300),
            });
            streamingContent.value = `> ❌ 工具调用失败: \`${err}\``;
            rustMsgs.push({ role: "tool", tool_call_id: call.id, content: `错误: ${err}` });
            continue;
          }
          const { server, tool } = ref;
          if (isRealWorkTool(tool)) didRealWork = true;
          const serverName = server !== "app" ? `（${server}）` : "";
          streamingContent.value = `🔧 正在调用工具：${tool}${serverName}...`;
          dbg(`[tool-native] 开始执行 ${server}/${tool}，args=${argsStr.slice(0, 120)}`);
          try {
            const result = await callToolStoppable(server, tool, args);
            if (stopRequested) break;
            noteToolOutcome(tool, true); // 计入当前执行步骤的成功计数
            const clipped = formatToolResultPreview(tool, result);
            const card =
              `### 🔧 调用工具：\`${tool}\`\n\n` +
              `<details><summary>参数</summary>\n\n\`\`\`json\n${argsStr.slice(0, 400)}\n\`\`\`\n\n</details>` +
              `\n<details><summary>✅ 工具结果</summary>\n\n\`\`\`\n${clipped}\n\`\`\`\n\n</details>`;
            toolChain.push(card);
            toolCards.push({
              name: tool,
              server,
              status: "done",
              durationMs: Date.now() - startTool,
              argsPreview: argsStr.slice(0, 300),
              resultPreview: clipped.slice(0, 300),
            });
            streamingContent.value = card; // 展示卡片（下一轮流式在其后追加最终答案）
            // role:"tool" 结果原样回填（无需 <tool_result> 文本包裹，API 原生语义）。
            // O4：外部抓取类工具结果仍先 markExternalToolResult 包裹【不可信内容】边界，
            // 防注入；再截断防上下文膨胀。
            rustMsgs.push({
              role: "tool",
              tool_call_id: call.id,
              content: await foldToolResult(tool, markExternalToolResult(tool, result)),
            });
            dbg(`[tool-native] ${tool} 执行成功，结果长度=${result.length}`);
          } catch (e: unknown) {
            if (e instanceof AgentStoppedError) throw e; // 用户停止 → 立即退出工具循环
            const err = e instanceof Error ? e.message : String(e);
            dbg(`[tool-native] ${tool} 执行失败: ${err}`);
            noteToolOutcome(tool, false); // 计入当前执行步骤的失败计数
            const card = `> ❌ 工具调用失败: \`${err}\``;
            toolChain.push(card);
            toolCards.push({
              name: tool,
              server,
              status: "error",
              durationMs: Date.now() - startTool,
              argsPreview: argsStr.slice(0, 300),
              error: err.slice(0, 300),
            });
            streamingContent.value = card;
            rustMsgs.push({
              role: "tool",
              tool_call_id: call.id,
              content: `错误: ${await foldToolResult(tool, err)}`,
            });
          }
        }
      }

      // 主循环：发起流式；若返回工具调用则执行并把结果回填上下文后继续
      let round = 0;
      let planNudged = false; // 任务模式是否已强制提示创建任务计划（至多一次）
      let didRealWork = false; // 本轮是否真正执行过“实际工作”类工具（非 plan_*）
      // P1-6 自动续跑规则表状态：各规则本轮已纠偏次数 + 本轮总续跑次数
      const continueAttempts: Record<string, number> = {};
      let autoContinues = 0;
      resetTurnToolStats();
      resetVerificationReceipts(); // P0-5：回合开始清空验证凭据与文件改动计数
      let fakeCompletionWarned = false; // 是否已就“假完成”给出纠正（至多一次）
      let roundResult: {
        toolCall: ToolCall | null;
        content: string;
        nativeCalls?: NativeToolCallMsg[] | null;
        finishReason?: string | null;
        usage?: RoundUsage;
      } | null = null;
      let nativeDegraded = false; // 首次轮因原生 tools 报错 → 已降级为文本模式
      while (round < MAX_TOOL_ROUNDS) {
        if (stopRequested) break; // 用户停止 → 立即退出工具循环
          if (stopRequested) break; // 用户停止 → 立即退出工具循环
        dbg(
          `[loop] 第 ${round} 轮开始 streamRound，messages=${rustMsgs.length}，原生=${!!nativeToolsOn}`,
        );
        try {
          flushHookInjections(rustMsgs); // P1-3：钩子注入在下一轮开头回填
          flushPendingViewImages(rustMsgs); // view_image 图片在下一轮注入
          roundResult = await streamRound(rustMsgs, nativeToolsOn);
        } catch (e) {
          // 端点不支持原生 tools（或首轮异常与 tools 相关）→ 降级文本模式重试本
          // 轮（错误发生在内容产出前，rustMsgs 未变）；仅对“本会话已启用原生”的首轮生效。
          const em = e instanceof Error ? e.message : String(e);
          const toolsRelated =
            /tool|function|tool_calls/i.test(em) || /argument/i.test(em);
          if (nativeToolsOn && !nativeDegraded && round === 0 && toolsRelated) {
            nativeDegraded = true;
            nativeToolsOn = null;
            nativeRegistry = null;
            dbg(`[loop] 原生 tools 首轮报错（${em.slice(0, 120)}）→ 降级文本模式重试`);
            continue; // 不动 round，重发同一轮（不带 tools）
          }
          throw e;
        }
        if (stopRequested) break; // 本轮流式返回后仍被停止 → 不再处理/重试
        const nativeCalls = roundResult.nativeCalls ?? null;
        // 原生工具调用（可多个）→ 结构化执行并把结果（role:tool）回填后继续下一轮
        if (nativeCalls && nativeCalls.length > 0) {
          // 任务模式护栏（原生路径）：目标须先建计划再干活。模型若直接原生调用了实际工具
          // （如 analyze_project）而计划还没建 → 丢弃本轮调用，强制先 plan_task，
          // 让下一轮以原生 plan_task 开头重建计划（保证任务进度卡片出现）。
          const hasPlanCall = nativeCalls.some((c) => {
            const nm = c.function?.name;
            const ref = nm ? nativeRegistry?.byName.get(nm) : null;
            return ref?.kind === "builtin" && ref.tool === "plan_task";
          });
          if (isTaskModeActive() && !useChatStore().taskPlan && !planNudged && !hasPlanCall) {
            planNudged = true;
            round++;
            dbg(`[loop] 任务模式（原生）未建计划，第 ${round} 轮强制要求 plan_task`);
            rustMsgs.push({
              role: "user",
              content:
                "⚠️ 你处于【任务模式】，但还没有创建任务计划。你上一条直接要调用实际工作工具而跳过了规划。\n" +
                '请**立即**用原生工具调用 `plan_task` 为当前目标创建任务计划（参数 {"title":"目标标题","steps":["子步骤1","子步骤2",...]}），' +
                "再用 `plan_update` 逐步标记进度并执行；在计划建立前**不要**调用其它实际工作工具。",
            });
            continue;
          }
          dbg(`[loop] 第 ${round} 轮返回原生 tool_calls ${nativeCalls.length} 个`);
          await handleNativeRound(nativeCalls, roundResult.content);
          round++;
          if (round >= MAX_TOOL_ROUNDS) break; // 达到轮次上限，停止循环
          if (totalMsgChars(rustMsgs) > MAX_CONTEXT_CHARS) break; // 上下文总长保护
          continue;
        }
        const tc = roundResult.toolCall;
        addUsage(roundResult.usage); // 累加本轮真实用量（usage 每轮只到一次）
        dbg(
          `[loop] 第 ${round} 轮结束，toolCall=${tc ? `${tc.server}/${tc.tool}` : "null"}，本轮content长度=${roundResult.content.length}`,
        );
        if (!tc) {
          // 任务模式但尚未创建任务计划：模型可能在思考中反复"要建计划"却没真正调用
          // → 强制它立即 plan_task，避免空想太久。
          if (isTaskModeActive() && !useChatStore().taskPlan && !planNudged) {
            planNudged = true;
            round++;
            dbg(`[loop] 任务模式尚未建计划，第 ${round} 轮强制要求 plan_task`);
            rustMsgs.push({ role: "assistant", content: roundResult.content });
            rustMsgs.push({
              role: "user",
              content:
                "⚠️ 你处于【任务模式】，但还没有创建任务计划。请**立即**调用 plan_task 为当前目标创建任务计划（参数 {\"title\":\"目标标题\",\"steps\":[\"子步骤1\",\"子步骤2\",...]}），再用 plan_update 逐步标记进度并执行。不要继续空想。",
            });
            continue;
          }
          // 模型**尝试**了工具调用（正文出现闭合标记）但解析失败：
          // 空 <tool_call></tool_call>、JSON 不合法、或写成「### 🔧 调用工具」卡片文本。
          // 这些都不会真正执行工具 → 回复中断（用户看到"断了"）。
          // 这里主动注入修正指令重试一轮，而不是直接放弃。
          if (hasCompleteToolCall(roundResult.content) && round + 1 < MAX_TOOL_ROUNDS) {
            round++;
            dbg(`[loop] 工具调用格式无效（有闭合标记但解析失败），第 ${round} 轮注入修正指令重试`);
            rustMsgs.push({ role: "assistant", content: roundResult.content });
            rustMsgs.push({
              role: "user",
              content:
                "⚠️ 你上一条回复里的工具调用格式无效：要么是空的 <tool_call></tool_call>，要么 JSON 不合法，要么写成了「### 🔧 调用工具」卡片文本——这些都**不会真正执行工具**。\n" +
                "请重新用**唯一合法格式**输出：\n" +
                '<tool_call>\n{"server":"文件系统","tool":"工具名","arguments":{...}}\n</tool_call>\n' +
                "JSON 必须是合法对象且含 server、tool、arguments 三个字段；不要写卡片文本，不要输出空标记。",
            });
            continue; // 重新发起一轮流式
          }
          // 有工具调用**意图**但未形成完整可解析调用（开标记未闭合 / DSML 半截 / 流式截断）：
          // 模型想调工具却因标记不完整没执行 → 正文只剩残句（用户看到「回复中断」）。
          // 注入修正指令重试一轮，要求补全成完整合法的 <tool_call>。
          if (hasToolCallIntent(roundResult.content) && round + 1 < MAX_TOOL_ROUNDS) {
            round++;
            // write_file 大 content 截断：模型把整份 HTML 塞进一个 write_file 的 content，
            // 超过单次输出上限被截断（有 write_file 开标记且已输出不少 content 但仍无 </tool_call>）。
            // 这种场景重试一次性大输出只会再截断 → 必须引导改为分段写入。
            const isBigWriteFile =
              /write_file/.test(roundResult.content) &&
              /"content"\s*:/.test(roundResult.content) &&
              roundResult.content.length > 2000;
            dbg(
              `[loop] 检测到工具调用意图但未闭合/解析失败（大 write_file 截断=${isBigWriteFile}），第 ${round} 轮注入修正指令重试`,
            );
            rustMsgs.push({ role: "assistant", content: roundResult.content });
            rustMsgs.push({
              role: "user",
              content: isBigWriteFile
                ? "⚠️ 你上一条 **write_file 调用因 content 过长被截断**，`</tool_call>` 未闭合，文件没有写入；再一次性输出仍会被截断。\n" +
                  "**改用分段写入（禁止一次塞整份文件）**：\n" +
                  "① 先 `write_file` 写文件**开头部分**，末尾放唯一占位标记 `<!--MORE-->`（HTML 根标签 `<html>`/`</html>` 在本段内闭合，保证文件合法）；\n" +
                  '② 用 `insert_string` 逐段追加：`{"path": 同一路径, "anchor": "<!--MORE-->", "position": "before", "new_text": "<下一段>\\n<!--MORE-->"}`；\n' +
                  "③ 重复 ② 直到写完，最后一次 `new_text` 不要留 `<!--MORE-->`，让文件完整收尾。\n" +
                  "每次工具调用的内容 ≤ 2500 字符。不要重试一次性大输出。"
                : "⚠️ 你上一条回复想调用工具，但工具调用标记不完整/格式异常（未闭合、半截或乱码），工具**没有真正执行**，回复因此中断。\n" +
                  "请重新输出**完整合法**的工具调用：\n" +
                  '<tool_call>\n{"server":"app","tool":"工具名","arguments":{...}}\n</tool_call>\n' +
                  "必须是完整的开/闭合标记、JSON 合法且含 server、tool、arguments 字段。若确实不需要工具，直接在正文给出完整答案。",
            });
            continue;
          }
          // 正文空洞（模型口头承诺要做某事、却未调用工具也未给实质内容，如
          // 「搜索与问题无关，我直接访问官网获取办事指南」）→ 注入指令要求真正执行
          // 或直接完整作答后重试一轮，避免「工具卡片 + 一句意图声明」就断头。
          if (isVagueBody(roundResult.content) && round + 1 < MAX_TOOL_ROUNDS) {
            round++;
            dbg(`[loop] 正文空洞（仅过程声明），第 ${round} 轮注入指令要求实际执行或完整作答`);
            rustMsgs.push({ role: "assistant", content: roundResult.content });
            rustMsgs.push({
              role: "user",
              content:
                "⚠️ 你上一条回复只声明了『要做某事』（例如“访问官网获取信息”“接下来去查询”“搜索与问题无关，我直接…”），既没有实际调用工具，也没有给出实质内容——这样的回复不算完成任务。\n" +
                "请二选一：\n" +
                "1) 若确实还需要信息：立即输出 <tool_call> 调用对应工具（如 fetch_page 抓取网页 / web_search 重新搜索）真正获取数据，再继续；\n" +
                "2) 若已有足够信息：直接在正文给出**完整、详细、结构化的最终回答**（结论 / 步骤 / 要点）。\n" +
                "不要只写过程声明，不要输出空 <tool_call>。",
            });
            continue; // 重新发起一轮流式
          }
          // 防“假完成”：任务模式下若建了计划、却全程没执行任何实际工作工具，
          // 不能作为最终答案退出（避免只播报计划就宣称“全部完成”）。
          if (isTaskModeActive() && useChatStore().taskPlan && !didRealWork && !fakeCompletionWarned) {
            fakeCompletionWarned = true;
            round++;
            dbg(`[loop] 任务模式但未执行任何实际工具，第 ${round} 轮强制要求真正执行`);
            rustMsgs.push({ role: "assistant", content: roundResult.content });
            rustMsgs.push({
              role: "user",
              content:
                "⚠️ 你创建了任务计划，但到目前为止**还没有执行任何实际操作**（未调用任何文件/命令/测试/检索等工具），不能算完成，更不要声称“全部完成”。\n" +
                "请二选一：\n" +
                "1) 真正去执行目标：调用相应工具（如 list_dir / read_file / write_file / run_command / run_tests / web_search 等）完成工作并验证结果；\n" +
                "2) 若确实无需任何工具即可回答，直接在正文给出完整答案并说明“无需工具即可完成”。",
            });
            continue;
          }
          // P0-5 验证凭据 + P1-6 自动续跑规则表：
          // 收尾时按问题类型（工具全失败 / 验证凭据缺失 / 计划未完 / 目标未达成 / 正文为空）
          // 决定是否再给一轮，并注入针对性的纠偏文本。
          // 护栏（用户停止 / 预算阻断 / 轮数不足 / 本轮总次数 / 单规则次数）全部在纯函数里判定。
          if (round + 1 < MAX_TOOL_ROUNDS) {
            const planNow = useChatStore().taskPlan;
            const signals: TurnSignals = {
              content: roundResult.content ?? "",
              verificationIssue: evaluateVerificationClaims(roundResult.content),
              plan: planNow ? { steps: planNow.steps.map((s) => ({ status: s.status })) } : null,
              goal: getGoal(activeConversationId.value || ""),
              toolSuccesses: turnToolOk,
              toolFailures: turnToolFail,
            };
            const verdict = planAutoContinue(signals, {
              attempts: continueAttempts,
              totalContinues: autoContinues,
              stopped: stopRequested,
              budgetBlocked: budgetVerdict.value.level === "blocked",
              remainingRounds: MAX_TOOL_ROUNDS - round - 1,
              failedTools: turnFailedTools,
            });
            if (verdict.action === "continue") {
              continueAttempts[verdict.reason] = verdict.attempt;
              autoContinues++;
              round++;
              await dbg(
                `[continue] 第 ${round} 轮注入纠偏（${verdict.ruleId} 第 ${verdict.attempt} 次；命中 ${verdict.reasons.join("+")}）`,
              );
              rustMsgs.push({ role: "assistant", content: roundResult.content });
              rustMsgs.push({ role: "user", content: verdict.nudge });
              continue;
            }
            if (verdict.reasons.length) {
              await dbg(`[continue] 不再续跑：${verdict.why}`);
            }
          }
          break; // 无工具调用 → 最终答案，退出循环
        }

        // 任务模式护栏（文本路径）：模型要执行**实际工作**工具却还没建计划 → 强制先
        // plan_task（plan_task/plan_update 不算实际工作，可正常执行并顺带建计划）。
        if (
          isTaskModeActive() &&
          !useChatStore().taskPlan &&
          !planNudged &&
          isRealWorkTool(tc.tool)
        ) {
          planNudged = true;
          round++;
          dbg(`[loop] 任务模式（文本）未建计划，第 ${round} 轮强制要求 plan_task`);
          rustMsgs.push({ role: "assistant", content: roundResult.content });
          rustMsgs.push({
            role: "user",
            content:
              "⚠️ 你处于【任务模式】，但还没有创建任务计划。你正准备执行实际工作而跳过了规划。\n" +
              '请**立即**调用 plan_task 为当前目标创建任务计划（参数 {"title":"目标标题","steps":["子步骤1","子步骤2",...]}），' +
              "再用 plan_update 逐步标记进度并执行；在计划建立前不要调用其它实际工作工具。",
          });
          continue;
        }

        round++;
        if (round >= MAX_TOOL_ROUNDS) {
          // 达到上限：直接停止工具循环（避免模型反复调工具造成死循环），
          // 以已执行的工具卡片收尾；streamingContent 若有残留工具 JSON 由 finally 剥离
          break;
        }
        // 上下文总长保护：工具结果持续回填会让 messages 逼近模型上限，
        // 接近阈值时停止继续调工具，避免下一轮请求 [400] 超长错误
        if (totalMsgChars(rustMsgs) > MAX_CONTEXT_CHARS) {
          break;
        }

        if (stopRequested) break; // 执行工具前再检查，避免停止后仍调工具（含子代理）
        // 内置工具 server 兜底映射：模型常省略 server 字段或写 "default"，
        // parseToolCall 会兜底成 "default" → 不映射成 "app" 就会误走 MCP 路径
        // 报「Tool xxx not found」；反之，MCP/浏览器工具（puppeteer_*）若被写成
        // app/builtin，则由 resolveToolServer 路由回真实服务器，避免误报「未知内置工具」。
        const toolServer = resolveToolServer(tc.server, tc.tool);
        if (isRealWorkTool(tc.tool)) didRealWork = true; // 记录确实执行了实际工作
        // 实时显示"正在调用工具"
        const serverName = toolServer !== "app" ? `（${toolServer}）` : "";
        streamingContent.value = `🔧 正在调用工具：${tc.tool}${serverName}...`;
        const argsStr = JSON.stringify(tc.arguments, null, 2);
        const startTool = Date.now();
        dbg(`[tool] 开始执行 ${toolServer}/${tc.tool}，args=${argsStr.slice(0, 120)}`);
        try {
          // 用户停止时立即中断（不等当前工具跑完），让「停止」即刻生效
          const result = await callToolStoppable(toolServer, tc.tool, tc.arguments);
          if (stopRequested) break; // 工具返回后被停止 → 不再回填继续下一轮
          noteToolOutcome(tc.tool, true); // 计入当前执行步骤的成功计数
          dbg(
            `[tool] ${tc.tool} 执行成功，结果长度=${result.length}，耗时=${Date.now() - startTool}ms`,
          );
          const clipped = formatToolResultPreview(tc.tool, result);
          const card =
            `### 🔧 调用工具：\`${tc.tool}\`\n\n` +
            `<details><summary>参数</summary>\n\n\`\`\`json\n${argsStr.slice(0, 400)}\n\`\`\`\n\n</details>` +
            `\n<details><summary>✅ 工具结果</summary>\n\n\`\`\`\n${clipped}\n\`\`\`\n\n</details>`;
          toolChain.push(card);
          toolCards.push({
            name: tc.tool,
            server: toolServer,
            status: "done",
            durationMs: Date.now() - startTool,
            argsPreview: argsStr.slice(0, 300),
            resultPreview: clipped.slice(0, 300),
          });
          streamingContent.value = card; // 展示卡片（下一轮流式在其后追加最终答案）
          rustMsgs.push({ role: "assistant", content: roundResult.content });
          // 承接上一轮工作的收尾提示：接近工具轮次上限，或任务计划已全部完成后，
          // 明确要求模型停止继续探索/重复工作，直接输出最终交付汇报。
          const planDoneAll = isTaskPlanAllDone();
          const closingHint = planDoneAll
            ? "\n\n✅ 任务计划已全部完成。请**立即停止继续调用工具**，直接在正文给出**完整、详细的最终交付汇报**（做了什么、各步骤结果、最终结论）；不要再新增或重复任何步骤。"
            : round >= MAX_TOOL_ROUNDS - 3
              ? "\n\n⚠️ 已接近工具调用次数上限（剩余次数有限）。请基于**当前已获取的全部目录/文件结果**直接给出完整、详细的最终分析总结，**不要再调用更多工具**。"
              : "";
          rustMsgs.push({
            role: "user",
            content: `<tool_result>\n${truncateToolResult(markExternalToolResult(tc.tool, result))}\n</tool_result>\n\n请基于工具结果继续回答用户的问题。${closingHint}`,
          });
        } catch (e: unknown) {
          if (e instanceof AgentStoppedError) throw e; // 用户停止 → 立即退出工具循环，不当作工具失败
          const err = e instanceof Error ? e.message : String(e);
          dbg(`[tool] ${tc.tool} 执行失败: ${err}`);
          noteToolOutcome(tc.tool, false); // 计入当前执行步骤的失败计数
          const card = `> ❌ 工具调用失败: \`${err}\``;
          toolChain.push(card);
          toolCards.push({
            name: tc.tool,
            server: toolServer,
            status: "error",
            durationMs: Date.now() - startTool,
            argsPreview: argsStr.slice(0, 300),
            error: err.slice(0, 300),
          });
          streamingContent.value = card;
          rustMsgs.push({ role: "assistant", content: roundResult.content });
          // 精确编辑失败（old_text/anchor 与实际文件不一致）：不让模型直接放弃，
          // 强制先 read_file 核对实际内容后以精确原文重试——避免分段写入/占位符类任务半途而废
          const editRetryHint =
            /未找到文本|未找到锚点/.test(err) &&
            /^(replace_string|insert_string|delete_file)$/.test(tc.tool)
              ? "\n\n⚠️ **精确编辑失败：old_text/anchor 与实际文件内容不一致（文件未改动）**。请**务必**先用 `read_file` 读取该文件（长文件请用较大 `offset` 读**末尾**区域），找到**文件中实际存在**的精确文本，再重新发起 replace_string/insert_string。注意分段占位 `<!--MORE-->` 可能多次出现或与相邻内容连排，必须逐字复制、可用 `occurrence` 指定第几次出现。**禁止臆测文件内容、禁止原样重试、禁止直接向用户报告失败**——修正后必须重试成功。"
              : "";
          rustMsgs.push({
            role: "user",
            content: `<tool_result>\n错误: ${truncateToolResult(err)}\n</tool_result>\n\n工具调用失败，请直接回答或调整参数重试。${editRetryHint}`,
          });
        }
      }

      // ── 输出被 max_tokens 截断（finish_reason=length）→ 自动续写 ──
      // 根因：Profile 的 max_tokens（默认 4096）限制单次输出长度，长报告/多步汇报会写到一半
      // 被 API 截断；此前**完全不读 finish_reason**，半截话被当作最终答案收尾——现象就是
      // 「复制出的正文断在半句、任务计划剩余步骤永远停在待办」。这里把已生成部分回填为
      // assistant 消息，要求模型「紧接其后续写、不要重复」，直到不再截断或达到续写上限；
      // 用尽后附可见告警，绝不让截断静默发生。
      if (!stopRequested && roundResult?.finishReason === "length") {
        const MAX_TRUNCATION_CONTINUES = 2;
        let rawAcc = roundResult.content;
        let continues = 0;
        let stillTruncated = true;
        while (
          continues < MAX_TRUNCATION_CONTINUES &&
          !stopRequested &&
          round + 1 < MAX_TOOL_ROUNDS
        ) {
          continues++;
          round++;
          const tail = stripToolJson(rawAcc).trim().slice(-160);
          dbg(
            `[loop] 输出被 max_tokens 截断（finish_reason=length），第 ${continues}/${MAX_TRUNCATION_CONTINUES} 次自动续写`,
          );
          rustMsgs.push({ role: "assistant", content: rawAcc });
          rustMsgs.push({
            role: "user",
            content:
              "⚠️ 你上一条回复因达到**输出长度上限**而被截断，最后停在：\n…" +
              tail +
              "\n\n请**紧接其后续写**剩余内容：不要重复已写过的部分，不要重新开头，不要重新列提纲，直接从断点接着写完整。",
          });
          try {
            const fr = await streamRound(rustMsgs, nativeToolsOn);
            addUsage(fr.usage); // 续写轮的用量同样计入本轮总量
            const add = stripToolJson(fr.content).trim();
            if (!add) break;
            rawAcc = `${rawAcc}\n${add}`;
            // 把合并结果回写展示层，避免下一轮流式把前半段覆盖掉
            streamingContent.value = stripToolJson(rawAcc).trim();
            stillTruncated = fr.finishReason === "length";
            if (!stillTruncated) break;
          } catch (e) {
            dbg(`[loop] 续写轮失败: ${e instanceof Error ? e.message : String(e)}`);
            break;
          }
        }
        if (continues > 0 && stillTruncated && !stopRequested) {
          streamingContent.value =
            stripToolJson(rawAcc).trim() +
            `\n\n> ⚠️ 本次回复达到输出上限（max_tokens=${config.maxTokens ?? "?"}）被截断，已自动续写 ${continues} 次仍未写完。可在「设置 → API 配置」把 max_tokens 调大（如 8192/16384）后继续，或直接回复「继续」。`;
        }
      }

      // 工具循环结束：若执行了工具但正文没有最终答案（streamingContent 仍被工具卡片/占位占用，
      // 或为空），自动追加一轮强制模型在正文输出完整分析——避免"只有工具调用记录、没有分析结果"。
      // 关键：用户已停止（stopRequested）时**绝不追加收尾轮**——否则会再发起一次完整 LLM 请求，
      // 表现为“点了停止还在继续生成”。
      const sc = streamingContent.value.trim();
      const hasFinalAnswer = !isVagueBody(streamingContent.value);
      if (!stopRequested && toolChain.length > 0 && !hasFinalAnswer) {
        dbg(
          `[loop] 工具已执行但正文无实质答案（streamingContent=${sc.length} 字符，判定空洞=${isVagueBody(streamingContent.value)}），追加收尾轮`,
        );
        // 收尾轮强制要求「纯正文最终交付汇报」：此时工具已基本执行完毕，若模型仍尝试
        // 输出 <tool_call>（常见是 plan_update 想标末步 done），收尾轮并不会执行它 →
        // 正文被 stripToolJson 剥空，出现「只有工具卡片 + 空正文」，随后兜底标 done
        // 又造成「计划全完成却无任何文字输出」的假象。因此明确告知：本轮不执行工具、
        // 计划收尾由系统自动处理，只允许输出实实在在的汇报正文。
        rustMsgs.push({
          role: "user",
          content:
            "工具执行已结束，本回复为最终交付汇报轮：请把**完整、详细、结构化的最终回答**直接写在回复正文中" +
            "（做了什么 / 各步骤结果 / 最终结论 / 产物保存位置）。\n" +
            "⚠️ 本轮**不会执行任何工具调用**（包括 plan_update/plan_task——写了也不会执行，任务计划收尾由系统自动完成）。" +
            "请不要输出 <tool_call> 标记，也不要只写「已完成 / 全部完成 / 正在收尾」这类无实质内容的短句；" +
            "请给出**实实在在的交付内容**（结论、要点、数据、路径等）。",
        });
        try {
          flushPendingViewImages(rustMsgs); // view_image 图片在收尾轮也要注入
          const fr = await streamRound(rustMsgs);
          addUsage(fr.usage); // 收尾轮用量计入本轮总量
          const fc = stripToolJson(fr.content).trim();
          // 收尾轮产出也要防空洞：正文为空、只剩工具标记、或仍是一句"完成"短声明，
          // 都不算最终答案 → 退回思考摘要（剥标记后截尾）作为可见兜底，
          // 避免「空正文却显示计划全部完成」。仍无任何可用内容则给显式失败提示。
          if (fc.length > 0 && !isVagueBody(fc)) {
            streamingContent.value = fc;
          } else if (streamingReasoning.value) {
            const fallback = stripToolJson(streamingReasoning.value).trim().slice(-3000);
            streamingContent.value = fallback
              ? `（模型正文未输出实质内容，以下为思考摘要）\n\n${fallback}`
              : "⚠️ 模型未输出最终汇报正文。上方为已完成的工具执行记录，可据此查看产物或重发消息继续。";
          } else {
            streamingContent.value =
              "⚠️ 模型未输出最终汇报正文。上方为已完成的工具执行记录，可据此查看产物或重发消息继续。";
          }
        } catch (e) {
          dbg(`[loop] 收尾轮失败: ${e instanceof Error ? e.message : String(e)}`);
          // 收尾轮异常时也保证用户能看到可读内容，而不是空正文配「计划全完成」
          if (!streamingContent.value || isVagueBody(streamingContent.value)) {
            streamingContent.value =
              "⚠️ 最终汇报生成失败，但上方工具执行已基本完成。可查看已生成的产物或重新发送消息重试。";
          }
        }
      }
      // 任务收尾：若存在未完成的任务计划，把剩余 待办/进行中 步骤统一标记为 done
      //（确定性兜底，避免“实际做完但进度卡差一步没标 done”；failed 保留）。
      // 2026-09-10 守卫：仅当本轮确实产出了**实质正文交付**（非空洞）才做兜底标 done。
      // 若模型既没真正执行内容、正文仍空洞（收尾轮也失败等），保留 doing 状态而非
      // 标 done —— 避免「啥都没输出却把计划显示成全部完成」的假象。
      if (!isVagueBody(streamingContent.value)) {
        markTaskPlanDoneIfPending();
      }
      // Phase 3 收尾：本轮工具序列若成功且有复用价值 → 异步抽象成可复用工作流并沉淀。
      // 不 await（不拖慢本轮回复）；完成后把说明追加到消息尾部告知用户。
      if (!stopRequested && toolCards.length > 0) {
        const cardsSnapshot = toolCards.slice();
        void mineWorkflowFromTurn(text, cardsSnapshot).then((note) => {
          if (note) {
            assistantMsg.content = `${assistantMsg.content}\n\n> ${note}`;
            // 追加的说明晚于本轮落库，补一次保存，避免刷新后说明消失
            scheduleSave();
          }
        });
      }
      // 任务结束：断开浏览器服务器，形成使用闭环
      await closeBrowserIfOpen();
      // 系统通知：任务完成 / 最终产物就绪（窗口未聚焦时才打扰，避免盯着屏幕被弹窗打断）
      // 注：此处 streamingContent 已是本轮最终正文（finally 才做落库装配）
      notifyTurnFinished(streamingContent.value, toolCards.length);
      // P1-3：turn_end 钩子（notify/shell/http/inject 都会在这里触发）
      void fireHooks({
        event: "turn_end",
        status: "success",
        result: streamingContent.value.slice(0, 2000),
      });
    } catch (err: unknown) {
      if (err instanceof Error) {
        let msg = err.message;
        // 图片发送失败时给出明确引导（多为模型不支持图片输入）
        if (
          images &&
          images.length > 0 &&
          /400|unsupported|not.?support|image|content_type/i.test(msg)
        ) {
          msg +=
            "\n\n💡 当前模型可能不支持图片输入。请在「设置 → API 配置」中添加支持视觉能力的模型（如 OpenAI、Gemini、Qwen-VL 等），或切换到支持图片的模型。";
        }
        dbg(`[sendMessage] 外层错误: ${msg}`);
        // 修复：工具已执行过（streamingContent 被工具卡片占用、非空）时，错误分支
        // `|| '[错误]'` 不触发、错误被静默吞掉 → 用户只看到工具卡片没有最终答案。
        // 这里始终把错误以可见形式拼进 toolChain，确保任何中断都对用户可见。
        if (toolChain.length > 0) {
          toolChain.push(`> ❌ 回复生成中断: ${msg}`);
          streamingContent.value = ""; // 清空，让 finally 只拼 toolChain（含错误卡片）
        } else {
          streamingContent.value = streamingContent.value || `[错误] ${msg}`;
        }
      }
    } finally {
      activeStreamRequestId = null; // 本轮结束，清除当前流式 request_id
      dbg(
        `[sendMessage] finally: toolChain=${toolChain.length}，streamingContent=${streamingContent.value.length}，reasoning=${streamingReasoning.value.length}`,
      );
      unlistenFns.forEach((f) => f());
      // 流式兜底：剥离模型口头输出的工具调用 JSON；工具卡片（toolChain）逐段拼在最前
      const finalText = stripToolJson(streamingContent.value);
      assistantMsg.content =
        toolChain.length > 0
          ? finalText
            ? toolChain.join("\n\n") + "\n\n" + finalText
            : toolChain.join("\n\n")
          : finalText;
      if (toolCards.length > 0) assistantMsg.tools = toolCards;
      assistantMsg.reasoning_content = streamingReasoning.value || undefined;
      assistantMsg.duration = Number(((Date.now() - startTime) / 1000).toFixed(1));
      // Token 计数（口径修正，见 AGENT_DIAGNOSIS 问题 1）：
      // - tokens   = 本轮**总消耗**（多轮 prompt + completion 累加）→ 这才是实际付费量
      // - outputTokens = 本轮**回复产出**（completion 累加）→ 用于成本输出侧计价与展示细分
      // 老实现把单轮 total_tokens 当回复 token 且被最后一轮覆盖，数值不可解释（379 字 → 28240）。
      if (usageSum.total > 0) {
        assistantMsg.tokens = usageSum.total;
        assistantMsg.outputTokens = usageSum.completion;
      } else if (!assistantMsg.tokens) {
        // 无 usage（本地命令/上游未返回）→ 退回本地估算（只算可见产出）
        assistantMsg.tokens = estimateMessageTokens(
          streamingContent.value,
          streamingReasoning.value,
        );
      }
      // 费用估算：输入侧用真实 prompt token（缺则退回本地估算），输出侧用真实 completion token
      try {
        assistantMsg.cost = estimateCost(
          currentConfig.value.model,
          usageSum.prompt > 0 ? usageSum.prompt : inputTokens,
          usageSum.completion > 0 ? usageSum.completion : assistantMsg.tokens || 0,
        );
      } catch {
        /* 费用计算失败不影响主流程 */
      }
      assistantMsg.streaming = false;
      // turn_timing：轮末输出分段耗时（压缩显式计时；工具直接汇总 toolCards 的 durationMs；
      // 采样=总-工具-压缩）—— 用于定位「到底慢在推理、工具还是压缩」。
      {
        const totalMs = Date.now() - startTime;
        const toolsMs = toolCards.reduce((sum, c) => sum + (c.durationMs || 0), 0);
        const samplingMs = Math.max(0, totalMs - toolsMs - turnTiming.compaction);
        const s = (ms: number) => (ms / 1000).toFixed(1);
        await dbg(
          `[timing] 本轮 总 ${s(totalMs)}s｜采样(模型) ${s(samplingMs)}s｜工具 ${s(toolsMs)}s(${toolCards.length} 次)｜压缩 ${s(turnTiming.compaction)}s`,
        );
      }
      // 目标 token 预算累加（吸收自 Codex 的 goal token_budget）：本轮消耗计入当前目标，
      // 预算超支时下一轮注入的 goalPrompt 会要求模型收尾。
      try {
        const g = getGoal(convId);
        if (g) saveGoal(convId, addGoalUsage(g, usageSum.total || assistantMsg.tokens || 0));
      } catch {
        /* 目标记录失败不影响主流程 */
      }
      // 用量历史累计：即使删除会话也保留 token/费用统计（后端 usage_agg 表，按天累计）。
      // 只统计 LLM 消耗（/run、/read 等本地指令不走这里，不计入）。
      const aggTokens = assistantMsg.tokens || 0;
      const aggCost = assistantMsg.cost || 0;
      if (aggTokens > 0 || aggCost > 0) {
        invoke("accumulate_usage", {
          tokens: aggTokens,
          cost: aggCost,
          duration: assistantMsg.duration || 0,
          timestamp: assistantMsg.timestamp,
        })
          .then(() => refreshUsageAgg())
          .catch(() => {});
      }
      // 空回复诊断：内容为空时必现可操作提示，避免静默空泡泡。
      // 只有思考过程而无内容（如模型把工具调用 JSON 当唯一输出被剥离）也算空回复。
      if (!assistantMsg.content) {
        assistantMsg.content = assistantMsg.reasoning_content
          ? "⚠️ 模型仅返回了思考过程，未生成回复内容。可点击「🔄 重试」或换个说法再问。"
          : "⚠️ 未收到模型回复。可能原因：\n- 当前模型/API 不支持该请求（模型名无效、图片输入等）\n- API 地址或 Key 配置有误\n- 网络或服务端异常\n\n请检查「设置 → API 配置」或重试。";
      }
      streamingContent.value = "";
      streamingReasoning.value = "";
      isStreaming.value = false;
      conv.updatedAt = Date.now();
      scheduleSave();
      // 本轮彻底结束：若队列有待发消息则自动续跑（放在 isStreaming=false 之后）
      drainQueue();

      // 对话结束：用完断开 MCP 服务器，释放资源（浏览器等子进程随之关闭）
      useMcpStore()
        .disconnectAll()
        .catch(() => {});

      // 后台提取关键事实
      if (currentConfig.value.apiKey) {
        memory.extractFacts(convId, conv.messages, currentConfig.value).catch(() => {});
      }
    }
  }

  function stopStreaming() {
    isStreaming.value = false;
    // 停止 = 取消：同时清空排队消息（避免停止当前后立刻自动续跑，让用户觉得“停不住”）
    if (pendingTurns.value.length > 0) {
      dbg(`[queue] 用户停止生成，清空 ${pendingTurns.value.length} 条排队消息`);
      pendingTurns.value = [];
    }
    requestStop(); // 立即中断正在运行的子代理/主代理工具循环（不只是改标志）
    // 用户终止会话 → 把进行中任务计划标记为「已终止」，任务卡不再显示“进行中”转圈
    markTaskPlanTerminated();
    // 立刻取消 Rust 端当前流式生成：之前只在前端移除了监听，Rust 仍在继续拉流/emit/耗 token，
    // 用户会感觉「点了停止还在生成」。cancel_stream 让 Rust 在下一个 chunk 到达时停止。
    if (activeStreamRequestId) {
      const rid = activeStreamRequestId;
      activeStreamRequestId = null;
      invoke("cancel_stream", { requestId: rid }).catch(() => {});
    }
  }

  function clearCurrentConversation() {
    const conv = activeConversation.value;
    if (conv) {
      conv.messages = [];
      conv.updatedAt = Date.now();
    }
    taskPlan.value = null; // 新对话清空任务计划
    resetPlanHealth(); // 复位步骤健康状态（P-A6）
  }

  // 重试：移除最后一条 AI 回复，重新发送上一条用户消息
  function retryLast() {
    const conv = activeConversation.value;
    if (!conv || isStreaming.value) return;
    const msgs = conv.messages;
    // 找到最后一个 user 消息和它之后的 assistant 消息
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return;
    const lastUser = msgs[lastUserIdx];
    // 删除 user 消息之后的所有 assistant 消息
    conv.messages = msgs.slice(0, lastUserIdx + 1);
    // 重发
    sendMessage(lastUser.content, lastUser.images);
  }

  // 复制消息到剪贴板
  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  }

  // --- 对话搜索 (Rust SQLite) ---
  async function searchConversations(query: string) {
    if (!query.trim()) return [];
    try {
      return await invoke<
        {
          conversation_id: string;
          conversation_title: string;
          message_id: string;
          role: string;
          snippet: string;
          timestamp: number;
        }[]
      >("search_conversations_cmd", { query });
    } catch {
      return [];
    }
  }

  // --- 对话导出 (Rust) ---
  async function downloadExport(id: string, format: "md" | "json") {
    const conv = conversations.value.find((c) => c.id === id);
    const filename = `${conv?.title || "对话"}.${format}`;
    try {
      const content = await invoke<string>("export_conversation_cmd", { id, format });
      // Tauri 桌面环境：WKWebView 不支持 <a download>，改用原生保存对话框 + Rust 写文件
      if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const path = await save({
          defaultPath: filename,
          filters: [{ name: format === "md" ? "Markdown" : "JSON", extensions: [format] }],
        });
        if (!path) return; // 用户取消
        await invoke("write_text_file", { path, content });
        return;
      }
      // 浏览器预览：回退 <a download>
      const blob = new Blob([content], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.warn("[道生一] 导出失败:", e);
    }
  }

  // S4 queue：后台投递完成/失败事件 → 刷新对应会话（后台回复落地后即时可见）
  if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    listen<any>("queue-turn-done", (e) => {
      const cid = e.payload?.conversationId;
      if (cid) {
        markSessionDone(cid);
        refreshConversation(cid);
      }
    });
    listen<any>("queue-turn-error", (e) => {
      const cid = e.payload?.conversationId;
      if (cid) {
        markSessionDone(cid);
        refreshConversation(cid);
      }
    });
  }

  return {
    conversations,
    activeConversationId,
    activeConversation,
    sortedConversations,
    visibleConversations,
    archivedConversations,
    conversationStats,
    cacheHitRate,
    cacheHitTotal,
    cacheMissTotal,
    usageAgg,
    usageAggTotal,
    usageAggCost,
    budgetVerdict,
    refreshUsageAgg,
    profiles,
    activeProfileId,
    activeProfile,
    currentConfig,
    profileSwitching,
    isStreaming,
    streamingContent,
    streamingReasoning,
    pendingCount,
    currentToolLabel,
    switchProfile,
    updateProfile,
    addProfile,
    deleteProfile,
    reloadProfilesFromRust,
    createConversation,
    deleteConversation,
    forkConversation,
    queueTurn,
    refreshConversation,
    selectConversation,
    archiveConversation,
    unarchiveConversation,
    deleteArchived,
    sendMessage,
    stopStreaming,
    getAuxConfig,
    getRoutedAuxConfig,
    editConfirm,
    resolveEditConfirm,
    askInput,
    resolveAskInput,
    hasSessionPermit,
    rememberSessionPermit,
    clearSessionPermits,
    activePersonaId,
    setPersona,
    activeModeId,
    setMode,
    readModeHist,
    subagents,
    spawnSubagent,
    completeSubagent,
    failSubagent,
    clearFinishedSubagents,
    clearCurrentConversation,
    retryLast,
    taskPlan,
    setTaskPlan,
    ensureActiveConversation,
    agentRunCommand,
    agentExecCommand,
    agentWriteStdin,
    copyToClipboard,
    downloadExport,
    searchConversations,
  };
});
