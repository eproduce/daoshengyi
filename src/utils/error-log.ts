import { invoke } from "@tauri-apps/api/core";

// 前端全局错误收集（本地优先）：
// window error / unhandledrejection → 复用 Rust `debug_log` 命令写入
// 应用数据目录 `daoshengyi.log`（本地落盘，不上报、不联网，仅供排查）。
// 非 Tauri 环境（浏览器预览）invoke 不可用 → 回退 console.error。

let installed = false;

function send(scope: string, message: string, stack?: string) {
  const line = stack
    ? `[${scope}] ${message}\n${stack.split("\n").slice(0, 12).join("\n")}`
    : `[${scope}] ${message}`;
  invoke("debug_log", { msg: line }).catch(() => {
    // 浏览器预览等无 Tauri 后端时：原样输出到控制台，避免静默
    console.error(line);
  });
}

/** 取「失败原因」的可读文本：非 Error 时 String() */
function describeReason(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason ?? "未处理的 Promise 拒绝");
}

/**
 * 安装全局错误监听（幂等）。应在应用挂载前调用以捕获初始化期错误。
 *
 * ⚠️ 这里**绝不能抛**：它在 `main.ts` 顶层执行，一旦抛错，Vue 应用根本不会挂载 ——
 * 表现就是**白屏**，而且连错误监听都没装上（日志里一点痕迹都没有），极难排查。
 * 所以整段包 try/catch。同理，不要在启动路径上给 Tauri 的 `__TAURI_INTERNALS__.invoke`
 * 之类内部对象打 monkey-patch：曾经为了在日志里附上失败的 Tauri 命令名而这么做过，
 * 直接导致白屏（2026-10-02），已移除。诊断能力再重要，也不能有弄坏启动的可能。
 */
export function installGlobalErrorLog(): void {
  if (installed) return;
  installed = true;
  try {
    window.addEventListener("error", (e) => {
      const err = e.error;
      send(
        "uncaught",
        e.message || describeReason(err),
        err instanceof Error ? err.stack : undefined,
      );
    });

    window.addEventListener("unhandledrejection", (e) => {
      const reason = e.reason;
      // 无 stack 的情况（WKWebView 的网络类失败很常见）显式标注，免得看起来像日志残缺
      const stack = reason instanceof Error ? reason.stack : undefined;
      send(
        "unhandledrejection",
        describeReason(reason),
        stack ?? "（该错误没有 stack——多为 WebView 网络/IPC 层失败）",
      );
    });
  } catch (e) {
    // 兜底：错误监听装不上也不能拦住启动（宁可少日志，不可白屏）
    console.error("[道生一] 全局错误监听安装失败:", e);
  }
}
