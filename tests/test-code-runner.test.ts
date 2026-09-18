// code-mode（run_code）单测：沙箱主线程侧的桥接/超时/上限，以及共享的格式化与错误归类。
//
// 这里用假 Worker 而不是真 Worker：要能在不跑真 JS、不等 30 秒的前提下，
// 逐一构造「超时」「工具报错」「调用超限」「日志超限」「晚到的工具调用」等
// **出错路径**——真实使用中出错路径才是用户会遇到的，也最难手测。

import { describe, expect, it, vi } from "vitest";
import {
  capText,
  classifyCodeError,
  errorParts,
  formatRunValue,
  MAX_LOG_LINES,
  MAX_OUTPUT_CHARS,
} from "../src/utils/code-format";
import {
  CODE_RUN_TIMEOUT_MS,
  describeWorkerError,
  formatCodeRunResult,
  MAX_TOOL_CALLS_PER_RUN,
  runCodeInWorker,
  type CodeRunResult,
  type WorkerLike,
} from "../src/utils/code-runner";

/** 假 Worker：记录 postMessage、可手动投递消息、记录是否被 terminate */
class FakeWorker implements WorkerLike {
  sent: Record<string, unknown>[] = [];
  terminated = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  postMessage(msg: unknown): void {
    this.sent.push(msg as Record<string, unknown>);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
  /** 取第 n 条（从 0 起）发回 Worker 的消息 */
  toolReplies(): Record<string, unknown>[] {
    return this.sent.filter((m) => m.type === "tool-result");
  }
}

/** 让已排队的微任务/宏任务跑完（工具桥是异步的） */
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(opts: {
  timeoutMs?: number;
  maxToolCalls?: number;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
  signal?: AbortSignal;
}) {
  const worker = new FakeWorker();
  const callTool = vi.fn(
    opts.callTool ?? (async (_n: string, _a: Record<string, unknown>) => "工具结果"),
  );
  const promise = runCodeInWorker({
    code: "return 1",
    callTool,
    timeoutMs: opts.timeoutMs,
    maxToolCalls: opts.maxToolCalls,
    signal: opts.signal,
    createWorker: () => worker,
  });
  return { worker, callTool, promise };
}

describe("code-format.capText", () => {
  it("未超限原样返回，超限截断并注明原文长度（不静默丢）", () => {
    expect(capText("abc", 10)).toBe("abc");
    const out = capText("x".repeat(20), 10);
    expect(out.startsWith("x".repeat(10))).toBe(true);
    expect(out).toContain("原文共 20 字符");
  });
});

describe("code-format.formatRunValue", () => {
  it("区分 undefined / null / 字符串 / 基本类型", () => {
    expect(formatRunValue(undefined)).toBe("undefined");
    expect(formatRunValue(null)).toBe("null");
    expect(formatRunValue("原样字符串")).toBe("原样字符串");
    expect(formatRunValue(42)).toBe("42");
    expect(formatRunValue(false)).toBe("false");
  });

  it("对象/数组走 JSON，可读", () => {
    expect(formatRunValue({ a: 1, b: [2, 3] })).toBe(
      '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}',
    );
  });

  it("循环引用如实标注，不抛错", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const out = formatRunValue(a);
    expect(out).toContain("[循环引用]");
  });

  it("同一对象出现两次（非嵌套）不算循环引用", () => {
    const shared = { v: 1 };
    const out = formatRunValue({ x: shared, y: shared });
    expect(out).not.toContain("循环引用");
    expect(out).toContain('"v": 1');
  });
});

describe("code-format.errorParts", () => {
  it("Error / 普通对象 / 原始值都能规整", () => {
    expect(errorParts(new SyntaxError("坏代码"))).toEqual({
      name: "SyntaxError",
      message: "坏代码",
    });
    expect(errorParts({ name: "Custom", message: "细节" })).toEqual({
      name: "Custom",
      message: "细节",
    });
    expect(errorParts("就一句话")).toEqual({ name: "Error", message: "就一句话" });
    expect(errorParts({ odd: true })).toEqual({ name: "Error", message: '{"odd":true}' });
  });
});

describe("code-format.classifyCodeError", () => {
  it("语法错误点明「只接受 JS，Python/shell 请改用 run_command」", () => {
    const msg = classifyCodeError("SyntaxError", "Unexpected token 'def'");
    expect(msg).toContain("JavaScript");
    expect(msg).toContain("run_command");
  });

  it("引用错误点明沙箱没有 window/fetch 并指路工具桥", () => {
    const msg = classifyCodeError("ReferenceError", "window is not defined");
    expect(msg).toContain("window");
    expect(msg).toContain("tools.");
  });

  it("不是函数：区分被禁能力与工具名写错", () => {
    const msg = classifyCodeError("TypeError", "fetch is not a function");
    expect(msg).toContain("禁用");
    expect(msg).toContain("tools.fetch_page");
  });

  it("未知错误原样返回（不伪造解释）", () => {
    expect(classifyCodeError("Weird", "少见的失败")).toBe("Weird: 少见的失败");
  });

  it("name 为 Error 时不加冗余前缀（工具抛错时常见）", () => {
    expect(classifyCodeError("Error", "工具被拒绝")).toBe("工具被拒绝");
  });
});

describe("runCodeInWorker · 成功路径", () => {
  it("把 run 消息发给 Worker，收到 done 后结算并 terminate", async () => {
    const { worker, promise } = setup({});
    expect(worker.sent[0]).toMatchObject({ type: "run", code: "return 1" });
    worker.emit({ type: "done", output: "结果文本" });
    const r = await promise;
    expect(r.ok).toBe(true);
    expect(r.output).toBe("结果文本");
    expect(r.timedOut).toBe(false);
    expect(worker.terminated).toBe(true);
  });

  it("超长返回值被截断并注明长度", async () => {
    const { worker, promise } = setup({});
    worker.emit({ type: "done", output: "y".repeat(MAX_OUTPUT_CHARS + 100) });
    const r = await promise;
    expect(r.output.length).toBeLessThan(MAX_OUTPUT_CHARS + 100);
    expect(r.output).toContain("已截断");
  });

  it("console 日志按序回传", async () => {
    const { worker, promise } = setup({});
    worker.emit({ type: "log", line: "第一行" });
    worker.emit({ type: "log", line: "第二行" });
    worker.emit({ type: "done", output: "" });
    const r = await promise;
    expect(r.logs).toEqual(["第一行", "第二行"]);
  });

  it("日志超上限时如实报告丢弃行数（不静默）", async () => {
    const { worker, promise } = setup({});
    for (let i = 0; i < MAX_LOG_LINES + 3; i++) worker.emit({ type: "log", line: `L${i}` });
    worker.emit({ type: "done", output: "" });
    const r = await promise;
    expect(r.logs).toHaveLength(MAX_LOG_LINES + 1);
    expect(r.logs[r.logs.length - 1]).toContain("另有 3 行");
  });
});

describe("runCodeInWorker · 错误与超时", () => {
  it("Worker 报错时**忠实转发**（不重复归类，避免套两层解释）", async () => {
    // 归类发生在 Worker 内（见 code-format 的 classifyCodeError 用例）；
    // 主线程只负责把已归类的文案原样带给模型。
    const { worker, promise } = setup({});
    worker.emit({
      type: "error",
      name: "ReferenceError",
      message: "引用了不存在的变量（window is not defined）。\n- 沙箱里**没有** window",
    });
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("引用了不存在的变量");
    expect(r.error).toContain("沙箱");
    expect(worker.terminated).toBe(true);
  });

  it("超时强杀 Worker 并给出可执行的下一步", async () => {
    const { worker, promise } = setup({ timeoutMs: 5 });
    const r = await promise;
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("超时");
    expect(worker.terminated).toBe(true);
  });

  it("外部停止立刻终止，不跑满超时", async () => {
    const ac = new AbortController();
    const { worker, promise } = setup({ signal: ac.signal });
    ac.abort();
    const r = await promise;
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(worker.terminated).toBe(true);
  });

  it("传入已 aborted 的信号：立即结算", async () => {
    const ac = new AbortController();
    ac.abort();
    const { promise } = setup({ signal: ac.signal });
    const r = await promise;
    expect(r.aborted).toBe(true);
  });

  it("创建 Worker 失败时给出明确原因，而不是挂住", async () => {
    const r = await runCodeInWorker({
      code: "return 1",
      callTool: async () => "",
      createWorker: () => {
        throw new Error("Worker is not supported");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Worker is not supported");
  });

  it("Worker onerror 也能结算", async () => {
    const { worker, promise } = setup({});
    worker.onerror?.(new Error("脚本加载失败"));
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("脚本加载失败");
  });

  it("Worker onerror 收到 ErrorEvent 时给出**可读**原因（不是 [object ErrorEvent]）", async () => {
    // 实测教训：Worker 的 onerror 传的是 ErrorEvent 而非 Error，
    // 直接 String() 只得到 "[object ErrorEvent]"，完全无法定位问题；
    // 真实场景里里面藏的是 `Cannot use import statement outside a module`。
    const { worker, promise } = setup({});
    worker.onerror?.({
      message: "Cannot use import statement outside a module",
      filename: "http://localhost/assets/run-code.worker.js",
      lineno: 3,
    });
    const r = await promise;
    expect(r.error).toContain("Cannot use import statement outside a module");
    expect(r.error).not.toContain("[object ErrorEvent]");
    expect(r.error).toContain("run-code.worker.js:3");
  });

  it("默认上限是 30 秒 / 20 次调用", () => {
    expect(CODE_RUN_TIMEOUT_MS).toBe(30_000);
    expect(MAX_TOOL_CALLS_PER_RUN).toBe(20);
  });
});

describe("describeWorkerError", () => {
  it("Error 取 message（空 message 回退 name）", () => {
    expect(describeWorkerError(new Error("炸了"))).toBe("炸了");
    expect(describeWorkerError(new TypeError(""))).toBe("TypeError");
  });

  it("ErrorEvent 形态：message + 文件:行号", () => {
    expect(describeWorkerError({ message: "语法错误", filename: "a.js", lineno: 12 })).toBe(
      "语法错误（a.js:12）",
    );
    // 没有行号时不硬凑 :0
    expect(describeWorkerError({ message: "语法错误", filename: "a.js", lineno: 0 })).toBe(
      "语法错误（a.js）",
    );
  });

  it("只有内层 error 时取内层 message", () => {
    expect(describeWorkerError({ error: new Error("内层原因") })).toBe("内层原因");
  });

  it("不认识的值也不抛错", () => {
    expect(describeWorkerError("就是字符串")).toBe("就是字符串");
    expect(describeWorkerError(undefined)).toBe("undefined");
    expect(typeof describeWorkerError({ weird: true })).toBe("string");
  });
});

describe("runCodeInWorker · 工具桥", () => {
  it("tools.x(...) 回到 callTool，结果原样回传 Worker", async () => {
    const { worker, callTool, promise } = setup({
      callTool: async (name) => `结果来自 ${name}`,
    });
    worker.emit({ type: "tool-call", id: 7, name: "calc", args: { expression: "1+2" } });
    await flush();
    expect(callTool).toHaveBeenCalledWith("calc", { expression: "1+2" });
    expect(worker.toolReplies()).toEqual([
      { type: "tool-result", id: 7, ok: true, value: "结果来自 calc" },
    ]);
    worker.emit({ type: "done", output: "ok" });
    const r = await promise;
    expect(r.toolCalls).toEqual([{ name: "calc", args: '{"expression":"1+2"}' }]);
  });

  it("工具抛错时回传 ok:false + 原因（让代码能 catch）", async () => {
    const { worker, promise } = setup({
      callTool: async () => {
        throw new Error("被权限规则拦截");
      },
    });
    worker.emit({ type: "tool-call", id: 1, name: "write_file", args: {} });
    await flush();
    expect(worker.toolReplies()[0]).toMatchObject({ id: 1, ok: false, error: "被权限规则拦截" });
    worker.emit({ type: "done", output: "" });
    await promise;
  });

  it("工具调用的 args 非对象时按空对象兜底（不把 undefined 传下去）", async () => {
    const { worker, callTool, promise } = setup({});
    worker.emit({ type: "tool-call", id: 2, name: "current_time", args: undefined });
    await flush();
    expect(callTool).toHaveBeenCalledWith("current_time", {});
    worker.emit({ type: "done", output: "" });
    await promise;
  });

  it("工具调用超上限：拒绝并如实记账，不静默忽略", async () => {
    const { worker, callTool, promise } = setup({ maxToolCalls: 2 });
    for (let i = 1; i <= 3; i++) {
      worker.emit({ type: "tool-call", id: i, name: "current_time", args: {} });
      await flush();
    }
    expect(callTool).toHaveBeenCalledTimes(2);
    const third = worker.toolReplies()[2];
    expect(third.ok).toBe(false);
    expect(String(third.error)).toContain("上限");
    worker.emit({ type: "done", output: "" });
    const r = await promise;
    expect(r.toolCalls).toHaveLength(3);
    expect(r.toolCalls[2].name).toContain("被拒");
  });

  it("工具结果过长会被截断后再回传（防 Worker 内存被灌爆）", async () => {
    const { worker, promise } = setup({ callTool: async () => "z".repeat(MAX_OUTPUT_CHARS + 50) });
    worker.emit({ type: "tool-call", id: 1, name: "read_file", args: {} });
    await flush();
    const value = String(worker.toolReplies()[0].value);
    expect(value).toContain("已截断");
    worker.emit({ type: "done", output: "" });
    await promise;
  });

  it("已结算后晚到的工具调用不再回复（Worker 已终止）", async () => {
    const { worker, callTool, promise } = setup({});
    worker.emit({ type: "done", output: "" });
    await promise;
    worker.emit({ type: "tool-call", id: 9, name: "calc", args: {} });
    await flush();
    expect(callTool).not.toHaveBeenCalled();
    expect(worker.toolReplies()).toHaveLength(0);
  });

  it("非法消息（null/字符串/未知类型）被忽略，不炸", async () => {
    const { worker, promise } = setup({});
    worker.emit(null);
    worker.emit("随便一个字符串");
    worker.emit({ type: "unknown-type" });
    worker.emit({ type: "done", output: "still alive" });
    const r = await promise;
    expect(r.ok).toBe(true);
    expect(r.output).toBe("still alive");
  });
});

describe("formatCodeRunResult", () => {
  const base: CodeRunResult = {
    ok: true,
    output: "",
    logs: [],
    toolCalls: [],
    timedOut: false,
    aborted: false,
    durationMs: 1234,
  };

  it("成功：状态 + 耗时 + 无返回值时明确说明", () => {
    const text = formatCodeRunResult(base);
    expect(text).toContain("✅ 成功");
    expect(text).toContain("1.2s");
    expect(text).toContain("（无返回值）");
  });

  it("成功：列出工具调用次数与名字 + console 输出 + 返回值", () => {
    const text = formatCodeRunResult({
      ...base,
      output: "最终结果",
      logs: ["中间值 1", "中间值 2"],
      toolCalls: [
        { name: "calc", args: "{}" },
        { name: "current_time", args: "{}" },
      ],
    });
    expect(text).toContain("工具调用 2 次：calc, current_time");
    expect(text).toContain("中间值 2");
    expect(text).toContain("最终结果");
  });

  it("超时 / 停止 / 失败三种状态文案不同且带原因", () => {
    expect(formatCodeRunResult({ ...base, ok: false, timedOut: true, error: "超时了" })).toContain(
      "⏱ 超时终止",
    );
    expect(formatCodeRunResult({ ...base, ok: false, aborted: true, error: "被停止" })).toContain(
      "⏹ 已停止",
    );
    const failed = formatCodeRunResult({ ...base, ok: false, error: "类型错误（x）" });
    expect(failed).toContain("❌ 失败");
    expect(failed).toContain("类型错误（x）");
  });

  it("失败但已有输出时保留输出（便于定位）", () => {
    const text = formatCodeRunResult({
      ...base,
      ok: false,
      output: "打印到一半的结果",
      error: "boom",
    });
    expect(text).toContain("已产生的输出");
    expect(text).toContain("打印到一半的结果");
  });
});
