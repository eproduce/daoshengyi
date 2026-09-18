// run_code（code-mode）主线程侧：建 Worker、接工具桥、超时兜底、结果组装。
//
// 三条硬约束（都是"宁可明确失败，也不要静默降级"的体现）：
//   ① 绝不退回主线程 eval——沙箱可终止是这项能力的前提；
//   ② 超时/停止一定 `terminate()`，不留后台残留；
//   ③ 工具调用次数、输出长度、日志行数都有上限，且**超限要如实报告**（不静默丢）。

import { MAX_LOG_LINES, capText } from "./code-format";

/** 单次 run_code 的执行上限（超时即强杀 Worker） */
export const CODE_RUN_TIMEOUT_MS = 30_000;
/** 单次 run_code 允许的工具调用次数（防「用代码把工具调成风暴」） */
export const MAX_TOOL_CALLS_PER_RUN = 20;

/** Worker 的最小接口（便于测试注入假实现） */
export interface WorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror?: ((e: unknown) => void) | null;
}

export interface CodeToolCallLog {
  name: string;
  /** 参数摘要（截断，仅供展示/审计阅读） */
  args: string;
}

export interface CodeRunResult {
  ok: boolean;
  /** 代码 `return` 的值（已截断） */
  output: string;
  /** console 输出（超上限时如实标注丢了多少行） */
  logs: string[];
  /** 本次执行发生过的工具调用 */
  toolCalls: CodeToolCallLog[];
  /** 失败原因（人话，已归类） */
  error?: string;
  timedOut: boolean;
  /** 是否因超时被外部停止（用户点停止） */
  aborted: boolean;
  durationMs: number;
}

export interface RunCodeOptions {
  code: string;
  /** 工具桥：由调用方接到既有管线（权限矩阵/模式白名单/危险审批/审计） */
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  timeoutMs?: number;
  maxToolCalls?: number;
  /** 外部停止（用户点"停止"时 terminate，不让它跑满 30 秒） */
  signal?: AbortSignal;
  /** Worker 工厂（测试注入用；默认走同源 module worker） */
  createWorker?: () => WorkerLike;
}

/// 默认工厂：同源 **module** Worker。
/// 三个刻意的选择（都有实测依据）：
///   ① **不用 Blob URL**——应用 CSP 是 `script-src 'self'`，`blob:` 会被直接拦掉；
///   ② **必须是 module worker**（`worker.format: "es"` + `type: "module"`）——
///      Worker 里引用了 `code-format` 的共享实现，而 *classic* worker 不能有 import：
///      实测 classic 模式下 **dev 直接崩**（Vite 只做 TS 转译不打平 import → 浏览器报
///      `Cannot use import statement outside a module`），而 build 恰好因为是打包好的
///      IIFE 而看起来正常——「dev 坏、生产好」的假象最危险，所以两边统一成 module；
///   ③ 不共享实现而各写一份的话，共享逻辑的分叉会发生在最难被测到的出错路径上。
function defaultCreateWorker(): WorkerLike {
  return new Worker(new URL("./run-code.worker.ts", import.meta.url), {
    type: "module",
    name: "daoshengyi-run-code",
  }) as unknown as WorkerLike;
}

/// 把 Worker 抛出的东西变成能读的消息。
/// Worker 的 `onerror` 给的是 **ErrorEvent**（不是 Error），直接 String() 只会得到
/// `[object ErrorEvent]`——实测这个"消息"让人完全无法定位问题（比如真正的报错是
/// `Cannot use import statement outside a module`）。这里把 message/filename/lineno
/// 与内层 error 都取出来。
export function describeWorkerError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; filename?: unknown; lineno?: unknown; error?: unknown };
    const inner = e.error instanceof Error ? e.error.message : undefined;
    const text =
      (typeof e.message === "string" && e.message) || inner || JSON.stringify(err) || String(err);
    const where =
      typeof e.filename === "string" && e.filename
        ? `（${e.filename}${typeof e.lineno === "number" && e.lineno ? `:${e.lineno}` : ""}）`
        : "";
    return `${text}${where}`;
  }
  return String(err);
}

function summarizeArgs(args: unknown): string {
  let text: string;
  try {
    text = typeof args === "string" ? args : JSON.stringify(args ?? {});
  } catch {
    text = String(args);
  }
  return text && text.length > 200 ? `${text.slice(0, 200)}…` : (text ?? "{}");
}

/// 执行一段模型写的 JS。**任何情况下都会结算并 terminate Worker**（不会挂着）。
export async function runCodeInWorker(opts: RunCodeOptions): Promise<CodeRunResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? CODE_RUN_TIMEOUT_MS;
  const maxToolCalls = opts.maxToolCalls ?? MAX_TOOL_CALLS_PER_RUN;
  const createWorker = opts.createWorker ?? defaultCreateWorker;

  let worker: WorkerLike;
  try {
    worker = createWorker();
  } catch (err) {
    return {
      ok: false,
      output: "",
      logs: [],
      toolCalls: [],
      error: `无法创建沙箱 Worker（${describeWorkerError(err)}）。代码执行需要支持 Web Worker 的环境。`,
      timedOut: false,
      aborted: false,
      durationMs: Date.now() - started,
    };
  }

  return await new Promise<CodeRunResult>((resolve) => {
    const logs: string[] = [];
    const toolCalls: CodeToolCallLog[] = [];
    let logOverflow = 0;
    let settled = false;
    let toolOverflow = 0;

    const finish = (r: Omit<CodeRunResult, "durationMs" | "toolCalls" | "logs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      try {
        worker.terminate();
      } catch {
        /* 已退出 */
      }
      if (logOverflow > 0) logs.push(`…（另有 ${logOverflow} 行日志未显示，已超每行上限）`);
      if (toolOverflow > 0)
        toolCalls.push({ name: `（另有 ${toolOverflow} 次调用被拒）`, args: "{}" });
      resolve({ ...r, logs, toolCalls, durationMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        output: "",
        error: `执行超时（${Math.round(timeoutMs / 1000)} 秒）已被强制终止。请缩小数据量、减少循环，或先验证关键片段。`,
        timedOut: true,
        aborted: false,
      });
    }, timeoutMs);

    const onAbort = () => {
      finish({
        ok: false,
        output: "",
        error: "执行已被用户停止。",
        timedOut: false,
        aborted: true,
      });
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort);
    }

    worker.onmessage = (e: { data: unknown }) => {
      const msg = e.data as
        | { type: "log"; line: string }
        | { type: "done"; output: string }
        | { type: "error"; name: string; message: string }
        | { type: "tool-call"; id: number; name: string; args: unknown }
        | undefined;
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "log") {
        if (logs.length < MAX_LOG_LINES) logs.push(msg.line);
        else logOverflow += 1;
        return;
      }

      if (msg.type === "done") {
        finish({ ok: true, output: capText(msg.output ?? ""), timedOut: false, aborted: false });
        return;
      }

      if (msg.type === "error") {
        finish({ ok: false, output: "", error: msg.message, timedOut: false, aborted: false });
        return;
      }

      if (msg.type === "tool-call") {
        void handleToolCall(msg);
      }
    };

    worker.onerror = (err: unknown) => {
      finish({
        ok: false,
        output: "",
        error: `沙箱执行异常：${describeWorkerError(err)}`,
        timedOut: false,
        aborted: false,
      });
    };

    async function handleToolCall(msg: { id: number; name: string; args: unknown }): Promise<void> {
      const reply = (payload: { ok: boolean; value?: string; error?: string }) => {
        try {
          worker.postMessage({ type: "tool-result", id: msg.id, ...payload });
        } catch {
          /* Worker 已被终止：无需回复 */
        }
      };
      if (settled) return;
      if (toolCalls.length >= maxToolCalls) {
        toolOverflow += 1;
        reply({
          ok: false,
          error: `工具调用次数已达上限（${maxToolCalls} 次）。请减少调用，或把多次调用合并成一次批量操作。`,
        });
        return;
      }
      const args = (msg.args && typeof msg.args === "object" ? msg.args : {}) as Record<
        string,
        unknown
      >;
      toolCalls.push({ name: msg.name, args: summarizeArgs(args) });
      try {
        const value = await opts.callTool(msg.name, args);
        if (settled) return;
        reply({ ok: true, value: capText(String(value ?? "")) });
      } catch (err) {
        if (settled) return;
        reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    try {
      worker.postMessage({ type: "run", code: opts.code });
    } catch (err) {
      finish({
        ok: false,
        output: "",
        error: `无法启动沙箱执行：${describeWorkerError(err)}`,
        timedOut: false,
        aborted: false,
      });
    }
  });
}

/// 把执行结果组装成回填给模型的文本（工具结果）。
/// 成功/超时/失败三条路径都给出**可执行的下一步**，而不是只说一句"失败"。
export function formatCodeRunResult(r: CodeRunResult): string {
  const head = `【代码执行结果】${r.ok ? "✅ 成功" : r.timedOut ? "⏱ 超时终止" : r.aborted ? "⏹ 已停止" : "❌ 失败"}（耗时 ${(r.durationMs / 1000).toFixed(1)}s）`;
  const parts: string[] = [head];
  if (r.toolCalls.length) {
    const names = r.toolCalls.map((c) => c.name).join(", ");
    parts.push(`工具调用 ${r.toolCalls.length} 次：${names}`);
  }
  if (r.logs.length) parts.push(`console 输出：\n${r.logs.join("\n")}`);
  if (r.ok) {
    parts.push(`返回值：\n${r.output === "" ? "（无返回值）" : r.output}`);
  } else {
    if (r.output) parts.push(`已产生的输出：\n${r.output}`);
    parts.push(`错误：${r.error ?? "未知错误"}`);
  }
  return parts.join("\n\n");
}
