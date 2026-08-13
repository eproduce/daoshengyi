import { invoke } from "@tauri-apps/api/core";
import { v4 as uuidv4 } from "./uuid";
import type { ChatMessage } from "@/types";

const SUMMARIZE_THRESHOLD = 20;
const SUMMARIZE_CHUNK = 15;

interface FactRow {
  id: string; conversation_id?: string; fact: string; fact_type: string;
  importance: number; access_count: number; last_accessed?: number; created_at: number;
}

interface SummaryRow {
  id: string; conversation_id: string; summary: string;
  msg_range_start: number; msg_range_end: number; created_at: number;
}

export function useMemorySystem() {
  // --- Embedding 生成 (OpenAI 兼容 API) ---
  async function generateEmbedding(text: string, config: { baseUrl: string; apiKey: string; model: string }): Promise<number[] | null> {
    try {
      const baseUrl = config.baseUrl.replace(/\/+$/, "");
      const resp = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 8000) }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.data?.[0]?.embedding || null;
    } catch { return null; }
  }
  // --- 摘要压缩 ---
  async function maybeSummarize(convId: string, messages: ChatMessage[], config: { baseUrl: string; apiKey: string; model: string }): Promise<string[]> {
    if (messages.length < SUMMARIZE_THRESHOLD) return [];

    // 检查是否已有摘要覆盖
    const existing = await invoke<SummaryRow[]>("get_summaries", { convId }).catch(() => [] as SummaryRow[]);
    const covered = new Set<number>();
    for (const s of existing) {
      for (let i = s.msg_range_start; i <= s.msg_range_end; i++) covered.add(i);
    }

    // 找到未被摘要覆盖的最早一批消息
    const summaries: string[] = [];
    let start = 0;
    while (start < messages.length - 5) {
      if (covered.has(start)) { start++; continue; }
      const end = Math.min(start + SUMMARIZE_CHUNK, messages.length - 5);
      if (end - start < 5) break;

      const chunk = messages.slice(start, end);
      const convText = chunk.map(m => `[${m.role}]: ${m.content}`).join("\n\n");
      const summary = await callLLM(config, `请将以下对话压缩为一段 150 字以内的摘要，保留关键信息：\n\n${convText}`);
      if (!summary) break;

      const id = uuidv4();
      await invoke("save_summary", { id, convId, summary, rangeStart: start, rangeEnd: end - 1 }).catch(() => {});
      summaries.push(summary);
      for (let i = start; i < end; i++) covered.add(i);
      start = end;
    }

    return summaries;
  }

  // --- 事实提取 ---
  async function extractFacts(convId: string, messages: ChatMessage[], config: { baseUrl: string; apiKey: string; model: string }): Promise<FactRow[]> {
    const convText = messages.slice(-10).map(m => `[${m.role}]: ${m.content}`).join("\n\n");
    const prompt = `从以下对话片段中提取关键事实。返回 JSON 数组，每个事实包含 fact 和 type 字段。
type: preference(用户偏好)/info(信息)/decision(决策)/todo(待办)

对话：
${convText}

只返回 JSON 数组，不要其他内容。示例：[{"fact":"用户叫小明","type":"info"}]`;

    const raw = await callLLM(config, prompt);
    if (!raw) return [];

    try {
      const jsonStr = raw.replace(/```json|```/g, "").trim();
      const items = JSON.parse(jsonStr) as { fact: string; type: string }[];
      const facts: FactRow[] = [];
      for (const item of items) {
        if (!item.fact || item.fact.length < 3) continue;
        const f: FactRow = {
          id: uuidv4(), conversation_id: convId, fact: item.fact,
          fact_type: item.type || "info",
          importance: item.type === "preference" ? 8 : 5,
          access_count: 0, last_accessed: undefined, created_at: Date.now(),
        };
        await invoke("save_fact", { fact: f }).catch(() => {});

        // 生成 embedding 并存储（后台，不阻塞）
        generateEmbedding(item.fact, config).then(emb => {
          if (emb) invoke("set_fact_embedding", { id: f.id, embedding: emb }).catch(() => {});
        });

        facts.push(f);
      }
      return facts;
    } catch { return []; }
  }

  // --- 检索相关记忆（语义 + 关键词混合）---
  async function retrieveMemories(query: string, config?: { baseUrl: string; apiKey: string; model: string }): Promise<string> {
    try {
      const prefs = await invoke<FactRow[]>("get_preferences");
      let facts: FactRow[] = [];

      // 尝试语义检索
      if (config?.apiKey) {
        const emb = await generateEmbedding(query, config);
        if (emb) {
          const scored = await invoke<[FactRow, number][]>("search_by_embedding", { embedding: emb, limit: 5n });
          facts = scored.map(([f]) => f);
        }
      }

      // 回退：关键词检索
      if (facts.length === 0) {
        facts = await invoke<FactRow[]>("search_facts", { query, limit: 5n });
      }

      const all = [...prefs, ...facts];
      const seen = new Set<string>();
      const unique = all.filter(f => {
        if (seen.has(f.fact)) return false;
        seen.add(f.fact);
        invoke("touch_fact", { id: f.id }).catch(() => {});
        return true;
      });

      if (unique.length === 0) return "";
      const labels: Record<string, string> = { preference: "偏好", info: "信息", decision: "决策", todo: "待办" };
      return "## 记忆\n" + unique.map(f => `- ${f.fact} (${labels[f.fact_type] || f.fact_type})`).join("\n");
    } catch { return ""; }
  }

  return { maybeSummarize, extractFacts, retrieveMemories };
}

// --- LLM 调用辅助 ---
async function callLLM(config: { baseUrl: string; apiKey: string; model: string }, prompt: string): Promise<string | null> {
  try {
    const baseUrl = config.baseUrl.replace(/\/+$/, "");
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model || "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 400,
        temperature: 0.3,
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}
