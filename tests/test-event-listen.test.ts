// 事件监听重试单测：启动期 IPC 未就绪（Load failed / 永久挂起）必须能自愈，且绝不抛
import { describe, it, expect } from "vitest";
import { listenWithRetry, isCriticalEvent } from "../src/utils/event-listen";

/** 造一个「前 n 次失败，之后成功」的注册函数 */
function flaky(n: number) {
  let calls = 0;
  const fn = (async () => {
    calls++;
    if (calls <= n) throw new TypeError("Load failed");
    return () => {};
  }) as unknown;
  return { fn, calls: () => calls };
}

const noop = () => {};

describe("listenWithRetry", () => {
  it("首次就成功：只调用一次", async () => {
    const { fn, calls } = flaky(0);
    const un = await listenWithRetry("menu://action", noop, {
      register: fn as never,
      wait: async () => {},
    });
    expect(typeof un).toBe("function");
    expect(calls()).toBe(1);
  });

  it("启动期 IPC 未就绪（前几次 Load failed）→ 重试成功，监听不丢", async () => {
    const { fn, calls } = flaky(3);
    const un = await listenWithRetry("im-pair-request", noop, {
      attempts: 6,
      register: fn as never,
      wait: async () => {},
    });
    expect(typeof un).toBe("function");
    expect(calls()).toBe(4);
  });

  it("一直失败 → 返回 null 且**不抛**（顶层使用，抛了会变成未处理拒绝）", async () => {
    const { fn, calls } = flaky(99);
    let failed: { event: string; attempts: number } | null = null;
    const un = await listenWithRetry("menu://action", noop, {
      attempts: 4,
      register: fn as never,
      wait: async () => {},
      onFail: (event, _err, attempts) => {
        failed = { event, attempts };
      },
    });
    expect(un).toBeNull();
    expect(calls()).toBe(4);
    expect(failed).toEqual({ event: "menu://action", attempts: 4 });
  });

  it("退避等待被调用 attempts-1 次（最后一次不再等）", async () => {
    const { fn } = flaky(99);
    let waits = 0;
    await listenWithRetry("x", noop, {
      attempts: 3,
      delayMs: 10,
      register: fn as never,
      wait: async () => {
        waits++;
      },
    });
    expect(waits).toBe(2);
  });
});

describe("isCriticalEvent", () => {
  it("菜单/IM/Ollama 事件算关键（失败要在日志里点名）」", () => {
    expect(isCriticalEvent("menu://action")).toBe(true);
    expect(isCriticalEvent("im-pair-request")).toBe(true);
    expect(isCriticalEvent("ollama-configured")).toBe(true);
    expect(isCriticalEvent("some-other")).toBe(false);
  });
});
