// run_code 的执行沙箱：模型写的 JS **只在这里跑**。
//
// 为什么必须是 Worker（而不是主线程 eval / new Function）：
//   ① 可以被 `terminate()` 真正掐断——死循环、卡住的 Promise 都能立刻止住；
//      主线程 eval 一旦跑飞，整个应用就卡死了，连超时都救不回来。
//   ② 没有 DOM、没有 window，拿不到页面上的任何东西。
//   ③ 拿不到 Tauri 的 IPC——`invoke` 由主文档注入（`window.__TAURI_INTERNALS__`），
//      Worker 作用域里根本不存在，所以模型代码**无法绕过工具管线直接调用任何命令**。
//
// 能力只有一条出路：`tools.xxx(...)` → postMessage 回主线程 → 走既有工具管线
//（权限矩阵 / 模式白名单 / 危险命令审批 / 审计），结果再回传。
//
// 仍然要主动屏蔽几个全局：Worker 里 `fetch` / `XMLHttpRequest` / `WebSocket`
// 是真实存在的，而页面 CSP 的 `connect-src https:` 并不会替我们拦住 Worker 的请求
// ——「不让模型代码无声上网」只能靠显式清空 + 工具桥内的显式审计。

import { classifyCodeError, errorParts, formatRunValue } from "./code-format";

/** Worker 侧只用到这几个全局方法，用最小接口避免依赖 DOM lib 的 Window 类型 */
const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage: (msg: unknown) => void;
  close: () => void;
};

interface ToolCallMsg {
  type: "tool-call";
  id: number;
  name: string;
  args: unknown;
}
interface ToolResultMsg {
  type: "tool-result";
  id: number;
  ok: boolean;
  value?: string;
  error?: string;
}
interface RunMsg {
  type: "run";
  code: string;
}

/// 被禁用的全局：模型代码若下意识用了它们，会得到 `undefined` →
/// 报「xx is not a function」，再由 classifyCodeError 翻成人话。
const BLOCKED_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "importScripts",
  "indexedDB",
  "caches",
  "navigator",
];
for (const name of BLOCKED_GLOBALS) {
  try {
    (globalThis as unknown as Record<string, unknown>)[name] = undefined;
  } catch {
    /* 个别环境下属性只读，忽略（后面的工具桥仍然是唯一出口） */
  }
}

/** 等待中的工具调用：id → 结算函数 */
const pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();
let seq = 0;

/// 工具桥：`tools.calc({...})` 会挂起当前执行、把请求发回主线程，等结果回来再继续。
/// 返回 Promise 是刻意的——主线程那边要跑权限校验/审批，本质是异步的。
function makeTools(): Record<string, (args?: unknown) => Promise<string>> {
  const target = Object.create(null) as Record<string, (args?: unknown) => Promise<string>>;
  return new Proxy(target, {
    get: (_t, prop) => {
      if (typeof prop !== "string") return undefined;
      // 防 thenable 陷阱：若 `tools` 被 await，引擎会读 `then`——
      // 返回一个函数会让 await 永远挂起。这里必须返回 undefined。
      if (prop === "then" || prop === "constructor") return undefined;
      return (args?: unknown) =>
        new Promise<string>((resolve, reject) => {
          const id = ++seq;
          pending.set(id, { resolve, reject });
          const msg: ToolCallMsg = { type: "tool-call", id, name: prop, args: args ?? {} };
          scope.postMessage(msg);
        });
    },
  });
}

function postLog(line: string): void {
  scope.postMessage({ type: "log", line });
}

/// 把 console 接到主线程（模型常用 console.log 看中间结果）。
/// 用 Proxy 兜住任意方法名，未知方法按普通输出处理，不抛错。
function makeConsole(): Record<string, (...args: unknown[]) => void> {
  const emit =
    (level: string) =>
    (...args: unknown[]) => {
      const text = args.map((a) => (typeof a === "string" ? a : formatRunValue(a))).join(" ");
      postLog(level === "log" ? text : `[${level}] ${text}`);
    };
  return new Proxy(Object.create(null) as Record<string, (...a: unknown[]) => void>, {
    get: (_t, prop) => (typeof prop === "string" ? emit(prop) : undefined),
  });
}

/// 用 AsyncFunction 而不是 (0, eval)：模型代码整体当成 **async 函数体**，
/// 因此可以直接 `await`、用 `return` 交出结果——这是最好解释、也最不容易写错的契约。
const AsyncFunction = Object.getPrototypeOf(async function () {
  /* 仅用于取构造函数 */
}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

async function execute(code: string): Promise<void> {
  try {
    const fn = new AsyncFunction("tools", "console", code);
    const value = await fn(makeTools(), makeConsole());
    scope.postMessage({ type: "done", output: formatRunValue(value) });
  } catch (err) {
    const { name, message } = errorParts(err);
    scope.postMessage({ type: "error", name, message: classifyCodeError(name, message) });
  }
}

scope.onmessage = (e: MessageEvent) => {
  const msg = e.data as RunMsg | ToolResultMsg | undefined;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "tool-result") {
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.ok) waiter.resolve(msg.value ?? "");
    else waiter.reject(new Error(msg.error || "工具调用失败"));
    return;
  }
  if (msg.type === "run") {
    // 单个 Worker 只服务一次执行：跑完由主线程 terminate，不做复用，
    // 避免「上一次执行的全局污染影响到下一次」这类难查的问题。
    void execute(msg.code);
  }
};
