// run_code（code-mode）的纯逻辑：值格式化 / 文本截断 / 错误归类。
//
// 刻意写成**不依赖任何浏览器全局**的模块，让 Worker 与主线程共用同一份实现——
// 各写一份迟早会悄悄分叉（本项目已被这类分叉咬过多次），而分叉出来的行为
// 恰恰发生在「出错路径」上，最难被测到。

/** 单次 run_code 回填给模型的最大字符数（超出截断并注明原文长度） */
export const MAX_OUTPUT_CHARS = 8000;
/** 单次 run_code 捕获的 console 行数上限（超出只报数量，不静默丢弃） */
export const MAX_LOG_LINES = 50;

/** 截断长文本并明确告知被截断（绝不静默丢内容） */
export function capText(s: string, max: number = MAX_OUTPUT_CHARS): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（已截断，原文共 ${s.length} 字符）`;
}

/// 兜底序列化：JSON.stringify 遇到循环引用会直接抛错，
/// 这里按「祖先链」判定循环（用祖先集合而非全局集合，`[a, a]` 这种
/// 同一对象出现两次的合法结构不会被误标成循环引用）。
function walkToString(v: unknown, depth: number, seen: Set<object>): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v !== "object") return String(v);
  if (depth <= 0) return Array.isArray(v) ? "[…]" : "{…}";
  const obj = v as object;
  if (seen.has(obj)) return "[循环引用]";
  seen.add(obj);
  let out: string;
  if (Array.isArray(v)) {
    out = `[${v.map((x) => walkToString(x, depth - 1, seen)).join(", ")}]`;
  } else {
    const entries = Object.entries(v as Record<string, unknown>).map(
      ([k, val]) => `${k}: ${walkToString(val, depth - 1, seen)}`,
    );
    out = `{${entries.join(", ")}}`;
  }
  seen.delete(obj);
  return out;
}

/** 把模型代码的返回值变成可读文本（对象走 JSON；循环引用不炸、如实标注） */
export function formatRunValue(v: unknown): string {
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v;
  if (v === null) return "null";
  if (typeof v !== "object") return String(v);
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return walkToString(v, 4, new Set<object>());
  }
}

/** 把未知异常规整成 {name, message}（跨 Worker 只能传字符串） */
export function errorParts(err: unknown): { name: string; message: string } {
  if (err instanceof Error)
    return { name: err.name || "Error", message: err.message || String(err) };
  if (typeof err === "object" && err !== null) {
    const o = err as { name?: unknown; message?: unknown };
    return {
      name: typeof o.name === "string" ? o.name : "Error",
      message: typeof o.message === "string" ? o.message : JSON.stringify(err),
    };
  }
  return { name: "Error", message: String(err) };
}

/// 错误归类：把 JS 引擎的报错翻成「模型能据此改对」的提示。
/// 实测价值最高的两类：模型拿 Python/shell 当 JS 写（SyntaxError）、
/// 以及下意识调用被禁用的能力（没有 window/document/fetch）。
export function classifyCodeError(name: string, message: string): string {
  const raw = `${name}: ${message}`;
  switch (name) {
    case "SyntaxError":
      return (
        `语法错误（${message}）。\n` +
        "- 本工具只接受 **JavaScript**：写 Python（`def`/`import`/缩进块）或 shell 会直接语法错误；" +
        "需要跑环境命令请改用 `run_command`。\n" +
        "- 常见原因：括号/引号未闭合、把 Python 语法（如 `print x`、`x = 1 if y else 2` 之外的 `elif`）写进来。"
      );
    case "ReferenceError":
      return (
        `引用了不存在的变量（${message}）。\n` +
        "- 沙箱里**没有** `window` / `document` / `process` / `require`；也没有 Node 的 `fs`、`fetch`、`XMLHttpRequest`。\n" +
        "- 需要读写文件或访问网络，请通过工具桥：`await tools.write_file({...})`、`await tools.fetch_page({...})`。"
      );
    case "TypeError":
      if (/is not a function/.test(message)) {
        return (
          `调用失败（${message}）。\n` +
          "- 若是 `fetch` / `XMLHttpRequest` / `importScripts`：这些能力在沙箱里被**显式禁用**（要联网请用 `tools.fetch_page`）。\n" +
          "- 若是 `tools.xxx`：该工具名不存在或不在本次允许范围内，请核对工具名与参数。"
        );
      }
      return `类型错误（${message}）。`;
    case "RangeError":
      return `取值范围错误（${message}）。常见于无限递归或数组长度过大。`;
    default:
      // name 就是 "Error" 时不加前缀（否则会变成 "Error: 工具被拒绝" 这种噪音）
      return name === "Error" ? message : raw;
  }
}
