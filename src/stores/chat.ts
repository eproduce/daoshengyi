import { defineStore } from "pinia";
import { ref, computed, watch, reactive } from "vue";
import type { Conversation, ChatMessage, ApiConfig, ApiProfile, ImageAttachment, FileAttachment, MessageRole } from "@/types";
import { v4 as uuidv4 } from "./uuid";
import { formatSearchResults } from "@/api/search";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSkillStore } from "./skill";
import { MCP_CATALOG } from "@/data/mcp-catalog";
import { useMcpStore } from "./mcp";
import { useMemorySystem } from "./memory";
import { estimateMessageTokens, estimateCost } from "@/utils/tokens";
import { parseToolCall, stripToolJson } from "@/utils/tool-call";
import { initSettings, updateSettings, getSettings, reloadSettings } from "@/api/appSettings";

// --- MCP 工具辅助 ---
let mcpToolsCache: { server: string; name: string; description: string; inputSchema?: Record<string, unknown> }[] = [];
export async function refreshMcpTools() {
  try {
    const servers = await invoke<[string, {name:string;description:string;inputSchema?:Record<string,unknown>}[]][]>("mcp_list_tools");
    mcpToolsCache = [];
    for (const [server, tools] of servers) {
      for (const t of tools) mcpToolsCache.push({ server, name: t.name, description: t.description, inputSchema: t.inputSchema });
    }
  } catch { mcpToolsCache = []; }
}
/// 列出已启用但未连接的 MCP 服务器（如浏览器自动化），提示模型按需激活。
/// 浏览器等重服务器不会在日常对话中自动连接/弹窗，只有模型明确需要时才激活。
function pendingServersPrompt(): string {
  const pending = useMcpStore().servers.filter(s => s.enabled && !s.connected);
  if (pending.length === 0) return "";
  const lines = pending.map(s => {
    const cat = MCP_CATALOG.find(c => c.name === s.name || `${c.command} ${c.args}` === `${s.command} ${s.args}`);
    return `- **${s.name}**（未连接）: ${cat ? cat.description : "可用的 MCP 服务器"}`;
  });
  return (
    "\n\n## 未连接服务器（按需激活，不占用资源、不弹窗）\n" +
    lines.join("\n") +
    "\n\n若任务需要上述服务器的能力，请先调用其激活指令，收到工具列表后再选择具体工具：\n" +
    pending.map(s => `<tool_call>\n{"server":"${s.name}","tool":"__connect__","arguments":{}}\n</tool_call>`).join("\n")
  );
}

function getMcpToolsPrompt(): string {
  // 内置工具：如实描述特性/优势/适用场景，由大模型根据任务自行选择，不硬编码倾向
  const builtin =
    "\n\n## 内置工具（server 填 `app`）\n" +
    "- **fetch_page** (app): 抓取网页 HTML 并转为纯文本返回。特点：快、稳定、无需浏览器；适合获取静态网页正文（新闻、天气、文档、说明等）；对需要登录/点击/JS 动态渲染的页面可能拿不全。参数 {\"url\": \"完整网址\"}\n" +
    "- **web_search** (app): 网络搜索，返回相关网页标题/链接/摘要。特点：适合需要发现多个信息源、获取最新信息、或不确定具体网址时的探索。参数 {\"query\": \"关键词\"}\n" +
    "- **describe_image** (app): 用本地视觉模型描述图片内容。参数 {\"path\": \"本地图片文件路径\"}。用于理解截图/图片内容（可配合浏览器截图后使用）。\n" +
    "- **ocr_image** (app): 用本地 OCR（macOS Vision）提取图片中的文字。参数 {\"path\": \"本地图片文件路径\"}。用于从截图/图片提取文字。";
  // 强制约束：实时/时效信息必须真实获取，严禁编造。防止模型凭训练数据"发挥"（如编造天气）。
  const realtime =
    "\n\n## 强制要求（实时/时效信息）\n" +
    "涉及任何**实时/时效性信息**（天气、新闻、股票、汇率、比分、价格、最新政策、当前现状、日期时间等）时，" +
    "**必须先调用 web_search 或 fetch_page 获取真实数据**，严禁凭记忆编造温度、数值、价格、事件或新闻。\n" +
    "若工具确实拿不到数据（搜索无结果、页面无法访问），请明确告知用户「无法获取」，不要编造。";
  const pending = pendingServersPrompt();

  if (mcpToolsCache.length === 0) {
    return builtin + realtime + pending +
      "\n\n需要工具时只回复以下格式：\n<tool_call>\n{\"server\":\"app\",\"tool\":\"工具名\",\"arguments\":{...}}\n</tool_call>";
  }

  return builtin + realtime +
    "\n\n## MCP 服务器工具（特性各异，请按需选择）\n" +
    mcpToolsCache.map(t => `- **${t.name}** (${t.server}): ${t.description}`).join("\n") +
    pending +
    "\n\n工具选择由你根据任务自行判断：静态网页正文用 fetch_page；需要打开浏览器、点击/输入/截图或抓取动态渲染内容用浏览器工具；本地文件读写用文件系统；回忆历史信息用记忆。不确定时可先用 web_search 或 fetch_page 探索。" +
    "\n\n需要工具时只回复以下格式：\n<tool_call>\n{\"server\":\"服务器名\",\"tool\":\"工具名\",\"arguments\":{...}}\n</tool_call>" +
    "\n\n完成任务后，如果调用过浏览器类工具（如 puppeteer_*），请最后调用关闭工具（如 puppeteer_close）释放资源；没有则无需关闭。";
}

/// 任务完成后关闭浏览器，形成使用闭环。
/// server-puppeteer 无 puppeteer_close 工具，只能通过断开 MCP 连接
/// （kill 服务器进程，kill_on_drop）使浏览器窗口随之关闭。
async function closeBrowserIfOpen(): Promise<void> {
  const browserServers = new Set(
    mcpToolsCache.filter((t) => /^puppeteer_/i.test(t.name)).map((t) => t.server)
  );
  for (const server of browserServers) {
    try { await invoke("mcp_disconnect", { name: server }); } catch { /* 忽略 */ }
  }
  if (browserServers.size > 0) {
    // 同步清空工具缓存，并把 mcp store 中的服务器标记为未连接
    try { await refreshMcpTools(); } catch { /* 忽略 */ }
    try {
      const { useMcpStore } = await import("./mcp");
      useMcpStore().markDisconnected([...browserServers]);
    } catch { /* 忽略 */ }
  }
}
export async function callMcpTool(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
  // 内置工具（应用自带，无需 MCP 服务器）
  if (server === "app" || server === "builtin") {
    return callBuiltinTool(tool, args);
  }

  // 按需激活：模型请求 __connect__，或调用了未连接服务器的工具（未先激活）时，
  // 连接该服务器后返回工具列表，让模型重选具体工具。浏览器服务器借此才真正启动。
  const mcp = useMcpStore();
  const target = mcp.servers.find(s => s.name === server) ?? mcp.servers.find(s => s.enabled && !s.connected);
  if (tool === "__connect__" || (target && target.enabled && !target.connected && target.name === server)) {
    if (!target) {
      return `未找到可激活的服务器「${server}」。可用工具：${mcpToolsCache.map(t => `${t.name}(${t.server})`).join(", ") || "无"}`;
    }
    if (target.connected) {
      return `服务器「${target.name}」已连接。可用工具：${mcpToolsCache.filter(t => t.server === target.name).map(t => t.name).join(", ") || "（暂无工具）"}。请选择合适的工具继续。`;
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
  const result = await invoke<{content:{type:string;text?:string;data?:string}[];isError?:boolean}>("mcp_call_tool", {
    server: effectiveServer, toolName: tool, arguments: args,
  });
  const text = result.content.map(c => c.text || "").join("\n");
  // 若返回了图片数据（如 puppeteer_screenshot 截图），保存到临时文件，
  // 并提示大模型可用 describe_image / ocr_image 分析该截图
  const images = result.content.filter(c => c.type === "image" && c.data);
  let out = text;
  for (const img of images) {
    try {
      const p = await invoke<string>("save_temp_image", { data: img.data });
      out += `\n\n截图已保存到: ${p}\n（如需理解截图内容，可调用内置工具 describe_image 描述图片 或 ocr_image 提取文字，参数 path 填该路径）`;
    } catch { /* 保存失败忽略 */ }
  }
  return out;
}

/** 调用应用内置工具（fetch_page 网页抓取、web_search 搜索） */
async function callBuiltinTool(tool: string, args: Record<string, unknown>): Promise<string> {
  switch (tool) {
    case "fetch_page": {
      const url = String(args.url || "");
      if (!url) throw new Error("fetch_page 需要 url 参数");
      const res = await invoke<{title: string; text: string; url: string}>("fetch_page", { url });
      return `【${res.title}】\n${res.text.slice(0, 4000)}`;
    }
    case "web_search": {
      const query = String(args.query || "");
      if (!query) throw new Error("web_search 需要 query 参数");
      const results = await invoke<{ title: string; url: string; snippet: string }[]>("web_search", { query, braveKey: "" });
      if (!results.length) return "（搜索无结果）";
      return results.map((r) => `- ${r.title}: ${r.url}\n  ${r.snippet}`).join("\n");
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
      return ocr || "（未识别到文字）";
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

/// ReAct 循环返回：finalAnswer 存在表示拿到最终答案；否则交由流式兜底回答
interface ReactLoopResult {
  finalAnswer?: string;
  toolResults: string[];
}

/// 非流式模型请求（chat_once）带前端超时兜底：
/// 网络/服务端偶尔会无响应，超时返回 null，避免 ReAct 循环一直等待导致气泡卡死为空泡泡
const CHAT_ONCE_TIMEOUT_MS = 60000;
async function chatOnce(config: ApiConfig, convo: { role: string; content: string }[]) {
  return Promise.race([
    invoke<{ content: string; reasoning_content?: string; cache_hit?: number; cache_miss?: number }>("chat_once", {
      config: {
        base_url: config.baseUrl,
        api_key: config.apiKey,
        model: config.model || "deepseek-v4-flash",
        max_tokens: config.maxTokens,
        temperature: 0.3, // 工具决策用低温更稳定
        thinking_enabled: config.thinkingEnabled,
        reasoning_effort: config.reasoningEffort,
        system_prompt: withCurrentDate(config.systemPrompt || "你是道生一，一个AI桌面助手。"),
        enable_web_search: config.enableWebSearch,
      },
      messages: convo,
    }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), CHAT_ONCE_TIMEOUT_MS)),
  ]);
}

/** ReAct 循环：非流式调用 LLM，执行工具，直到得到最终答案 */
async function runReactLoop(
  config: ApiConfig,
  messages: { role: string; content: string }[],
  maxIterations = 5,
  onProgress?: (text: string) => void,
  onReasoning?: (text: string) => void,
  onCache?: (hit: number, miss: number) => void
): Promise<ReactLoopResult> {
  const toolResults: string[] = [];
  const convo = [...messages];

  for (let i = 0; i < maxIterations; i++) {
    // 通过 Rust 端非流式请求（chat_once）：与流式同架构走 reqwest，避免前端
    // fetch 跨域被 CORS 拦截导致 ReAct 一直失败、回退到流式后模型只能“口头”调工具
    const data = await chatOnce(config, convo);
    if (!data) break; // 超时/失败：停止循环，交由流式兜底回答
    // 思考过程也累积展示（非流式返回的 reasoning_content）
    if (data.reasoning_content) onReasoning?.(data.reasoning_content);
    // 累积缓存命中/未命中
    if ((data.cache_hit ?? 0) > 0 || (data.cache_miss ?? 0) > 0) {
      onCache?.(data.cache_hit ?? 0, data.cache_miss ?? 0);
    }
    const content: string = data.content || "";

    const toolCall = parseToolCall(content);
    if (!toolCall) {
      // 没有工具调用，是最终答案 → 关闭浏览器形成闭环
      await closeBrowserIfOpen();
      return { finalAnswer: content, toolResults };
    }

    // 实时告诉用户正在调用哪个工具（避免出现"正在分析并调用工具..."这类莫名的占位）
    const serverName = toolCall.server && toolCall.server !== "default" ? `（${toolCall.server}）` : "";
    onProgress?.(`🔧 正在调用工具：${toolCall.tool}${serverName}...`);

    // 执行工具（展示为清晰的工具调用卡片，参数折叠，避免原始 JSON 刷屏）
    const argsStr = JSON.stringify(toolCall.arguments, null, 2);
    toolResults.push(
      `### 🔧 调用工具：\`${toolCall.tool}\`\n\n` +
      `<details><summary>参数</summary>\n\n\`\`\`json\n${argsStr.slice(0, 400)}\n\`\`\`\n\n</details>`
    );
    try {
      const result = await callMcpTool(toolCall.server, toolCall.tool, toolCall.arguments);
      const clipped = result.length > 800 ? result.slice(0, 800) + "\n...(结果已截断)" : result;
      toolResults.push(`<details><summary>✅ 工具结果</summary>\n\n\`\`\`\n${clipped}\n\`\`\`\n\n</details>`);
      convo.push({ role: "assistant", content });
      convo.push({
        role: "user",
        content: `<tool_result>\n${result}\n</tool_result>\n\n请基于工具结果继续回答用户的问题。`,
      });
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      toolResults.push(`> ❌ 工具调用失败: \`${err}\``);
      convo.push({ role: "assistant", content });
      convo.push({ role: "user", content: `<tool_result>\n错误: ${err}\n</tool_result>\n\n工具调用失败，请直接回答或调整参数重试。` });
    }
  }
  // 达到最大迭代次数仍未得到最终答案，也关闭浏览器形成闭环
  await closeBrowserIfOpen();
  return { toolResults };
}

const DEFAULT_PROFILES: ApiProfile[] = [
  {
    id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com",
    apiKey: "", model: "deepseek-v4-flash", maxTokens: 4096, temperature: 0.7,
    thinkingEnabled: true, reasoningEffort: "high",
    systemPrompt: "你是道生一，一个AI桌面助手。你运行在用户的本地设备上。请用简洁、准确的中文回答。",
    enableWebSearch: false, maxContextMessages: 50,
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
      const convs = await invoke<{id:string;title:string;model:string;created_at:number;updated_at:number}[]>("load_conversations");
      for (const c of convs) {
        const msgs = await invoke<{id:string;conversation_id:string;role:string;content:string;reasoning_content?:string;images?:string;attachments?:string;timestamp:number;tokens?:number;duration?:number;cost?:number}[]>("get_messages", { conversationId: c.id });
        conversations.value.push({
          id: c.id, title: c.title, model: c.model,
          createdAt: c.created_at, updatedAt: c.updated_at,
          messages: msgs.map(m => ({
            id: m.id, role: m.role as MessageRole, content: m.content,
            reasoning_content: m.reasoning_content,
            images: m.images ? JSON.parse(m.images) as ImageAttachment[] : undefined,
            attachments: m.attachments ? JSON.parse(m.attachments) as FileAttachment[] : undefined,
            timestamp: m.timestamp, tokens: m.tokens, duration: m.duration, cost: m.cost,
          })),
        });
      }
      // 优先从 Rust 设置读活跃对话，回退 localStorage 旧数据
      let activeId: string | null = null;
      try {
        const settings = await initSettings();
        activeId = settings.activeConversationId;
      } catch { /* ignore */ }
      if (!activeId) activeId = localStorage.getItem("daoshengyi_activeConv");
      if (activeId && conversations.value.some(c => c.id === activeId)) {
        activeConversationId.value = activeId;
      }
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
          conv: { id: conv.id, title: conv.title, model: conv.model, created_at: conv.createdAt, updated_at: conv.updatedAt },
          messages: conv.messages.map(m => ({
            id: m.id, conversation_id: conv.id, role: m.role, content: m.content,
            reasoning_content: m.reasoning_content || null,
            images: m.images ? JSON.stringify(m.images) : null,
            attachments: m.attachments ? JSON.stringify(m.attachments) : null,
            timestamp: m.timestamp, tokens: m.tokens || null, duration: m.duration || null, cost: m.cost || null,
          })),
        });
      } catch (e) { console.warn("[道生一] 保存失败:", e); }
    }, 500);
  }

  initFromDb();

  // --- 状态 ---
  const conversations = ref<Conversation[]>([]);
  const activeConversationId = ref<string | null>(null);
  const profiles = ref<ApiProfile[]>(loadProfilesLegacy());
  const activeProfileId = ref<string>(profiles.value[0]?.id ?? "default");
  const isStreaming = ref(false);
  const streamingContent = ref("");
  const streamingReasoning = ref("");

  // 缓存命中统计（DeepSeek usage.prompt_cache_hit/miss_tokens）
  const cacheHitTotal = ref(0);
  const cacheMissTotal = ref(0);
  const cacheHitRate = computed<number | null>(() => {
    const total = cacheHitTotal.value + cacheMissTotal.value;
    return total > 0 ? (cacheHitTotal.value / total) * 100 : null;
  });

  // 异步加载 Rust 端配置（优先于 localStorage 旧数据）
  initSettingsFromRust();

  // --- 计算属性 ---
  const activeConversation = computed(() =>
    conversations.value.find((c) => c.id === activeConversationId.value) ?? null
  );

  const sortedConversations = computed(() =>
    [...conversations.value].sort((a, b) => b.updatedAt - a.updatedAt)
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

  // 对话变更时自动保存 + 标记活跃对话
  watch(conversations, scheduleSave, { deep: true });
  watch(activeConversationId, (id) => {
    if (id) updateSettings({ activeConversationId: id });
  });

  const activeProfile = computed(() =>
    profiles.value.find((p) => p.id === activeProfileId.value) ?? profiles.value[0]
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

  // --- 配置组持久化（Rust 端 SQLite + 加密 API Key） ---
  // 同步兜底：先读 localStorage 旧数据（作为迁移源）
  // 移除历史代码生成的默认 OpenAI 占位配置（未填 Key）
  function stripDefaultOpenAI(list: ApiProfile[]): ApiProfile[] {
    const filtered = list.filter(
      (p) => !(p.id === "default" && p.name === "OpenAI" && !p.apiKey)
    );
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
    } catch { /* ignore */ }
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
        if (settings.activeProfileId && profiles.value.some((p) => p.id === settings.activeProfileId)) {
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
        if (settings.activeProfileId && profiles.value.some((p) => p.id === settings.activeProfileId)) {
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

  function switchProfile(id: string) {
    if (profiles.value.some((p) => p.id === id)) {
      activeProfileId.value = id;
    }
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

  function selectConversation(id: string) {
    if (conversations.value.some((c) => c.id === id)) {
      activeConversationId.value = id;
    }
  }

  // --- 消息管理 ---
  function addUserMessage(
    convId: string,
    text: string,
    images?: ImageAttachment[],
    attachments?: FileAttachment[]
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
        const titleText = text || (images?.length ? "[图片]" : "") || (attachments?.length ? "[附件]" : "");
        conv.title = titleText.slice(0, 30) + (titleText.length > 30 ? "..." : "");
      }
    }
    return msg;
  }

  // --- 图片预处理：用视觉模型描述图片（图片→文字描述→交给文本大模型） ---
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
    } catch { /* 非 macOS 或无 OCR 工具时忽略 */ }

    // 2) 语义描述：本地视觉模型（跨平台通用；Intel 无 GPU 约 1 分钟）
    let semantic = "";
    try {
      // 110 秒兜底：本地推理慢，但避免异常导致前端永久挂起
      semantic = await Promise.race([
        invoke<string>("ollama_describe_image", { images: b64s }),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), 110000)),
      ]);
    } catch { /* 视觉模型不可用时忽略 */ }

    // 合并 OCR 文字 + 语义描述
    const parts: string[] = [];
    if (ocrText) parts.push(`[图片中的文字（OCR）：]\n${ocrText}`);
    if (semantic) parts.push(`[图片内容描述：]\n${semantic}`);
    if (parts.length > 0) return parts.join("\n\n");

    // 3) 回退：找一个有视觉能力的 API（非 DeepSeek，已配 Key）
    const visionProfile = profiles.value.find(
      p => p.apiKey && !p.baseUrl.includes("deepseek")
    );
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
            messages: [{
              role: "user",
              content: [
                { type: "text", text: "请详细描述这张图片的内容。如果图片中有文字，请逐字转录。用中文回答，简洁准确。" },
                { type: "image_url", image_url: { url: img.base64, detail: "auto" } },
              ],
            }],
            max_tokens: 500,
          }),
        });
        if (resp.ok) {
          const data = await resp.json();
          const desc = data.choices?.[0]?.message?.content || "";
          if (desc) fbParts.push(`[图片: ${img.fileName || "附件"}] ${desc}`);
        }
      } catch { /* 单张失败不影响其他 */ }
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

  // 危险命令模式（借鉴 DeepSeek Harness 的 approval 审批理念）
  const DANGEROUS_PATTERNS: RegExp[] = [
    /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,   // rm -rf / rm -fr
    /\brm\s+.*\s\/\s*$|\brm\s+-[a-z]*r[a-z]*f\s+\//i,
    /\bsudo\b/i,
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
    /\bshutdown\b/i,
    /\breboot\b/i,
    /\b:\(\)\s*\{/i,                                  // fork bomb
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+push\b[^\n]*--force\b/i,
    /\bchmod\s+-R\s+777\b/i,
  ];

  function isDangerous(cmdStr: string): boolean {
    return DANGEROUS_PATTERNS.some((p) => p.test(cmdStr));
  }

  async function runCommand(cmdStr: string) {
    const { command, args } = parseCommandLine(cmdStr);
    if (!command) return;

    // 危险命令需用户确认；YOLO 模式开启时自动批准执行（不再弹确认）
    if (isDangerous(cmdStr) && !getSettings().yoloMode) {
      const ok = window.confirm(`⚠️ 检测到危险命令：\n\n$ ${cmdStr}\n\n确定要执行吗？`);
      if (!ok) return;
    }

    let convId = activeConversationId.value;
    if (!convId) convId = createConversation();
    addUserMessage(convId, `/run ${cmdStr}`);

    const conv = conversations.value.find((c) => c.id === convId)!;
    const assistantMsg = reactive<ChatMessage>({
      id: uuidv4(), role: "assistant", content: "", timestamp: Date.now(), streaming: true,
    });
    conv.messages.push(assistantMsg);
    conv.updatedAt = Date.now();
    isStreaming.value = true;
    streamingContent.value = `$ ${cmdStr}\n⏳ 执行中...`;

    const startTime = Date.now();
    try {
      const result = await invoke<{ stdout: string; stderr: string; exit_code: number; timed_out: boolean }>(
        "execute_command", {
          command,
          args,
          cwd: getSettings().workspace || null,
          timeoutSecs: 30,
        },
      );
      const out = result.stdout.trimEnd();
      const err = result.stderr.trimEnd();
      let content = `$ ${cmdStr}\n`;
      if (out) content += `\n${out}\n`;
      if (err) content += `\n[stderr]\n${err}\n`;
      content += `\n退出码: ${result.exit_code}${result.timed_out ? "（超时）" : ""}`;
      assistantMsg.content = content;
    } catch (e: unknown) {
      assistantMsg.content = `$ ${cmdStr}\n\n❌ 执行失败: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      assistantMsg.streaming = false;
      assistantMsg.duration = Number(((Date.now() - startTime) / 1000).toFixed(1));
      assistantMsg.tokens = estimateMessageTokens(assistantMsg.content);
      assistantMsg.cost = 0;
      streamingContent.value = "";
      isStreaming.value = false;
      conv.updatedAt = Date.now();
      scheduleSave();
    }
  }

  // 读取文件（/read 指令，借鉴 DeepSeek Harness 的文件能力）
  async function runRead(filePath: string) {
    let convId = activeConversationId.value;
    if (!convId) convId = createConversation();
    addUserMessage(convId, `/read ${filePath}`);

    const conv = conversations.value.find((c) => c.id === convId)!;
    const assistantMsg = reactive<ChatMessage>({
      id: uuidv4(), role: "assistant", content: "", timestamp: Date.now(), streaming: true,
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
    }
  }

  // --- 流式发送 ---
  async function sendMessage(text: string, images?: ImageAttachment[], attachments?: FileAttachment[]) {
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

    let convId = activeConversationId.value;
    if (!convId) {
      convId = createConversation();
    }

    addUserMessage(convId, text, images, attachments);

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
    isStreaming.value = true;
    streamingContent.value = "";
    streamingReasoning.value = "";
    const startTime = Date.now();

    // 图片预处理：主模型非视觉（如 DeepSeek）→ 先用本地 Ollama 识别图片转成文字描述。
    // 描述作为上下文注入 system（模型可见），不写入用户消息，避免"分析内容"污染用户对话。
    const isDS = (currentConfig.value.baseUrl || "").includes("deepseek");
    let descCtx = "";
    let ocrFailed = false;
    if (isDS && images && images.length > 0) {
      // 流式消息渲染读的是 chatStore.streamingContent（不是 message.content），
      // 写这里界面才会在 agent 气泡立即显示"正在分析图片..."，否则会一直显示"思考中..."
      streamingContent.value = "🔍 正在用本地视觉模型分析图片（首次较慢，约 1 分钟）...\n\n";
      const desc = await describeImages(images);
      if (desc) {
        descCtx = `[用户上传了图片，经本地视觉模型识别，图片内容如下：]\n${desc}`;
        images = undefined;
      } else {
        ocrFailed = true;
      }
      streamingContent.value = ""; // 清空占位，交由后续流式回复填充
    }

    let unlistenFns: UnlistenFn[] = [];
    let inputTokens = 0;
    const memory = useMemorySystem();

    try {
      // 本地图片识别失败/超时：明确报错，避免静默降级成空回复
      if (ocrFailed) {
        throw new Error("本地图片识别失败或超时（请确认 Ollama 服务正常运行、llava-phi3 模型已下载）后重试");
      }
      const config = currentConfig.value;
      if (!config.baseUrl || !config.apiKey) throw new Error("请先在设置中配置 API 地址和 Key");

      // 每次发送前都刷新 MCP 工具缓存（不只缓存为空时）——
      // 避免启动早期只拿到部分服务器的工具（如缺文件系统），导致模型误以为没有该工具。
      // 连接失败不阻塞发送：按需连接失败时用已有工具兜底。
      const mcpSettings = getSettings().mcpServers ?? [];
      if (mcpSettings.some((s) => s.enabled)) {
        // 按需连接：对话开始时连接启用的 MCP 服务器（启动不全连、用完即断），再刷新工具缓存
        try { await useMcpStore().connectEnabled(); } catch { /* 连接失败不阻塞 */ }
        try { await refreshMcpTools(); } catch { /* 忽略 */ }
      }

      // 注入当前日期（防止日期幻觉），作为系统提示基础。
      // 用"天"粒度：每天只变一次，system 前缀稳定 → 历史消息可整段命中缓存。
      let sp = withCurrentDate(config.systemPrompt || "你是道生一，一个AI桌面助手。");

      // ---- 稳定上下文：进 system（跨消息不变，保证前缀可缓存） ----
      // 注入已启用的技能
      const skillStore = useSkillStore();
      const skillPrompts = skillStore.enabledPrompts();
      if (skillPrompts) sp = sp ? `${sp}\n\n---\n\n${skillPrompts}` : skillPrompts;

      // 注入 MCP 工具（工具描述相对稳定）
      const mcpPrompt = getMcpToolsPrompt();
      if (mcpPrompt) sp = sp ? `${sp}\n\n${mcpPrompt}` : mcpPrompt;

      // ---- 易变上下文：每次提问都不同 → 追加到最新用户消息末尾，不进 system ----
      // 若放进 system，每次提问 system 都变，会从 system 开始打断前缀缓存；
      // 放进最新 user 消息后，system+历史前缀保持不变，可整段命中缓存。
      const volatileCtx: string[] = [];
      // 精确时间（分钟级，放进本次上下文不伤缓存，模型仍能答"现在几点"）。
      // 补全完整日期：系统提示的天粒度日期对"今天"有效，但用户消息里再带一份
      // 完整日期+星期+时刻，双保险，进一步压低日期/时间幻觉。
      const nowDt = new Date();
      const todayStr = `${nowDt.getFullYear()}年${nowDt.getMonth()+1}月${nowDt.getDate()}日 ${nowDt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", weekday: "long" })}`;
      volatileCtx.push(`【当前时间】现在是 ${todayStr} ${nowDt.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false,
      })}（Asia/Shanghai）。`);
      // 图片描述作为上下文（不展示在对话里，但模型可见）
      if (descCtx) volatileCtx.push(descCtx);
      // 注入文件上下文（文本/PDF 提取内容作为 AI 可读的上下文）
      if (attachments && attachments.length > 0) {
        const fileCtx = attachments
          .map((f) => `\n--- 文件: ${f.name} ---\n${f.content.slice(0, 12000)}`)
          .join("");
        volatileCtx.push(`[用户提供的文件上下文]\n${fileCtx}`);
      }
      // 联网搜索结果
      if (config.enableWebSearch && text.trim()) {
        try {
          const results = await invoke<{title:string;url:string;snippet:string}[]>("web_search", { query: text.trim(), braveKey: "" });
          if (results.length > 0) volatileCtx.push(formatSearchResults(text.trim(), results));
        } catch { /* 搜索暂不可用 */ }
      }
      // 注入相关记忆（语义 + 关键词混合检索）——15 秒超时兜底，避免阻塞主对话
      const memText = await Promise.race([
        memory.retrieveMemories(text, config),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), 15000)),
      ]);
      if (memText) volatileCtx.push(memText);
      // 自动摘要旧消息——30 秒超时兜底，避免阻塞主对话
      const summaries = await Promise.race([
        memory.maybeSummarize(convId, conv.messages, config),
        new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 30000)),
      ]);
      for (const s of summaries) volatileCtx.push(`对话摘要: ${s}`);

      // 构建 Rust 格式消息
      const maxCtx = config.maxContextMessages || 50;
      const rustMsgs: { role: string; content: unknown }[] = [];
      if (sp) rustMsgs.push({ role: "system", content: sp });
      conv.messages.filter(m => m.role !== "system" && !m.streaming).slice(-maxCtx).forEach(m => {
        // DeepSeek 不支持图片：所有带图片的消息（含历史残留的图片消息）一律只发文本，
        // 避免收到 image_url 报 400；支持图片的模型才发送多模态。
        if (m.images?.length && !isDS) {
          rustMsgs.push({ role: m.role, content: [{ type: "text", text: m.content }, ...m.images.map(img => ({ type: "image_url", image_url: { url: img.base64, detail: "auto" } }))] });
        } else {
          rustMsgs.push({ role: m.role, content: m.content });
        }
      });

      // 把本次易变上下文追加到最新一条用户消息末尾（不进 system，保证 system+历史前缀稳定可缓存）
      if (volatileCtx.length > 0) {
        const lastUser = [...rustMsgs].reverse().find(m => m.role === "user");
        if (lastUser && typeof lastUser.content === "string") {
          lastUser.content = `${lastUser.content}\n\n[本次补充上下文]\n${volatileCtx.join("\n\n")}`;
        } else {
          rustMsgs.push({ role: "user", content: `[本次补充上下文]\n${volatileCtx.join("\n\n")}` });
        }
      }

      // 估算输入 token（用于费用计算）
      inputTokens = rustMsgs.reduce((sum, m) => {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return sum + estimateMessageTokens(text);
      }, 0);

      const rustCfg = {
        base_url: config.baseUrl, api_key: config.apiKey, model: config.model || "deepseek-v4-flash",
        max_tokens: config.maxTokens, temperature: config.temperature,
        thinking_enabled: config.thinkingEnabled, reasoning_effort: config.reasoningEffort,
        system_prompt: sp, enable_web_search: config.enableWebSearch,
      };

      // ReAct 自动工具调用：有 MCP 工具时先跑决策循环。
      // 注意：含图片（或图片已识别成文字 descCtx）时不走 ReAct——
      // 图片场景应直接流式回复，完整展示 DeepSeek 的思考过程与内容；
      // ReAct 会跳过流式直接给结果，导致思考/工具过程不可见。
      let reactDone = false;
      // 有已连接工具，或有未连接但可按需激活的服务器（如浏览器）时，都先跑决策循环
      const hasPendingMcp = useMcpStore().servers.some(s => s.enabled && !s.connected);
      if ((mcpToolsCache.length > 0 || hasPendingMcp) && !(images && images.length > 0) && !descCtx) {
        const flatMsgs = rustMsgs.map(m => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        }));
        try {
          // ReAct 期间实时显示"正在调用 xx 工具"，并把非流式返回的思考过程也累积展示
          const react = await runReactLoop(config, flatMsgs, 5,
            (text) => { streamingContent.value = text; },
            (r) => { streamingReasoning.value += r; },
            (hit, miss) => { cacheHitTotal.value += hit; cacheMissTotal.value += miss; }
          );
          if (react.finalAnswer) {
            // ReAct 循环给出了最终答案，直接展示（跳过流式）
            streamingContent.value =
              (react.toolResults.length > 0 ? react.toolResults.join("\n") + "\n\n" : "") + react.finalAnswer;
            reactDone = true;
          } else if (react.toolResults.length > 0) {
            // 循环耗尽仍在调工具：把过程附到上下文，交给流式兜底回答
            rustMsgs.push({ role: "user", content: react.toolResults.join("\n") + "\n请直接给出最终答案。" });
          }
        } catch { /* ReAct 失败，回退到流式 */ }
      }

      if (!reactDone) {
        // ReAct 未给出最终答案（超时/耗尽/失败）：清掉 ReAct 期间的"正在调用工具"占位，
        // 让流式从头生成完整回复，避免残留占位文本混在答案前面
        streamingContent.value = "";
        // 先注册监听并 await 确保注册完成，再调用 invoke，避免事件竞态丢失
        let resolveDone!: () => void;
        let rejectDone!: (e: Error) => void;
        const doneP = new Promise<void>((resolve, reject) => {
          resolveDone = resolve;
          rejectDone = reject;
        });

        unlistenFns.push(
          await listen<{ reasoning_content?: string; content?: string; tokens?: number; cache_hit?: number; cache_miss?: number }>("sse-delta", e => {
            const d = e.payload;
            if (d.reasoning_content) streamingReasoning.value += d.reasoning_content;
            if (d.content) streamingContent.value += d.content;
            if (d.tokens) assistantMsg.tokens = d.tokens;
            if (d.cache_hit) cacheHitTotal.value += d.cache_hit;
            if (d.cache_miss) cacheMissTotal.value += d.cache_miss;
          }),
          await listen<string>("sse-error", e => rejectDone(new Error(e.payload))),
          await listen("sse-done", () => resolveDone()),
        );

        await invoke("send_message", { config: rustCfg, messages: rustMsgs });
        // doneP 加超时兜底：若 Rust 流式一直不返回（网络卡死），超时抛错进入 catch，
        // 确保 finally 一定执行、气泡不会卡死成空泡泡
        await Promise.race([
          doneP,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("模型回复超时（120 秒）")), 120000)
          ),
        ]);
      }

    } catch (err: unknown) {
      if (err instanceof Error) {
        let msg = err.message;
        // 图片发送失败时给出明确引导（多为模型不支持图片输入）
        if (images && images.length > 0 && /400|unsupported|not.?support|image|content_type/i.test(msg)) {
          msg += "\n\n💡 当前模型可能不支持图片输入。请在「设置 → API 配置」中添加支持视觉能力的模型（如 OpenAI、Gemini、Qwen-VL 等），或切换到支持图片的模型。";
        }
        streamingContent.value = streamingContent.value || `[错误] ${msg}`;
      }
    } finally {
      unlistenFns.forEach(f => f());
      // 流式兜底：即使走了流式路径，也剥离模型口头输出的工具调用 JSON，避免展示莫名其妙的内容
      assistantMsg.content = stripToolJson(streamingContent.value);
      assistantMsg.reasoning_content = streamingReasoning.value || undefined;
      assistantMsg.duration = Number(((Date.now() - startTime) / 1000).toFixed(1));
      // Token 计数：优先使用 Rust 端返回的 usage，否则本地估算
      if (!assistantMsg.tokens) {
        assistantMsg.tokens = estimateMessageTokens(streamingContent.value, streamingReasoning.value);
      }
      // 费用估算
      try {
        assistantMsg.cost = estimateCost(currentConfig.value.model, inputTokens, assistantMsg.tokens || 0);
      } catch { /* 费用计算失败不影响主流程 */ }
      assistantMsg.streaming = false;
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

      // 对话结束：用完断开 MCP 服务器，释放资源（浏览器等子进程随之关闭）
      useMcpStore().disconnectAll().catch(() => {});

      // 后台提取关键事实
      if (currentConfig.value.apiKey) {
        memory.extractFacts(convId, conv.messages, currentConfig.value).catch(() => {});
      }
    }
  }

  function stopStreaming() {
    // Rust 后端会自然结束，前端标记超时即可
    isStreaming.value = false;
  }

  function clearCurrentConversation() {
    const conv = activeConversation.value;
    if (conv) {
      conv.messages = [];
      conv.updatedAt = Date.now();
    }
  }

  // 重试：移除最后一条 AI 回复，重新发送上一条用户消息
  function retryLast() {
    const conv = activeConversation.value;
    if (!conv || isStreaming.value) return;
    const msgs = conv.messages;
    // 找到最后一个 user 消息和它之后的 assistant 消息
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") { lastUserIdx = i; break; }
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
      ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
    }
  }

  // --- 对话搜索 (Rust SQLite) ---
  async function searchConversations(query: string) {
    if (!query.trim()) return [];
    try {
      return await invoke<{conversation_id:string;conversation_title:string;message_id:string;role:string;snippet:string;timestamp:number}[]>(
        "search_conversations_cmd", { query }
      );
    } catch { return []; }
  }

  // --- 对话导出 (Rust) ---
  async function downloadExport(id: string, format: "md" | "json") {
    try {
      const content = await invoke<string>("export_conversation_cmd", { id, format });
      const conv = conversations.value.find(c => c.id === id);
      const blob = new Blob([content], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${conv?.title || "对话"}.${format}`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { console.warn("[道生一] 导出失败:", e); }
  }

  return {
    conversations,
    activeConversationId,
    activeConversation,
    sortedConversations,
    conversationStats,
    cacheHitRate,
    cacheHitTotal,
    cacheMissTotal,
    profiles,
    activeProfileId,
    activeProfile,
    currentConfig,
    isStreaming,
    streamingContent,
    streamingReasoning,
    switchProfile,
    updateProfile,
    addProfile,
    deleteProfile,
    reloadProfilesFromRust,
    createConversation,
    deleteConversation,
    selectConversation,
    sendMessage,
    stopStreaming,
    clearCurrentConversation,
    retryLast,
    copyToClipboard,
    downloadExport,
    searchConversations,
  };
});
