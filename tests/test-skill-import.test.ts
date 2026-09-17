import { describe, it, expect } from "vitest";
import {
  fallbackName,
  normalizeSkillName,
  planSkillImport,
  skillSourceSpecs,
  summarizePlan,
  type ExternalSkillFile,
} from "../src/utils/skill-import";

const file = (p: Partial<ExternalSkillFile> = {}): ExternalSkillFile => ({
  source: "claude-code",
  label: "Claude Code 技能",
  path: "/Users/tester/.claude/skills/reviewer/SKILL.md",
  name: "SKILL.md",
  content: "---\nname: 代码审查\ndescription: 审查代码\n---\n请审查以下代码。",
  bytes: 100,
  ...p,
});

describe("P1-9a 技能导入 · 来源规格", () => {
  it("生成 Claude Code / Codex / 通用 三类来源；有工作区时加 Cursor", () => {
    const without = skillSourceSpecs("/Users/tester");
    const ids = without.map((s) => s.id);
    expect(ids).toEqual(["claude-code", "claude-commands", "codex", "generic"]);
    expect(without[0].dir).toBe("/Users/tester/.claude/skills");
    expect(without[0].file_name).toBe("SKILL.md");
    expect(without[1].file_name).toBeUndefined();

    const withWs = skillSourceSpecs("/Users/tester", "/Users/tester/op/proj/");
    expect(withWs.map((s) => s.id)).toContain("cursor");
    expect(withWs[withWs.length - 1].dir).toBe("/Users/tester/op/proj/.cursor/rules");
  });

  it("主目录为空时只退化为空数组（不崩）", () => {
    expect(skillSourceSpecs("")).toEqual([]);
    expect(skillSourceSpecs("", "")).toEqual([]);
  });

  it("尾斜杠被清理，不会拼出双斜杠", () => {
    for (const s of skillSourceSpecs("/Users/tester/", "/Users/tester/op/")) {
      expect(s.dir).not.toContain("//");
    }
  });
});

describe("P1-9a 技能导入 · 命名与兜底", () => {
  it("normalizeSkillName 忽略大小写与空白（判同名）", () => {
    expect(normalizeSkillName("  Code Review ")).toBe(normalizeSkillName("code review"));
    expect(normalizeSkillName("A B")).toBe(normalizeSkillName("ab"));
  });

  it("fallbackName：普通文件用文件名；SKILL.md 用所在目录名", () => {
    expect(fallbackName(file({ name: "my-skill.md" }))).toBe("my-skill");
    expect(fallbackName(file({ name: "SKILL.md" }))).toBe("reviewer");
    expect(fallbackName(file({ name: "", path: "/a/b/c.md" }))).toBe("b");
    expect(fallbackName(file({ name: "", path: "" }))).toBe("导入技能");
  });
});

describe("P1-9a 技能导入 · 规划判定", () => {
  it("全新文件 → add（带 frontmatter 的 name/description）", () => {
    const plan = planSkillImport([file()], []);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action).toBe("add");
    expect(plan.items[0].draft.name).toBe("代码审查");
    expect(plan.items[0].draft.description).toBe("审查代码");
    expect(plan.items[0].draft.prompt).toContain("请审查以下代码");
    expect(plan.bySource).toEqual({ "claude-code": 1 });
  });

  it("无 frontmatter → 用文件名兜底命名，正文整篇作为 prompt", () => {
    const plan = planSkillImport(
      [file({ source: "codex", name: "refactor.md", content: "# 重构提示\n把函数拆小。" })],
      [],
    );
    expect(plan.items[0].draft.name).toBe("重构提示"); // 无 frontmatter 时取首行标题
    expect(plan.items[0].draft.prompt).toContain("把函数拆小");
  });

  it("同一 importUrl 已存在 → update（刷新正文，不新增）", () => {
    const plan = planSkillImport(
      [file({ content: "---\nname: 代码审查\n---\n新正文" })],
      [
        {
          id: "s1",
          name: "代码审查",
          source: "import",
          importUrl: "/Users/tester/.claude/skills/reviewer/SKILL.md",
        },
      ],
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action).toBe("update");
    expect(plan.items[0].targetId).toBe("s1");
    expect(plan.items[0].draft.prompt).toContain("新正文");
  });

  it("同名但来源是用户手写/目录安装 → 冲突，**绝不覆盖**", () => {
    for (const source of ["user", "catalog"]) {
      const plan = planSkillImport([file()], [{ id: "x", name: "代码审查", source }]);
      expect(plan.items).toHaveLength(0);
      expect(plan.conflicts).toHaveLength(1);
      expect(plan.conflicts[0].reason).toContain("同名技能已存在");
    }
  });

  it("同名且都是 import 但来源文件不同 → 冲突（不互相顶替）", () => {
    const plan = planSkillImport(
      [file()],
      [{ id: "s2", name: "代码审查", source: "import", importUrl: "/other/path.md" }],
    );
    expect(plan.items).toHaveLength(0);
    expect(plan.conflicts[0].reason).toContain("其它文件的导入");
  });

  it("同批次内重复同名 → 后者跳过", () => {
    const plan = planSkillImport(
      [file(), file({ path: "/Users/tester/.claude/skills/other/SKILL.md" })],
      [],
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].reason).toContain("同批次已有同名");
  });

  it("空文件 / 只有 frontmatter 没有正文 → 跳过并说明原因", () => {
    const plan = planSkillImport(
      [
        file({ path: "/a/empty.md", content: "   \n" }),
        file({ path: "/a/fm-only.md", content: "---\nname: 空\n---\n\n" }),
      ],
      [],
    );
    expect(plan.items).toHaveLength(0);
    expect(plan.skipped.map((s) => s.path)).toEqual(["/a/empty.md", "/a/fm-only.md"]);
    expect(plan.skipped[0].reason).toContain("为空");
    expect(plan.skipped[1].reason).toContain("解析失败或无正文");
  });

  it("一次导入多个来源：混合 add/update/冲突/跳过，统计准确", () => {
    const plan = planSkillImport(
      [
        file({ source: "claude-code", path: "/a/1.md", content: "---\nname: 技能甲\n---\n正文甲" }),
        file({ source: "codex", path: "/b/2.md", content: "---\nname: 技能乙\n---\n正文乙" }),
        file({
          source: "codex",
          path: "/b/3.md",
          content: "---\nname: 已存在\n---\n正文",
        }),
        file({ source: "cursor", path: "/c/4.md", content: "" }),
      ],
      [{ id: "e1", name: "已存在", source: "user" }],
    );
    // 中文排序按 UTF-16 码位，不能假设拼音序 → 用集合比较
    expect(new Set(plan.items.map((i) => i.draft.name))).toEqual(new Set(["技能甲", "技能乙"]));
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.bySource).toEqual({ "claude-code": 1, codex: 2, cursor: 1 });
  });

  it("空输入 → 空计划（不抛错）", () => {
    const plan = planSkillImport([], []);
    expect(plan.items).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(summarizePlan(plan)).toContain("没有可导入");
  });

  it("summarizePlan 汇总各处置数量", () => {
    const plan = planSkillImport(
      [
        file({ path: "/a/1.md", content: "---\nname: 新技能\n---\nX" }),
        file({ path: "/a/dup.md", content: "---\nname: 已存在\n---\nX" }),
        file({ path: "/a/empty.md", content: "" }),
      ],
      [{ id: "e", name: "已存在", source: "user" }],
    );
    const s = summarizePlan(plan);
    expect(s).toContain("新增 1");
    expect(s).toContain("同名冲突 1");
    expect(s).toContain("跳过 1");
    expect(s).not.toContain("更新");
  });
});
