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

/** 浮层生命周期：auto = 自动淡出（默认）｜sticky = 留着直到下次｜pin = 钉回会话 */
export type DisplayLife = "auto" | "sticky" | "pin";
export const DISPLAY_LIVES: readonly DisplayLife[] = ["auto", "sticky", "pin"];

/** 优先级：只有 primary 才允许冒到浮层/语音；secondary 只进会话（默认 secondary = 不打扰） */
export type DisplayPriority = "primary" | "secondary";

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
  kind: DisplayKind;
  title?: string;
  priority: DisplayPriority;
  life: DisplayLife;
  /** 要念出来的那一句（不填则由 title/text 推导） */
  speech?: string;
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

/**
 * 容错解析展示意图。**永不抛错**：模型给的东西再离谱也要能变成可渲染对象。
 * `issues` 记录降级原因，便于排查「为什么呈现成了这样」。
 */
export function parseDisplayIr(raw: unknown): { ir: DisplayIr; issues: string[] } {
  const issues: string[] = [];
  if (!raw || typeof raw !== "object") {
    issues.push("不是对象：降级为空白卡片");
    return { ir: { kind: "card", priority: "secondary", life: "auto", body: {} }, issues };
  }
  const r = raw as Record<string, unknown>;

  let kind = r.kind as DisplayKind;
  if (typeof kind !== "string" || !DISPLAY_KINDS.includes(kind)) {
    issues.push(`未知 kind「${String(r.kind)}」：降级为 card`);
    kind = "card";
  }

  const priority: DisplayPriority = r.priority === "primary" ? "primary" : "secondary";
  if (r.priority !== undefined && r.priority !== "primary" && r.priority !== "secondary") {
    issues.push(`未知 priority「${String(r.priority)}」：按 secondary 处理（不打扰）`);
  }

  let life = r.life as DisplayLife;
  if (!DISPLAY_LIVES.includes(life)) {
    if (r.life !== undefined) issues.push(`未知 life「${String(r.life)}」：按 auto 处理`);
    life = "auto";
  }

  const body = parseBody(r.body);
  const title = str(r.title, IR_LIMITS.title);
  if (r.title !== undefined && !title) issues.push("title 为空或类型不对：忽略");

  return {
    ir: {
      kind,
      ...(title ? { title } : {}),
      priority,
      life,
      ...(str(r.speech, IR_LIMITS.speech) ? { speech: str(r.speech, IR_LIMITS.speech) } : {}),
      body,
    },
    issues,
  };
}

// ── 本轮收尾的自动呈现（宿主兜底，与模型无关）────────────────────

/** 构造收尾呈现的输入（宿主在任务结束时给出） */
export interface FinishSummaryInput {
  /** 纯文本结论（已去 markdown/代码块） */
  text: string;
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
  const speech = cleanForSpeech(firstSentence(text) ?? text);

  return {
    kind: isTask ? "callout" : "card",
    title: allDone ? "✅ 任务完成" : isTask ? "✅ 执行完成" : "💬 回复完成",
    priority: isTask ? "primary" : "secondary",
    // sticky：用户不在时 auto 几秒就消失，等于白推；留在那儿等他回来一眼看到
    life: isTask ? "sticky" : "auto",
    ...(speech ? { speech } : {}),
    body: { text: withProgress, tone: "success" },
  };
}

// ── surface 与降级 ────────────────────────────────────────────────────────────

/** 出海口。`session` 永远有（钉回会话是底线：浮层可以阅后即焚，留痕不能丢） */
export type Surface = "hud" | "speech" | "session" | "page";

/** 各 surface 能原生渲染的 kind（不在表里的按 `degradeForSurface` 降级） */
const SURFACE_KINDS: Record<Surface, readonly DisplayKind[]> = {
  hud: ["card", "metric", "chart", "kv", "timeline", "callout", "code", "speech"],
  speech: ["speech", "card", "metric", "callout"],
  // 会话要求最高保真度，但它同样**只列真正有渲染器的 kind**：
  // flow / animation 目前没有渲染器（Phase B 再做 SVG/时间轴视图），
  // 所以它们在每个出口都会降级 —— 矩阵必须诚实，否则就会「声明支持、实际空白」。
  session: [
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
  page: ["page", "card", "code", "table", "kv", "timeline", "chart"],
};

/** 某个 surface 是否原生支持这个 kind */
export function supportsKind(surface: Surface, kind: DisplayKind): boolean {
  return SURFACE_KINDS[surface].includes(kind);
}

/**
 * 降级：把一个 IR 变成某 surface 能渲染的形态。
 *
 * 降级是**有损但不出错**的：优先保留「标题 + 一句话」，
 * 结构（图表/表格/时间轴）在放不下时退化成多行文本，最后一定有兜底文案。
 */
export function degradeForSurface(ir: DisplayIr, surface: Surface): DisplayIr {
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
  return { ...ir, kind: "card", body: { ...ir.body, text: ir.body.text ?? ir.title } };
}

function flowLines(ir: DisplayIr): string[] | undefined {
  const steps = ir.body.steps;
  if (!steps?.length) return ir.body.lines;
  return steps.map((s, i) => `${i + 1}. ${s.label}${s.detail ? ` — ${s.detail}` : ""}`);
}

/** 语音要念的文本：优先 `speech`，其次标题，最后正文首句；并清掉念不出来的东西 */
export function speechTextOf(ir: DisplayIr): string {
  const candidate = ir.speech ?? ir.title ?? firstSentence(ir.body.text ?? "") ?? "";
  return cleanForSpeech(candidate);
}

/** 去掉 markdown 记号/换行——`say` 会把它们念出来（`**` 念成"星号星号"） */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "（代码略）")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, IR_LIMITS.speech);
}

function firstSentence(text: string): string | undefined {
  if (!text) return undefined;
  const m = text.match(/^[^。！？.!?\n]{1,80}[。！？.!?]?/);
  return m?.[0];
}

/** 宿主侧的能力与场景（决定"要不要冒出来"） */
export interface SurfaceContext {
  /** 静默模式：只钉回会话，不出声、不冒层 */
  silent: boolean;
  /** 环境层总开关（用户可在设置里关掉） */
  hudEnabled: boolean;
  /** 语音播报开关（默认关：出声属于打扰，必须显式开） */
  speechEnabled: boolean;
  /** 主窗口是否在前台：在前台时没必要再弹浮层/发通知（用户已经在看了） */
  windowFocused: boolean;
}

export interface SurfacePlan {
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
 * 为什么不让模型直接决定出口：模型不知道窗口是否在前台、用户是否开了静默、
 * 浮层是否被占用 —— 这些只有宿主知道。规则可单测，也便于事后解释。
 */
export function planSurfaces(ir: DisplayIr, ctx: SurfaceContext): SurfacePlan {
  const surfaces: Surface[] = ["session"];
  const reasons: string[] = [];

  if (ir.priority !== "primary") {
    reasons.push("priority=secondary：只进会话，不打扰");
    return { surfaces, speechText: "", reasons };
  }

  if (ctx.silent) {
    reasons.push("静默模式：只钉回会话");
    return { surfaces, speechText: "", reasons };
  }

  if (ctx.windowFocused) {
    reasons.push("主窗口在前台：你正在看，不再冒浮层");
  } else if (ctx.hudEnabled) {
    surfaces.push("hud");
    reasons.push("已推送到 HUD 浮层");
  } else {
    reasons.push("HUD 已在设置里关闭");
  }

  if (ir.kind === "page") {
    surfaces.push("page");
    reasons.push("kind=page：完整内容走产物页（answer_html）");
  }

  let speechText = "";
  if (ctx.speechEnabled) {
    speechText = speechTextOf(ir);
    if (speechText) {
      surfaces.push("speech");
      reasons.push("已语音播报");
    } else {
      reasons.push("没有可念的正文（speech/title/text 都为空）");
    }
  } else {
    reasons.push("语音播报未开启");
  }

  return { surfaces, speechText, reasons };
}
