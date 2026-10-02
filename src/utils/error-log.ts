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

/** 取「失败原因」的可读文本：非 Error 时 String()，并带上可能附着的 Tauri 命令名 */
function describeReason(reason: unknown): string {
  const base = reason instanceof Error ? reason.message : String(reason ?? "未处理的 Promise 拒绝");
  const cmd = (reason as { __dsyCmd?: string } | undefined)?.__dsyCmd;
  return cmd ? `${base}（Tauri 命令：${cmd}）` : base;
}

/**
 * 给 Tauri `invoke` 包一层：失败时把**命令名**附到错误对象上。
 *
 * 为什么需要：WKWebView 里 IPC / fetch 失败的报错是 `TypeError: Load failed`，而且
 * **没有 stack**（实测：日志里每次启动固定 7 条，完全看不出是哪个命令）。
 * 「哪个调用失败了」这种最基本的定位信息不应该靠猜。
 * 只附加属性、不改错误类型与消息，避免影响既有 catch 逻辑对 message 的判断。
 */
function instrumentInvoke(): void {
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__?: {
        invoke?: (...a: unknown[]) => Promise<unknown>;
        __dsyWrapped?: boolean;
      };
    }
  ).__TAURI_INTERNALS__;
  if (!internals?.invoke || internals.__dsyWrapped) return;
  const raw = internals.invoke.bind(internals);
  internals.invoke = (cmd: unknown, args?: unknown, options?: unknown) =>
    Promise.resolve(raw(cmd as string, args, options)).catch((e: unknown) => {
      try {
        if (e && typeof e === "object") (e as { __dsyCmd?: string }).__dsyCmd = String(cmd);
      } catch {
        /* 冻结对象等：忽略，不干扰原错误 */
      }
      throw e;
    });
  internals.__dsyWrapped = true;
}

/** 安装全局错误监听（幂等）。应在应用挂载前调用以捕获初始化期错误。 */
export function installGlobalErrorLog(): void {
  if (installed) return;
  installed = true;
  instrumentInvoke();

  window.addEventListener("error", (e) => {
    const err = e.error;
    send(
      "uncaught",
      e.message || describeReason(err) || "未知错误",
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
}
