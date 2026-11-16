import { describe, it, expect } from "vitest";
import {
  AGENT_STATUSES,
  budgetExceeded,
  canTransition,
  describeAgent,
  isNameTaken,
  isTerminal,
  normalizeAgentName,
  statusAfterRestart,
  type AgentStatus,
} from "../src/utils/agent-roster.ts";

/**
 * 花名册逻辑：**状态迁移是这类功能最容易写坏的地方**——
 * 允许了不该允许的迁移，就会出现「已 cancelled 的成员又被派活」「重启后 interrupted 被当 idle
 * 自动跑起来」这类难查问题。所以这里把每条边界都钉住。
 */
describe("状态机", () => {
  it("正常生命周期：idle → running → idle/done/failed", () => {
    expect(canTransition("idle", "running")).toBe(true);
    expect(canTransition("running", "idle")).toBe(true);
    expect(canTransition("running", "done")).toBe(true);
    expect(canTransition("running", "failed")).toBe(true);
  });

  it("失败不粘：failed 可以直接被派新活", () => {
    expect(canTransition("failed", "running")).toBe(true);
  });

  it("不能凭空开始：idle 不能直接到 done/failed（没跑过就是没跑过）", () => {
    expect(canTransition("idle", "done")).toBe(false);
    expect(canTransition("idle", "failed")).toBe(false);
  });

  it("cancelled 只能被重新激活，不能直接变成 done（取消就是取消）", () => {
    expect(isTerminal("cancelled")).toBe(true);
    expect(canTransition("cancelled", "done")).toBe(false);
    expect(canTransition("cancelled", "running")).toBe(true);
  });

  it("interrupted 只能 resume 或归档（不自动续跑）", () => {
    expect(canTransition("interrupted", "idle")).toBe(false);
    expect(canTransition("interrupted", "running")).toBe(true);
    expect(canTransition("interrupted", "cancelled")).toBe(true);
  });

  it("迁移表对每个状态都有定义（新增状态时不会静默漏掉）", () => {
    for (const s of AGENT_STATUSES) {
      expect(() => canTransition(s, s as AgentStatus)).not.toThrow();
    }
    // 自迁移一律不允许（写库时若出现 from==to 说明调用方逻辑有误）
    for (const s of AGENT_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });
});

describe("重启语义", () => {
  it("在跑的和等输入的都变 interrupted", () => {
    expect(statusAfterRestart("running")).toBe("interrupted");
    expect(statusAfterRestart("waiting")).toBe("interrupted");
  });

  it("已经结束的保持原状（别把 done 改成 interrupted）", () => {
    expect(statusAfterRestart("done")).toBe("done");
    expect(statusAfterRestart("failed")).toBe("failed");
    expect(statusAfterRestart("cancelled")).toBe("cancelled");
    expect(statusAfterRestart("idle")).toBe("idle");
  });
});

describe("名字规范", () => {
  it("折叠空白并接受正常名字", () => {
    expect(normalizeAgentName("  调研  员 ")).toEqual({ ok: true, name: "调研 员" });
  });

  it("空名/超长/保留名/非法字符都要给可读理由", () => {
    for (const bad of ["", "   ", "x".repeat(25), "main", "Main", "a/b", "a:b"]) {
      const r = normalizeAgentName(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(4);
    }
    expect(normalizeAgentName("x".repeat(24)).ok).toBe(true);
  });

  it("重名检查大小写不敏感", () => {
    expect(isNameTaken(["Researcher", "写手"], "researcher")).toBe(true);
    expect(isNameTaken(["Researcher"], "写手")).toBe(false);
  });
});

describe("预算与展示", () => {
  it("超限给可读原因，未超返回 null", () => {
    expect(budgetExceeded({ tokens: 100 }, { maxTokens: 400_000 })).toBeNull();
    expect(budgetExceeded({ tokens: 400_000 }, { maxTokens: 400_000 })).toContain("上限");
    expect(budgetExceeded({ tokens: 1, cost: 2 }, { maxTokens: 400_000, maxCost: 1 })).toContain(
      "$",
    );
  });

  it("列表行含角色/状态/回合，接近上限时给警告", () => {
    const line = describeAgent({
      name: "调研员",
      roleId: "analyst",
      status: "running",
      turns: 3,
      tokens: 120,
    });
    expect(line).toContain("调研员");
    expect(line).toContain("analyst");
    expect(line).toContain("running");
    expect(line).toContain("3 回合");
    expect(describeAgent({ name: "a", status: "idle", turns: 0, tokens: 350_000 })).toContain(
      "tokens",
    );
  });
});
