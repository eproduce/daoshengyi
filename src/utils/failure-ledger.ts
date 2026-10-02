// P1-9b 失败台账：把「工具老是错」变成可读的模式，而不是每次从头踩。
//
// 两条用法：
//   ① 事后复盘——`summarizeFailures(tool_audit 行)` 按工具聚合失败率 + 相似错误分组 + 处置建议，
//      接到审计面板（数据源复用既有 `tool_audit` 表，**不新增存储**）。
//   ② 事中提醒——`failureHint()` 记账本会话内的重复失败，同一工具同一错误第 2 次就提醒模型
//      别再原样重试，改成先确认参数/换等价工具。
//
// 关键点是 `normalizeErrorText`：错误文本里行号、路径、时间戳、哈希每轮都变，
// 必须先把「会变的部分」抹平才有分组价值。

/** 审计行（与 Rust `ToolAuditRow` 字段对齐；`is_error` 来自 serde snake_case） */
export interface FailureRow {
  tool_name: string;
  is_error: boolean;
  result?: string | null;
  arguments?: string | null;
  created_at: number;
  duration_ms?: number | null;
}

export interface FailureGroup {
  /** 归一化后的错误特征（可直接当分组标题展示） */
  signature: string;
  /** 一条原始错误样本（截断、首行），用于人工判读 */
  sample: string;
  count: number;
  firstAt: number;
  lastAt: number;
}

export interface ToolFailureSummary {
  tool: string;
  /** 该工具被调用的总次数 */
  total: number;
  failed: number;
  /** 失败率 0~1（保留 3 位小数，便于展示） */
  rate: number;
  lastFailedAt: number | null;
  /** 相似错误分组（按次数降序，次数相同按签名升序 → 结果确定） */
  groups: FailureGroup[];
  /** 出现最多的错误特征 */
  topSignature: string | null;
  /** 一句话处置建议（无失败时为 null） */
  advice: string | null;
}

const MAX_SIG_TEXT = 200;
const MAX_SAMPLE_TEXT = 200;
/** 归一化时只取前几行：错误头稳定，栈帧/调用链尾巴每次都变 */
const HEAD_LINES = 3;

/** 代码文件扩展名（用于把裸文件名识别成路径） */
const FILE_EXT_SRC =
  "tsx?|jsx?|mjs|cjs|vue|rs|py|rb|go|java|kt|swift|md|json|jsonl|toml|ya?ml|css|scss|html|txt|log|csv|db|sqlite|sh|zsh|lock";

/** 剥掉各工具自加的前缀标记，让 `⛔ ENOENT…` 与 `错误: ENOENT…` 归到同一组 */
const LEADING_MARKERS =
  /^[\s\uFE0F]*(?:⛔|❌|⚠️|⚠|×|✗|✘|!)*(?:\s*(?:错误|失败|error|failed|exception|panic)[:：]?)?[\s\uFE0F]*/i;

/** 错误特征里「导致同因异文」的模式 → 建议。顺序即优先级，命中即用。 */
const ADVICE_RULES: { re: RegExp; advice: string }[] = [
  {
    // P1-9c 2026-10-02 实测（用户真实环境）：本机代理用 fake-IP 劫持 DNS —— `dig +short A` 返回
    // 198.18.0.89（RFC 2544 基准网段）这类假地址，直连该域名会**随机超时/连接被重置**，而走
    // 代理（127.0.0.1:7897）或内置浏览器就正常。上一轮 agent 不懂这个，围着同一下载任务
    // 连续 45 次 run_command 重写脚本，把整轮轮次预算烧光 —— 因此把「怎么自查」写进建议里。
    re: /fetch failed|failed to fetch|enotfound|eai_again|getaddrinfo|无法解析|域名|econnreset|connection reset|socket hang up|network is unreachable|could not connect|dial tcp|连接被(?:重置|拒|拒绝)|代理|proxy/i,
    advice:
      "网络路径问题：先用 `dig +short A <host>` 自查——若 IPv4 落在 198.18.0.0/15（或 IPv6 2001:2::/48），说明本机代理在用 fake-IP 劫持 DNS，直连会随机超时/被重置：改走代理（如 `curl -x http://127.0.0.1:7897 …`）或改用内置浏览器；**别反复直连重试**，2 次不通就换路径或如实告知用户",
  },
  {
    re: /no such file|not found|enoent|does not exist|不存在/i,
    advice: "路径可能不对或文件已改名：先用 list_dir / glob 确认现状，别照抄旧路径重试",
  },
  {
    re: /permission denied|eacces|eperm|operation not permitted|not allowed|只读/i,
    advice: "权限/沙箱拦截：确认是否越出工作区、或把沙箱档位放宽后再试",
  },
  {
    re: /command not found|not recognized|no such command|未找到命令/i,
    advice: "该命令不在 PATH：先 `which <命令>` 或用绝对路径，别重复调用",
  },
  {
    re: /timed? ?out|timeout|etimedout|超时/i,
    advice:
      "超时：涉及网络时先按上面的 DNS/代理自查（别原样重发）；若是页面/脚本本身慢，加大超时参数（browser_evaluate 支持 timeout_ms，1000~180000 毫秒），或改成后台/分步执行（如先发起、再用短脚本把 window 上的结果取回）",
  },
  {
    re: /invalid (?:arguments|params|input)|missing (?:required|field)|schema|参数(?:不合法|错误|缺失)/i,
    advice: "参数形状不符：重读该工具的 schema（名字/类型/必填项），必要时用 tool_search 查用法",
  },
  {
    re: /econnrefused|connection refused|connect ex|socket hang up|连接被拒/i,
    advice: "依赖的服务没起：先确认端口/进程是否在跑（必要时用 status 类工具查）",
  },
  {
    re: /\b(?:400|401|403)\b|unauthorized|forbidden|invalid api key|api key|bad request/i,
    advice:
      "服务端明确拒绝（4xx）：多为**参数/URL 不合法**——别猜构造资源路径（例如 Wikimedia 缩略图只接受白名单宽度 `NNNpx-`，猜错就 400 或直接丢连接），先用官方 API 取规范 URL（如 `prop=imageinfo&iiurlwidth=` 返回的 thumburl）；凭据类（401/403）则检查设置里的 Key/权限",
  },
  {
    re: /\b429\b|rate limit|too many requests|限流/i,
    advice: "被限流：降低频率或换模型档，稍后重试",
  },
  {
    re: /unexpected token|json\.parse|invalid json|syntaxerror|不是合法(?:的)?json/i,
    advice: "JSON 不合法：检查是不是把自然语言混进参数，或先取原文再解析",
  },
  { re: /already exists|已存在/i, advice: "目标已存在：先读现状再改（读-改-写），别直接新建覆盖" },
  {
    re: /no such tool|unknown tool|工具未(?:找到|注册)/i,
    advice: "工具名不对：用 tool_search 检索真实工具名，别猜",
  },
  {
    re: /old_text|not found in file|anchor|锚点|未匹配/i,
    advice: "文件内容已变（或 old_text 不唯一）：重新读取该文件取最新内容，必要时带行锚点",
  },
  {
    re: /context (?:length|window)|too many tokens|token 超|超出上下文/i,
    advice: "上下文超限：先压缩历史或收尾本轮，再继续",
  },
  { re: /disk|enospc|no space|空间不足/i, advice: "磁盘空间不足：清理或换写入位置" },
];

/**
 * 归一化错误文本：抹平「每轮都会变」的行号/路径/时间戳/哈希/大数字。
 * 不改变语义关键部分（命令名、小数字=退出码、错误关键字）。
 */
export function normalizeErrorText(text: unknown): string {
  let s = text == null ? "" : String(text);
  if (!s) return "";
  s = s.replace(/\r\n?/g, "\n");
  const head = s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, HEAD_LINES)
    .join(" ");
  s = head.replace(LEADING_MARKERS, "");
  // 时间戳 → 必须早于数字规则（否则年月日被拆散）
  s = s
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<date>")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "<time>");
  // URL（含 query，先于路径处理）
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`]+/gi, "<url>");
  // UUID → 先于长十六进制
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>");
  // 长十六进制（commit sha、内容哈希）
  s = s.replace(/\b[0-9a-f]{8,}\b/gi, "<hex>");
  // 路径：**一条正则三种形态**（绝对 / ~ / ./ · 相对多段 · 裸文件名）
  // 必须合成一条：分三条时「相对路径」会被绝对路径规则从中间的 `/` 处接上，
  // 把前缀目录（src / lib）留在签名里，而它恰好是每轮都变的噪声。
  s = s.replace(
    new RegExp(
      `(?:~|\\.{1,2})?(?:\\/[\\w.@+-]+)+` +
        `|(?:[\\w.@+-]+\\/)+[\\w.@+-]+` +
        `|[\\w.@+-]+\\.(?:${FILE_EXT_SRC})`,
      "gi",
    ),
    "<path>",
  );
  // 行:列（tsc / 编译器等格式）
  s = s.replace(/:\d+:\d+\b/g, ":<pos>");
  // 大数字：行号、字节数、耗时、端口
  s = s.replace(/\b\d{3,}\b/g, "<n>");
  // 顺序很重要：先压缩空白并 trim，再剥尾部标点，最后再 trim（
  // 否则 `a b 。` 会留下尾空格，使「同一句话」拆成两个签名）
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[：:，,。.;；]+$/, "").trim();
  if (s.length > MAX_SIG_TEXT) s = s.slice(0, MAX_SIG_TEXT) + "…";
  return s;
}

/** 错误签名：工具名 + 归一化错误文本（同一工具同一错误 → 同一签名） */
export function failureSignature(tool: string, errorText: unknown): string {
  return `${tool}｜${normalizeErrorText(errorText)}`;
}

/** 一条人类可读的错误样本（首行、截断） */
export function errorSample(text: unknown): string {
  const s = text == null ? "" : String(text);
  const first =
    s
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0] ?? "";
  const clipped = first.length > MAX_SAMPLE_TEXT ? first.slice(0, MAX_SAMPLE_TEXT) + "…" : first;
  return clipped || "(空结果)";
}

/** 按错误文本给处置建议（可 0 条，最多 2 条，顺序确定） */
export function adviceForError(errorText: unknown): string[] {
  const s = String(errorText ?? "");
  if (!s) return [];
  const out: string[] = [];
  for (const r of ADVICE_RULES) {
    if (r.re.test(s)) {
      out.push(r.advice);
      if (out.length >= 2) break;
    }
  }
  return out;
}

/** 工具名 → 是否属于「写/改」类（这类失败通常要重新读取现状，而不是重试） */
const MUTATING = new Set([
  "write_file",
  "create_file",
  "replace_string",
  "insert_string",
  "apply_patch",
  "delete_file",
  "edit_file",
]);

/**
 * 汇总失败台账。`rows` 建议传最近数百条审计记录（面板默认 300）。
 * 排序：失败次数降序 → 失败率降序 → 工具名升序（结果确定，便于快照测试）。
 */
export function summarizeFailures(
  rows: FailureRow[],
  opts: { topGroups?: number; limit?: number; includeClean?: boolean } = {},
): ToolFailureSummary[] {
  const topGroups = opts.topGroups ?? 3;
  const limit = opts.limit ?? 20;
  const includeClean = opts.includeClean ?? false;
  type Acc = {
    total: number;
    failed: number;
    lastFailedAt: number | null;
    groups: Map<string, FailureGroup>;
  };
  const acc = new Map<string, Acc>();
  for (const r of rows ?? []) {
    const tool = String(r?.tool_name ?? "").trim();
    if (!tool) continue;
    let a = acc.get(tool);
    if (!a) {
      a = { total: 0, failed: 0, lastFailedAt: null, groups: new Map() };
      acc.set(tool, a);
    }
    a.total++;
    if (!r.is_error) continue;
    a.failed++;
    const at = Number(r.created_at) || 0;
    if (a.lastFailedAt == null || at > a.lastFailedAt) a.lastFailedAt = at;
    const sig = normalizeErrorText(r.result);
    const g = a.groups.get(sig);
    if (g) {
      g.count++;
      if (at > g.lastAt) g.lastAt = at;
      if (at && (g.firstAt === 0 || at < g.firstAt)) g.firstAt = at;
    } else {
      a.groups.set(sig, {
        signature: sig,
        sample: errorSample(r.result),
        count: 1,
        firstAt: at,
        lastAt: at,
      });
    }
  }
  const out: ToolFailureSummary[] = [];
  for (const [tool, a] of acc) {
    // 台账只看「有问题的工具」：0 失败的条目噪声大于信息（默认过滤）
    if (!includeClean && a.failed === 0) continue;
    const groups = [...a.groups.values()].sort(
      (x, y) => y.count - x.count || x.signature.localeCompare(y.signature),
    );
    const summary: ToolFailureSummary = {
      tool,
      total: a.total,
      failed: a.failed,
      rate: a.total > 0 ? Math.round((a.failed / a.total) * 1000) / 1000 : 0,
      lastFailedAt: a.lastFailedAt,
      groups: groups.slice(0, topGroups),
      topSignature: groups.length ? groups[0].signature : null,
      advice: null,
    };
    summary.advice = failureAdvice(summary);
    out.push(summary);
  }
  return out
    .sort((x, y) => y.failed - x.failed || y.rate - x.rate || x.tool.localeCompare(y.tool))
    .slice(0, limit);
}

/**
 * 一句话处置建议：优先给「错误本身指向的办法」，其次按失败次数与失败率给通用建议。
 * 工具没有失败过 → null（调用方据此不渲染）。
 */
export function failureAdvice(
  summary: Pick<ToolFailureSummary, "tool" | "total" | "failed" | "rate">,
): string | null {
  if (!summary || summary.failed <= 0) return null;
  const parts: string[] = [];
  const tool = summary.tool;
  // 失败率视角：高失败率说明「这个工具本身不好用」，而不是偶发
  if (summary.total >= 3 && summary.rate >= 0.5) {
    parts.push(
      `失败率 ${Math.round(summary.rate * 100)}%（${summary.failed}/${summary.total}）——换工具或换思路，别硬用它`,
    );
  } else if (summary.failed >= 3) {
    parts.push(`已失败 ${summary.failed} 次——同一处反复失败说明前提假设错了，先查现状`);
  }
  if (MUTATING.has(tool)) {
    parts.push("写入类工具失败：先 read_file 取最新内容（必要时带行锚点）再改");
  }
  return parts.length ? parts.join("；") : `失败 ${summary.failed} 次，重试前先核对参数`;
}

/** 台账 → Markdown（审计面板导出用） */
export function failureLedgerToMarkdown(summaries: ToolFailureSummary[], totalRows = 0): string {
  const lines = ["# 工具失败台账", "", `样本：最近 ${totalRows || "?"} 条工具调用记录`, ""];
  if (!summaries.length) {
    lines.push("（样本内没有失败记录）");
    return lines.join("\n");
  }
  lines.push(
    "| 工具 | 调用 | 失败 | 失败率 | 最近失败 | 主要错误 | 建议 |",
    "|---|---|---|---|---|---|---|",
  );
  for (const s of summaries) {
    lines.push(
      `| ${esc(s.tool)} | ${s.total} | ${s.failed} | ${Math.round(s.rate * 100)}% | ${
        s.lastFailedAt ? new Date(s.lastFailedAt).toLocaleString("zh-CN") : "-"
      } | ${esc(s.topSignature ?? "-")} | ${esc(s.advice ?? "-")} |`,
    );
  }
  const withGroups = summaries.filter((s) => s.groups.length);
  if (withGroups.length) {
    lines.push("", "## 相似错误分组", "");
    for (const s of withGroups) {
      lines.push(`### ${s.tool}`, "");
      for (const g of s.groups) {
        lines.push(`- ×${g.count} \`${g.signature}\``);
        if (g.sample && g.sample !== g.signature) lines.push(`  - 样本：${esc(g.sample)}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}
function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ---------------------------------------------------------------------------
// 事中提醒：会话内失败台账（纯内存，不落盘；轮次无关，重启即清）
// ---------------------------------------------------------------------------

/** 同一签名第 2 次出现就提醒（第一次失败可能是偶发，第二次说明方法有问题） */
export const SAME_SIGNATURE_HINT_AT = 2;
/** 同一工具（签名不同）累计 3 次失败也提醒 */
export const SAME_TOOL_HINT_AT = 3;

interface LedgerEntry {
  signature: string;
  count: number;
  sample: string;
}
/** tool → (signature → 计数) */
const ledger = new Map<string, Map<string, LedgerEntry>>();

export interface LedgerHit {
  tool: string;
  signature: string;
  /** 同一签名的累计次数（含本次） */
  sameSignature: number;
  /** 该工具本次会话累计失败次数（含本次） */
  sameTool: number;
}

/** 记一笔失败，返回计数（纯函数式副作用，便于单测） */
export function recordToolFailure(tool: string, errorText: unknown): LedgerHit {
  const t = String(tool ?? "").trim();
  const sig = normalizeErrorText(errorText);
  let m = ledger.get(t);
  if (!m) {
    m = new Map();
    ledger.set(t, m);
  }
  const e = m.get(sig);
  if (e) e.count++;
  else m.set(sig, { signature: sig, count: 1, sample: errorSample(errorText) });
  let sameTool = 0;
  for (const v of m.values()) sameTool += v.count;
  return { tool: t, signature: sig, sameSignature: m.get(sig)!.count, sameTool };
}

/** 该工具本次会话的失败总数 */
export function toolFailureTotal(tool: string): number {
  const m = ledger.get(String(tool ?? "").trim());
  if (!m) return 0;
  let n = 0;
  for (const v of m.values()) n += v.count;
  return n;
}

/**
 * 记一笔失败并在达到阈值时返回提醒文案（未达阈值 → null）。
 * 提醒是「追加到工具结果末尾」的一段文字，必须短且可执行。
 */
export function failureHint(tool: string, errorText: unknown): string | null {
  const hit = recordToolFailure(tool, errorText);
  const advice = adviceForError(errorText);
  const tail = advice.length ? `建议：${advice.join("；")}。` : "";
  if (hit.sameSignature >= SAME_SIGNATURE_HINT_AT) {
    return (
      `[失败台账] 本会话内 \`${hit.tool}\` 已经用同样的方式失败 ${hit.sameSignature} 次（${hit.signature.slice(0, 80)}）。` +
      `别原样重试：先核对入参、确认现状，或换一个等价工具。${tail}`
    );
  }
  if (hit.sameTool >= SAME_TOOL_HINT_AT) {
    return (
      `[失败台账] \`${hit.tool}\` 本会话已失败 ${hit.sameTool} 次（错误各不相同）。` +
      `说明前提假设可能有问题：先只读探查，再决定下一步。${tail}`
    );
  }
  return null;
}

/** 台账快照（供界面展示，按失败次数降序） */
export function failureLedgerRows(): {
  tool: string;
  signature: string;
  sample: string;
  count: number;
}[] {
  const out: { tool: string; signature: string; sample: string; count: number }[] = [];
  for (const [tool, m] of ledger) {
    for (const e of m.values())
      out.push({ tool, signature: e.signature, sample: e.sample, count: e.count });
  }
  return out.sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
}

/** 清空（新会话 / 用户手动重置） */
export function resetFailureLedger(): void {
  ledger.clear();
}

// ---------------------------------------------------------------------------
// 停滞中止（P1-9c）：同一「工具 + 同一错误」在本轮内反复失败
// ---------------------------------------------------------------------------
//
// 背景（2026-10-02 用户反馈「为什么任务都没有处理完 agent 就结束了」）：
// 上一轮实战里 `run_command` 围绕同一个网络下载任务**同因失败 45 次**仍在重写脚本。
// 现有 `failureHint` 只在结果末尾附一段提醒文字 —— 提醒压不住模型，提示照旧重试。
// 因此增加「停滞判定」：同一签名在本轮内累计到 STUCK_GIVEUP_AT 次，就把本轮**主动中止**，
// 用 stuckNotice 如实说明「不是做完了，是卡住了」，把决定权交回用户，而不是烧光轮次。

/** 同一签名在本轮内累计到该次数 → 判定停滞（4 次同因失败基本可确定是方法/前提有问题） */
export const STUCK_GIVEUP_AT = 4;

export interface StreakHit {
  /** 计数键：工具｜错误签名 */
  key: string;
  signature: string;
  /** 本轮内该签名的累计次数（含本次） */
  count: number;
  /** 是否已达停滞阈值 */
  stuck: boolean;
}

/**
 * 从工具**结果文本**里抽出「病因」片段：剔除被回显的命令、无关输出，只留错误/状态行。
 *
 * 为什么需要它（2026-10-02 实测）：`run_command` 的结果以 `$ 命令` 回显开头，直接用整段文本
 * 当签名，则「同一原因、每次不同命令」会被拆成互不相同的签名 —— 审计库里明明有 **14 次
 * 同一句「命令执行超时（60s），已终止」**，却一次都累计不到停滞阈值。
 * 优先级：stderr 前几行（脚本报错最可靠）> 末尾几行（无 stderr 时兜底）> 整段。
 * 末尾状态行（如 `⏰ 执行超时，已终止` / `❌ 执行失败（退出码 1…）`）总是拼进去。
 */
export function errorCause(text: unknown): string {
  const s = text == null ? "" : String(text);
  if (!s.trim()) return "";
  const lines = s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // 第一行的命令回显（`$ ...`）必须剔除，否则同因不同命令永远聚不到一起
  const body = lines[0]?.startsWith("$ ") ? lines.slice(1) : lines;
  const errIdx = body.findIndex((l) => l.startsWith("[stderr]"));
  const parts: string[] = [];
  const errLines = errIdx >= 0 ? body.slice(errIdx + 1) : [];
  if (errLines.length > 0) parts.push(...errLines.slice(0, 3));
  else parts.push(...body.slice(-3));
  const last = body[body.length - 1];
  if (last) parts.push(last);
  const uniq: string[] = [];
  for (const p of parts) if (!uniq.includes(p)) uniq.push(p);
  return uniq.join(" ¦ ");
}

/**
 * 累加「工具｜病因」在本轮的失败次数。
 * `store` 由调用方持有（按轮重置），因此这里是纯函数、可直接单测。
 */
export function bumpFailureStreak(
  store: Map<string, number>,
  tool: string,
  errorText: unknown,
): StreakHit {
  const sig = normalizeErrorText(errorCause(errorText) || errorText);
  const key = `${String(tool ?? "").trim()}｜${sig}`;
  const count = (store.get(key) ?? 0) + 1;
  store.set(key, count);
  return { key, signature: sig, count, stuck: count >= STUCK_GIVEUP_AT };
}

/** 停滞中止时追加到正文的如实告知（「不是做完了，是被卡住了」） */
export function stuckNotice(tool: string, signature: string, count: number): string {
  return (
    `\n\n> ⛔ **本轮因反复以同一方式失败而主动中止**（\`${tool}\` 同因失败 ${count} 次）：${signature.slice(0, 160)}\n` +
    `>\n> 这不代表「任务完成」，而是**前置条件没打通**（网络 / 路径 / 权限 / 参数 / 凭据之一）——继续原样重试只会空转烧轮次，所以先停下来。\n` +
    `> 接下来可以：按上面的建议先解决前置问题；或直接告诉我可用的替代路径（例如代理地址、正确的文件路径、换个数据源），我接着做。\n` +
    `> （若系统判定还有可行的替代方案，会自动换方案再试一次；第二次仍卡住才交回你决定。）`
  );
}
