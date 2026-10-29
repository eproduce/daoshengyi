// 展示 IR：**把「想表达什么」与「怎么渲染」分开**。
//
// 背景（见 `docs/DESKTOP_AMBIENT_UI.md` §4）：环境层最弱的一环是「呈现不固定」——
// 之前只有「产物文件」一种出口。这里定义模型的**结构化展示意图**，由**宿主**决定
// 落到哪个 surface、怎么降级渲染。好处不只是"能冒到浮层"，还顺手治好现有老大难：
// 模型手写 HTML 的行列错位 / 大文件被截断 / 渲染器无数学引擎。
//
// ## 两条纪律
//
// 1. **模型输出一律当不可信输入**：`parseDisplayIr` 容错解析（未知 kind 降级、
//    超长截断、类型不符强转），永不抛错 —— 呈现失败不该弄挂一轮对话。
// 2. **降级必须可测**：同一个 IR 在不同 surface 上按能力降级（HUD 小、会话大、语音只念一句），
//    `degradeForSurface` 是纯函数，降级矩阵有单测覆盖。

/** 展示意图的种类。前 10 个是 HUD/会话能直接渲染的，后 2 个走别的出口 */
export type DisplayKind =
  | "card"
  | "metric"
  | "chart"
  | "table"
  | "kv"
  | "timeline"
  | "callout"
  | "code"
  | "speech"
  | "page"
  | "flow"
  | "animation";

/** 允许出现的 kind（不在表里的一律降级成 card —— 模型偶尔会自创名字） */
export const DISPLAY_KINDS: readonly DisplayKind[] = [
  "card",
  "metric",
  "chart",
  "table",
  "kv",
  "timeline",
  "callout",
  "code",
  "speech",
  "page",
  "flow",
  "animation",
];

/** 浮层生命周期：auto = 自动淡出（默认）｜sticky = 停留更久｜pin = 钉回会话 */
export type DisplayLife = "auto" | "sticky" | "pin";
export const DISPLAY_LIVES: readonly DisplayLife[] = ["auto", "sticky", "pin"];

/**
 * 浮层停留时长（毫秒）。
 *
 * `sticky` 曾经是「留着直到下次」——**没有下次就永远留着**（真机上表现为
 * 一次任务结束后浮层一直钉在桌面）。环境层可以多停一会儿，但必须有上限。
 */
export const HUD_AUTO_HIDE_MS = 6000;
export const HUD_STICKY_HIDE_MS = 30_000;

/** life → 浮层停留时长（`pin` 的归宿是会话，不是桌面常驻） */
export function hudHideDelay(life: DisplayLife): number {
  return life === "sticky" ? HUD_STICKY_HIDE_MS : HUD_AUTO_HIDE_MS;
}

/** 优先级：`primary` 才允许冒到浮层/语音；`secondary` 只进会话（默认 primary = 调用即呈现） */
export type DisplayPriority = "primary" | "secondary";

// ── 协议层：版本 / 身份 / 来源 / 引用（`docs/PRESENT_PROTOCOL.md`）──────────
//
// 这四项不是为了渲染，而是为了**协议**：
// - `v`：协议只增不改，宿主得知道对面说的是哪一版；
// - `id`：HUD 去重 + 回执关联（同一条重复推不该亮两次）；
// - `source`：谁产生的 → 决定**默认打扰级别**（定时任务的结果不该跟用户当面问的一样闹）；
// - `refs`：能跳回去（通知点击、钉回会话）。

/** 当前协议版本。演进只加字段/加 kind/加出口，不删不改语义 */
export const PRESENT_PROTOCOL_VERSION = 1;

/** 谁产生的这条呈现 */
export type DisplaySource = "model" | "host" | "schedule" | "hook" | "subagent" | "external" | "ui";
export const DISPLAY_SOURCES: readonly DisplaySource[] = [
  "model",
  "host",
  "schedule",
  "hook",
  "subagent",
  "external",
  "ui",
];

/** 后台来源：默认低打扰（浮层自动淡出、不念），除非**显式**要求 primary */
const QUIET_SOURCES: readonly DisplaySource[] = ["schedule", "hook", "subagent"];

/** 可跳回/可归属的引用（v1 只用于通知点击与钉回会话） */
export interface DisplayRef {
  kind: "file" | "conversation" | "url" | "tool";
  value: string;
}
const REF_KINDS: readonly DisplayRef["kind"][] = ["file", "conversation", "url", "tool"];

let irSeq = 0;
/** 生成报文 id（会话内唯一即可；不引 uuid 依赖） */
export function newIrId(): string {
  irSeq += 1;
  return `ir_${Date.now().toString(36)}${irSeq.toString(36)}`;
}

/** 各 kind 的正文（宽松结构：一个 kind 只用其中几项，其余忽略） */
export interface DisplayBody {
  /** 一句话正文（多数 kind 用） */
  text?: string;
  /** 多行兜底（渲染器不认识 kind 时的最终降级） */
  lines?: string[];
  /** metric */
  value?: string | number;
  unit?: string;
  delta?: string;
  /** chart */
  chartType?: "bar" | "line" | "pie";
  series?: { label: string; value: number }[];
  /** kv / table */
  items?: { key: string; value: string }[];
  columns?: string[];
  rows?: string[][];
  /** timeline / flow */
  steps?: { label: string; detail?: string; status?: string }[];
  /** code */
  language?: string;
  code?: string;
  /** callout：语气 */
  tone?: "info" | "warn" | "success";
  /** page：交给 answer_html 渲染的 markdown */
  markdown?: string;
}

export interface DisplayIr {
  /** 协议版本（`PRESENT_PROTOCOL_VERSION`） */
  v: number;
  /** 报文 id：HUD 去重 + 回执关联（不参与渲染） */
  id: string;
  /** 来源：决定默认打扰级别 */
  source: DisplaySource;
  kind: DisplayKind;
  title?: string;
  priority: DisplayPriority;
  /**
   * `priority` 是不是**显式写的**（宿主侧元数据，不上线）。
   * 需要它是因为：对后台来源而言，「默认 primary」与「明确要 primary」是两种待遇。
   */
  priorityExplicit?: boolean;
  life: DisplayLife;
  /** 要念出来的那一句（不填则由 title/text 推导） */
  speech?: string;
  /** 可跳回的引用（最多 4 条） */
  refs?: DisplayRef[];
  body: DisplayBody;
}

/** 各字段的长度上限：模型爱写长文，但浮层只有 380×132 */
export const IR_LIMITS = {
  title: 80,
  text: 400,
  speech: 120,
  lines: 12,
  lineLen: 160,
  series: 24,
  items: 12,
  steps: 12,
  code: 4000,
  refs: 4,
  refLen: 400,
} as const;

function str(v: unknown, max: number): string | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : undefined;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return String(v);
  return undefined;
}

function strList(v: unknown, max: number, itemMax: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .map((x) => str(x, itemMax))
    .filter((x): x is string => !!x)
    .slice(0, max);
  return out.length ? out : undefined;
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^\d.+-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function parseBody(raw: unknown): DisplayBody {
  // 模型有时直接把 body 写成字符串（"正文"）——这属于最常见的用法，友好接受
  if (typeof raw === "string") {
    const text = str(raw, IR_LIMITS.text);
    return text ? { text } : {};
  }
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const body: DisplayBody = {};

  const text = str(r.text, IR_LIMITS.text);
  if (text) body.text = text;
  const lines = strList(r.lines, IR_LIMITS.lines, IR_LIMITS.lineLen);
  if (lines) body.lines = lines;
  const value = str(r.value, 40);
  if (value !== undefined) body.value = value;
  const unit = str(r.unit, 16);
  if (unit) body.unit = unit;
  const delta = str(r.delta, 24);
  if (delta) body.delta = delta;
  const language = str(r.language, 24);
  if (language) body.language = language;
  const code = str(r.code, IR_LIMITS.code);
  if (code) body.code = code;
  const markdown = str(r.markdown, 20_000);
  if (markdown) body.markdown = markdown;

  if (r.chartType === "bar" || r.chartType === "line" || r.chartType === "pie") {
    body.chartType = r.chartType;
  }
  if (r.tone === "info" || r.tone === "warn" || r.tone === "success") body.tone = r.tone;

  if (Array.isArray(r.series)) {
    const series = r.series
      .map((s) => {
        const o = (s ?? {}) as Record<string, unknown>;
        const label = str(o.label ?? o.name, 40);
        return label ? { label, value: num(o.value) } : undefined;
      })
      .filter((s): s is { label: string; value: number } => !!s)
      .slice(0, IR_LIMITS.series);
    if (series.length) body.series = series;
  }

  if (Array.isArray(r.items)) {
    const items = r.items
      .map((s) => {
        const o = (s ?? {}) as Record<string, unknown>;
        const key = str(o.key ?? o.label, 40);
        const value = str(o.value, 200);
        return key !== undefined && value !== undefined ? { key, value } : undefined;
      })
      .filter((s): s is { key: string; value: string } => !!s)
      .slice(0, IR_LIMITS.items);
    if (items.length) body.items = items;
  }

  if (Array.isArray(r.steps)) {
    const steps = r.steps
      .map((s) => {
        const o = (s ?? {}) as Record<string, unknown>;
        const label = str(o.label ?? o.text, 60);
        if (!label) return undefined;
        const detail = str(o.detail, 160);
        const status = str(o.status, 16);
        return { label, ...(detail ? { detail } : {}), ...(status ? { status } : {}) };
      })
      .filter((s): s is { label: string; detail?: string; status?: string } => !!s)
      .slice(0, IR_LIMITS.steps);
    if (steps.length) body.steps = steps;
  }

  const columns = strList(r.columns, 8, 24);
  if (columns) body.columns = columns;
  if (Array.isArray(r.rows)) {
    const rows = r.rows
      .map((row) => (Array.isArray(row) ? row.map((c) => str(c, 60) ?? "") : undefined))
      .filter((row): row is string[] => !!row)
      .slice(0, IR_LIMITS.lines);
    if (rows.length) body.rows = rows;
  }

  return body;
}

/** 解析引用：脏条目丢掉、超量截断，不因为一条坏数据整条失败 */
export function parseRefs(raw: unknown): DisplayRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DisplayRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = o.kind as DisplayRef["kind"];
    if (!REF_KINDS.includes(kind)) continue;
    const value = str(o.value, IR_LIMITS.refLen);
    if (!value) continue;
    out.push({ kind, value });
    if (out.length >= IR_LIMITS.refs) break;
  }
  return out.length ? out : undefined;
}

/**
 * 容错解析展示意图。**永不抛错**：模型给的东西再离谱也要能变成可渲染对象。
 * `issues` 记录降级原因，便于排查「为什么呈现成了这样」。
 *
 * `opts.source` 是宿主告诉我们的来源（模型调用时是 `model`，定时任务是 `schedule`）；
 * 报文里已经带了 `source` 时以报文为准（HUD 重新解析时不能把来源弄丢）。
 */
export function parseDisplayIr(
  raw: unknown,
  opts?: { source?: DisplaySource; id?: string },
): { ir: DisplayIr; issues: string[] } {
  const issues: string[] = [];
  const base = (): Pick<DisplayIr, "v" | "id" | "source"> => ({
    v: PRESENT_PROTOCOL_VERSION,
    id: opts?.id ?? newIrId(),
    source: opts?.source ?? "model",
  });
  if (!raw || typeof raw !== "object") {
    issues.push("不是对象：降级为空白卡片");
    return {
      ir: { ...base(), kind: "card", priority: "secondary", life: "auto", body: {} },
      issues,
    };
  }
  const r = raw as Record<string, unknown>;

  // 协议版本：未知的新版本仍然按 v1 解析（只增不改），把原版本带回去便于排查
  let v = PRESENT_PROTOCOL_VERSION;
  if (typeof r.v === "number" && Number.isFinite(r.v) && r.v > 0) {
    v = Math.floor(r.v);
    if (v > PRESENT_PROTOCOL_VERSION) {
      issues.push(`报文协议版本 v${v} 高于本机 v${PRESENT_PROTOCOL_VERSION}：按 v1 尽力解析`);
    }
  }

  // id：有则沿用（HUD 重新解析时不能换 id，否则去重就失效了）
  const id =
    typeof r.id === "string" && r.id.trim() ? r.id.trim().slice(0, 64) : (opts?.id ?? newIrId());

  let source: DisplaySource = opts?.source ?? "model";
  if (typeof r.source === "string") {
    if (DISPLAY_SOURCES.includes(r.source as DisplaySource)) {
      source = r.source as DisplaySource;
    } else {
      issues.push(`未知 source「${r.source}」：按 ${source} 处理`);
    }
  }

  let kind = r.kind as DisplayKind;
  if (typeof kind !== "string" || !DISPLAY_KINDS.includes(kind)) {
    issues.push(`未知 kind「${String(r.kind)}」：降级为 card`);
    kind = "card";
  }

  // 默认 **primary**：调用 present 本身就是「请求呈现」。
  // 早先默认 secondary，结果是「模型没填 priority 就什么都不显示」——那很傻（用户反馈过）。
  // secondary 保留为**显式逃生口**：只想留痕、不想冒浮层时填它。
  const priority: DisplayPriority = r.priority === "secondary" ? "secondary" : "primary";
  if (r.priority !== undefined && r.priority !== "primary" && r.priority !== "secondary") {
    issues.push(`未知 priority「${String(r.priority)}」：按 primary 处理`);
  }

  let life = r.life as DisplayLife;
  if (!DISPLAY_LIVES.includes(life)) {
    if (r.life !== undefined) issues.push(`未知 life「${String(r.life)}」：按 auto 处理`);
    life = "auto";
  }

  const body = parseBody(r.body);
  const title = str(r.title, IR_LIMITS.title);
  if (r.title !== undefined && !title) issues.push("title 为空或类型不对：忽略");
  const refs = parseRefs(r.refs);
  const speech = str(r.speech, IR_LIMITS.speech);

  return {
    ir: {
      v,
      id,
      source,
      kind,
      ...(title ? { title } : {}),
      priority,
      priorityExplicit: r.priority === "primary" || r.priority === "secondary",
      life,
      ...(speech ? { speech } : {}),
      ...(refs ? { refs } : {}),
      body,
    },
    issues,
  };
}

// ── 本轮收尾的自动呈现（宿主兜底，与模型无关）────────────────────

/** 构造收尾呈现的输入（宿主在任务结束时给出） */
export interface FinishSummaryInput {
  /** 纯文本结论（已去 markdown/代码块）——浮层正文用（会截到 220 字） */
  text: string;
  /** 播报用全文（不截断）：短则整段念完，长则由 `finishSpeech` 退回顾述 */
  speechSource?: string;
  /** 本轮用到的工具数：0 = 纯问答 */
  toolCount: number;
  /** 计划进度（有则用于标题与副文） */
  planDone?: number;
  planTotal?: number;
}

/**
 * 由「本轮收尾结果」构造展示意图。
 *
 * **为什么宿主兜这一手**：长任务结束时用户往往已经走开去看别的了，而模型**不一定记得**
 * 调 `present` 工具。环境层要真的"环境"，就得在收尾时自己兜一次。
 *
 * **预筛（低打扰的关键）**：纯问答（`toolCount = 0`）**只进会话**——把每一轮对话都冒到
 * 桌面上就是骚扰；只有真干活（用过工具）的那一轮才值得 `primary`。
 * 这也是把「按话轮」变回「按任务」的那道确定性门禁（与 search-gate / danger-rules 同思路）。
 */
export function buildFinishIr(input: FinishSummaryInput): DisplayIr {
  const hasPlan = !!input.planTotal && input.planTotal > 0;
  const done = hasPlan ? (input.planDone ?? 0) : undefined;
  const allDone = hasPlan && done === input.planTotal;
  const isTask = input.toolCount > 0;
  const text = str(input.text, 220) ?? "";
  const withProgress = hasPlan ? `${done}/${input.planTotal} 步 · ${text}` : text;
  // 播报用**全文**（浮层只放摘要）：短回复整段念完，长回复退回顾述。
  const speech = finishSpeech(input.speechSource ?? text);

  return {
    v: PRESENT_PROTOCOL_VERSION,
    id: newIrId(),
    source: "host",
    kind: isTask ? "callout" : "card",
    title: allDone ? "✅ 任务完成" : isTask ? "✅ 执行完成" : "💬 回复完成",
    priority: isTask ? "primary" : "secondary",
    // 显式标记：这是宿主自己算出来的主意，不是模型要求
    priorityExplicit: true,
    // sticky：用户不在时 auto 几秒就消失，等于白推；多留一会儿等他回来一眼看到。
    // 注意“多留”也有上限（`HUD_STICKY_HIDE_MS`），否则就是永久占屏。
    life: isTask ? "sticky" : "auto",
    ...(speech ? { speech } : {}),
    body: { text: withProgress, tone: "success" },
  };
}

// ── 该不该念（宿主判断，模型不用操心）────────────────────────

/** 适合「念」的 kind：念是给看不到屏幕的场景的；表格/代码/图表/时间轴属于「看」的内容 */
const SPEAKABLE_KINDS: readonly DisplayKind[] = ["speech", "metric", "callout", "card"];

/** 语音长度上限：超过它念出来是折磨（而且用户多半已经在看 / 会去看） */
export const SPEAK_MAX_CHARS = 80;

/**
 * 判断这条展示意图“值不值得念”。
 *
 * 设计前提：**用户没必要为“该不该出声”操心**（也不用模型每次指定）——
 * 开了语音总闸后，由宿主按内容决定哪此念、哪些只看：
 * - 内容太短/太长、纯符号 → 不念；
 * - 表格/代码/图表/时间轴 → 不念（那是看的，念出来没意义）；
 * - 剩下的（一句话结论、关键数字、提示）→ 念。
 */
export function shouldSpeak(ir: DisplayIr): { speak: boolean; text: string; reason: string } {
  const text = speechTextOf(ir);
  if (!text) return { speak: false, text: "", reason: "没有可念的正文" };
  if (!SPEAKABLE_KINDS.includes(ir.kind)) {
    return { speak: false, text, reason: `${ir.kind} 属于「看」的内容（表格/代码/图表），不念` };
  }
  const cap = ir.source === "host" ? FINISH_SPEECH_MAX : SPEAK_MAX_CHARS;
  if (text.length > cap) {
    return {
      speak: false,
      text,
      reason: `正文 ${text.length} 字太长，念出来是折磨（浮层上能看）`,
    };
  }
  return { speak: true, text, reason: "" };
}

// ── surface 与降级 ────────────────────────────────────────────────────────────

/** 出海口。`session` 永远有（钉回会话是底线：浮层可以阅后即焚，留痕不能丢） */
export type Surface = SurfaceName;

/** 某个 surface 是否原生支持这个 kind（能力表在文件末尾的出口注册表，单一数据源） */
export function supportsKind(surface: Surface, kind: DisplayKind): boolean {
  return capabilityKinds(surface).includes(kind);
}

/**
 * 降级：把一个 IR 变成某 surface 能渲染的形态。
 *
 * 降级是**有损但不出错**的：优先保留「标题 + 一句话」，
 * 结构（图表/表格/时间轴）在放不下时退化成多行文本，最后一定有兜底文案。
 */
export function degradeForSurface(ir: DisplayIr, surface: Surface): DisplayIr {
  const out = degradeKindOnce(ir, surface);
  // 统一兜底：**不变量是硬约束** —— 降级结果必须是该出口能渲染的 kind。
  // 走到这里说明该出口连 card 都不支持（如 quicklook 只认 page），
  // 那就退到它登记的第一个 kind：宁可在语义上妥协，也不能让渲染端拿到画不出来的东西。
  return supportsKind(surface, out.kind) ? out : { ...out, kind: capabilityKinds(surface)[0] };
}

/** 一次降级（按 kind 逐条分支）；不保证结果被出口支持，由 `degradeForSurface` 兜底 */
function degradeKindOnce(ir: DisplayIr, surface: Surface): DisplayIr {
  if (supportsKind(surface, ir.kind)) return ir;

  // 图（flow）与动画无法在窄浮层表达 → 退化成时间轴/多行
  if (ir.kind === "flow") {
    const steps = ir.body.steps;
    if (steps?.length && surface === "session") {
      return { ...ir, kind: "timeline", body: { ...ir.body, steps } };
    }
    return { ...ir, kind: "card", body: { ...ir.body, lines: flowLines(ir) } };
  }
  if (ir.kind === "animation") {
    return { ...ir, kind: "card", body: { ...ir.body, text: ir.body.text ?? ir.title } };
  }
  // page 落到会话/浮层：正文退化成文本（markdown 太长就截断）
  if (ir.kind === "page") {
    const md = ir.body.markdown ?? ir.body.text;
    return {
      ...ir,
      kind: "card",
      body: { ...ir.body, text: md ? str(md, IR_LIMITS.text) : ir.title },
    };
  }
  // table 落到浮层：行数少时保留为文本行，否则截断
  if (ir.kind === "table") {
    const rows = ir.body.rows ?? [];
    return {
      ...ir,
      kind: "card",
      body: {
        ...ir.body,
        lines: rows.slice(0, 4).map((r) => r.join(" ｜ ")),
        ...(rows.length > 4 ? { text: `（共 ${rows.length} 行，完整内容见会话）` } : {}),
      },
    };
  }
  // 其余：退化成卡片，标题/文本优先
  return {
    ...ir,
    kind: "card",
    body: { ...ir.body, text: ir.body.text ?? ir.title },
  };
}

function flowLines(ir: DisplayIr): string[] | undefined {
  const steps = ir.body.steps;
  if (!steps?.length) return ir.body.lines;
  return steps.map((s, i) => `${i + 1}. ${s.label}${s.detail ? ` — ${s.detail}` : ""}`);
}

/** 语音要念的文本：优先 `speech`，其次标题，最后正文首句；并清掉念不出来的东西 */
export function speechTextOf(ir: DisplayIr): string {
  const candidate = ir.speech ?? ir.title ?? firstSentence(ir.body.text ?? "") ?? "";
  // 宿主收尾的 IR 是「结果概述」，允许更长（见 FINISH_SPEECH_MAX）；模型给的展示单元仍按 120 字
  const limit = ir.source === "host" ? FINISH_SPEECH_MAX : IR_LIMITS.speech;
  return cleanForSpeech(candidate, limit);
}

/** 去掉 markdown 记号/换行——`say` 会把它们念出来（`**` 念成"星号星号"） */
export function cleanForSpeech(text: string, limit: number = IR_LIMITS.speech): string {
  return text
    .replace(/```[\s\S]*?```/g, "（代码略）")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/**
 * 宿主收尾播报的上限。
 *
 * 用户的诉求很具体（2026-10-29）：「一个回复只播一次；要么是简略但相对完整的概述，
 * 要么就把对话框里的结果念完」。所以宿主这条路径**不受 80 字限制**——600 字以内整段读完
 * （中文约 2 分钟，是「想听结果」的人能接受的量级），超过才退回概述。
 */
export const FINISH_SPEECH_MAX = 600;

/**
 * 决定收尾播报念什么：
 * - `raw` 清洗后 ≤ FINISH_SPEECH_MAX → **整段念完**（用户要的「完整读完结果」）；
 * - 超长 → 取前 2~3 句（≤140 字）作概述，并明说「详细内容在对话里」。
 * 两条都保证以句末标点收尾（否则 `say` 会念成半句话）。
 */
export function finishSpeech(raw: string, maxChars: number = FINISH_SPEECH_MAX): string {
  const full = cleanForSpeech(raw, Number.MAX_SAFE_INTEGER);
  if (!full) return "";
  const endPunct = /[。！？.!?…]$/;
  if (full.length <= maxChars) return endPunct.test(full) ? full : `${full}。`;

  const summaryLimit = 140;
  const sentences = full.match(/[^。！？.!?\n]+[。！？.!?]?/g) ?? [full];
  let out = "";
  for (const s of sentences) {
    if (out.length + s.length > summaryLimit) break;
    out += s;
  }
  if (!out) out = full.slice(0, summaryLimit);
  if (!endPunct.test(out)) out += "。";
  return `${out}详细内容在对话里。`;
}

/**
 * 同一回复**只播一次**：把「过程中 present 的播报」从计划里摘掉，
 * 让位给回合结束的统一概述（`presentTurnFinished`）。
 * 只在用户开着「自动收尾呈现」时摘——关掉它的人仍按原来的即时播报走。
 */
export function deferSpeechToTurnEnd<T extends SurfacePlan>(plan: T, autoFinish: boolean): T {
  if (!autoFinish || !plan.surfaces.includes("speech")) return plan;
  return dropSpeech(plan, "播报延后到回合结束统一念一次（避免同一回复念两遍）");
}

/** 只摘掉语音出口（浮层/留痕不动），并把原因记进 `reasons` 便于排查「为什么没念」 */
export function dropSpeech<T extends SurfacePlan>(plan: T, reason: string): T {
  if (!plan.surfaces.includes("speech")) return plan;
  return {
    ...plan,
    surfaces: plan.surfaces.filter((s) => s !== "speech"),
    speechText: "",
    reasons: [...plan.reasons, reason],
  };
}

function firstSentence(text: string): string | undefined {
  if (!text) return undefined;
  const m = text.match(/^[^。！？.!?\n]{1,80}[。！？.!?]?/);
  return m?.[0];
}

/** 宿主侧的能力与场景（决定“要不要冒出来”） */
export interface SurfaceContext {
  /** 静默模式：只钉回会话，不出声、不冒层（这是“别打扰我”的总闸） */
  silent: boolean;
  /** 桌面浮层开关（用户可在设置里关掉） */
  hudEnabled: boolean;
  /** 语音播报开关（默认关：出声属于打扰，必须显式开） */
  speechEnabled: boolean;
  /** 勿扰时段（如 22:30–08:00，支持跨零点）；空/非法 = 不生效 */
  quietHours?: QuietHours | null;
  /** 当前时间（只为可测；不传则用真实时间） */
  now?: Date;
}

/** 勿扰时段：`"HH:MM"` 形式的起止（跨零点也算合法：起 > 止） */
export interface QuietHours {
  start: string;
  end: string;
}

/** `"22:30"` → 当天分钟数；非法返回 null（**不猜**：非法就当没配） */
export function parseClock(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 当前时刻是否落在勿扰区间。
 *
 * 起止相等 / 任一非法 → **不生效**（宁可不出声也不因一个笔误把语音永久关掉）。
 */
export function inQuietHours(
  quiet: QuietHours | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!quiet) return false;
  const s = parseClock(quiet.start);
  const e = parseClock(quiet.end);
  if (s === null || e === null || s === e) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/**
 * 源策略：把「来源」转成对 IR 的实际修正（纯函数，可测）。
 *
 * 后台来源（定时任务/钩子/子代理）默认**低打扰**：浮层自动淡出、不念。
 * 但若模型/调用方**显式**写了 `priority: primary`，就按其意愿办 —— 显式意图优先于默认策略。
 */
export function effectiveIr(ir: DisplayIr): DisplayIr {
  if (!QUIET_SOURCES.includes(ir.source)) return ir;
  if (ir.priorityExplicit && ir.priority === "primary") return ir;
  return { ...ir, life: "auto" };
}

export interface SurfacePlan {
  /** **生效后的 IR**（已施加源策略）——调用方应该把它送给执行端，而不是原始 IR */
  ir: DisplayIr;
  /** 实际要执行的出口 */
  surfaces: Surface[];
  /** 语音要念的文本（未选 speech 时为空串） */
  speechText: string;
  /** 人话解释（写进工具结果与日志，便于回答"为什么没弹出来"） */
  reasons: string[];
}

/**
 * 呈现决策：**宿主规则为主**（模型只能给 kind/priority/life 的建议）。
 *
 * 为什么不让模型直接决定出口：模型不知道用户开了静默还是关了浮层 —— 这些只有宿主知道。
 * 规则可单测，也便于事后解释。
 *
 * **两条从真实反馈里改掉的错规则**（之前很“傻”）：
 * 1. 默认 `secondary` ⇒ 模型不填 priority 就什么都不显示。现在**调用即呈现**（默认 primary），
 *    `secondary` 降级为“只想留痕”的显式逃生口。
 * 2. “主窗口在前台就不冒浮层” ⇒ 用户盯着屏幕做事时反而什么都看不到。浮层的本职就是
 *    “一眼看到结果”，它小、不挡、会自动淡出（静默模式已提供了“别打扰”的总闸）。
 *    改用内容维度区分：**能看的都上浮层，能听且值得听的才念**。
 */
export function planSurfaces(irRaw: DisplayIr, ctx: SurfaceContext): SurfacePlan {
  const ir = effectiveIr(irRaw);
  const surfaces: Surface[] = ["session"];
  const reasons: string[] = [];
  const done = (speechText = ""): SurfacePlan => ({
    ir,
    surfaces,
    speechText,
    reasons,
  });

  if (QUIET_SOURCES.includes(ir.source) && !(ir.priorityExplicit && ir.priority === "primary")) {
    reasons.push(
      `来源 ${ir.source}：后台结果默认低打扰（浮层自动淡出、不念；要念请显式 priority=primary）`,
    );
  }

  // 宿主在回合结束时自己生成的「结果概述」：secondary 只表示**不冒浮层**，
  // 不该把语音一起静音 —— 用户开着语音就是为了听结果（2026-10-29 用户反馈）。
  const hostFinish = ir.source === "host";
  if (ir.priority === "secondary" && !hostFinish) {
    reasons.push("priority=secondary：只进会话，不打扰");
    return done();
  }

  if (ctx.silent) {
    reasons.push("静默模式：只钉回会话");
    return done();
  }

  // 勿扰时段：不是整条丢掉，而是“不出声不冒层，但会话照样留痕”
  if (inQuietHours(ctx.quietHours, ctx.now)) {
    reasons.push(
      `勿扰时段（${ctx.quietHours!.start}–${ctx.quietHours!.end}）：只留痕，不出声不冒层`,
    );
    return done();
  }

  if (ir.priority === "secondary") {
    reasons.push("priority=secondary：不冒浮层（语音仍可播报结果）");
  } else if (ctx.hudEnabled) {
    surfaces.push("hud");
    reasons.push("已推送到桌面浮层");
  } else {
    reasons.push("桌面浮层已在设置里关闭");
  }

  if (ir.kind === "page") {
    surfaces.push("page");
    reasons.push("kind=page：完整内容走产物页（answer_html）");
  }

  let speechText = "";
  const quietSource = QUIET_SOURCES.includes(ir.source) && !ir.priorityExplicit;
  if (!ctx.speechEnabled) {
    reasons.push("语音播报未开启");
  } else if (quietSource) {
    // 后台来源：能看就行，默认不念（深夜跑完的定时任务不该突然开口）
    reasons.push("后台来源默认不念（浮层可看）");
  } else {
    const verdict = shouldSpeak(ir);
    if (verdict.speak) {
      speechText = verdict.text;
      surfaces.push("speech");
      reasons.push("已语音播报");
    } else {
      reasons.push(`不出声：${verdict.reason}`);
    }
  }

  return done(speechText);
}

// ── 出口能力注册表（协议第②层）──────────────────────────────────────────────
//
// 为什么把它做成**一张表**而不是代码里的 if 分支：这张表就是协议本身 ——
// 「这个出口能渲染什么、打扰多大、默认开不开」写在一处，前端/后端/文档都能对着它校准。
// `docs/PRESENT_PROTOCOL.md` §3 是同一张表的人话版；改这里要同步改那边。

/** 全部出口名（含**尚未收编**的 notify/tray/quicklook/im —— 先登记，后接线） */
export type SurfaceName =
  "session" | "hud" | "speech" | "page" | "notify" | "tray" | "quicklook" | "im";

/** 已接线的出口（`planSurfaces` 只会发这些；其余登记在册、等 P-A4 收编） */
export const IMPLEMENTED_SURFACES: readonly SurfaceName[] = ["session", "hud", "speech", "page"];

export interface SurfaceCapability {
  /** 原生支持的 kind（不在表里的靠 `degradeForSurface` 降级） */
  kinds: readonly DisplayKind[];
  /** 打扰度：排序即“有多吵”，供决策时比较 */
  intrusion: "none" | "low" | "medium" | "high";
  /** 默认是否开启 */
  defaultEnabled: boolean;
  /** 单条渲染预算（人话描述，写给读者与提示词用） */
  budget: string;
}

export const SURFACE_CAPABILITIES: Record<SurfaceName, SurfaceCapability> = {
  session: {
    kinds: [
      "card",
      "metric",
      "chart",
      "table",
      "kv",
      "timeline",
      "callout",
      "code",
      "speech",
      "page",
    ],
    intrusion: "none",
    defaultEnabled: true,
    budget: "全量",
  },
  hud: {
    kinds: ["card", "metric", "chart", "kv", "timeline", "callout", "code", "speech"],
    intrusion: "low",
    defaultEnabled: true,
    budget: "380×132、正文 ≤400 字、图表 ≤24 点",
  },
  speech: {
    kinds: ["speech", "card", "metric", "callout"],
    intrusion: "medium",
    defaultEnabled: false,
    budget: "≤80 字（超长只念第一句）",
  },
  notify: {
    kinds: ["card", "metric", "callout", "speech"],
    intrusion: "low",
    defaultEnabled: false,
    budget: "标题 60 / 正文 140",
  },
  tray: {
    kinds: ["metric", "card"],
    intrusion: "low",
    defaultEnabled: true,
    budget: "8 字",
  },
  page: {
    kinds: ["page", "card", "code", "table", "kv", "timeline", "chart"],
    intrusion: "none",
    defaultEnabled: true,
    budget: "全量",
  },
  quicklook: {
    kinds: ["page"],
    intrusion: "none",
    defaultEnabled: false,
    budget: "一个文件",
  },
  im: {
    kinds: ["card", "metric", "callout", "code", "speech"],
    intrusion: "medium",
    defaultEnabled: false,
    budget: "平台上限",
  },
};

/** 每个出口登记的 kind 都必须真的能渲染 —— 否则就是“声明支持、实际空白” */
export function capabilityKinds(surface: SurfaceName): readonly DisplayKind[] {
  return SURFACE_CAPABILITIES[surface].kinds;
}
