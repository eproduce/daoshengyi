import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import type { Conversation, ChatMessage, ApiConfig, ApiProfile, ImageAttachment, MessageRole } from "@/types";
import { v4 as uuidv4 } from "./uuid";
import { formatSearchResults } from "@/api/search";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSkillStore } from "./skill";
import { useMemorySystem } from "./memory";
import { estimateMessageTokens, estimateCost } from "@/utils/tokens";
import { parseToolCall } from "@/utils/tool-call";
import { initSettings, updateSettings, getSettings } from "@/api/appSettings";

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
function getMcpToolsPrompt(): string {
  if (mcpToolsCache.length === 0) return "";
  return "\n\n## 可用工具 (MCP)\n" + mcpToolsCache.map(t =>
    `- **${t.name}** (${t.server}): ${t.description}`
  ).join("\n") +
  `\n\n当需要使用工具时，只回复以下格式（不要加其他文字）：\n<tool_call>\n{"server":"服务器名","tool":"工具名","arguments":{...}}\n</tool_call>`;
}
export async function callMcpTool(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const result = await invoke<{content:{type:string;text?:string}[];isError?:boolean}>("mcp_call_tool", {
    server, toolName: tool, arguments: args,
  });
  return result.content.map(c => c.text || "").join("\n");
}

/** ReAct 循环：非流式调用 LLM，执行工具，直到得到最终答案 */
async function runReactLoop(
  config: ApiConfig,
  messages: { role: string; content: string }[],
  maxIterations = 5
): Promise<string[]> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const toolResults: string[] = [];
  const convo = [...messages];

  for (let i = 0; i < maxIterations; i++) {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model || "deepseek-chat",
        messages: convo,
        max_tokens: 1000,
        temperature: 0.3,
      }),
    });

    if (!resp.ok) break;
    const data = await resp.json();
    const content: string = data.choices?.[0]?.message?.content || "";

    const toolCall = parseToolCall(content);
    if (!toolCall) {
      // 没有工具调用，是最终答案
      return [content, ...toolResults];
    }

    // 执行工具
    toolResults.push(`> 🔧 调用工具 \`${toolCall.tool}\`\n> \`\`\`json\n> ${JSON.stringify(toolCall.arguments).slice(0, 300)}\n> \`\`\``);
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
  return toolResults;
}

/** 清洗 AI 模型自报身份的词汇 */
const AI_NAMES = ["DeepSeek", "deepseek", "DEEPSEEK", "OpenAI", "openai", "ChatGPT", "GPT-4", "Claude", "claude", "Gemini", "Llama"];
function sanitizeAI(t: string) {
  let r = t;
  for (const n of AI_NAMES) r = r.replace(new RegExp(n, "g"), "道生一");
  return r;
}

const DEFAULT_PROFILES: ApiProfile[] = [
  {
    id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com",
    apiKey: "", model: "deepseek-chat", maxTokens: 4096, temperature: 0.7,
    thinkingEnabled: true, reasoningEffort: "high",
    systemPrompt: "你是道生一，一个AI桌面助手。你运行在用户的本地设备上。请用简洁、准确的中文回答。",
    enableWebSearch: false, maxContextMessages: 50,
  },
];

export const useChatStore = defineStore("chat", () => {
  // --- Rust SQLite 持久化 ---
  async function initFromDb() {
    // 等 Tauri API 就绪
    if (!(window as unknown as { __TAURI__?: unknown }).__TAURI__) {
      setTimeout(initFromDb, 100);
      return;
    }
    try {
      const convs = await invoke<{id:string;title:string;model:string;created_at:number;updated_at:number}[]>("load_conversations");
      for (const c of convs) {
        const msgs = await invoke<{id:string;conversation_id:string;role:string;content:string;reasoning_content?:string;images?:string;timestamp:number;tokens?:number;duration?:number;cost?:number}[]>("get_messages", { conversationId: c.id });
        conversations.value.push({
          id: c.id, title: c.title, model: c.model,
          createdAt: c.created_at, updatedAt: c.updated_at,
          messages: msgs.map(m => ({
            id: m.id, role: m.role as MessageRole, content: m.content,
            reasoning_content: m.reasoning_content,
            images: m.images ? JSON.parse(m.images) as ImageAttachment[] : undefined,
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
    if (!(window as unknown as { __TAURI__?: unknown }).__TAURI__) return;
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
    if (!(window as unknown as { __TAURI__?: unknown }).__TAURI__) return;
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
    images?: ImageAttachment[]
  ): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: "user",
      content: text,
      images: images && images.length > 0 ? images : undefined,
      timestamp: Date.now(),
    };
    const conv = conversations.value.find((c) => c.id === convId);
    if (conv) {
      conv.messages.push(msg);
      conv.updatedAt = Date.now();
      if (conv.title === "新对话" && conv.messages.length === 1) {
        const titleText = text || (images?.length ? "[图片]" : "");
        conv.title = titleText.slice(0, 30) + (titleText.length > 30 ? "..." : "");
      }
    }
    return msg;
  }

  // --- 图片预处理：用视觉模型描述图片 ---
  async function describeImages(images: ImageAttachment[]): Promise<string> {
    // 找一个有视觉能力的 API（非 DeepSeek，已配 Key）
    const visionProfile = profiles.value.find(
      p => p.apiKey && !p.baseUrl.includes("deepseek")
    );
    if (!visionProfile) return "";

    const baseUrl = visionProfile.baseUrl.replace(/\/+$/, "");
    const parts: string[] = [];

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
          if (desc) parts.push(`[图片: ${img.fileName || "附件"}] ${desc}`);
        }
      } catch { /* 单张失败不影响其他 */ }
    }
    return parts.join("\n\n");
  }

  // --- 流式发送 ---
  async function sendMessage(text: string, images?: ImageAttachment[]) {
    let convId = activeConversationId.value;
    if (!convId) {
      convId = createConversation();
    }

    addUserMessage(convId, text, images);

    const assistantMsg: ChatMessage = {
      id: uuidv4(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      streaming: true,
    };
    const conv = conversations.value.find((c) => c.id === convId)!;

    // 图片预处理：非视觉模型 → 调用视觉 API 描述图片
    const isDS = currentConfig.value.baseUrl.includes("deepseek");
    if (isDS && images && images.length > 0) {
      assistantMsg.content = "🔍 正在分析图片...\n\n";
      const desc = await describeImages(images);
      if (desc) {
        // 将图片描述注入用户消息
        const lastUserMsg = conv.messages.filter((m) => m.role === "user").at(-1);
        if (lastUserMsg) {
          lastUserMsg.content = `${text}\n\n${desc}`;
          lastUserMsg.images = undefined;
        }
        images = undefined;
        assistantMsg.content = "";
      } else {
        // 没有可用视觉 API，回退到文本模式
        images = undefined;
        const lastUserMsg = conv.messages.filter((m) => m.role === "user").at(-1);
        if (lastUserMsg) {
          lastUserMsg.images = undefined;
          if (!lastUserMsg.content) lastUserMsg.content = "[图片]";
        }
        assistantMsg.content = "⚠️ 未配置视觉 API，无法识别图片。请在设置中添加支持视觉能力的 API 配置。\n\n";
      }
    }

    conv.messages.push(assistantMsg);
    conv.updatedAt = Date.now();

    isStreaming.value = true;
    streamingContent.value = "";
    streamingReasoning.value = "";
    const startTime = Date.now();
    let unlistenFns: UnlistenFn[] = [];
    let timedOut = false;
    let inputTokens = 0;

    const timeoutId = setTimeout(() => { timedOut = true; stopStreaming(); }, 120000);
    const memory = useMemorySystem();

    try {
      const config = currentConfig.value;
      if (!config.baseUrl || !config.apiKey) throw new Error("请先在设置中配置 API 地址和 Key");

      // 联网搜索
      let sp = config.systemPrompt || "";
      if (config.enableWebSearch && text.trim()) {
        try {
          const results = await invoke<{title:string;url:string;snippet:string}[]>("web_search", { query: text.trim(), braveKey: "" });
          if (results.length > 0) {
            sp += formatSearchResults(text.trim(), results);
          }
        } catch { /* 搜索暂不可用 */ }
      }

      // 注入已启用的技能
      const skillStore = useSkillStore();
      const skillPrompts = skillStore.enabledPrompts();
      if (skillPrompts) {
        sp = sp ? `${sp}\n\n---\n\n${skillPrompts}` : skillPrompts;
      }

      // 注入 MCP 工具
      const mcpPrompt = getMcpToolsPrompt();
      if (mcpPrompt) {
        sp = sp ? `${sp}\n\n${mcpPrompt}` : mcpPrompt;
      }

      // 注入相关记忆（语义 + 关键词混合检索）
      const memText = await memory.retrieveMemories(text, config);
      if (memText) {
        sp = sp ? `${sp}\n\n${memText}` : memText;
      }

      // 自动摘要旧消息
      const summaries = await memory.maybeSummarize(convId, conv.messages, config);
      for (const s of summaries) {
        sp = sp ? `${sp}\n\n对话摘要: ${s}` : `对话摘要: ${s}`;
      }

      // 构建 Rust 格式消息
      const maxCtx = config.maxContextMessages || 50;
      const rustMsgs: { role: string; content: unknown }[] = [];
      if (sp) rustMsgs.push({ role: "system", content: sp });
      conv.messages.filter(m => m.role !== "system" && !m.streaming).slice(-maxCtx).forEach(m => {
        if (m.images?.length) {
          rustMsgs.push({ role: m.role, content: [{ type: "text", text: m.content }, ...m.images.map(img => ({ type: "image_url", image_url: { url: img.base64, detail: "auto" } }))] });
        } else {
          rustMsgs.push({ role: m.role, content: m.content });
        }
      });

      // 估算输入 token（用于费用计算）
      inputTokens = rustMsgs.reduce((sum, m) => {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return sum + estimateMessageTokens(text);
      }, 0);

      const rustCfg = {
        base_url: config.baseUrl, api_key: config.apiKey, model: config.model || "deepseek-chat",
        max_tokens: config.maxTokens, temperature: config.temperature,
        thinking_enabled: config.thinkingEnabled, reasoning_effort: config.reasoningEffort,
        system_prompt: sp, enable_web_search: config.enableWebSearch,
      };

      // ReAct 自动工具调用：有 MCP 工具时先跑决策循环
      let reactDone = false;
      if (mcpToolsCache.length > 0) {
        const flatMsgs = rustMsgs.map(m => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        }));
        try {
          streamingContent.value = "🔍 正在分析并调用工具...";
          const [finalAnswer, ...toolResults] = await runReactLoop(config, flatMsgs);
          if (finalAnswer) {
            // ReAct 循环给出了最终答案，直接展示（跳过流式）
            streamingContent.value =
              (toolResults.length > 0 ? toolResults.join("\n") + "\n\n" : "") + sanitizeAI(finalAnswer);
            reactDone = true;
          } else if (toolResults.length > 0) {
            // 循环耗尽仍在调工具：把过程附到上下文，交给流式兜底回答
            rustMsgs.push({ role: "user", content: toolResults.join("\n") + "\n请直接给出最终答案。" });
          }
        } catch { /* ReAct 失败，回退到流式 */ }
      }

      if (!reactDone) {
        // 监听 Rust SSE 事件
        const doneP = new Promise<void>((resolve, reject) => {
          listen<{ reasoning_content?: string; content?: string; tokens?: number }>("sse-delta", e => {
            const d = e.payload;
            if (d.reasoning_content) streamingReasoning.value += sanitizeAI(d.reasoning_content);
            if (d.content) streamingContent.value += sanitizeAI(d.content);
            if (d.tokens) assistantMsg.tokens = d.tokens;
          }).then(f => unlistenFns.push(f));
          listen<string>("sse-error", e => reject(new Error(e.payload))).then(f => unlistenFns.push(f));
          listen("sse-done", () => resolve()).then(f => unlistenFns.push(f));
        });

        await invoke("send_message", { config: rustCfg, messages: rustMsgs });
        await doneP;
      }

    } catch (err: unknown) {
      if (!timedOut && err instanceof Error) {
        streamingContent.value = streamingContent.value || `[错误] ${err.message}`;
      }
    } finally {
      clearTimeout(timeoutId);
      unlistenFns.forEach(f => f());
      assistantMsg.content = streamingContent.value;
      assistantMsg.reasoning_content = streamingReasoning.value || undefined;
      assistantMsg.duration = ((Date.now() - startTime) / 1000).toFixed(1) as unknown as number;
      // Token 计数：优先使用 Rust 端返回的 usage，否则本地估算
      if (!assistantMsg.tokens) {
        assistantMsg.tokens = estimateMessageTokens(streamingContent.value, streamingReasoning.value);
      }
      // 费用估算
      try {
        assistantMsg.cost = estimateCost(currentConfig.value.model, inputTokens, assistantMsg.tokens || 0);
      } catch { /* 费用计算失败不影响主流程 */ }
      assistantMsg.streaming = false;
      streamingContent.value = "";
      streamingReasoning.value = "";
      isStreaming.value = false;
      conv.updatedAt = Date.now();
      scheduleSave();

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
