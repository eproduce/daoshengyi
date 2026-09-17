// P1-3 生命周期钩子（吸收自 `truelove-dreamer/dsh-plugin-hooks` / `hookkit`）：
//
// ## 能力
//
// 在 Agent 生命周期的固定事件上挂动作，用来做「不用改代码就能扩展行为」：
// 例如「每轮结束发个通知」「改了 package.json 就跑一次 npm run build」
// 「命令失败时把错误摘要注回上下文」。
//
// 事件：`turn_start`（一轮开始）· `tool_before`（工具调用前）· `tool_after`（工具调用后）· `turn_end`（一轮结束）
// 动作：`notify`（系统通知）· `inject`（把文本注回上下文）· `block`（仅 tool_before：拦下这次调用）
//       · `shell`（执行配置里的命令）· `http`（发请求）
//
// ## 安全边界（四条，全部有单测兜底）
//
// 1. **命令只来自配置，不接受模型拼接**：只替换白名单占位符，且 shell 动作的值一律
//    **单引号转义**（防止 tool 名/命令里的 `;` `$( )` 等注入成第二条命令）。
// 2. **配置期就用危险命令门禁校验**：`forbidden` 级命令**直接拒绝入表**；
//    `danger` 级必须显式写 `"allow_danger": true` 才允许保存（UI 会提示风险）。
// 3. **HTTP 只允许 http/https**；内网/环回地址默认**拒绝**，必须显式 `"allow_private": true`；
//    运行时还会再走一遍 Rust 侧 SSRF 策略（`fetch_page`）。
// 4. **运行时仍受权限规则约束**：shell 动作在执行前会用 P1-4 的规则求值
//    （`tool: "run_command"`），deny 直接放弃、ask 弹确认。
//
// 另外：注入文本有条数/长度上限，避免钩子把上下文撑爆。

import { assessCommandRisk } from "./danger-rules";

/** 触发事件 */
export type HookEvent = "turn_start" | "tool_before" | "tool_after" | "turn_end";

/** 动作类型 */
export type HookAction = "notify" | "inject" | "block" | "shell" | "http";

/** 工具调用后的状态过滤 */
export type HookWhen = "any" | "success" | "error";

export interface HookRule {
  id?: string;
  event: HookEvent;
  /** tool_before / tool_after 的工具名过滤：精确名，或 `puppeteer_*` 这种前缀通配 */
  tool?: string;
  /** tool_after 的状态过滤（默认 any） */
  when?: HookWhen;
  action: HookAction;
  /** notify / inject / block 的文本（支持占位符） */
  text?: string;
  /** shell 的命令（支持占位符，值会被 shell 转义） */
  command?: string;
  /** http 的地址 */
  url?: string;
  method?: "GET" | "POST";
  /** http POST 的请求体（支持占位符） */
  body?: string;
  /** 超时秒数（默认 15，最大 120） */
  timeout?: number;
  /** danger 级命令的显式放行（保存时必填，否则拒绝） */
  allow_danger?: boolean;
  /** http 允许访问内网/环回（默认禁止） */
  allow_private?: boolean;
  enabled?: boolean;
}

/** 触发上下文：钩子能拿到的全部信息 */
export interface HookContext {
  event: HookEvent;
  tool?: string;
  command?: string;
  path?: string;
  /** tool_after：工具结果文本（渲染时截断） */
  result?: string;
  /** tool_after：错误文本 */
  error?: string;
  status?: "success" | "error";
}

export const MAX_INJECTIONS_PER_EVENT = 3;
export const MAX_INJECT_CHARS = 2000;
export const MAX_VALUE_CHARS = 500;
export const DEFAULT_TIMEOUT_SECS = 15;
export const MAX_TIMEOUT_SECS = 120;

/** 允许在模板里使用的占位符（白名单，其他一律原样保留，不猜不替换） */
export const PLACEHOLDER_KEYS = [
  "event",
  "tool",
  "command",
  "path",
  "result",
  "error",
  "status",
] as const;

/** shell 单引号转义：把 `'` 拆成 `'\''`，其余字符在单引号内安全 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/// 文本值净化：去控制字符（保留 \n）、压缩连续空行、按上限截断
export function sanitizeTextValue(value: string, max = MAX_VALUE_CHARS): string {
  const cleaned = value
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n");
  return cleaned.length > max ? `${cleaned.slice(0, max)}…（已截断）` : cleaned;
}

/// 取上下文里的某个占位符值（未提供的字段 → 空串）
export function contextValue(ctx: HookContext, key: string): string {
  switch (key) {
    case "event":
      return ctx.event;
    case "tool":
      return ctx.tool ?? "";
    case "command":
      return ctx.command ?? "";
    case "path":
      return ctx.path ?? "";
    case "result":
      return ctx.result ?? "";
    case "error":
      return ctx.error ?? "";
    case "status":
      return ctx.status ?? "";
    default:
      return "";
  }
}

/**
 * 渲染模板。
 * - `mode: "shell"` → 值用**单引号转义**（命令注入防护）
 * - `mode: "text"` → 值净化（去控制字符 + 截断）
 * - 未知占位符原样保留（便于发现写错），已知但缺值的 → 空串
 */
export function renderTemplate(
  template: string,
  ctx: HookContext,
  mode: "shell" | "text",
): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (raw, name: string) => {
    const key = name.toLowerCase();
    if (!PLACEHOLDER_KEYS.includes(key as (typeof PLACEHOLDER_KEYS)[number])) return raw;
    const v = contextValue(ctx, key);
    return mode === "shell" ? shellQuote(sanitizeTextValue(v)) : sanitizeTextValue(v);
  });
}

/// URL 是否指向内网/环回/本地（用于 HTTP 动作的默认拦截）
export function isPrivateUrl(url: string): boolean {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false; // 无法解析的交给后续校验处理
  }
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "[::1]") return true;
  if (/^127\./.test(host) || /^0\.0\.0\.0$/.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  return false;
}

/** 工具名过滤：精确名，或前缀通配（`puppeteer_*`），空 = 匹配所有工具 */
export function toolMatches(filter: string | undefined, tool: string | undefined): boolean {
  if (!filter || filter === "*") return true;
  if (!tool) return false;
  if (filter.endsWith("*")) return tool.startsWith(filter.slice(0, -1));
  return filter === tool;
}

/// 事件 + 工具 + 状态是否命中该条规则
export function hookMatches(rule: HookRule, ctx: HookContext): boolean {
  if (rule.enabled === false) return false;
  if (rule.event !== ctx.event) return false;
  if (!toolMatches(rule.tool, ctx.tool)) return false;
  const when = rule.when ?? "any";
  if (ctx.event === "tool_after" && when !== "any") {
    const status = ctx.status ?? "success";
    if (when !== status) return false;
  }
  return true;
}

/// 选出本次事件要执行的全部规则（保持配置顺序）
export function selectHooks(hooks: HookRule[], ctx: HookContext): HookRule[] {
  return hooks.filter((h) => hookMatches(h, ctx));
}

/** 校验一条规则的 shell 命令：返回错误（null = 通过） */
function checkShellCommand(rule: HookRule): string | null {
  const cmd = rule.command ?? "";
  if (!cmd.trim()) return "shell 动作需要 command";
  // 用占位符的「最坏形态」评估：把占位符替换成常见危险目标的形态
  const probe = cmd.replace(/\{\{\s*[a-z_]+\s*\}\}/gi, "/");
  const verdict = assessCommandRisk(probe);
  if (verdict.level === "forbidden") {
    return `命令被安全规则禁止（${verdict.title}）：${verdict.reason}。钩子不允许执行禁止级命令。`;
  }
  if (verdict.level === "danger" && rule.allow_danger !== true) {
    return `命令属于危险级（${verdict.title}）：${verdict.reason}。确需使用请在规则里显式写 "allow_danger": true。`;
  }
  return null;
}

/** 校验一条规则的 HTTP 地址 */
function checkHttpUrl(rule: HookRule): string | null {
  const url = (rule.url ?? "").trim();
  if (!url) return "http 动作需要 url";
  if (!/^https?:\/\//i.test(url)) return "只允许 http/https 地址（不支持 file:// 等本地协议）";
  if (isPrivateUrl(url) && rule.allow_private !== true) {
    return "该地址指向内网/环回，默认禁止；确需使用请显式写 \"allow_private\": true。";
  }
  if (rule.method && !["GET", "POST"].includes(rule.method)) return "method 只能是 GET / POST";
  return null;
}

/** 校验整张钩子表：返回错误列表（带下标，空 = 合法） */
export function validateHooks(input: unknown): string[] {
  const errs: string[] = [];
  if (!Array.isArray(input)) {
    return ['钩子表必须是数组，如 [{"event":"turn_end","action":"notify","text":"完成"}]'];
  }
  input.forEach((raw, i) => {
    const at = `第 ${i + 1} 条`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errs.push(`${at}：必须是对象`);
      return;
    }
    const rule = raw as HookRule;
    const events: HookEvent[] = ["turn_start", "tool_before", "tool_after", "turn_end"];
    if (!events.includes(rule.event)) {
      errs.push(`${at}：event 必须是 ${events.join(" / ")}`);
    }
    const actions: HookAction[] = ["notify", "inject", "block", "shell", "http"];
    if (!actions.includes(rule.action)) {
      errs.push(`${at}：action 必须是 ${actions.join(" / ")}`);
    }
    if (rule.action === "block" && rule.event !== "tool_before") {
      errs.push(`${at}：block 只能用于 tool_before`);
    }
    if (["notify", "inject", "block"].includes(rule.action) && !(rule.text ?? "").trim()) {
      errs.push(`${at}：${rule.action} 动作需要 text`);
    }
    if (rule.action === "shell") {
      const e = checkShellCommand(rule);
      if (e) errs.push(`${at}：${e}`);
    }
    if (rule.action === "http") {
      const e = checkHttpUrl(rule);
      if (e) errs.push(`${at}：${e}`);
    }
    if (rule.timeout !== undefined) {
      if (typeof rule.timeout !== "number" || !Number.isFinite(rule.timeout) || rule.timeout <= 0) {
        errs.push(`${at}：timeout 必须是正数秒`);
      }
    }
    if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") {
      errs.push(`${at}：enabled 必须是布尔值`);
    }
  });
  return errs;
}

/// 容错解析：跳过非法项，合法项保留
export function parseHooks(raw: unknown): { hooks: HookRule[]; errors: string[] } {
  const errors = validateHooks(raw);
  if (!Array.isArray(raw)) return { hooks: [], errors };
  const hooks = raw.filter((r): r is HookRule => {
    if (!r || typeof r !== "object" || Array.isArray(r)) return false;
    const rule = r as HookRule;
    return (
      ["turn_start", "tool_before", "tool_after", "turn_end"].includes(rule.event) &&
      ["notify", "inject", "block", "shell", "http"].includes(rule.action)
    );
  });
  return { hooks, errors };
}

/// 规则的可读描述（设置面板与调试日志用）
export function describeHook(rule: HookRule, index: number): string {
  const id = rule.id ? `「${rule.id}」` : `#${index + 1}`;
  const at = `on ${rule.event}${rule.tool ? `(tool=${rule.tool})` : ""}${
    rule.event === "tool_after" && rule.when && rule.when !== "any" ? `[${rule.when}]` : ""
  }`;
  const what =
    rule.action === "shell"
      ? `执行命令 ${rule.command}`
      : rule.action === "http"
        ? `请求 ${rule.method ?? "GET"} ${rule.url}`
        : `${rule.action === "notify" ? "通知" : rule.action === "inject" ? "注入上下文" : "拦截"}「${rule.text}」`;
  return `${id} ${at} → ${what}`;
}

/** 渲染后的动作（可直接执行） */
export interface PlannedAction {
  kind: HookAction;
  rule: HookRule;
  index: number;
  /** notify/inject/block 的文本 */
  text: string;
  /** shell 的最终命令 */
  command: string;
  /** http 的最终地址与请求体 */
  url: string;
  method: "GET" | "POST";
  body: string;
  timeout: number;
}

/// 把一条规则渲染成可执行动作（模板值已按动作类型转义/净化）
export function renderAction(rule: HookRule, index: number, ctx: HookContext): PlannedAction {
  const isShell = rule.action === "shell";
  const url = rule.url ?? "";
  // 非法/缺失的 timeout 一律回落默认值（配置校验会另行报错，这里只保证运行安全）
  const rawTimeout = rule.timeout;
  const timeout =
    typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : DEFAULT_TIMEOUT_SECS;
  return {
    kind: rule.action,
    rule,
    index,
    text: renderTemplate(rule.text ?? "", ctx, "text"),
    command: isShell ? renderTemplate(rule.command ?? "", ctx, "shell") : "",
    url: isShell ? "" : renderTemplate(url, ctx, "text"),
    method: rule.method ?? "GET",
    body: renderTemplate(rule.body ?? "", ctx, "text"),
    timeout: Math.min(MAX_TIMEOUT_SECS, Math.max(1, Math.round(timeout))),
  };
}

/**
 * 事件 → 计划：返回本次要执行的动作列表 + 注入类动作的合并文本。
 * 注入受 `MAX_INJECTIONS_PER_EVENT` / `MAX_INJECT_CHARS` 限制（防钩子把上下文撑爆）。
 */
export function planHooks(
  hooks: HookRule[],
  ctx: HookContext,
): { actions: PlannedAction[]; injections: string[]; skipped: string[] } {
  const matched = selectHooks(hooks, ctx);
  const actions: PlannedAction[] = [];
  const injections: string[] = [];
  const skipped: string[] = [];
  let injected = 0;
  let budget = MAX_INJECT_CHARS;
  for (const rule of matched) {
    const idx = hooks.indexOf(rule);
    const action = renderAction(rule, idx, ctx);
    if (action.kind === "inject") {
      if (injected >= MAX_INJECTIONS_PER_EVENT || budget <= 0) {
        skipped.push(`注入超限（已注入 ${injected} 条 / ${MAX_INJECT_CHARS} 字符）：${describeHook(rule, idx)}`);
        continue;
      }
      const body = action.text.slice(0, budget);
      budget -= body.length;
      injected++;
      injections.push(body);
      continue;
    }
    actions.push(action);
  }
  return { actions, injections, skipped };
}
