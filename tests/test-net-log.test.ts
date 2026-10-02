// 「最近网络活动」环形缓冲单测：只旁观不改行为，且要能回答「这批无 stack 错误是不是 fetch 引起的」
import { describe, it, expect, beforeEach } from "vitest";
import {
  noteNetAttempt,
  noteNetFailure,
  settleNetAttempt,
  recentNetActivity,
  netActivityCount,
  resetNetActivity,
} from "../src/utils/net-log";

beforeEach(() => resetNetActivity());

describe("网络活动环形缓冲", () => {
  it("记录尝试与结果（URL + 状态）", () => {
    const a = noteNetAttempt("POST", "https://api.example.com/v1/chat/completions");
    expect(a.status).toBeNull();
    noteNetFailure("POST", "https://api.example.com/v1/chat/completions", new Error("Load failed"));
    const lines = recentNetActivity();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("POST");
    expect(lines[0]).toContain("api.example.com");
    expect(lines[0]).toContain("Load failed");
  });

  it("失败没配对上尝试时，独立记一条（不丢信息）", () => {
    noteNetFailure("GET", "https://cdn.example.com/skill.md", "Load failed");
    expect(netActivityCount()).toBe(1);
    expect(recentNetActivity()[0]).toContain("cdn.example.com");
  });

  // 启动期会有大量**同名** IPC 调用（连续的 debug_log）；靠 URL 匹配结算会把更早的
  // 那条误标成失败（我第一版就踩了这个坑，日志里全是“未完成”，看不出谁真失败）。
  it("同名调用多次时，靠句柄精确结算（不误标更早那条）", () => {
    const first = noteNetAttempt("POST", "ipc://localhost/debug_log");
    const second = noteNetAttempt("POST", "ipc://localhost/debug_log");
    settleNetAttempt(second, -1, new Error("Load failed"));
    settleNetAttempt(first, 200);
    const lines = recentNetActivity(4);
    expect(lines.filter((l) => l.includes("失败")).length).toBe(1);
    expect(lines.join()).toContain("Load failed");
  });

  it("失败排前面（排查对象优先），IPC 命令名可读化", () => {
    settleNetAttempt(noteNetAttempt("POST", "ipc://localhost/get_messages"), 200);
    settleNetAttempt(
      noteNetAttempt("POST", "ipc://localhost/plugin%3Aevent%7Clisten"),
      -1,
      "Load failed",
    );
    settleNetAttempt(noteNetAttempt("POST", "ipc://localhost/debug_log"), 200);
    const lines = recentNetActivity(3);
    expect(lines[0]).toContain("失败");
    expect(lines[0]).toContain("ipc:plugin:event|listen");
    expect(lines.join()).toContain("ipc:get_messages");
    expect(lines.join()).not.toContain("ipc://localhost");
  });

  it("环形上限：只保留最近 30 条（长跑不涨内存）", () => {
    for (let i = 0; i < 50; i++) noteNetAttempt("GET", `https://x.example.com/${i}`);
    expect(netActivityCount()).toBe(30);
    const lines = recentNetActivity(3);
    expect(lines[2]).toContain("/49");
    expect(lines.join()).not.toContain("/19");
  });

  it("URL 过长时截断，避免日志被撑爆", () => {
    noteNetAttempt("GET", "https://y.example.com/" + "a".repeat(500));
    expect(recentNetActivity()[0].length).toBeLessThan(240);
  });

  it("reset 后为空（判「与 fetch 无关」时不能有残留）", () => {
    noteNetAttempt("GET", "https://z.example.com");
    resetNetActivity();
    expect(netActivityCount()).toBe(0);
    expect(recentNetActivity()).toEqual([]);
  });
});
