// 工具调用拦截点（pre-tool）：把「散落在主循环里的判定」收敛成**有序、可短路、可改写**的一条链。
//
// 为什么要有这层（对 DSH 的差距复盘，`docs/DSH_ARCHITECTURE_DEEPDIVE.md` §三）：
// 模式护栏、工具禁用、路径白名单、审批、审计、钩子……原先各自散在 `chat.ts` 的 7,900 行主循环
// 与 `callBuiltinTool`/`callMcpTool` 两个入口里，**每加一条就改主循环**，回归风险全靠人记。
// DSH 的答案是 waterfall 拦截点：不调 `next()` 即短路，参数与结果都可在链上被改写。
//
// 这一层的边界（故意很窄）：
// - **纯函数**：配置从参数进，不读全局设置 → 可单测、可回放；
// - **只做判定与改写**，不做副作用（审批弹窗、审计落库仍在调用方）；
// - 顺序固定（`order` 升序，同序保持注册顺序），**deny 立即短路**，rewrite 传给下一环。

/** 一次工具调用的入参（拦截点看到的全部） */
export interface ToolCallInput {
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

/** 拦截结果：放行 / 拒绝（带给人看的话）/ 改写参数后继续 */
export type ToolDecision =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "rewrite"; args: Record<string, unknown> };

/** 单个拦截器：拿到当前输入，返回决策（不抛异常是契约） */
export interface ToolInterceptor {
  /** 稳定的标识（日志/测试断言用） */
  id: string;
  /** 越小的先执行；同序按注册顺序 */
  order: number;
  run(input: ToolCallInput): ToolDecision;
}

export interface InterceptOutcome {
  /** 是否放行（deny 时为 false） */
  allowed: boolean;
  /** 最终参数（可能被链上改写） */
  args: Record<string, unknown>;
  /** deny 时给人/模型看的话 */
  message: string;
  /** 实际执行过的拦截器 id（按执行顺序；排查「谁拦的」） */
  applied: string[];
}

/**
 * 依次执行拦截器：**deny 立即短路**，`rewrite` 把新参数交给下一环。
 *
 * 不变量：
 * - 空链 → 放行（没有规则不该等于拦截）；
 * - 拦截器抛异常 → 视为放行并记录（安全侧的判定自己该保证不抛；这里不能让一次异常变成
 *   「整个工具系统静默不可用」，那是更严重的故障）；
 * - `args` 永远返回一个对象（便于调用方直接分发）。
 */
export function runPreTool(
  interceptors: readonly ToolInterceptor[],
  input: ToolCallInput,
): InterceptOutcome {
  const ordered = [...interceptors].sort((a, b) => a.order - b.order);
  let args = input.args;
  const applied: string[] = [];
  for (const it of ordered) {
    let decision: ToolDecision;
    try {
      decision = it.run({ ...input, args });
    } catch {
      applied.push(it.id);
      continue;
    }
    applied.push(it.id);
    if (decision.kind === "deny") {
      return { allowed: false, args, message: decision.message, applied };
    }
    if (decision.kind === "rewrite") {
      args = decision.args;
    }
  }
  return { allowed: true, args, message: "", applied };
}

// ── 内置拦截器（纯函数工厂：配置进、判定出）───────────────────────────────────

/** order 约定：数值越小越靠前。留出空档便于以后插队（10/20/30…） */
export const ORDER = {
  /** 工具级开关：最先拦（禁用的工具不该走到任何后续判定） */
  disabled: 10,
  /** 路径白名单：第二 */
  pathWhitelist: 20,
  /** 留给「审批 / 危险命令语义门禁」等更细的判定 */
  approval: 30,
} as const;

/**
 * 工具级开关（P-A7 权限矩阵）：`disabled` 支持精确名与 `前缀*` 通配。
 *
 * 与设置页「权限矩阵」的语义一致（那边由 `utils/permissions.ts` 判定，这里只复述结果形态）：
 * 拒绝话术保持原文，避免同一件事在两条路径给用户两种说法。
 */
export function disabledToolRule(disabled: readonly string[], isDisabled: (t: string) => boolean) {
  return {
    id: "disabled-tools",
    order: ORDER.disabled,
    run: ({ tool }: ToolCallInput): ToolDecision =>
      isDisabled(tool) || disabled.includes(tool)
        ? {
            kind: "deny",
            message: `⛔ 工具「${tool}」已在权限矩阵中禁用。请改用其它工具，或在「设置 → 权限」中重新启用。`,
          }
        : { kind: "allow" },
  } satisfies ToolInterceptor;
}

/**
 * 路径白名单（P-A7）：配置了白名单时，带路径参数的工具只能访问白名单目录。
 *
 * `pickPath` 由调用方注入（不同工具的参数名不同：`path` / `file_path` / `root` / `cwd`…），
 * 保证这层不重复维护一份参数名表（那份表在 `builtin-params.ts`，是单一真相）。
 */
export function pathWhitelistRule(
  allowedPaths: readonly string[],
  pickPath: (args: Record<string, unknown>) => string | undefined,
  isAllowed: (path: string, allowed: string[]) => boolean,
) {
  return {
    id: "path-whitelist",
    order: ORDER.pathWhitelist,
    run: ({ args }: ToolCallInput): ToolDecision => {
      if (allowedPaths.length === 0) return { kind: "allow" };
      const p = pickPath(args);
      if (!p) return { kind: "allow" };
      if (isAllowed(p, [...allowedPaths])) return { kind: "allow" };
      return {
        kind: "deny",
        message: `⛔ 路径「${p}」不在权限白名单内（允许：${allowedPaths.join("、")}）。请使用白名单内的路径。`,
      };
    },
  } satisfies ToolInterceptor;
}

// ── 反向不变量：**发给模型的历史**里不许有 UI 卡片 ────────────────────────────
//
// 2026-11-10 起新写入的正文已经不含卡片（见 `composeAssistantContent`），但**老会话**
// （库里 content 还带 `### 🔧 调用工具` + `<details>`）继续对话时，历史仍会被原样发给模型 →
// 模型照样能模仿。所以请求装配处必须再洗一次：显示层早就这么做了，模型侧没做。
//
// 为什么放在这里而不是 chat.ts 内联：它是**纯函数**，能被单测钉住；主循环只调用一次。

/**
 * 历史消息 → 模型可见正文。
 * - assistant：剥掉**开头连续**的机器卡片（只剥开头，正文里同形文字不动）；
 *   剥完为空但有工具记录时给一句如实的占位（空 assistant 消息对上游 API 不安全）。
 * - 其它角色：原样返回（用户可能真的在问「怎么写这种卡片」）。
 */
export function modelVisibleContent(
  msg: { role: string; content: string; tools?: readonly unknown[] | undefined },
  stripLeadingCards: (content: string) => string,
): string {
  if (msg.role !== "assistant") return msg.content;
  const body = stripLeadingCards(msg.content || "").trim();
  if (body) return body;
  if ((msg.tools?.length ?? 0) > 0) return "（本轮执行了工具，未给出文字结论）";
  return "";
}

// ── 工具结果的后处理链（post-tool）────────────────────────────────────────────
//
// 同样的病：结果后处理原来也有两份实现 —— 原生 tool_calls 走 `foldToolResult`
// （脱敏 → 内容感知压缩 → 阈值 → 落盘 + 首尾保留），而**文本工具路径与子代理**走
// `truncateToolResult`（只脱敏 + 硬截断）：压缩没做（上下文白白变大）、中间内容直接丢。
// 现在统一成一条链，两个调用面都走它。

/** 后处理规则的副作用说明：`notes` 会拼进结果末尾（让模型知道「你看到的是压缩视图」） */
export interface PostToolRule {
  id: string;
  order: number;
  run(text: string, ctx: { tool: string }): { text: string; notes: string[] };
}

export interface PostToolOutcome {
  text: string;
  notes: string[];
  applied: string[];
}

/**
 * 依次跑后处理规则。与 pre-tool 不同：**不短路**（每一步都是对文本的变换，全都要生效），
 * 单条规则抛异常则跳过它并继续（不能因为一条脱敏规则崩了就把工具结果吞掉）。
 */
export function runPostTool(
  rules: readonly PostToolRule[],
  ctx: { tool: string },
  text: string,
): PostToolOutcome {
  const ordered = [...rules].sort((a, b) => a.order - b.order);
  let out = text;
  const notes: string[] = [];
  const applied: string[] = [];
  for (const r of ordered) {
    try {
      const res = r.run(out, ctx);
      out = res.text;
      notes.push(...res.notes);
      applied.push(r.id);
    } catch {
      applied.push(`${r.id}(skipped)`);
    }
  }
  return { text: out, notes, applied };
}

export const POST_ORDER = {
  /** 脱敏必须最先：后面任何一步都可能把密钥写进日志/落盘 */
  redact: 10,
  /** 压缩/折叠 */
  reduce: 20,
} as const;

/** 脱敏规则（`redactSecrets` 由调用方注入，保持本模块零依赖） */
export function secretRedactRule(redact: (t: string) => { text: string; kinds: string[] }) {
  return {
    id: "secret-redact",
    order: POST_ORDER.redact,
    run: (text: string) => {
      const r = redact(text);
      return {
        text: r.text,
        // 只说「脱敏了几个」，不说是哪种密钥（避免把类型名当提示泄回去）
        notes: r.kinds.length ? [`已脱敏 ${r.kinds.length} 类敏感信息`] : [],
      };
    },
  } satisfies PostToolRule;
}

/** 内容感知压缩规则（`reduceToolResult` 由调用方注入） */
export function contentReduceRule(
  reduce: (tool: string, text: string) => { text: string; notes: string[] },
) {
  return {
    id: "content-reduce",
    order: POST_ORDER.reduce,
    run: (text: string, ctx: { tool: string }) => {
      const r = reduce(ctx.tool, text);
      return { text: r.text, notes: r.notes };
    },
  } satisfies PostToolRule;
}
