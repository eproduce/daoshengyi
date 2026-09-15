// 工具发现（融合自 Codex 的 `tool_search`）：对「未直接声明的工具」做 BM25 检索。
//
// 为什么需要：单次请求能声明的工具数有上限（MAX_NATIVE_TOOLS），超出的 MCP 工具过去被
// **静默截尾**——模型根本不知道它们存在，也就永远用不上。现在改为把溢出的工具放进
// 「可检索目录」，模型用自然语言（中文/英文均可）检索，命中后**立即激活**到可用工具里。
//
// 纯函数 + 无副作用，便于单元测试。

/** 参与检索的一条文档（这里一条 = 一个工具） */
export interface SearchDoc {
  id: string;
  /** 检索正文（工具名 + 描述 + 服务器名；由 buildToolSearchText 生成） */
  text: string;
}

export interface SearchHit {
  id: string;
  score: number;
}

/** BM25 参数（业界常用默认值） */
const K1 = 1.2;
const B = 0.75;

/**
 * 中英文混合分词：
 * - ASCII：按 `[a-z0-9]+` 切词并小写（`workflow_run` → workflow / run，
 *   这样查 "run" 也能命中 `workflow_run`）；
 * - CJK（中文/日文/韩文）：切**单字 + 相邻双字（bigram）**。
 *   中文没有空格，纯按空格切词会全部落空；bigram 是无需分词典的实用折中
 *   （"数据库" → 数/据/库/数据/据库）。
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = (text || "").toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9]+/g)) out.push(m[0]);
  const runs = lower.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? [];
  for (const run of runs) {
    for (let i = 0; i < run.length; i++) {
      out.push(run[i]);
      if (i + 1 < run.length) out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

/** 把工具信息拼成检索正文（名称重复两遍以提高「按名字查」的权重） */
export function buildToolSearchText(name: string, description: string, server = ""): string {
  return `${name} ${name} ${description} ${server}`;
}

/** BM25 索引：一次性建好词频/文档频，之后可反复检索 */
export class BM25Index {
  private readonly ids: string[] = [];
  private readonly docLen: number[] = [];
  private readonly tf: Map<string, number>[] = [];
  private readonly df = new Map<string, number>();
  private readonly avgdl: number;

  constructor(docs: SearchDoc[]) {
    let totalLen = 0;
    for (const doc of docs) {
      const tokens = tokenize(doc.text);
      const freq = new Map<string, number>();
      for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
      this.ids.push(doc.id);
      this.tf.push(freq);
      this.docLen.push(tokens.length);
      totalLen += tokens.length;
      for (const term of freq.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
    }
    this.avgdl = this.ids.length > 0 ? totalLen / this.ids.length : 0;
  }

  get size(): number {
    return this.ids.length;
  }

  /** 检索：返回得分 > 0 的结果（按分数降序），最多 `limit` 条 */
  search(query: string, limit = 8): SearchHit[] {
    const terms = tokenize(query);
    if (terms.length === 0 || this.ids.length === 0) return [];
    const n = this.ids.length;
    const scores = new Array<number>(n).fill(0);
    const seen = new Set<string>();
    for (const term of terms) {
      if (seen.has(term)) continue;
      seen.add(term);
      const df = this.df.get(term);
      if (!df) continue;
      // BM25 IDF（+0.5 平滑，避免出现在全部文档里的词得到负分）
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (let i = 0; i < n; i++) {
        const f = this.tf[i].get(term);
        if (!f) continue;
        const denom = f + K1 * (1 - B + (B * this.docLen[i]) / (this.avgdl || 1));
        scores[i] += idf * ((f * (K1 + 1)) / denom);
      }
    }
    const hits: SearchHit[] = [];
    for (let i = 0; i < n; i++) {
      if (scores[i] > 0) hits.push({ id: this.ids[i], score: scores[i] });
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, Math.max(1, limit));
  }
}
