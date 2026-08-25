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
  // --- Embedding 生成 (兼容 API) ---
  async function generateEmbedding(text: string, config: { baseUrl: string; apiKey: string; model: string }): Promise<number[] | null> {
    // DeepSeek 不提供 embeddings 端点，跳过语义检索（回退关键词检索）
    if (config.baseUrl.includes("deepseek")) return null;
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

  // --- 事实提取（带质量门槛：只存跨会话有用的关键事实，排除过程性/一次性信息）---
  async function extractFacts(convId: string, messages: ChatMessage[], config: { baseUrl: string; apiKey: string; model: string }): Promise<FactRow[]> {
    const convText = messages.slice(-10).map(m => `[${m.role}]: ${m.content}`).join("\n\n");
    const prompt = `从以下对话中提取值得长期记住的关键事实。返回 JSON 数组，每项含 fact、type、importance 字段。
type: preference(用户偏好)/info(信息)/decision(决策)/todo(待办)
importance: 重要度 1-10（用户偏好/个人信息/明确决定给 7-9；一般信息 4-6；低价值给 1-3）

【提取标准】
- 要提取：用户个人偏好、姓名/职业/所在地等身份信息、作出的决定、交代的待办事项、对未来的计划
- 【不要提取】一次性的过程性/即时信息，例如：本次查询了什么、搜索结果具体数值、截图保存路径、访问了哪个网页、单次的天气/价格结果。这些会过期或对后续对话无价值，只会让记忆库膨胀。

对话：
${convText}

只返回 JSON 数组，不要其他内容。示例：[{"fact":"用户喜欢简洁的回答","type":"preference","importance":9}]`;

    const raw = await callLLM(config, prompt);
    if (!raw) return [];

    try {
      const jsonStr = raw.replace(/```json|```/g, "").trim();
      const items = JSON.parse(jsonStr) as { fact: string; type: string; importance?: number }[];
      const facts: FactRow[] = [];
      for (const item of items) {
        if (!item.fact || item.fact.length < 3) continue;
        // 重要度门槛：importance < 3 的低价值事实不存（避免膨胀）
        const importance = Math.max(1, Math.min(10, item.importance ?? (item.type === "preference" ? 8 : 5)));
        if (importance < 3) continue;
        const f: FactRow = {
          id: uuidv4(), conversation_id: convId, fact: item.fact,
          fact_type: item.type || "info",
          importance,
          access_count: 0, last_accessed: undefined, created_at: Date.now(),
        };
        // save_fact 后端做 FTS 索引 + 近似去重合并；返回 "saved:id" 或 "merged:目标id"
        const saved = await invoke<string>("save_fact", { fact: f }).catch(() => "saved:" + f.id);
        const mergedId = saved.startsWith("merged:") ? saved.slice(7) : null;

        // 生成 embedding 并存储（后台，不阻塞；已合并则对目标 id 写入）
        generateEmbedding(item.fact, config).then(emb => {
          if (emb) invoke("set_fact_embedding", { id: mergedId || f.id, embedding: emb }).catch(() => {});
        });

        facts.push(mergedId ? { ...f, id: mergedId } : f);
      }
      return facts;
    } catch { return []; }
  }

  // --- 用户画像：聚合 preference 偏好 + 高重要度身份/环境信息，形成跨会话「用户档案」---
  // 每次对话稳定注入（不进相关记忆检索，属于"始终该知道的"用户画像）
  async function getUserProfile(): Promise<string> {
    try {
      // 偏好（总是）+ 高重要度（>=7）的 info/decision（身份/职业/环境/重要决定）
      const prefs = await invoke<FactRow[]>("get_preferences");
      const high = await invoke<FactRow[]>("list_facts", { factType: "", limit: 50 });
      const highImportant = high.filter(f => f.fact_type !== "preference" && f.importance >= 7);
      const all = [...prefs, ...highImportant];
      const seen = new Set<string>();
      const unique = all.filter(f => {
        if (seen.has(f.fact)) return false;
        seen.add(f.fact);
        return true;
      });
      if (unique.length === 0) return "";
      const labels: Record<string, string> = { preference: "偏好", info: "信息", decision: "决策", todo: "待办" };
      return "## 用户画像\n" + unique.map(f => `- ${f.fact} (${labels[f.fact_type] || f.fact_type})`).join("\n");
    } catch { return ""; }
  }

  // --- 意图关键词扩展：FTS 检索为空时，用 LLM 从问题提取核心检索词重试 ---
  async function expandKeywords(query: string, config: { baseUrl: string; apiKey: string; model: string }): Promise<string[]> {
    try {
      const prompt = `根据用户的问题，提取 2-3 个最适合检索历史记忆的关键词（实体名词/主题词），用顿号分隔，只输出关键词不要其它。\n用户问题：${query}\n\n示例：问题"我上次说的那家公司叫什么" → 公司\n问题"还记得我偏好什么风格的代码吗" → 代码风格 偏好`;
      const raw = await callLLM(config, prompt);
      if (!raw) return [];
      return raw.split(/[,，、\s]+/).map(s => s.trim()).filter(s => s.length >= 2).slice(0, 3);
    } catch { return []; }
  }

  // --- 检索相关记忆（混合：FTS5 全文 + 语义向量 + 意图扩展 + 偏好，按相关度×重要度×时效排序）---
  async function retrieveMemories(query: string, config?: { baseUrl: string; apiKey: string; model: string }): Promise<string> {
    try {
      const prefs = await invoke<FactRow[]>("get_preferences");
      let facts: FactRow[] = [];

      // 1) FTS5 全文检索（后端 bm25×importance×recency 加权；中文 unigram，DeepSeek 下主力）
      facts = await invoke<FactRow[]>("search_facts", { query, limit: 6n });

      // 1.5) 意图关键词扩展：首轮无结果时，LLM 提取核心词重试（提升"模糊提问"召回）
      if (facts.length === 0 && config?.apiKey) {
        const kws = await expandKeywords(query, config);
        for (const kw of kws) {
          const more = await invoke<FactRow[]>("search_facts", { query: kw, limit: 4n });
          for (const f of more) {
            if (!facts.some(x => x.fact === f.fact)) facts.push(f);
          }
          if (facts.length > 0) break;
        }
      }

      // 2) 语义向量补充（DeepSeek 无 embeddings 自动跳过，不产生结果）
      if (config?.apiKey) {
        const emb = await generateEmbedding(query, config);
        if (emb) {
          const scored = await invoke<[FactRow, number][]>("search_by_embedding", { embedding: emb, limit: 3n });
          const vecFacts = scored.map(([f]) => f);
          // 与 FTS 结果按 fact 去重合并（向量优先排前）
          facts = [...vecFacts.filter(v => !facts.some(f => f.fact === v.fact)), ...facts];
        }
      }

      // 3) 合并偏好（总是注入，用户画像；此处避免与 getUserProfile 重复，只补检索相关的）
      const all = [...prefs.filter(p => p.importance >= 7 && !facts.some(f => f.fact === p.fact)), ...facts];
      const seen = new Set<string>();
      const unique = all.filter(f => {
        if (seen.has(f.fact)) return false;
        seen.add(f.fact);
        invoke("touch_fact", { id: f.id }).catch(() => {});
        return true;
      });

      if (unique.length === 0) return "";
      const labels: Record<string, string> = { preference: "偏好", info: "信息", decision: "决策", todo: "待办" };
      return "## 相关记忆\n" + unique.map(f => `- ${f.fact} (${labels[f.fact_type] || f.fact_type})`).join("\n");
    } catch { return ""; }
  }

  return { maybeSummarize, extractFacts, retrieveMemories, getUserProfile };
}

// --- LLM 调用辅助 ---
async function callLLM(config: { baseUrl: string; apiKey: string; model: string }, prompt: string): Promise<string | null> {
  // 30 秒超时：摘要/事实提取不应阻塞主对话
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const baseUrl = config.baseUrl.replace(/\/+$/, "");
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model || "deepseek-v4-flash",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 400,
        temperature: 0.3,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
