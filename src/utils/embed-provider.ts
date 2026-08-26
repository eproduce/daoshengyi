// P-A6 本地语义 embedding：判断 embedding 提供方（纯函数，可测试）。
// - "ollama"：baseUrl 指向本地 Ollama（/v1 兼容端点）→ 用 ollama_embed 命令（nomic-embed-text）
// - "deepseek 主模型"：DeepSeek 无 embeddings 端点 → 也归为 ollama，尝试本地 Ollama 补语义
//   （Ollama 未运行 / nomic-embed-text 未装时 ollama_embed 返回错误 → 上层返回 null 静默跳过）
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
