import { it, expect } from "vitest";
import {
  normalizeWorkspace,
  workspaceLabel,
  workspaceTitle,
  workspaceInputError,
  resolveWorkspace,
  workspaceSource,
} from "../src/utils/workspace.ts";

// 场景：Agent 工作区从「设置 → API 配置」抽到输入框工具栏后，工具栏要显示短名、
// 悬浮给全路径、保存前清洗与校验。这些小判定最容易在改 UI 时被改坏，故钉成单测。

it("normalizeWorkspace：去空白、去结尾斜杠、空值归 null", () => {
  expect(normalizeWorkspace("  /Users/me/op/daoshengyi  ")).toBe("/Users/me/op/daoshengyi");
  expect(normalizeWorkspace("/Users/me/op/daoshengyi/")).toBe("/Users/me/op/daoshengyi");
  expect(normalizeWorkspace("/Users/me//op/")).toBe("/Users/me//op");
  expect(normalizeWorkspace("/")).toBe("/"); // 根目录不能被剥成空串
  expect(normalizeWorkspace("")).toBeNull();
  expect(normalizeWorkspace("   ")).toBeNull();
  expect(normalizeWorkspace(undefined)).toBeNull();
  expect(normalizeWorkspace(null)).toBeNull();
});

it("workspaceLabel：只取最后一级目录名，未设置给空串（工具栏据此显示「工作区」占位）", () => {
  expect(workspaceLabel("/Users/me/op/daoshengyi")).toBe("daoshengyi");
  expect(workspaceLabel("/Users/me/op/daoshengyi/")).toBe("daoshengyi");
  expect(workspaceLabel("/")).toBe("/");
  expect(workspaceLabel("~/op/daoshengyi")).toBe("daoshengyi");
  expect(workspaceLabel("~")).toBe("~");
  expect(workspaceLabel("")).toBe("");
  expect(workspaceLabel(null)).toBe("");
});

it("workspaceTitle：有值时给全路径与用途，未设置时说清「空 = 不限定」", () => {
  const on = workspaceTitle("/Users/me/op");
  expect(on).toContain("/Users/me/op");
  expect(on).toContain("工作区可写");
  const off = workspaceTitle("");
  expect(off).toContain("未设置");
  expect(off).toContain("不限定");
});

it("workspaceInputError：相对路径被拦下，绝对路径与 ~ 通过，空值=清除不报错", () => {
  expect(workspaceInputError("op/daoshengyi")).toContain("绝对路径");
  expect(workspaceInputError("daoshengyi")).toContain("绝对路径");
  expect(workspaceInputError("/Users/me/op")).toBe("");
  expect(workspaceInputError("~/op")).toBe("");
  expect(workspaceInputError("/")).toBe("");
  expect(workspaceInputError("")).toBe(""); // 清空是合法操作
  expect(workspaceInputError(null)).toBe("");
});

// 会话级工作区（DSH：会话头 cwd 是真源，全局设置只是新会话默认）——三态语义易错，钉死
it("resolveWorkspace：未覆盖→跟随全局；空串→本会话明确不限定；有值→用会话值", () => {
  // 未设置覆盖 → 跟随全局（含全局也空的情况）
  expect(resolveWorkspace(undefined, "/Users/me/op")).toBe("/Users/me/op");
  expect(resolveWorkspace(null, "/Users/me/op")).toBe("/Users/me/op");
  expect(resolveWorkspace(undefined, null)).toBeNull();
  expect(resolveWorkspace(null, "   ")).toBeNull();
  // 空串 = 明确不限定 → 覆盖掉全局默认（不是「回落到全局」）
  expect(resolveWorkspace("", "/Users/me/op")).toBeNull();
  // 会话值优先，并做同样的清洗
  expect(resolveWorkspace("/tmp/proj", "/Users/me/op")).toBe("/tmp/proj");
  expect(resolveWorkspace("/tmp/proj/", "/Users/me/op")).toBe("/tmp/proj");
});

it("workspaceSource：UI 据此显示「跟随全局」还是「本会话」", () => {
  expect(workspaceSource(undefined)).toBe("global");
  expect(workspaceSource(null)).toBe("global");
  expect(workspaceSource("")).toBe("session"); // 「本会话不限定」也是覆盖
  expect(workspaceSource("/tmp/x")).toBe("session");
});
