/**
 * 确定性工具集（吸收自 DSH 生态：omdsh-dev/dsh-toolkit · dsh-unitverse · dsh-tool-* 系列 · jean3690/dsh-devtoolbox）。
 *
 * 存在理由：模型对「算术 / 单位换算 / 正则 / 哈希 / 表格统计 / 时间时区 / JSON Schema」
 * 这类**有唯一正确答案**的任务，靠口算或凭记忆极易出错且无法自证。把它们下沉为
 * 零依赖、纯计算、不联网的确定性工具，结果可复现、可核对、可写进测试。
 *
 * 统一入口 `runDeterministicTool(tool, args, ctx)`，由 chat.ts 的 callBuiltinTool 分发；
 * ctx.readTextFile 用于需要读文件的工具（CSV/JSON/正则/统计/diff/schema）。
 */

import { convertUnit, listUnits } from "./unit-convert";
import { unifiedDiff } from "./text-diff";
import { validateJsonSchema } from "./json-schema-lite";

export const DETERMINISTIC_TOOL_NAMES = [
  "calc",
  "convert_unit",
  "time_convert",
  "csv_query",
  "json_query",
  "regex_test",
  "hash_encode",
  "stats_describe",
  "diff_text",
  "schema_validate",
] as const;

export type DeterministicToolName = (typeof DETERMINISTIC_TOOL_NAMES)[number];

export interface DeterministicToolContext {
  /** 读文本文件（由调用方注入，避免本模块依赖 Tauri invoke） */
  readTextFile?: (path: string) => Promise<string>;
  /** 密钥脱敏开关（默认开）——这些工具的输出同样可能含凭据（如 regex_test 里的原文） */
  redact?: boolean;
}

const MAX_OUT = 6000;

function clip(text: string, max = MAX_OUT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[输出过长，已截断，共 ${text.length} 字符]`;
}

function sArg(args: Record<string, unknown>, key: string, fallback = ""): string {
  const v = args[key];
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function needStr(args: Record<string, unknown>, key: string, hint: string): string {
  const v = sArg(args, key).trim();
  if (!v) throw new Error(`${hint}（缺少参数 ${key}）`);
  return v;
}

function nArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function numOr(args: Record<string, unknown>, key: string, fallback: number): number {
  return nArg(args, key) ?? fallback;
}

/** 统一的「取文本」：优先 text/code/content，其次 path 读文件 */
async function textOf(
  args: Record<string, unknown>,
  ctx: DeterministicToolContext,
  keys: string[],
): Promise<string> {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  const p = sArg(args, "path").trim();
  if (p) {
    if (!ctx.readTextFile) throw new Error("当前环境不支持读文件（请把内容直接放进 text 参数）");
    return await ctx.readTextFile(p);
  }
  throw new Error(`需要提供内容：${keys.join(" / ")} 之一，或用 path 指向文件`);
}

// ---------------------------------------------------------------- calc

interface CalcFn {
  min: number;
  max: number; // -1 = 不限
  fn: (a: number[]) => number;
}

const CALC_FNS: Record<string, CalcFn> = {
  sqrt: { min: 1, max: 1, fn: ([x]) => Math.sqrt(x) },
  cbrt: { min: 1, max: 1, fn: ([x]) => Math.cbrt(x) },
  abs: { min: 1, max: 1, fn: ([x]) => Math.abs(x) },
  floor: { min: 1, max: 1, fn: ([x]) => Math.floor(x) },
  ceil: { min: 1, max: 1, fn: ([x]) => Math.ceil(x) },
  trunc: { min: 1, max: 1, fn: ([x]) => Math.trunc(x) },
  sign: { min: 1, max: 1, fn: ([x]) => Math.sign(x) },
  round: {
    min: 1,
    max: 2,
    fn: ([x, d]) => {
      if (d === undefined || !Number.isFinite(d)) return Math.round(x);
      const n = Math.max(0, Math.min(15, Math.trunc(d)));
      const f = Math.pow(10, n);
      return Math.round(x * f) / f;
    },
  },
  exp: { min: 1, max: 1, fn: ([x]) => Math.exp(x) },
  ln: { min: 1, max: 1, fn: ([x]) => Math.log(x) },
  log10: { min: 1, max: 1, fn: ([x]) => Math.log10(x) },
  log2: { min: 1, max: 1, fn: ([x]) => Math.log2(x) },
  log: { min: 1, max: 2, fn: ([x, b]) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)) },
  sin: { min: 1, max: 1, fn: ([x]) => Math.sin(x) },
  cos: { min: 1, max: 1, fn: ([x]) => Math.cos(x) },
  tan: { min: 1, max: 1, fn: ([x]) => Math.tan(x) },
  asin: { min: 1, max: 1, fn: ([x]) => Math.asin(x) },
  acos: { min: 1, max: 1, fn: ([x]) => Math.acos(x) },
  atan: { min: 1, max: 1, fn: ([x]) => Math.atan(x) },
  atan2: { min: 2, max: 2, fn: ([y, x]) => Math.atan2(y, x) },
  pow: { min: 2, max: 2, fn: ([x, y]) => Math.pow(x, y) },
  hypot: { min: 1, max: -1, fn: (a) => Math.hypot(...a) },
  min: { min: 1, max: -1, fn: (a) => Math.min(...a) },
  max: { min: 1, max: -1, fn: (a) => Math.max(...a) },
  sum: { min: 1, max: -1, fn: (a) => a.reduce((x, y) => x + y, 0) },
  avg: { min: 1, max: -1, fn: (a) => a.reduce((x, y) => x + y, 0) / a.length },
  product: { min: 1, max: -1, fn: (a) => a.reduce((x, y) => x * y, 1) },
  gcd: {
    min: 2,
    max: -1,
    fn: (a) => a.map((x) => Math.abs(Math.trunc(x))).reduce((x, y) => {
      let p = x;
      let q = y;
      while (q) [p, q] = [q, p % q];
      return p;
    }),
  },
  lcm: {
    min: 2,
    max: -1,
    fn: (a) =>
      a.map((x) => Math.abs(Math.trunc(x))).reduce((x, y) => {
        if (x === 0 || y === 0) return 0;
        let p = x;
        let q = y;
        while (q) [p, q] = [q, p % q];
        return (x / p) * y;
      }),
  },
  factorial: {
    min: 1,
    max: 1,
    fn: ([x]) => {
      const n = Math.trunc(x);
      if (n < 0 || n > 170) throw new Error("factorial 仅支持 0~170 的整数");
      let r = 1;
      for (let i = 2; i <= n; i++) r *= i;
      return r;
    },
  },
};

const CALC_CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

/** 递归下降求值（不使用 eval，避免执行任意代码） */
class CalcParser {
  private pos = 0;
  constructor(private readonly src: string) {}

  parse(): number {
    const v = this.expr();
    this.ws();
    if (this.pos < this.src.length) {
      throw new Error(`表达式中有无法解析的内容：「${this.src.slice(this.pos, this.pos + 20)}」`);
    }
    return v;
  }

  private ws(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  private peek(): string {
    this.ws();
    return this.src[this.pos] ?? "";
  }

  private expr(): number {
    let v = this.term();
    for (;;) {
      const c = this.peek();
      if (c === "+" || c === "-") {
        this.pos++;
        const r = this.term();
        v = c === "+" ? v + r : v - r;
      } else return v;
    }
  }

  private term(): number {
    let v = this.unary();
    for (;;) {
      const c = this.peek();
      if (c === "*" || c === "/" || c === "%") {
        this.pos++;
        const r = this.unary();
        if ((c === "/" || c === "%") && r === 0) throw new Error("除数不能为 0");
        v = c === "*" ? v * r : c === "/" ? v / r : v % r;
      } else return v;
    }
  }

  private unary(): number {
    const c = this.peek();
    if (c === "-") {
      this.pos++;
      return -this.unary();
    }
    if (c === "+") {
      this.pos++;
      return this.unary();
    }
    return this.power();
  }

  private power(): number {
    const base = this.primary();
    if (this.peek() === "^" || this.src.slice(this.pos, this.pos + 2) === "**") {
      this.pos += this.peek() === "^" ? 1 : 2;
      const exp = this.unary(); // 右结合
      return Math.pow(base, exp);
    }
    return base;
  }

  private primary(): number {
    this.ws();
    const c = this.src[this.pos];
    if (c === "(") {
      this.pos++;
      const v = this.expr();
      if (this.peek() !== ")") throw new Error("括号不匹配（缺少右括号）");
      this.pos++;
      return v;
    }
    // 只允许下划线做千分位（不能收逗号：否则会与函数参数分隔符冲突，如 min(3,5,1) 被读成 351）
    const numMatch = /^(?:\d[\d_]*(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (numMatch) {
      this.pos += numMatch[0].length;
      const v = Number(numMatch[0].replace(/[_,]/g, ""));
      if (!Number.isFinite(v)) throw new Error(`无法解析数字「${numMatch[0]}」`);
      return v;
    }
    const idMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (idMatch) {
      const name = idMatch[0];
      this.pos += name.length;
      if (this.peek() === "(") {
        const f = CALC_FNS[name.toLowerCase()];
        if (!f) throw new Error(`未知函数「${name}」（可用：${Object.keys(CALC_FNS).join("、")}）`);
        this.pos++; // (
        const argv: number[] = [];
        if (this.peek() !== ")") {
          for (;;) {
            argv.push(this.expr());
            if (this.peek() === ",") {
              this.pos++;
              continue;
            }
            break;
          }
        }
        if (this.peek() !== ")") throw new Error(`函数 ${name} 的括号不匹配`);
        this.pos++;
        if (argv.length < f.min || (f.max >= 0 && argv.length > f.max)) {
          throw new Error(
            `函数 ${name} 参数个数不对：期望 ${f.min}${f.max < 0 ? "+" : f.max === f.min ? "" : `~${f.max}`} 个，实际 ${argv.length} 个`,
          );
        }
        const out = f.fn(argv);
        if (!Number.isFinite(out)) throw new Error(`函数 ${name} 计算结果非有限数（检查定义域）`);
        return out;
      }
      const k = name.toLowerCase();
      if (k in CALC_CONSTS) return CALC_CONSTS[k];
      throw new Error(`未知标识符「${name}」（可用常量：${Object.keys(CALC_CONSTS).join("、")}）`);
    }
    throw new Error(`表达式在位置 ${this.pos} 处无法解析：「${this.src.slice(this.pos, this.pos + 12)}」`);
  }
}

export function evalExpression(expression: string): number {
  const expr = String(expression ?? "").trim();
  if (!expr) throw new Error("calc 需要 expression 参数");
  const v = new CalcParser(expr).parse();
  if (!Number.isFinite(v)) throw new Error("计算结果不是有限数（可能是除零或定义域错误）");
  return v;
}

function toolCalc(args: Record<string, unknown>): string {
  const expression = needStr(args, "expression", "calc 需要算术表达式");
  const value = evalExpression(expression);
  const precision = nArg(args, "precision");
  let shown = String(value);
  if (precision !== undefined) {
    const p = Math.max(0, Math.min(15, Math.trunc(precision)));
    shown = value.toFixed(p);
  }
  const intNote = Number.isInteger(value) ? "" : "（非整数结果，默认保留 JavaScript 双精度最长表示；需要定点请传 precision）";
  return `表达式：${expression}\n计算结果：${shown}${intNote}`;
}

// ---------------------------------------------------------------- convert_unit

function toolConvertUnit(args: Record<string, unknown>): string {
  if (args.list === true || sArg(args, "op") === "list") {
    return `可用单位类别与单位：\n${listUnits()}`;
  }
  const value = nArg(args, "value");
  if (value === undefined) throw new Error("convert_unit 需要 value（数值）");
  const from = needStr(args, "from", "convert_unit 需要 from（原单位）");
  const to = needStr(args, "to", "convert_unit 需要 to（目标单位）");
  const r = convertUnit(value, from, to);
  return `${value} ${r.from} = ${r.value} ${r.to}\n类别：${r.category}\n换算过程：${r.formula}`;
}

// ---------------------------------------------------------------- time_convert

function tzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  return asUtc - date.getTime();
}

function offsetLabel(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = Math.round(abs % 60);
  return `UTC${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatInTz(d: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat("zh-CN", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const wall = dtf.format(d).replace(/\//g, "-");
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone: tz, weekday: "short" }).format(d);
  return `${wall} ${weekday}（${offsetLabel(Math.round(tzOffsetMs(d, tz) / 60000))}）`;
}

/** 把「某时区的墙上时间」转成绝对时刻（两轮修正覆盖夏令时边界） */
function zonedWallToUtc(wall: string, tz: string): Date {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(wall.trim());
  if (!m) throw new Error(`时间格式无法识别：「${wall}」（请用 2026-03-01T09:30 或 2026-03-01T09:30:00）`);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  let ms = guess - tzOffsetMs(new Date(guess), tz);
  ms = guess - tzOffsetMs(new Date(ms), tz);
  return new Date(ms);
}

/** 解析时间参数：带 Z / ±HH:MM 视为绝对时刻；否则按 defaultTz 的墙上时间解释 */
function parseTimeArg(value: string, defaultTz: string): Date {
  const v = value.trim();
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(v)) {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new Error(`时间无法解析：「${v}」`);
    return d;
  }
  return zonedWallToUtc(v, defaultTz);
}

const TIME_UNIT_MS: Record<string, number> = {
  ms: 1,
  毫秒: 1,
  s: 1000,
  秒: 1000,
  min: 60000,
  分钟: 60000,
  h: 3600000,
  小时: 3600000,
  d: 86400000,
  天: 86400000,
  wk: 604800000,
  周: 604800000,
};

function humanDuration(ms: number): string {
  const abs = Math.abs(ms);
  const parts: string[] = [];
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor((abs % 86400000) / 3600000);
  const mins = Math.floor((abs % 3600000) / 60000);
  const secs = Math.round((abs % 60000) / 1000);
  if (days) parts.push(`${days} 天`);
  if (hours) parts.push(`${hours} 小时`);
  if (mins) parts.push(`${mins} 分`);
  if (secs || parts.length === 0) parts.push(`${secs} 秒`);
  return `${ms < 0 ? "负 " : ""}${parts.join(" ")}`;
}

function toolTimeConvert(args: Record<string, unknown>): string {
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const toTz = sArg(args, "to_tz").trim() || sArg(args, "tz").trim() || localTz;
  const fromTz = sArg(args, "from_tz").trim() || localTz;
  const actionRaw = sArg(args, "action").trim().toLowerCase();
  const action =
    actionRaw ||
    (sArg(args, "to").trim() || sArg(args, "time").trim() ? (sArg(args, "amount").trim() ? "add" : "convert") : "now");

  try {
    // 校验时区
    new Intl.DateTimeFormat("en-US", { timeZone: toTz }).format(new Date());
  } catch {
    throw new Error(`未知时区「${toTz}」。请用 IANA 名称，如 Asia/Shanghai、UTC、America/New_York、Europe/London`);
  }

  if (action === "now") {
    const now = new Date();
    return [
      `当前时刻（UTC）：${now.toISOString()}`,
      `本机时区：${localTz}`,
      `按 ${toTz}：${formatInTz(now, toTz)}`,
    ].join("\n");
  }

  if (action === "convert") {
    const timeStr = sArg(args, "time").trim() || sArg(args, "from").trim();
    if (!timeStr) throw new Error("time_convert(convert) 需要 time（如 2026-03-01T09:30，或用 to_tz 反推）");
    const d = parseTimeArg(timeStr, fromTz);
    return [
      `输入：${timeStr}（按 ${fromTz} 解释）`,
      `绝对时刻（UTC）：${d.toISOString()}`,
      `换算到 ${toTz}：${formatInTz(d, toTz)}`,
      `回到 ${fromTz}：${formatInTz(d, fromTz)}`,
    ].join("\n");
  }

  if (action === "add" || action === "sub") {
    const timeStr = sArg(args, "time").trim() || new Date().toISOString();
    const base = parseTimeArg(timeStr, fromTz);
    const amount = nArg(args, "amount") ?? 0;
    const unit = (sArg(args, "unit").trim() || "d").toLowerCase();
    const factor = TIME_UNIT_MS[unit];
    if (!factor) throw new Error(`未知时间单位「${unit}」（可用：${Object.keys(TIME_UNIT_MS).join("、")}）`);
    const delta = amount * factor * (action === "sub" ? -1 : 1);
    const out = new Date(base.getTime() + delta);
    return [
      `起点：${formatInTz(base, fromTz)}（UTC ${base.toISOString()}）`,
      `${action === "add" ? "加上" : "减去"} ${amount} ${unit}`,
      `结果：${formatInTz(out, toTz)}（UTC ${out.toISOString()}）`,
    ].join("\n");
  }

  if (action === "diff") {
    const aStr = sArg(args, "from").trim() || sArg(args, "time").trim();
    const bStr = sArg(args, "to").trim();
    if (!aStr || !bStr) throw new Error("time_convert(diff) 需要 from 与 to（两个时间）");
    const a = parseTimeArg(aStr, fromTz);
    const b = parseTimeArg(bStr, fromTz);
    const ms = b.getTime() - a.getTime();
    const unit = (sArg(args, "unit").trim() || "").toLowerCase();
    const factor = unit ? TIME_UNIT_MS[unit] : undefined;
    if (unit && !factor) throw new Error(`未知时间单位「${unit}」（可用：${Object.keys(TIME_UNIT_MS).join("、")}）`);
    return [
      `from：${formatInTz(a, fromTz)}`,
      `to：  ${formatInTz(b, fromTz)}`,
      `相差：${humanDuration(ms)}（${ms} 毫秒）`,
      factor ? `折合：${(ms / factor).toFixed(4)} ${unit}` : "",
      `含工作日估算：约 ${Math.max(0, Math.round(Math.abs(ms) / 86400000 / 7 * 5))} 个工作日（按 5/7 折算，仅参考）`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  throw new Error(`未知 action「${action}」（可用：now / convert / add / sub / diff）`);
}

// ---------------------------------------------------------------- csv_query

export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  const firstLine = src.split("\n")[0] ?? "";
  const delim =
    delimiter && delimiter !== "auto"
      ? delimiter
      : [",", "\t", ";", "|"].find((d) => firstLine.split(d).length > 1) ?? ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
      continue;
    }
    if (c === delim) {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  // 去掉全空行
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

function asNumber(v: string): number | null {
  const t = v.trim().replace(/,/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function cmpValues(a: string, b: string): number {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return a.localeCompare(b, "zh-CN");
}

interface WhereClause {
  column: string;
  op: string;
  value: unknown;
}

function parseWhere(raw: unknown): WhereClause[] {
  if (!raw) return [];
  const list: WhereClause[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) list.push(...parseWhere(item));
    return list;
  }
  if (typeof raw !== "object") return [];
  for (const [column, cond] of Object.entries(raw as Record<string, unknown>)) {
    if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      list.push({ column, op: String(c.op ?? "eq").toLowerCase(), value: c.value });
    } else {
      list.push({ column, op: "eq", value: cond });
    }
  }
  return list;
}

function matchWhere(cell: string, clause: WhereClause): boolean {
  const target = clause.value === null || clause.value === undefined ? "" : String(clause.value);
  switch (clause.op) {
    case "eq":
      return cell === target || cmpValues(cell, target) === 0;
    case "ne":
      return !(cell === target || cmpValues(cell, target) === 0);
    case "gt":
      return cmpValues(cell, target) > 0;
    case "gte":
      return cmpValues(cell, target) >= 0;
    case "lt":
      return cmpValues(cell, target) < 0;
    case "lte":
      return cmpValues(cell, target) <= 0;
    case "contains":
      return cell.toLowerCase().includes(target.toLowerCase());
    case "startswith":
      return cell.toLowerCase().startsWith(target.toLowerCase());
    case "endswith":
      return cell.toLowerCase().endsWith(target.toLowerCase());
    case "in":
      return (Array.isArray(clause.value) ? clause.value : target.split(",")).some(
        (v) => String(v).trim() === cell,
      );
    case "regex":
      try {
        return new RegExp(target).test(cell);
      } catch {
        return false;
      }
    default:
      throw new Error(`where 不支持的操作符「${clause.op}」（可用 eq/ne/gt/gte/lt/lte/contains/startswith/endswith/in/regex）`);
  }
}

function mdTable(rows: string[][]): string {
  if (!rows.length) return "（无数据）";
  const width = Math.max(...rows.map((r) => r.length));
  const cell = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [cell(rows[0]), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(cell)].join("\n");
}

function toolCsvQuery(args: Record<string, unknown>, raw: string): string {
  const delimiter = sArg(args, "delimiter").trim() || undefined;
  const rows = parseCsv(raw, delimiter);
  if (rows.length === 0) throw new Error("CSV 内容为空或无法解析");
  const header = rows[0];
  const body = rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => (o[h] = r[i] ?? ""));
    return o;
  });
  const out: string[] = [`CSV 共 ${body.length} 行数据 × ${header.length} 列`, `列名：${header.join(" | ")}`];

  if (args.profile === true) {
    out.push("", "列画像：");
    const prof: string[][] = [["列", "非空", "空值", "去重值", "数值样本(min/max)"]];
    for (const h of header) {
      const vals = body.map((r) => r[h] ?? "");
      const nonNull = vals.filter((v) => v.trim() !== "");
      const nums = nonNull.map(asNumber).filter((n): n is number => n !== null);
      prof.push([
        h,
        String(nonNull.length),
        String(vals.length - nonNull.length),
        String(new Set(nonNull).size),
        nums.length ? `${Math.min(...nums)} / ${Math.max(...nums)}` : "-",
      ]);
    }
    out.push(mdTable(prof));
    return clip(out.join("\n"));
  }

  const where = parseWhere(args.where);
  let filtered = body;
  if (where.length) {
    filtered = body.filter((r) => where.every((c) => matchWhere(r[c.column] ?? "", c)));
    out.push(`过滤条件 ${where.length} 条（${where.map((c) => `${c.column} ${c.op} ${JSON.stringify(c.value)}`).join(" 且 ")}）→ 命中 ${filtered.length} 行`);
  }

  const groupBy = sArg(args, "group_by").trim();
  const aggSpec: { fn: string; column: string }[] = [];
  const rawAgg = args.agg ?? args.aggregate;
  const pushAgg = (spec: string) => {
    const [fn, col] = spec.split(":").map((x) => x.trim());
    aggSpec.push({ fn: (fn || "count").toLowerCase(), column: col ?? "" });
  };
  if (typeof rawAgg === "string") rawAgg.split(",").forEach((x) => x.trim() && pushAgg(x));
  else if (Array.isArray(rawAgg)) {
    for (const item of rawAgg) {
      if (typeof item === "string") pushAgg(item);
      else if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        aggSpec.push({ fn: String(o.fn ?? "count").toLowerCase(), column: String(o.column ?? "") });
      }
    }
  } else if (rawAgg && typeof rawAgg === "object") {
    for (const [alias, expr] of Object.entries(rawAgg as Record<string, unknown>)) pushAgg(`${String(expr)}:${alias}`);
  }
  if (groupBy && aggSpec.length === 0) aggSpec.push({ fn: "count", column: "" });

  if (groupBy) {
    const groups = new Map<string, Record<string, string>[]>();
    for (const r of filtered) {
      const k = r[groupBy] ?? "";
      const arr = groups.get(k) ?? [];
      arr.push(r);
      groups.set(k, arr);
    }
    const table: string[][] = [[groupBy, ...aggSpec.map((a) => (a.column ? `${a.fn}(${a.column})` : a.fn))]];
    for (const [k, items] of groups) {
      const cells = aggSpec.map((a) => {
        const nums = items.map((r) => asNumber(r[a.column] ?? "")).filter((n): n is number => n !== null);
        switch (a.fn) {
          case "count":
            return String(items.length);
          case "count_distinct":
            return String(new Set(items.map((r) => r[a.column] ?? "")).size);
          case "sum":
            return String(nums.reduce((x, y) => x + y, 0));
          case "avg":
            return nums.length ? String(Number((nums.reduce((x, y) => x + y, 0) / nums.length).toFixed(4))) : "-";
          case "min":
            return nums.length ? String(Math.min(...nums)) : "-";
          case "max":
            return nums.length ? String(Math.max(...nums)) : "-";
          default:
            throw new Error(`不支持的聚合函数「${a.fn}」（可用 count/count_distinct/sum/avg/min/max）`);
        }
      });
      table.push([k, ...cells]);
    }
    out.push(`按「${groupBy}」分组，共 ${groups.size} 组：`, mdTable(table));
    return clip(out.join("\n"));
  }

  const select = Array.isArray(args.select)
    ? (args.select as unknown[]).map((x) => String(x))
    : sArg(args, "select").trim()
      ? sArg(args, "select").split(",").map((x) => x.trim())
      : header;

  const sortBy = sArg(args, "sort_by").trim();
  if (sortBy) {
    const desc = args.sort_desc === true || sArg(args, "sort_desc") === "true";
    filtered = [...filtered].sort((a, b) => (desc ? -1 : 1) * cmpValues(a[sortBy] ?? "", b[sortBy] ?? ""));
    out.push(`已按「${sortBy}」${desc ? "降序" : "升序"}排序`);
  }

  const limit = Math.max(1, Math.trunc(numOr(args, "limit", 30)));
  const shown = filtered.slice(0, limit);
  const table: string[][] = [select, ...shown.map((r) => select.map((c) => r[c] ?? ""))];
  out.push(`结果 ${filtered.length} 行，显示前 ${Math.min(limit, filtered.length)} 行：`, mdTable(table));
  if (filtered.length > shown.length) out.push(`（还有 ${filtered.length - shown.length} 行未显示，可调大 limit）`);
  return clip(out.join("\n"));
}

// ---------------------------------------------------------------- json_query

function jsonPathLookup(root: unknown, expr: string): unknown {
  if (!expr || expr === "$" || expr === ".") return root;
  const tokens: string[] = [];
  const src = expr.replace(/^\$?\.?/, "");
  let i = 0;
  let cur = "";
  while (i < src.length) {
    const c = src[i];
    if (c === ".") {
      if (cur) tokens.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === "[") {
      if (cur) tokens.push(cur);
      cur = "";
      const end = src.indexOf("]", i);
      if (end < 0) throw new Error(`json_path 方括号未闭合：「${expr}」`);
      tokens.push(src.slice(i + 1, end).trim());
      i = end + 1;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur) tokens.push(cur);

  let cur2: unknown = root;
  for (const raw of tokens) {
    if (raw === "*") {
      if (Array.isArray(cur2)) continue;
      if (cur2 && typeof cur2 === "object") {
        cur2 = Object.values(cur2 as Record<string, unknown>);
        continue;
      }
      return undefined;
    }
    if (raw === "") continue;
    const idx = Number(raw.replace(/^["']|["']$/g, ""));
    const key = raw.replace(/^["']|["']$/g, "");
    if (Array.isArray(cur2)) {
      if (Number.isInteger(idx)) {
        cur2 = cur2[idx];
        continue;
      }
      // 数组上按字段名取 → 映射
      cur2 = cur2.map((item) =>
        item && typeof item === "object" ? (item as Record<string, unknown>)[key] : undefined,
      );
      continue;
    }
    if (cur2 && typeof cur2 === "object") {
      cur2 = (cur2 as Record<string, unknown>)[key];
      continue;
    }
    return undefined;
  }
  return cur2;
}

function toolJsonQuery(args: Record<string, unknown>, raw: string): string {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`JSON 解析失败（${e instanceof Error ? e.message : String(e)}）。请先用 schema_validate 检查或修正文本`);
  }
  if (args.keys === true) {
    if (Array.isArray(data)) {
      const first = data[0];
      const keys = first && typeof first === "object" ? Object.keys(first as Record<string, unknown>) : [];
      return `顶层为数组（${data.length} 项）；元素字段：${keys.join(" | ") || "（元素非对象）"}`;
    }
    if (data && typeof data === "object") {
      return `顶层为对象；字段：${Object.keys(data as Record<string, unknown>).join(" | ")}`;
    }
    return `顶层为 ${typeof data}`;
  }
  const expr = sArg(args, "json_path").trim() || sArg(args, "expr").trim() || "$";
  const picked = jsonPathLookup(data, expr);
  if (picked === undefined) return `json_path「${expr}」未命中任何值（可用 keys:true 先看有哪些字段）`;

  if (args.table === true && Array.isArray(picked) && picked.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
    const cols = Array.from(
      new Set(picked.flatMap((x) => Object.keys(x as Record<string, unknown>))),
    );
    const rows: string[][] = [cols, ...picked.slice(0, 40).map((x) => cols.map((c) => {
      const v = (x as Record<string, unknown>)[c];
      return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    }))];
    return clip(`json_path「${expr}」命中 ${picked.length} 项，表格视图（显示前 ${Math.min(40, picked.length)} 项）：\n${mdTable(rows)}`);
  }
  const pretty = JSON.stringify(picked, null, 2);
  return clip(`json_path「${expr}」结果：\n${pretty}`);
}

// ---------------------------------------------------------------- regex_test

function toolRegexTest(raw: string, args: Record<string, unknown>): string {
  const pattern = needStr(args, "pattern", "regex_test 需要 pattern");
  const flags = sArg(args, "flags").trim() || "g";
  const max = Math.max(1, Math.trunc(numOr(args, "max", 30)));
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
  } catch (e) {
    throw new Error(`正则编译失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const warnings: string[] = [];
  if (/\([^()]*[*+][^()]*\)[*+{]/.test(pattern)) {
    warnings.push("⚠️ 检测到嵌套量词（(…*)+ 形态），特定输入下可能灾难性回溯——建议先限定输入长度");
  }
  if (/\.\*.*\.\*/s.test(pattern)) warnings.push("⚠️ 多个 .* 串联：可能匹配范围过大，建议用更精确的字符类");

  const out: string[] = [`正则 /${pattern}/${flags}`, `输入长度：${raw.length} 字符`];
  const matches: { index: number; text: string; groups: string[] }[] = [];
  if (re.flags.includes("g")) {
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(raw)) !== null && matches.length < max && guard++ < 100000) {
      matches.push({ index: m.index, text: m[0], groups: m.slice(1).map((g) => g ?? "") });
      if (m[0] === "") re.lastIndex++;
    }
  } else {
    const m = re.exec(raw);
    if (m) matches.push({ index: m.index, text: m[0], groups: m.slice(1).map((g) => g ?? "") });
  }
  if (matches.length === 0) {
    out.push("结果：无匹配");
    if (warnings.length) out.push(...warnings);
    return out.join("\n");
  }
  out.push(`结果：命中 ${matches.length}${matches.length >= max ? "+" : ""} 处（显示前 ${matches.length} 处）`);
  matches.forEach((m, i) => {
    const g = m.groups.length ? `；分组：${m.groups.map((x, gi) => `${gi + 1}=${JSON.stringify(x)}`).join(", ")}` : "";
    out.push(`${i + 1}) 位置 ${m.index}，长度 ${m.text.length} → ${JSON.stringify(m.text.slice(0, 200))}${g}`);
  });
  if (typeof args.replace === "string") {
    try {
      const replaced = raw.replace(new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`), args.replace);
      out.push(`替换预览（${args.replace}）→ 结果长度 ${replaced.length} 字符：\n${replaced.slice(0, 600)}`);
    } catch (e) {
      out.push(`替换失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  out.push(...warnings);
  return clip(out.join("\n"));
}

// ---------------------------------------------------------------- hash_encode

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64_CHARS[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64_CHARS[b2 & 63];
  }
  return out;
}

function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[\s=]/g, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const idx = B64_CHARS.indexOf(ch);
    if (idx < 0) throw new Error(`base64 含非法字符「${ch}」`);
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesToUtf8(b: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(b);
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(s: string): Uint8Array {
  const clean = s.replace(/[\s]/g, "").replace(/^0x/i, "");
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error("十六进制字符串非法（应为偶数长度的 0-9a-f）");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function subtleDigest(algo: string, bytes: Uint8Array): Promise<string> {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("当前运行环境没有 WebCrypto，无法计算摘要（请改用 hash_encode 的 base64/hex 编码功能）");
  const buf = await c.subtle.digest(algo, bytes as unknown as ArrayBuffer);
  return bytesToHex(new Uint8Array(buf));
}

/** 各运行时对摘要算法名的拼写不同（Node WebCrypto 要求 SHA-256 这种带连字符的写法） */
const DIGEST_ALGO: Record<string, string> = {
  sha1: "SHA-1",
  sha256: "SHA-256",
  sha384: "SHA-384",
  sha512: "SHA-512",
};

async function toolHashEncode(args: Record<string, unknown>): Promise<string> {
  const op = needStr(args, "op", "hash_encode 需要 op").toLowerCase();
  const input = sArg(args, "input");
  switch (op) {
    case "sha1":
    case "sha256":
    case "sha384":
    case "sha512": {
      const algo = DIGEST_ALGO[op];
      return `${op.toUpperCase()}(${input.length} 字符) = ${await subtleDigest(algo, utf8Bytes(input))}`;
    }
    case "hmac_sha256": {
      const key = needStr(args, "key", "hmac_sha256 需要 key");
      const c = globalThis.crypto;
      if (!c?.subtle) throw new Error("当前运行环境没有 WebCrypto，无法计算 HMAC");
      const k = await c.subtle.importKey(
        "raw",
        utf8Bytes(key) as unknown as ArrayBuffer,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await c.subtle.sign("HMAC", k, utf8Bytes(input) as unknown as ArrayBuffer);
      return `HMAC-SHA256(${input.length} 字符) = ${bytesToHex(new Uint8Array(sig))}`;
    }
    case "base64":
    case "base64_encode":
      return bytesToBase64(utf8Bytes(input));
    case "base64url":
      return bytesToBase64(utf8Bytes(input)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    case "base64_decode": {
      const bytes = base64ToBytes(input.replace(/-/g, "+").replace(/_/g, "/"));
      return bytesToUtf8(bytes);
    }
    case "hex":
    case "hex_encode":
      return bytesToHex(utf8Bytes(input));
    case "hex_decode":
      return bytesToUtf8(hexToBytes(input));
    case "url":
    case "url_encode":
      return encodeURIComponent(input);
    case "url_decode":
      try {
        return decodeURIComponent(input);
      } catch {
        throw new Error("URL 解码失败：输入含非法百分号转义");
      }
    case "uuid": {
      const c = globalThis.crypto;
      if (c?.randomUUID) return c.randomUUID();
      const bytes = new Uint8Array(16);
      if (c?.getRandomValues) c.getRandomValues(bytes);
      else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = bytesToHex(bytes);
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    case "random_hex": {
      const len = Math.max(1, Math.min(256, Math.trunc(numOr(args, "length", 16))));
      const bytes = new Uint8Array(len);
      const c = globalThis.crypto;
      if (c?.getRandomValues) c.getRandomValues(bytes);
      else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
      return bytesToHex(bytes);
    }
    default:
      throw new Error(
        `不支持的 op「${op}」（可用：sha1 / sha256 / sha384 / sha512 / hmac_sha256 / base64 / base64url / base64_decode / hex / hex_decode / url / url_decode / uuid / random_hex）`,
      );
  }
}

// ---------------------------------------------------------------- stats_describe

function parseNumberList(text: string): { values: number[]; skipped: number } {
  const tokens = text
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const values: number[] = [];
  let skipped = 0;
  for (const t of tokens) {
    const n = Number(t);
    if (Number.isFinite(n)) values.push(n);
    else skipped++;
  }
  return { values, skipped };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function describe(values: number[]): string[] {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = n > 1 ? sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const outliersIqr = sorted.filter((x) => x < lo || x > hi);
  const zOutliers = sd > 0 ? sorted.filter((x) => Math.abs((x - mean) / sd) > 3) : [];
  const f = (x: number) => (Number.isInteger(x) ? String(x) : String(Number(x.toFixed(6))));
  return [
    `样本数：${n}`,
    `总和：${f(sum)}`,
    `均值：${f(mean)}`,
    `中位数：${f(percentile(sorted, 0.5))}`,
    `标准差（样本）：${f(sd)}`,
    `最小 / 最大：${f(sorted[0])} / ${f(sorted[n - 1])}`,
    `极差：${f(sorted[n - 1] - sorted[0])}`,
    `分位数 P25 / P50 / P75：${f(q1)} / ${f(percentile(sorted, 0.5))} / ${f(q3)}`,
    `分位数 P90 / P95 / P99：${f(percentile(sorted, 0.9))} / ${f(percentile(sorted, 0.95))} / ${f(percentile(sorted, 0.99))}`,
    `IQR 离群（Q1-1.5IQR ~ Q3+1.5IQR = ${f(lo)} ~ ${f(hi)}）：${outliersIqr.length} 个${outliersIqr.length ? `，如 ${outliersIqr.slice(0, 5).map(f).join(", ")}` : ""}`,
    `|z|>3 离群：${zOutliers.length} 个${zOutliers.length ? `，如 ${zOutliers.slice(0, 5).map(f).join(", ")}` : ""}`,
  ];
}

function correlation(a: number[], b: number[]): string {
  const n = Math.min(a.length, b.length);
  if (n < 2) return "相关系数：样本不足（<2 对）";
  const ax = a.slice(0, n);
  const bx = b.slice(0, n);
  const ma = ax.reduce((x, y) => x + y, 0) / n;
  const mb = bx.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ax[i] - ma) * (bx[i] - mb);
    da += (ax[i] - ma) ** 2;
    db += (bx[i] - mb) ** 2;
  }
  if (da === 0 || db === 0) return "相关系数：无法计算（存在零方差序列）";
  const r = num / Math.sqrt(da * db);
  let slope = 0;
  let intercept = 0;
  if (da !== 0) {
    slope = num / da;
    intercept = mb - slope * ma;
  }
  const r2 = r * r;
  return [
    `配对样本数：${n}`,
    `皮尔逊相关系数 r：${r.toFixed(6)}`,
    `线性回归：y = ${slope.toFixed(6)}x + ${intercept.toFixed(6)}（R² = ${r2.toFixed(6)}）`,
  ].join("\n");
}

function toolStatsDescribe(args: Record<string, unknown>, raw: string): string {
  const column = sArg(args, "column").trim();
  let values: number[];
  let skipped = 0;
  if (Array.isArray(args.values)) {
    values = (args.values as unknown[]).map((x) => Number(x)).filter((x) => Number.isFinite(x));
    skipped = (args.values as unknown[]).length - values.length;
  } else if (column) {
    const rows = parseCsv(raw, sArg(args, "delimiter").trim() || undefined);
    const header = rows[0] ?? [];
    const idx = header.indexOf(column);
    if (idx < 0) throw new Error(`CSV 中找不到列「${column}」（列名：${header.join(" | ")}）`);
    const parsed = rows.slice(1).map((r) => r[idx] ?? "");
    values = parsed.map(asNumber).filter((n): n is number => n !== null);
    skipped = parsed.length - values.length;
  } else {
    const p = parseNumberList(raw);
    values = p.values;
    skipped = p.skipped;
  }
  if (values.length === 0) throw new Error("没有解析到任何数值（可传 values 数组，或 text 里每行一个数字）");

  const out = [`数值统计（${column ? `列「${column}」` : "输入序列"}）：`, ...describe(values)];
  if (skipped > 0) out.push(`（已跳过 ${skipped} 个非数值项）`);

  const values2 = Array.isArray(args.values2)
    ? (args.values2 as unknown[]).map((x) => Number(x)).filter((x) => Number.isFinite(x))
    : sArg(args, "column2").trim()
      ? (() => {
          const rows = parseCsv(raw, sArg(args, "delimiter").trim() || undefined);
          const idx = (rows[0] ?? []).indexOf(sArg(args, "column2").trim());
          if (idx < 0) throw new Error(`CSV 中找不到列「${sArg(args, "column2")}」`);
          return rows.slice(1).map((r) => asNumber(r[idx] ?? "")).filter((n): n is number => n !== null);
        })()
      : null;
  if (values2) out.push("", `与「${sArg(args, "column2").trim() || "values2"}」的关系：`, correlation(values, values2));
  return clip(out.join("\n"));
}

// ---------------------------------------------------------------- dispatcher

async function toolDiffText(args: Record<string, unknown>, ctx: DeterministicToolContext): Promise<string> {
  const pick = async (a: string, b: string, pathKey: string): Promise<string> => {
    if (typeof args[a] === "string") return args[a];
    if (typeof args[b] === "string") return args[b];
    const p = sArg(args, pathKey).trim();
    if (p) {
      if (!ctx.readTextFile) throw new Error("当前环境不支持读文件（请把内容放进 a / b 参数）");
      return await ctx.readTextFile(p);
    }
    throw new Error(`diff_text 需要 a/b（文本）或 ${pathKey}（文件路径）`);
  };
  const a = await pick("a", "text_a", "path_a");
  const b = await pick("b", "text_b", "path_b");
  const context = Math.max(0, Math.trunc(numOr(args, "context", 3)));
  const r = unifiedDiff(a, b, sArg(args, "a_label") || "a", sArg(args, "b_label") || "b", context);
  return clip(`差异统计：+${r.added} 行 / -${r.removed} 行${r.truncated ? "（输入过大，已降级）" : ""}\n\n${r.diff}`);
}

function toolSchemaValidate(args: Record<string, unknown>, raw: string, rawIsData: boolean): string {
  const schemaRaw = args.schema;
  const schema = typeof schemaRaw === "string" ? JSON.parse(schemaRaw) : schemaRaw;
  if (schema === undefined || schema === null) throw new Error("schema_validate 需要 schema（JSON Schema 字符串或对象）");
  let data: unknown;
  if (rawIsData) {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error(`待校验数据不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (typeof args.data === "string") {
    try {
      data = JSON.parse(args.data);
    } catch {
      data = args.data; // 非 JSON 字符串按原始字符串校验（type: string 场景）
    }
  } else {
    data = args.data;
  }
  const issues = validateJsonSchema(schema, data);
  if (issues.length === 0) return "✅ 校验通过：数据符合 schema";
  const lines = issues.map((i, n) => `${n + 1}) ${i.path}：${i.message}`);
  return clip(`❌ 校验失败，共 ${issues.length} 处问题：\n${lines.join("\n")}`);
}

/** 统一分发：由 chat.ts 的 callBuiltinTool 以单个 case 组调用 */
export async function runDeterministicTool(
  tool: string,
  args: Record<string, unknown>,
  ctx: DeterministicToolContext = {},
): Promise<string> {
  switch (tool) {
    case "calc":
      return toolCalc(args);
    case "convert_unit":
      return toolConvertUnit(args);
    case "time_convert":
      return toolTimeConvert(args);
    case "csv_query":
      return toolCsvQuery(args, await textOf(args, ctx, ["text", "csv", "content"]));
    case "json_query":
      return toolJsonQuery(args, await textOf(args, ctx, ["json", "text", "content"]));
    case "regex_test":
      return toolRegexTest(await textOf(args, ctx, ["text", "content"]), args);
    case "hash_encode":
      return await toolHashEncode(args);
    case "stats_describe": {
      // values 数组优先：此时不要求 text（否则会误报「需要提供内容」）
      let raw = "";
      try {
        raw = await textOf(args, ctx, ["text", "numbers", "content"]);
      } catch (e) {
        if (!Array.isArray(args.values) && !sArg(args, "column").trim()) throw e;
      }
      return toolStatsDescribe(args, raw);
    }
    case "diff_text":
      return await toolDiffText(args, ctx);
    case "schema_validate": {
      const hasInlineData = typeof args.data === "string" || (args.data !== undefined && args.data !== null);
      const text = hasInlineData ? "" : await textOf(args, ctx, ["data", "text", "json", "content"]);
      return toolSchemaValidate(args, text, !hasInlineData);
    }
    default:
      throw new Error(`未知的确定性工具「${tool}」`);
  }
}
