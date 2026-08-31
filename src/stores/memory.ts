// 长期记忆系统 store：跨会话记住用户偏好 / 事实 / 决策 / 待办。
// - 事实提取（LLM 输出 JSON → memory_facts）+ 摘要压缩 + 用户画像沉淀
// - 检索：FTS5 关键词 + Ollama 语义向量 混合，对话时自动注入
// - 主动记忆工具（memory_save / recall / forget）、智能复习、跨会话主题汇总（episodic）
// - 分层：事实（semantic）/ 会话摘要 / 主题聚合（episodic）
import { invoke } from "@tauri-apps/api/core";
import { v4 as uuidv4 } from "./uuid";
import { getSettings } from "@/api/appSettings";
import { embeddingSource } from "@/utils/embed-provider";
import { buildReviewPrompt, parseReviewActions } from "@/utils/memory-review";
import { routeProfileId } from "@/utils/model-routing";
import { formatMemoriesBlock } from "@/utils/memory-format";
import { buildEpisodicPrompt, parseEpisodic } from "@/utils/memory-episodic";
import { shouldExtractMessages, extractGateReason } from "@/utils/memory-extract";
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
  // P-A12 多模型路由：按任务类型解析辅助模型配置（routing[taskType] → 辅助模型 → fallback 主模型）。
  // 摘要/提取/关键词扩展/复习等批量辅助 LLM 任务可配置走更便宜/更快的模型，节省主模型额度。
  function resolveTaskConfig(taskType: string, fallback: { baseUrl: string; apiKey: string; model: string }) {
    const st = getSettings();
    const id = routeProfileId(taskType, st.modelRouting || {}, st.auxiliaryProfileId || "");
    const p = id ? st.profiles.find((x) => x.id === id) : undefined;
    if (p && p.baseUrl) return { baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model };
    return fallback;
  }

  // --- Embedding 生成 (兼容 API + P-A6 本地 Ollama) ---
  async function generateEmbedding(text: string, config: { baseUrl: string; apiKey: string; model: string }): Promise<number[] | null> {
    const src = embeddingSource(config.baseUrl);
    // P-A6 本地语义 embedding：baseUrl 是本地 Ollama，或主模型 DeepSeek（无 embeddings 端点）时，
    // 用 Ollama 的 nomic-embed-text 生成向量补语义检索。Ollama 未运行 / 模型未装时
    // ollama_embed 返回错误 → 返回 null（语义检索静默跳过，FTS5 关键词检索不受影响）。
    if (src === "ollama") {
      try {
        const emb = await invoke<number[][]>("ollama_embed", { texts: [text.slice(0, 8000)] });
        return emb?.[0] ?? null;
      } catch { return null; }
    }
    // 其它 OpenAI 兼容 /embeddings 端点（OpenAI/通义/智谱等）
    if (src === "none") return null;
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
      // P-A12：摘要走 summarize 路由模型（配置了专门模型则用之，否则跟随主模型）
      const cfg = resolveTaskConfig("summarize", config);
      const summary = await callLLM(cfg, `请将以下对话压缩为一段 150 字以内的摘要，保留关键信息：\n\n${convText}`);
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
    // 2.3 写入触发优化：对话过短/内容过少（纯寒暄、过程性问答）跳过提取，
    // 避免每次对话都调 LLM 生成低价值事实导致记忆库堆积（失败静默，不阻塞主流程）
    if (!shouldExtractMessages(messages)) {
      extractGateReason(messages); // 诊断用（当前静默，不打印日志）
      return [];
    }
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

    // P-A12：事实提取走 summarize 路由模型（降低批量辅助成本）
    const cfg = resolveTaskConfig("summarize", config);
    const raw = await callLLM(cfg, prompt);
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
        generateEmbedding(item.fact, cfg).then(emb => {
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
      // P-A12：关键词扩展走 summarize 路由模型
      const cfg = resolveTaskConfig("summarize", config);
      const raw = await callLLM(cfg, prompt);
      if (!raw) return [];
      return raw.split(/[,，、\s]+/).map(s => s.trim()).filter(s => s.length >= 2).slice(0, 3);
    } catch { return []; }
  }

  // --- 检索相关记忆（混合：FTS5 全文 + 语义向量 + 意图扩展 + 偏好，按相关度×重要度×时效排序）---
  async function retrieveMemories(query: string, config?: { baseUrl: string; apiKey: string; model: string }): Promise<string> {
    try {
      // §3.2 记忆配置：关闭则跳过相关记忆注入（用户画像 getUserProfile 独立不受影响）
      const st = getSettings();
      if (st.memoryEnabled === false) return "";
      const recallLimit = Math.max(1, Math.min(20, Number(st.memoryRecallLimit ?? 6) || 6));
      const prefs = await invoke<FactRow[]>("get_preferences");
      let facts: FactRow[] = [];

      // 1) FTS5 全文检索（后端 bm25×importance×recency 加权；中文 unigram，DeepSeek 下主力）
      facts = await invoke<FactRow[]>("search_facts", { query, limit: BigInt(recallLimit) });

      // 1.5) 意图关键词扩展：首轮无结果时，LLM 提取核心词重试（提升"模糊提问"召回）
      if (facts.length === 0 && config?.apiKey) {
        const kws = await expandKeywords(query, config);
        for (const kw of kws) {
          const more = await invoke<FactRow[]>("search_facts", { query: kw, limit: BigInt(Math.max(1, recallLimit - 2)) });
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
          const scored = await invoke<[FactRow, number][]>("search_by_embedding", { embedding: emb, limit: BigInt(Math.min(3, recallLimit)) });
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

      // §2.2 注入剪裁 + 来源标注（类型/重要度/时间），超长截断避免污染上下文
      if (unique.length === 0) return "";
      return formatMemoriesBlock("相关记忆", unique);
    } catch { return ""; }
  }

  // --- P-A9 记忆复习：LLM 回顾记忆库，删除/合并过时、矛盾、重复的事实 ---
  async function reviewMemories(config: { baseUrl: string; apiKey: string; model: string }): Promise<string> {
    try {
      const all = await invoke<FactRow[]>("list_facts", { factType: "", limit: 200 }).catch(() => [] as FactRow[]);
      if (all.length < 6) return `记忆数量较少（${all.length} 条），暂不需要复习。`;
      // P-A12：记忆复习走 summarize 路由模型
      const cfg = resolveTaskConfig("summarize", config);
      const actions = parseReviewActions((await callLLM(cfg, buildReviewPrompt(all))) || "");
      if (actions.length === 0) return "智能复习完成：未发现需要整理（过时/矛盾/重复）的记忆。";
      let del = 0;
      let merge = 0;
      const byId = new Map(all.map((f) => [f.id, f]));
      for (const a of actions) {
        if (a.action === "delete") {
          await invoke("delete_fact_cmd", { id: a.id }).catch(() => {});
          del++;
        } else if (a.action === "merge") {
          await invoke("delete_fact_cmd", { id: a.id }).catch(() => {});
          merge++;
          // merge 时把保留目标的重要度 +1（上限 10），让合并后的信息更突出
          const target = byId.get(a.intoId || "");
          if (target && target.importance < 10) {
            await invoke("update_fact_cmd", {
              id: target.id, fact: target.fact, factType: target.fact_type, importance: target.importance + 1,
            }).catch(() => {});
          }
        }
      }
      return `智能复习完成：删除 ${del} 条，合并 ${merge} 条（共整理 ${actions.length} 条）。`;
    } catch (e) {
      return "智能复习失败：" + (e instanceof Error ? e.message : String(e));
    }
  }

  // --- 记忆分层 1.4：跨会话主题汇总（episodic 聚合层） ---
  // 把最近的会话摘要（episodic 单会话层）交给 LLM 提炼跨会话反复出现的主题，
  // 保存到 memory_episodic（聚合层）；已汇总的摘要 id 记入来源，避免重复汇总。
  async function aggregateEpisodic(config: { baseUrl: string; apiKey: string; model: string }): Promise<string> {
    try {
      const summaries = await invoke<SummaryRow[]>("list_all_summaries", { limit: 60 }).catch(() => [] as SummaryRow[]);
      if (summaries.length === 0) return "暂无会话摘要。对话达到一定长度会自动生成摘要，之后可在此跨会话汇总。";
      const covered = await invoke<string[]>("episodic_covered").catch(() => [] as string[]);
      const pending = summaries.filter((s) => !covered.includes(s.id));
      if (pending.length < 2) {
        return `没有新的可汇总摘要（已有 ${covered.length} 条被汇总覆盖，待汇总 ${pending.length} 条，至少需 2 条）。`;
      }
      const batch = pending.slice(0, 30);
      const cfg = resolveTaskConfig("summarize", config);
      const raw = await callLLM(cfg, buildEpisodicPrompt(batch));
      const items = parseEpisodic(raw || "");
      if (items.length === 0) {
        return "跨会话汇总完成：未发现跨会话共同主题（这些摘要已标记为已汇总）。";
      }
      const sourceIds = JSON.stringify(batch.map((s) => s.id));
      let saved = 0;
      for (const it of items) {
        const id = uuidv4();
        await invoke("save_episodic_cmd", {
          id, title: it.title, summary: it.summary, sourceSummaryIds: sourceIds,
        }).catch(() => {});
        saved++;
      }
      return `跨会话汇总完成：新增 ${saved} 个主题条目（覆盖 ${batch.length} 条会话摘要）。`;
    } catch (e) {
      return "跨会话汇总失败：" + (e instanceof Error ? e.message : String(e));
    }
  }

  return { maybeSummarize, extractFacts, retrieveMemories, getUserProfile, reviewMemories, aggregateEpisodic };
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
