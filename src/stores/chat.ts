import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import type { Conversation, ChatMessage, ApiConfig, ApiProfile, ImageAttachment } from "@/types";
import { v4 as uuidv4 } from "./uuid";
import { searchDDG, formatSearchResults } from "@/api/search";

const DEFAULT_PROFILES: ApiProfile[] = [
  {
    id: "default", name: "OpenAI", baseUrl: "https://api.openai.com/v1",
    apiKey: "", model: "gpt-4o", maxTokens: 4096, temperature: 0.7,
    thinkingEnabled: false, reasoningEffort: "high", systemPrompt: "", enableWebSearch: false, maxContextMessages: 50,
  },
  {
    id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com",
    apiKey: "", model: "deepseek-v4-pro", maxTokens: 4096, temperature: 0.7,
    thinkingEnabled: true, reasoningEffort: "high",
    systemPrompt: "你是一个有帮助的AI助手。", enableWebSearch: false, maxContextMessages: 50,
  },
];

export const useChatStore = defineStore("chat", () => {
  // --- 状态 ---
  const conversations = ref<Conversation[]>([]);
  const activeConversationId = ref<string | null>(null);
  const profiles = ref<ApiProfile[]>(loadProfiles());
  const activeProfileId = ref<string>(profiles.value[0]?.id ?? "default");
  const isStreaming = ref(false);
  const streamingContent = ref("");
  const streamingReasoning = ref("");
  const abortController = ref<AbortController | null>(null);
  const activeReader = ref<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  // --- 计算属性 ---
  const activeConversation = computed(() =>
    conversations.value.find((c) => c.id === activeConversationId.value) ?? null
  );

  const sortedConversations = computed(() =>
    [...conversations.value].sort((a, b) => b.updatedAt - a.updatedAt)
  );

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

  // --- 配置组持久化 ---
  function loadProfiles(): ApiProfile[] {
    try {
      const saved = localStorage.getItem("daoshengyi_profiles");
      if (saved) {
        const parsed = JSON.parse(saved) as ApiProfile[];
        // 迁移：旧数据没有 thinkingEnabled 字段，重置为默认
        if (parsed.length > 0 && parsed[0].thinkingEnabled === undefined) {
          console.log("[道生一] 检测到旧配置格式，已重置为默认");
          localStorage.removeItem("daoshengyi_profiles");
          localStorage.removeItem("daoshengyi_activeProfile");
          return [...DEFAULT_PROFILES];
        }
        return parsed;
      }
    } catch { /* ignore */ }
    return [...DEFAULT_PROFILES];
  }

  function saveProfiles() {
    localStorage.setItem("daoshengyi_profiles", JSON.stringify(profiles.value));
    localStorage.setItem("daoshengyi_activeProfile", activeProfileId.value);
  }

  // 自动保存
  watch(profiles, saveProfiles, { deep: true });
  watch(activeProfileId, (id) => {
    localStorage.setItem("daoshengyi_activeProfile", id);
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

    // DeepSeek 不支持图片，自动剥离
    const isDS = currentConfig.value.baseUrl.includes("deepseek");
    if (isDS && images && images.length > 0) {
      images = undefined;
      const lastUserMsg = conv.messages.filter((m) => m.role === "user").at(-1);
      if (lastUserMsg) {
        lastUserMsg.images = undefined;
        if (!lastUserMsg.content) lastUserMsg.content = "[图片]";
      }
      assistantMsg.content = "⚠️ DeepSeek 不支持图片识别，已自动转为文本模式。\n\n";
    }

    conv.messages.push(assistantMsg);
    conv.updatedAt = Date.now();

    isStreaming.value = true;
    streamingContent.value = "";
    streamingReasoning.value = "";
    const controller = new AbortController();
    abortController.value = controller;
    const startTime = Date.now();

    const timeoutId = setTimeout(() => controller.abort(), 120000);

    try {
      const config = currentConfig.value;

      if (!config.baseUrl || !config.apiKey) {
        throw new Error("请先在设置中配置 API 地址和 Key");
      }

      // 构建消息（含系统提示词 + 上下文限制）
      const maxCtx = config.maxContextMessages || 50;
      const recentMessages = conv.messages
        .filter((m) => m.role !== "system" && !m.streaming)
        .slice(-maxCtx);
      let systemPrompt = config.systemPrompt || "";

      // 联网搜索
      if (config.enableWebSearch && text.trim()) {
        try {
          const results = await searchDDG(text.trim());
          if (results.length > 0) {
            systemPrompt += formatSearchResults(text.trim(), results);
          }
        } catch { /* 搜索失败不影响对话 */ }
      }

      const apiMessages: { role: string; content: unknown }[] = [];
      if (systemPrompt) {
        apiMessages.push({ role: "system", content: systemPrompt });
      }
      recentMessages.forEach((m) => {
          if (m.images && m.images.length > 0) {
            apiMessages.push({
              role: m.role,
              content: [
                { type: "text" as const, text: m.content },
                ...m.images.map((img) => ({
                  type: "image_url" as const,
                  image_url: { url: img.base64, detail: "auto" as const },
                })),
              ],
            });
          } else {
            apiMessages.push({ role: m.role, content: m.content });
          }
        });

      const requestBody: Record<string, unknown> = {
        model: config.model || "gpt-4o",
        messages: apiMessages,
        stream: true,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
      };

      // 思考模式：DeepSeek 需显式关闭
      if (config.thinkingEnabled) {
        requestBody.thinking = { type: "enabled" };
        requestBody.reasoning_effort = config.reasoningEffort;
      } else if (config.baseUrl.includes("deepseek")) {
        requestBody.thinking = { type: "disabled" };
      }

      const baseUrl = config.baseUrl.replace(/\/+$/, "");
      const url = `${baseUrl}/chat/completions`;

      console.log("[道生一] 发送请求:", url, "模型:", requestBody.model);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`[${response.status}] ${errText.slice(0, 200)}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("浏览器不支持流式响应");
      activeReader.value = reader;

      const decoder = new TextDecoder();
      let buffer = "";
      let chunkCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        chunkCount++;
        const size = value?.length || 0;
        console.log(`[道生一] 流块 #${chunkCount}: ${size} bytes, done=${done}`);

        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        const dataLines = lines.filter(l => l.trim().startsWith("data:"));
        if (dataLines.length > 0) console.log(`[道生一] SSE 行数: ${dataLines.length}, 内容长度: ${assistantMsg.content.length}`);

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const data = trimmed.replace(/^data:\s*/, "");
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.reasoning_content) {
              streamingReasoning.value += delta.reasoning_content;
            }
            if (delta?.content) {
              streamingContent.value += delta.content;
            }
            if (parsed.usage) {
              assistantMsg.tokens = parsed.usage.total_tokens || parsed.usage.completion_tokens;
            }
          } catch { /* skip */ }
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        if (!streamingContent.value) streamingContent.value = "[已取消]";
      } else if (err instanceof TypeError && err.message.includes("fetch")) {
        streamingContent.value = "[网络错误] 无法连接到 API 服务器";
      } else {
        streamingContent.value = `[错误] ${err instanceof Error ? err.message : "未知错误"}`;
      }
    } finally {
      clearTimeout(timeoutId);
      activeReader.value = null;
      assistantMsg.content = streamingContent.value;
      assistantMsg.reasoning_content = streamingReasoning.value || undefined;
      assistantMsg.duration = ((Date.now() - startTime) / 1000).toFixed(1) as unknown as number;
      assistantMsg.streaming = false;
      streamingContent.value = "";
      streamingReasoning.value = "";
      isStreaming.value = false;
      abortController.value = null;
      conv.updatedAt = Date.now();
    }
  }

  function stopStreaming() {
    abortController.value?.abort();
    activeReader.value?.cancel().catch(() => {});
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

  // --- 数据持久化 ---
  function saveToLocalStorage() {
    localStorage.setItem("daoshengyi_conversations", JSON.stringify(conversations.value));
    localStorage.setItem("daoshengyi_activeId", activeConversationId.value || "");
  }

  function loadFromLocalStorage() {
    try {
      const saved = localStorage.getItem("daoshengyi_conversations");
      if (saved) conversations.value = JSON.parse(saved);
      const activeId = localStorage.getItem("daoshengyi_activeId");
      if (activeId && conversations.value.some((c) => c.id === activeId)) {
        activeConversationId.value = activeId;
      }
      const activeProf = localStorage.getItem("daoshengyi_activeProfile");
      if (activeProf && profiles.value.some((p) => p.id === activeProf)) {
        activeProfileId.value = activeProf;
      }
    } catch { /* ignore */ }
  }

  loadFromLocalStorage();

  return {
    conversations,
    activeConversationId,
    activeConversation,
    sortedConversations,
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
    saveToLocalStorage,
  };
});
