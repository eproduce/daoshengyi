// 事件监听注册（带重试）：启动期 IPC 未就绪时的兜底（P1-13，2026-10-02）
//
// 实证（2026-10-02，应用每次启动都会出现）：
//   `[unhandledrejection] Load failed` —— 无 stack，抓到的最近活动全是
//   `POST ipc://localhost/plugin:event|listen`、`ipc://localhost/debug_log` 这类
//   **Tauri IPC 调用**（不是普通网络请求）。窗口刚创建时 IPC 有一小段「未就绪」窗口：
//   此时 `listen()` 会以 `TypeError: Load failed` 失败，或者干脆**永不 settle**。
//
// 后果比日志噪音严重得多：`listen` 失败 = 该事件监听**根本没注册**——
//   菜单栏项（menu://action）、IM 配对请求（im-pair-request）、Ollama 部署完成
//   （ollama-configured）都会在本会话里静默失效，直到重启应用。
//
// 所以：注册失败要重试（退避几次），彻底失败要**留下可见日志**，绝不静默。

import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";

/** 注册函数类型：`listen` 本身是泛型函数，注入时也要保持泛型（否则无法 `register<T>` 调用） */
export type RegisterFn = <U>(event: string, handler: EventCallback<U>) => Promise<UnlistenFn>;

export interface ListenRetryOptions {
  /** 最多尝试次数（含首次）。默认 6 次（约覆盖 2s 的 IPC 未就绪窗口） */
  attempts?: number;
  /** 退避基数（毫秒）。默认 300，按 attempt 线性增长 */
  delayMs?: number;
  /** 注入用：注册函数（单测替换） */
  register?: RegisterFn;
  /** 注入用：等待函数（单测替换，避免真睡） */
  wait?: (ms: number) => Promise<void>;
  /** 彻底失败时的回调（默认打日志） */
  onFail?: (event: string, err: unknown, attempts: number) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 事件名 → 是否属于「启动期必须注册上」的关键监听（用于失败时给出更明确的日志） */
const CRITICAL_PREFIX = ["menu://", "im-", "ollama-"];

export function isCriticalEvent(event: string): boolean {
  return CRITICAL_PREFIX.some((p) => event.startsWith(p));
}

/**
 * 注册事件监听，失败则退避重试；返回 unlisten（彻底失败返回 null）。
 * **永不抛**：调用方在 `main.ts` 顶层使用，抛错会变成未处理拒绝（历史上就是这样）。
 */
export async function listenWithRetry<T = unknown>(
  event: string,
  handler: EventCallback<T>,
  opts: ListenRetryOptions = {},
): Promise<UnlistenFn | null> {
  const attempts = Math.max(1, opts.attempts ?? 6);
  const delayMs = Math.max(0, opts.delayMs ?? 300);
  const wait = opts.wait ?? sleep;
  const register: RegisterFn = opts.register ?? (listen as unknown as RegisterFn);
  let lastErr: unknown = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await register<T>(event, handler);
    } catch (err) {
      lastErr = err;
      if (i < attempts) await wait(delayMs * i);
    }
  }
  if (opts.onFail) opts.onFail(event, lastErr, attempts);
  else {
    console.warn(
      `[listen] 注册事件监听失败（${event}，已重试 ${attempts} 次）` +
        `${isCriticalEvent(event) ? " —— 该功能本会话不可用" : ""}: ` +
        `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }
  return null;
}
