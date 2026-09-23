import { it, expect } from "vitest";
import {
  normalizeWorkspace,
  workspaceLabel,
  workspaceTitle,
  workspaceInputError,
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
