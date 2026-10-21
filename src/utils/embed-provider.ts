// P-A6 本地语义 embedding：判断 embedding 提供方（纯函数，可测试）。
// - "local"：主模型没有 embeddings 端点（DeepSeek 等），或 baseUrl 指向本机服务
//   （本地推理服务通常只提供 chat）→ 用 `embed_texts` 命令走本应用托管的 llama.cpp 嵌入模型。
// - "openai"：其它 OpenAI 兼容端点 → 直接请求其 /embeddings。
// - "none"：未配置 baseUrl。
export type EmbedSource = "local" | "openai" | "none";

const LOCAL_RE = /localhost|127\.0\.0\.1|\[::1\]/;

export function embeddingSource(baseUrl: string): EmbedSource {
  if (!baseUrl) return "none";
  if (isLocalBase(baseUrl)) return "local";
  if (baseUrl.includes("deepseek")) return "local"; // DeepSeek 无 embeddings → 用本地嵌入补语义
  return "openai";
}

export function isLocalBase(baseUrl: string): boolean {
  return LOCAL_RE.test(baseUrl);
}
