// 「本会话内不再询问」作用域的单测。
//
// 背景（用户反馈「勾选好像没有效果」）：勾选原本只按**单个工具名**记录，而 Agent 干活时
// 会混用 replace_string / insert_string / apply_patch —— 勾一次之后换个工具又被问，
// 用户就认为勾选无效。这里把这个作用域行为钉死，避免以后被"改回更精确的单工具名"。

import { describe, expect, it } from "vitest";
import {
  DELETE_TOOLS,
  EDIT_TOOLS,
  permitLabel,
  permitsSatisfy,
  toolGroup,
} from "../src/utils/session-permits";

describe("permitsSatisfy · 精确匹配", () => {
  it("无任何放行时一律不放行", () => {
    for (const t of [...EDIT_TOOLS, ...DELETE_TOOLS, "run_command"]) {
      expect(permitsSatisfy([], t)).toBe(false);
    }
  });

  it("同一个工具被放行后，它自己当然放行", () => {
    expect(permitsSatisfy(["replace_string"], "replace_string")).toBe(true);
  });

  it("未收录的工具只按精确名匹配（不误伤）", () => {
    expect(permitsSatisfy(["run_command"], "run_command")).toBe(true);
    expect(permitsSatisfy(["run_command"], "replace_string")).toBe(false);
    expect(permitsSatisfy(["replace_string"], "run_command")).toBe(false);
  });
});

describe("permitsSatisfy · 同类放行（本次修复的核心）", () => {
  it("放行任一编辑工具 → 其余编辑工具也放行", () => {
    for (const granted of EDIT_TOOLS) {
      for (const other of EDIT_TOOLS) {
        expect(permitsSatisfy([granted], other)).toBe(true);
      }
    }
  });

  it("放行 apply_patch 也应覆盖 replace_string（Agent 混用工具的真实场景）", () => {
    expect(permitsSatisfy(["apply_patch"], "replace_string")).toBe(true);
    expect(permitsSatisfy(["insert_string"], "apply_patch")).toBe(true);
  });

  it("删除是独立一类：编辑的放行不覆盖删除", () => {
    for (const granted of EDIT_TOOLS) {
      expect(permitsSatisfy([granted], "delete_file")).toBe(false);
    }
  });

  it("删除的放行也不覆盖编辑", () => {
    for (const other of EDIT_TOOLS) {
      expect(permitsSatisfy(["delete_file"], other)).toBe(false);
    }
  });

  it("接受任意可迭代（Set / 数组）", () => {
    expect(permitsSatisfy(new Set(["insert_string"]), "replace_string")).toBe(true);
    expect(permitsSatisfy(new Set(["delete_file"]), "replace_string")).toBe(false);
  });
});

describe("permitLabel · 文案必须说清范围", () => {
  it("成组的编辑工具：写明会放行哪几个（避免「勾了没用」的误解）", () => {
    const label = permitLabel("replace_string");
    expect(label).toContain("这类文件编辑");
    for (const t of EDIT_TOOLS) expect(label).toContain(t);
  });

  it("单独的删除：明确只说删除", () => {
    const label = permitLabel("delete_file");
    expect(label).toBe("本会话内不再询问 delete_file");
    expect(label).not.toContain("这类");
  });

  it("未收录工具：退化为精确文案", () => {
    expect(permitLabel("run_command")).toBe("本会话内不再询问 run_command");
  });
});

describe("toolGroup", () => {
  it("编辑类归到同一组，删除单独一组", () => {
    expect(toolGroup("replace_string")).toBe(EDIT_TOOLS);
    expect(toolGroup("insert_string")).toBe(EDIT_TOOLS);
    expect(toolGroup("apply_patch")).toBe(EDIT_TOOLS);
    expect(toolGroup("delete_file")).toBe(DELETE_TOOLS);
    expect(toolGroup("run_command")).toBeUndefined();
  });
});
