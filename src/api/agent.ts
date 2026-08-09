import type {
  ApiConfig,
  ChatCompletionRequest,
  ChatMessage,
  MessageContent,
  StreamDelta,
} from "@/types";

/**
 * 将 ChatMessage 转为 API 请求格式（支持多模态图片）
 */
function buildMessages(messages: ChatMessage[]) {
  return messages
    .filter((m) => m.role !== "system" && !m.streaming)
    .map((m) => {
      // 如果有图片附件，构建多模态内容
      if (m.images && m.images.length > 0) {
        const parts: MessageContent = [
          { type: "text", text: m.content },
          ...m.images.map((img) => ({
            type: "image_url" as const,
            image_url: { url: img.base64, detail: "auto" as const },
          })),
        ];
        return { role: m.role, content: parts };
      }
      return { role: m.role, content: m.content };
    });
}

/**
 * 发送流式聊天请求（SSE 解析）
 */
export async function* streamChat(
  messages: ChatMessage[],
  config: ApiConfig
): AsyncGenerator<StreamDelta> {
  const body: ChatCompletionRequest = {
    model: config.model,
    messages: buildMessages(messages),
    stream: true,
  };

  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API 错误 [${response.status}]: ${errText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("无法读取响应流");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        if (delta) yield delta as StreamDelta;
      } catch {
        // 跳过解析失败的行
      }
    }
  }
}

/**
 * 非流式聊天请求
 */
export async function sendChat(
  messages: ChatMessage[],
  config: ApiConfig
): Promise<string> {
  const body: ChatCompletionRequest = {
    model: config.model,
    messages: buildMessages(messages),
    stream: false,
  };

  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API 错误 [${response.status}]: ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

