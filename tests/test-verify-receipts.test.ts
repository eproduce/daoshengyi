import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyVerificationCommand,
  detectVerificationClaims,
  findVerificationIssue,
  resetVerificationReceipts,
  noteVerification,
  noteMutation,
  evaluateVerificationClaims,
  VERIFICATION_LABEL,
  type VerificationReceipt,
} from "../src/utils/verify-receipts.ts";

describe("classifyVerificationCommand：命令归类", () => {
  it("测试类", () => {
    for (const cmd of [
      "npm test",
      "pnpm run test",
      "npx vitest run",
      "pytest -q",
      "cargo test --lib",
      "go test ./...",
    ]) {
      expect(classifyVerificationCommand(cmd)).toBe("test");
    }
  });

  it("类型检查类（tsc/vue-tsc/cargo check 优先于构建）", () => {
    for (const cmd of ["npx vue-tsc --noEmit", "tsc -p tsconfig.json", "cargo check", "mypy src"]) {
      expect(classifyVerificationCommand(cmd)).toBe("typecheck");
    }
  });

  it("Lint 类", () => {
    for (const cmd of [
      "npx eslint .",
      "cargo clippy --all-targets -- -D warnings",
      "ruff check .",
      "npx prettier --check .",
    ]) {
      expect(classifyVerificationCommand(cmd)).toBe("lint");
    }
  });

  it("构建类", () => {
    for (const cmd of ["npx vite build", "npm run build", "cargo build", "make all"]) {
      expect(classifyVerificationCommand(cmd)).toBe("build");
    }
  });

  it("非验证命令返回 null", () => {
    for (const cmd of ["ls -la", "git status", "cat package.json", "", "echo hi"]) {
      expect(classifyVerificationCommand(cmd)).toBeNull();
    }
  });
});

describe("detectVerificationClaims：正文断言识别", () => {
  it("识别中英文「通过/成功」断言", () => {
    expect(detectVerificationClaims("已修复，测试全部通过。")).toEqual(["test"]);
    expect(detectVerificationClaims("All 17 tests passed.")).toEqual(["test"]);
    expect(detectVerificationClaims("类型检查通过，构建成功。")).toEqual(["typecheck", "build"]);
    expect(detectVerificationClaims("lint 干净，clippy 无告警。")).toEqual(["lint"]);
  });

  it("同一类只报一次，多类按出现顺序", () => {
    expect(detectVerificationClaims("测试通过。构建成功。测试通过。")).toEqual(["test", "build"]);
  });

  it("否定与假设语境不算断言（关键：避免误伤）", () => {
    expect(detectVerificationClaims("测试未通过，我在排查。")).toEqual([]);
    expect(detectVerificationClaims("尚未运行测试。")).toEqual([]);
    expect(detectVerificationClaims("如果测试通过就提交。")).toEqual([]);
    expect(detectVerificationClaims("3 tests failed.")).toEqual([]);
    expect(detectVerificationClaims("我还没跑构建。")).toEqual([]);
  });

  it("无断言的普通回复返回空", () => {
    expect(
      detectVerificationClaims("已按你的要求把文件写到 ~/Documents/道生一产物/报告.md。"),
    ).toEqual([]);
  });
});

describe("findVerificationIssue：三态判定（纯函数）", () => {
  const r = (
    kind: VerificationReceipt["kind"],
    ok: boolean,
    mutationSeq: number,
  ): VerificationReceipt => ({
    kind,
    ok,
    command: "npm test",
    at: 1,
    mutationSeq,
  });

  it("无凭据 → missing", () => {
    const issue = findVerificationIssue(["test"], [], 0);
    expect(issue?.status).toBe("missing");
    expect(issue?.notice).toContain("npm test");
  });

  it("最近一次失败 → failed", () => {
    const issue = findVerificationIssue(["test"], [r("test", true, 0), r("test", false, 0)], 0);
    expect(issue?.status).toBe("failed");
    expect(issue?.notice).toContain("失败");
  });

  it("凭据之后又改文件 → stale", () => {
    const issue = findVerificationIssue(["test"], [r("test", true, 0)], 2);
    expect(issue?.status).toBe("stale");
    expect(issue?.notice).toContain("2 次改动");
  });

  it("凭据新鲜 → 无问题", () => {
    expect(findVerificationIssue(["test"], [r("test", true, 3)], 3)).toBeNull();
  });

  it("只校验被声称的类别（没声称类型检查就不管它）", () => {
    expect(findVerificationIssue(["build"], [r("test", true, 0)], 0)?.kind).toBe("build");
    expect(findVerificationIssue([], [], 5)).toBeNull();
  });
});

describe("回合内凭据表：note/评估闭环", () => {
  beforeEach(() => resetVerificationReceipts());

  it("先断言无凭据 → missing，跑过之后 → 通过", () => {
    expect(evaluateVerificationClaims("测试全部通过。")).not.toBeNull();
    noteVerification("test", true, "npm test");
    expect(evaluateVerificationClaims("测试全部通过。")).toBeNull();
  });

  it("跑完之后再改文件 → stale；重跑 → 恢复", () => {
    noteVerification("test", true, "npm test");
    noteMutation();
    const issue = evaluateVerificationClaims("17 个测试用例全部通过。");
    expect(issue?.status).toBe("stale");
    noteVerification("test", true, "npm test");
    expect(evaluateVerificationClaims("测试通过。")).toBeNull();
  });

  it("失败凭据不会被后续无关命令洗白", () => {
    noteVerification("test", false, "npm test");
    noteVerification("build", true, "npx vite build");
    expect(evaluateVerificationClaims("构建成功。")).toBeNull();
    expect(evaluateVerificationClaims("测试通过。")?.status).toBe("failed");
  });

  it("未被声称的类别不做任何打扰", () => {
    noteMutation();
    noteMutation();
    expect(evaluateVerificationClaims("已完成重构，说明见下。")).toBeNull();
  });

  it("标签与提示文本面向中文用户可读", () => {
    expect(VERIFICATION_LABEL.typecheck).toBe("类型检查");
    const notice = evaluateVerificationClaims("类型检查通过。")?.notice ?? "";
    expect(notice).toContain("类型检查");
    expect(notice).toContain("未经验证");
  });
});
