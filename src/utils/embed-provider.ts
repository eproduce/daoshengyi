// P-A6 本地语义 embedding：判断 embedding 提供方（纯函数，可测试）。
// - "ollama"：baseUrl 指向本地端点（/v1 兼容）→ 用 `ollama_embed` 命令生成向量。
//   注：该命令**已是统一入口**（优先 llama.cpp 的嵌入 GGUF，Ollama 兑底），名字里的
//   `ollama` 是历史遗留——本枚举值/函数名同理，判定的是「用户的 baseUrl 是不是本地端点」。
// - "deepseek 主模型"：DeepSeek 无 embeddings 端点 → 也归为本地补语义
//   （本地嵌入不可用时命令返回错误 → 上层返回 null 静默跳过）
// - 其它（OpenAI 兼容 /embeddings 端点）→ 走通用 embeddings 请求
export type EmbedSource = "ollama" | "openai" | "none";

const OLLAMA_RE = /localhost:11434|127\.0\.0\.1:11434/;

export function embeddingSource(baseUrl: string): EmbedSource {
  if (OLLAMA_RE.test(baseUrl)) return "ollama";
  if (baseUrl.includes("deepseek")) return "ollama"; // DeepSeek 无 embeddings → 尝试本地 Ollama 补语义
  if (!baseUrl) return "none";
  return "openai";
}

export function isOllamaBase(baseUrl: string): boolean {
  return OLLAMA_RE.test(baseUrl);
}
