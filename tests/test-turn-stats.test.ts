import { describe, it, expect, vi } from "vitest";
import { createTurnStats, looksLikeToolError } from "../src/utils/turn-stats.ts";

/**
 * 回合统计：从 `chat.ts` 的模块级全局抽成**可实例化的作用域**。
 *
 * 抽出来的真实动机（不是洁癖）：并行子代理的工具调用同样走 `callToolStoppable`，
 * 共享全局会导致 —— 子代理失败污染主回合的「全军覆没」判定；子代理的同因失败
 * 甚至**打断主回合**（stuck 一旦置位就中止）。这里钉住「实例之间互不影响」。
 */
describe("createTurnStats：计数与停滞判定", () => {
  it("成功/失败分开计数，失败工具按顺序记录", () => {
    const t = createTurnStats();
    t.noteOk();
    t.noteFail("run_command", "exit 1");
    t.noteOk();
    t.noteFail("fetch_page", "timeout");
    expect(t.ok).toBe(2);
    expect(t.fail).toBe(2);
    expect(t.failedTools).toEqual(["run_command", "fetch_page"]);
  });

  it("同一工具同一病因反复失败 → 达阈值后返回停滞信息，且只回调一次", () => {
    const onStuck = vi.fn();
    const t = createTurnStats({ onStuck });
    let last = null;
    for (let i = 0; i < 10; i++) {
      const hit = t.noteFail("run_command", "connect ECONNREFUSED 127.0.0.1:7890");
      if (hit) last = hit;
    }
    expect(last).not.toBeNull();
    expect(last!.tool).toBe("run_command");
    expect(last!.count).toBeGreaterThan(1);
    expect(t.stuck).not.toBeNull();
    expect(onStuck).toHaveBeenCalledTimes(1);
  });

  it("不同病因不累积成停滞（避免「换着法失败」被误判卡死）", () => {
    const t = createTurnStats();
    for (let i = 0; i < 10; i++) t.noteFail("run_command", `error-${i}`);
    expect(t.stuck).toBeNull();
  });

  it("停滞是粘性的：后续成功不清除（语义是「本回合已被判定卡住」）", () => {
    const t = createTurnStats();
    for (let i = 0; i < 10; i++) t.noteFail("x", "same error");
    expect(t.stuck).not.toBeNull();
    t.noteOk();
    expect(t.stuck).not.toBeNull();
  });

  it("reset 清空一切（下一回合从零开始）", () => {
    const t = createTurnStats();
    t.noteOk();
    t.noteFail("x", "e");
    t.reset();
    expect(t.ok).toBe(0);
    expect(t.fail).toBe(0);
    expect(t.failedTools).toEqual([]);
    expect(t.stuck).toBeNull();
  });

  it("两个实例互不影响（子代理不再污染主回合）", () => {
    const main = createTurnStats();
    const sub = createTurnStats();
    main.noteOk();
    for (let i = 0; i < 10; i++) sub.noteFail("run_command", "same error");
    expect(sub.stuck).not.toBeNull();
    expect(main.stuck).toBeNull();
    expect(main.fail).toBe(0);
    expect(main.ok).toBe(1);
  });
});

describe("looksLikeToolError：字符串形式的工具报错", () => {
  it("⛔ / ❌ 开头算失败（内置工具普遍这么返回）", () => {
    expect(looksLikeToolError("⛔ 路径不在白名单")).toBe(true);
    expect(looksLikeToolError("  ❌ 命令失败")).toBe(true);
  });

  it("正常文本、emoji 在中间都不算失败", () => {
    expect(looksLikeToolError("命令输出：⛔ 只是正文里的符号")).toBe(false);
    expect(looksLikeToolError("✅ 成功")).toBe(false);
    expect(looksLikeToolError("")).toBe(false);
    expect(looksLikeToolError(null)).toBe(false);
  });
});
