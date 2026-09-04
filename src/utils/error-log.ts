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

/** 安装全局错误监听（幂等）。应在应用挂载前调用以捕获初始化期错误。 */
export function installGlobalErrorLog(): void {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (e) => {
    const err = e.error;
    send(
      "uncaught",
      e.message || (err instanceof Error ? err.message : String(err ?? "未知错误")),
      err instanceof Error ? err.stack : undefined,
    );
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    send(
      "unhandledrejection",
      reason instanceof Error ? reason.message : String(reason ?? "未处理的 Promise 拒绝"),
      reason instanceof Error ? reason.stack : undefined,
    );
  });
}
