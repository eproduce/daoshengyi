// 「最近网络活动」环形缓冲（P1-12，2026-10-02）
//
// 起因：应用每次启动都会在日志里留下若干条
//   `[unhandledrejection] Load failed（该错误没有 stack——多为 WebView 网络/IPC 层失败）`
// 无 stack、无 URL，排查只能靠猜（历史上已经反复出现却没定位）。
//
// 做法：**只旁观、绝不改行为**地记录 fetch 的「尝试」与「结果」到一个小环形缓冲；
// 全局错误处理遇到无 stack 的 rejection 时，把最近的活动一并写进日志 —— 于是：
//   · 若失败前后恰好有一批 fetch 尝试 → 直接看到是谁失败了（URL + 错误）
//   · 若一条 fetch 都没有 → 可判定问题不在 fetch（而是 Tauri IPC 等其它层）
//
// 安全约束（与 error-log.ts 同一原则）：
//   ① 安装时机在**应用挂载之后**（不进启动关键路径）；
//   ② 包装函数里任何异常都被吞掉，调用方拿到的一律是**原 promise**；
//   ③ 不修改 input/init、不读 body、不改响应。

export interface NetActivity {
  at: number;
  method: string;
  url: string;
  /** null = 尚未结束；数字 = HTTP 状态；-1 = 请求失败（网络层） */
  status: number | null;
  err?: string;
}

const MAX = 30;
const ring: NetActivity[] = [];
let installed = false;

function push(a: NetActivity): NetActivity {
  if (ring.length >= MAX) ring.shift();
  ring.push(a);
  return a;
}

/** 记录一次请求尝试（测试可直接调用）。返回条目本身当句柄 —— 结算时直接改这一条。 */
export function noteNetAttempt(method: string, url: string): NetActivity {
  return push({ at: Date.now(), method, url: url.slice(0, 200), status: null });
}

/**
 * 结算某条尝试（status: HTTP 状态码 / -1 = 失败）。
 * ⚠️ 必须靠**句柄**结算，不能靠 URL 匹配：启动期会有大量同名 IPC 调用（连续的
 * `debug_log`），按 URL 找会把更早那条误标成失败 —— 我第一版就这样，日志里全成了
 * 「进行中」，看不出谁真失败（2026-10-02）。
 */
export function settleNetAttempt(
  entry: NetActivity | undefined,
  status: number,
  err?: unknown,
): void {
  if (!entry) return;
  entry.status = status;
  if (err != null) {
    entry.err = (err instanceof Error ? err.message : String(err)).slice(0, 160);
  }
}

/** 记录一次失败（没拿到尝试句柄时的兼容入口，测试也用它） */
export function noteNetFailure(method: string, url: string, err: unknown): NetActivity {
  const e = err instanceof Error ? err.message : String(err ?? "失败");
  // 从**最新**往前找同名未结算条目（旧的同名条目属于更早的调用，不能误标）
  for (let i = ring.length - 1; i >= 0; i--) {
    const a = ring[i];
    if (a.status === null && a.url === url.slice(0, 200)) {
      a.status = -1;
      a.err = e.slice(0, 160);
      return a;
    }
  }
  return push({
    at: Date.now(),
    method,
    url: url.slice(0, 200),
    status: -1,
    err: e.slice(0, 160),
  });
}

/** `ipc://localhost/get_messages` → `ipc:get_messages`（读日志时一眼认出是哪种调用） */
function shortUrl(url: string): string {
  const m = /^ipc:\/\/localhost\/(.*)$/.exec(url);
  if (!m) return url;
  try {
    return `ipc:${decodeURIComponent(m[1])}`;
  } catch {
    return `ipc:${m[1]}`;
  }
}

/**
 * 最近网络活动摘要：**失败/异常的排前面**（它们才是排查对象），
 * 其余按时间正序补充上下文。IPC 调用显示成 `ipc:命令名`。
 */
export function recentNetActivity(n = 6): string[] {
  const fmt = (a: NetActivity) => {
    const st =
      a.status === null ? "未完成" : a.status === -1 ? `失败: ${a.err ?? "?"}` : `HTTP ${a.status}`;
    return `${a.method} ${shortUrl(a.url)} → ${st}`;
  };
  const bad = ring.filter((a) => a.status === -1);
  const good = ring.filter((a) => a.status !== -1);
  const merged = [...bad, ...good];
  const tail = merged.slice(Math.max(0, merged.length - n));
  // 展示时按时间正序（先失败、后其它），读起来是「这批发什么了」的顺序
  const badShown = tail.filter((a) => a.status === -1);
  const goodShown = tail.filter((a) => a.status !== -1);
  return [...badShown, ...goodShown].map(fmt);
}

/** 是否有过网络活动（判定「这批错误跟 fetch 有没有关系」用） */
export function netActivityCount(): number {
  return ring.length;
}

/** 清空（测试用） */
export function resetNetActivity(): void {
  ring.length = 0;
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  const u = (input as { url?: unknown })?.url;
  return typeof u === "string" ? u : String(input ?? "");
}

function methodOf(input: unknown, init?: unknown): string {
  const m = (init as { method?: unknown })?.method ?? (input as { method?: unknown })?.method;
  return typeof m === "string" && m ? m.toUpperCase() : "GET";
}

/**
 * 安装 fetch 旁观器（幂等）。**应在应用挂载后**调用。
 * 返回是否安装成功（浏览器预览 / 无 fetch 时返回 false）。
 */
export function installNetObserver(): boolean {
  if (installed) return true;
  try {
    if (typeof window === "undefined" || typeof window.fetch !== "function") return false;
    const orig = window.fetch;
    const patched = function (input: RequestInfo | URL, init?: RequestInit) {
      let url = "";
      let method = "GET";
      try {
        url = urlOf(input);
        method = methodOf(input, init);
      } catch {
        /* 取 URL 失败也照常放行 */
      }
      const p = orig.call(window, input as RequestInfo, init);
      try {
        const entry = url ? noteNetAttempt(method, url) : undefined;
        p.then(
          (resp) => {
            try {
              settleNetAttempt(entry, resp.status);
            } catch {
              /* 忽略 */
            }
          },
          (err) => {
            try {
              settleNetAttempt(entry, -1, err);
            } catch {
              /* 忽略 */
            }
          },
        );
      } catch {
        /* 旁观失败绝不影响请求本身 */
      }
      return p;
    };
    window.fetch = patched as typeof window.fetch;
    installed = true;
    return true;
  } catch {
    return false;
  }
}
