// P1-4 声明式权限规则（吸收自 `PerryLink/dsh-permission-rules`）：
//
// ## 解决什么问题
//
// 现有的「权限矩阵」只有两档：工具级禁用（黑名单）+ 路径白名单——粒度太粗：
// - 「只允许跑 `npm test` / `git status`，其它命令都要问」表达不出来；
// - 「改 `~/proj/**` 免确认，改别的地方必须确认」表达不出来；
// - 每次都要人工点确认（或者为了省事干脆开 YOLO，那就是全放开）。
//
// ## 做法
//
// 用户用一份**有序规则表**声明意图，每条规则 = `匹配条件 → 处置`：
// ```json
// [
//   { "action": "allow", "tool": "run_command", "command": "^npm (test|run lint)\\b", "reason": "常用只读校验" },
//   { "action": "deny",  "tool": "run_command", "command": "rm -rf /", "reason": "危险" },
//   { "action": "ask",   "path": "~/proj/**", "reason": "改代码前确认" }
// ]
// ```
//
// 匹配是**有序的、第一条命中即生效**——用户自己用顺序表达优先级，不引入隐式权重（好推理、好排查）。
//
// ## 安全边界（重要）
//
// - `deny` 是**硬拦截**：命中即拒绝，且**优先于任何 allow**（因为第一条命中生效，
//   所以 deny 规则要写在 allow 前面——内置的 deny 规则永远排在最前）。
// - `allow` 只能免掉「交互确认」，**不能绕过 danger/forbidden 命令门禁**
//   （那是系统级保护，用户不可能用一条 allow 规则把 `rm -rf /` 变成免确认）。
// - `ask` 强制确认，**优先级高于 allow**（同一工具上既有 allow 又有 ask 时，先写的生效，
//   测试里会明确这一点，避免"以为放开了其实没放开"）。

/** 处置动作 */
export type RuleAction = "allow" | "deny" | "ask";

/** 一条规则（JSON 可序列化，便于存设置 / 导出） */
export interface PermissionRule {
  /** 可选标识：命中时回显给用户，便于定位是哪条规则生效 */
  id?: string;
  action: RuleAction;
  /** 工具名精确匹配（内置或 MCP；省略则不限工具） */
  tool?: string;
  /** 命令正则（用于 run_command / exec_command 类工具的参数 command） */
  command?: string;
  /** 路径 glob（`*` 单段、`**` 跨段；同时匹配 `~` 展开后的绝对路径） */
  path?: string;
  /** 退出码/文本等补充说明（当前仅作注释用途，便于人读） */
  reason?: string;
  /** false = 临时停用该条（保留规则但跳过） */
  enabled?: boolean;
}

/** 一次工具调用的上下文（由调用方从参数里抽取） */
export interface ToolCallContext {
  tool: string;
  /** 命令类工具的参数 */
  command?: string;
  /** 文件类工具的参数 */
  path?: string;
}

/** 判定结果 */
export type RuleDecision =
  | { decision: "none"; message: "" }
  | { decision: RuleAction; rule: PermissionRule; index: number; message: string };

/** 校验规则表：返回错误信息列表（空 = 合法）。含正则/glob 非法时给出精确下标，避免静默失效。 */
export function validateRules(input: unknown): string[] {
  const errs: string[] = [];
  if (!Array.isArray(input)) return ["规则表必须是数组（每项形如 {\"action\":\"allow\",\"tool\":\"run_command\"}）"];
  input.forEach((r, i) => {
    const at = `第 ${i + 1} 条`;
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      errs.push(`${at}：必须是对象`);
      return;
    }
    const rule = r as Record<string, unknown>;
    if (rule.action !== "allow" && rule.action !== "deny" && rule.action !== "ask") {
      errs.push(`${at}：action 必须是 allow / deny / ask（当前 ${JSON.stringify(rule.action)}）`);
    }
    if (rule.command !== undefined) {
      if (typeof rule.command !== "string") {
        errs.push(`${at}：command 必须是字符串正则`);
      } else {
        try {
          new RegExp(rule.command);
        } catch (e) {
          errs.push(`${at}：command 正则非法（${e instanceof Error ? e.message : String(e)}）`);
        }
      }
    }
    for (const k of ["tool", "path", "reason", "id"] as const) {
      if (rule[k] !== undefined && typeof rule[k] !== "string") {
        errs.push(`${at}：${k} 必须是字符串`);
      }
    }
    if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") {
      errs.push(`${at}：enabled 必须是布尔值`);
    }
    if (rule.tool === undefined && rule.command === undefined && rule.path === undefined) {
      errs.push(`${at}：至少要有一个匹配条件（tool / command / path），否则会匹配一切调用`);
    }
  });
  return errs;
}

/// 解析规则表（容错）：非法项跳过并在 errors 里报告；返回可直接使用的规则数组
export function parseRules(raw: unknown): { rules: PermissionRule[]; errors: string[] } {
  const errors = validateRules(raw);
  if (!Array.isArray(raw)) return { rules: [], errors };
  const rules = raw.filter(
    (r): r is PermissionRule =>
      !!r &&
      typeof r === "object" &&
      !Array.isArray(r) &&
      ["allow", "deny", "ask"].includes((r as PermissionRule).action),
  );
  return { rules, errors };
}

/// 把 glob 编译成正则：`*` 不跨 `/`、`**` 跨段、`?` 单字符；其余字符转义
export function globToRegExp(glob: string): RegExp {
  const src = glob.trim();
  let out = "^";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "*") {
      if (src[i + 1] === "*") {
        out += ".*";
        i++;
        // `**/` 允许匹配零层目录（如 ~/proj/**/a.ts 也要匹配 ~/proj/a.ts）
        if (src[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(out + "$");
}

/// 展开 `~`（同时保留原串，便于匹配「用户按原样写的路径」）
export function expandPathVariants(path: string, home: string): string[] {
  const out = new Set<string>([path]);
  if (path === "~") out.add(home);
  else if (path.startsWith("~/")) out.add(home.replace(/\/+$/, "") + path.slice(1));
  return [...out];
}

/// 单条规则是否命中
export function ruleMatches(rule: PermissionRule, call: ToolCallContext, home = ""): boolean {
  if (rule.enabled === false) return false;
  if (rule.tool && rule.tool !== call.tool) return false;
  if (rule.command !== undefined) {
    if (!call.command) return false;
    try {
      if (!new RegExp(rule.command).test(call.command)) return false;
    } catch {
      return false; // 非法正则视为不命中（validateRules 会另行提示）
    }
  }
  if (rule.path !== undefined) {
    if (!call.path) return false;
    // `~` 两侧都要展开：规则里写 `~/proj/**` 时，调用路径可能是 `~/proj/a.ts`
    // 也可能是展开后的绝对路径（反之亦然），任一形态命中即算命中。
    const patterns =
      rule.path.startsWith("~") && home ? expandPathVariants(rule.path, home) : [rule.path];
    let res: RegExp[];
    try {
      res = patterns.map((p) => globToRegExp(p.startsWith("~") || p.startsWith("/") ? p : `**/${p}`));
    } catch {
      return false;
    }
    const variants = home ? expandPathVariants(call.path, home) : [call.path];
    if (!res.some((re) => variants.some((v) => re.test(v)))) return false;
  }
  return true;
}

/// 规则描述（给用户/模型看：哪条规则、什么处置、什么理由）
export function describeRule(rule: PermissionRule, index: number): string {
  const id = rule.id ? `「${rule.id}」` : `#${index + 1}`;
  const cond: string[] = [];
  if (rule.tool) cond.push(`工具=${rule.tool}`);
  if (rule.command) cond.push(`命令匹配 /${rule.command}/`);
  if (rule.path) cond.push(`路径匹配 ${rule.path}`);
  const label = rule.action === "allow" ? "允许（免确认）" : rule.action === "deny" ? "禁止" : "必须确认";
  return `${id} ${label}${cond.length ? `（${cond.join("、")}）` : ""}${rule.reason ? ` —— ${rule.reason}` : ""}`;
}

/**
 * 求值：**有序、第一条命中即生效**。
 * 未命中任何规则 → `none`（交回原有的权限矩阵 / 审批模式处理）。
 */
export function evaluateRules(
  rules: PermissionRule[],
  call: ToolCallContext,
  home = "",
): RuleDecision {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!ruleMatches(rule, call, home)) continue;
    const what = describeRule(rule, i);
    if (rule.action === "deny") {
      return {
        decision: "deny",
        rule,
        index: i,
        message: `⛔ 已被权限规则拒绝：${what}。请改用其它方式，或在「设置 → 权限规则」中调整该条规则。`,
      };
    }
    if (rule.action === "ask") {
      return { decision: "ask", rule, index: i, message: `⚠️ 权限规则要求确认：${what}` };
    }
    return { decision: "allow", rule, index: i, message: `✅ 权限规则允许（免确认）：${what}` };
  }
  return { decision: "none", message: "" };
}

/** dry-run 一行结果 */
export interface DryRunRow {
  tool: string;
  detail: string;
  decision: RuleAction | "none";
  matched: string;
}

/**
 * dry-run：把规则表套到一批真实调用上（如最近的工具审计记录），
 * 用于**启用前先看清会拦住什么**（避免线上才发现规则写反了）。
 */
export function dryRun(
  rules: PermissionRule[],
  calls: ToolCallContext[],
  home = "",
): { rows: DryRunRow[]; counts: Record<RuleAction | "none", number> } {
  const counts: Record<RuleAction | "none", number> = { allow: 0, deny: 0, ask: 0, none: 0 };
  const rows = calls.map((c) => {
    const v = evaluateRules(rules, c, home);
    counts[v.decision]++;
    const detail = [c.tool, c.command ? `$ ${c.command}` : "", c.path ?? ""]
      .filter(Boolean)
      .join(" ");
    return {
      tool: c.tool,
      detail: detail.slice(0, 160),
      decision: v.decision,
      matched: v.decision === "none" ? "" : describeRule(v.rule, v.index),
    };
  });
  return { rows, counts };
}

/** 从工具审计行（`{tool_name, arguments}`）抽取调用上下文，供 dry-run 使用 */
export function contextsFromAudit(
  rows: { tool_name: string; arguments: string }[],
): ToolCallContext[] {
  return rows.map((r) => {
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(r.arguments || "{}");
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    } catch {
      /* 参数不是 JSON（老记录/文本）→ 只按工具名 dry-run */
    }
    const command = typeof args.command === "string" ? args.command : undefined;
    const path = typeof args.path === "string" ? args.path : undefined;
    return { tool: r.tool_name, command, path };
  });
}
