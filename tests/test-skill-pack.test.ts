import { describe, it, expect } from "vitest";
import { importOrigin, planSkillImport, type ExistingSkillRef } from "../src/utils/skill-import";
import {
  packInputsFromSkills,
  packSlugOf,
  readPack,
  type SkillPackRead,
} from "../src/utils/skill-pack";
import type { Skill } from "../src/types";

function skill(p: Partial<Skill> = {}): Skill {
  return {
    id: "s1",
    name: "代码审查",
    description: "审查代码",
    prompt: "正文",
    enabled: true,
    category: "开发",
    source: "user",
    createdAt: 0,
    updatedAt: 0,
    ...p,
  };
}

describe("技能包 · 打包入参", () => {
  it("把技能（含 references / requires）翻成 Rust 入参", () => {
    const inputs = packInputsFromSkills(
      [
        skill({
          version: "2.0",
          whenToUse: "需要审查时",
          tags: ["review"],
          requires: { tools: ["read_file"], servers: ["GitHub"] },
          references: [{ id: "r1", title: "清单", content: "看命名" }],
        }),
      ],
      (id) => `MD:${id}`,
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      name: "代码审查",
      version: "2.0",
      whenToUse: "需要审查时",
      tags: ["review"],
      requiresTools: ["read_file"],
      requiresServers: ["GitHub"],
      content: "MD:s1",
      references: [{ title: "清单", content: "看命名" }],
    });
  });

  it("缺失字段给安全默认值（不产出 undefined）", () => {
    const inputs = packInputsFromSkills([skill({ category: "", tags: undefined })], () => "x");
    expect(inputs[0].tags).toEqual([]);
    expect(inputs[0].requiresTools).toEqual([]);
    expect(inputs[0].references).toEqual([]);
    expect(inputs[0].category).toBe("");
  });
});

describe("技能包 · 解包映射", () => {
  const read: SkillPackRead = {
    manifest: {
      format: "daoshengyi-skillpack",
      version: 1,
      count: 1,
      skills: [
        {
          name: "代码审查",
          slug: "code-review",
          version: "2.0",
          tags: ["review"],
          requires: { tools: ["read_file"], servers: ["GitHub"] },
          references: [{ title: "检查清单", file: "code-review/references/checklist.md" }],
        },
      ],
    },
    entries: [
      { path: "code-review/SKILL.md", content: "---\nname: 代码审查\n---\n正文", bytes: 26 },
      { path: "code-review/references/checklist.md", content: "1. 命名", bytes: 10 },
    ],
    ignored: 3,
  };

  it("SKILL.md → 可导入文件，路径带 pack: 前缀（来源徽标 + 避免跨包撞 importUrl）", () => {
    const { files } = readPack(read, "我的包.zip");
    expect(files).toHaveLength(1);
    expect(files[0].source).toBe("pack");
    expect(files[0].path).toBe("pack:我的包.zip/code-review/SKILL.md");
    expect(files[0].content).toContain("正文");
    expect(importOrigin(files[0].path)?.label).toBe("技能包");
  });

  it("references 按 slug 归到技能的元数据上，标题取 manifest 声明", () => {
    const { metaBySlug } = readPack(read, "p.zip");
    const meta = metaBySlug.get("code-review");
    expect(meta?.version).toBe("2.0");
    expect(meta?.requires).toEqual({ tools: ["read_file"], servers: ["GitHub"] });
    expect(meta?.references).toHaveLength(1);
    expect(meta?.references?.[0].title).toBe("检查清单");
    expect(meta?.references?.[0].content).toBe("1. 命名");
  });

  it("manifest 缺失也能用：只留 references，标题回退成文件名", () => {
    const { files, metaBySlug } = readPack(
      {
        manifest: null,
        entries: [
          { path: "a/SKILL.md", content: "body", bytes: 4 },
          { path: "a/references/api-design.md", content: "细节", bytes: 6 },
        ],
        ignored: 0,
      },
      "p.zip",
    );
    expect(files).toHaveLength(1);
    const meta = metaBySlug.get("a");
    expect(meta?.references?.[0].title).toBe("api-design");
  });

  it("packSlugOf：包内路径取 slug，外部目录路径取首段", () => {
    expect(packSlugOf("pack:我的包.zip/code-review/SKILL.md")).toBe("code-review");
    expect(packSlugOf("code-review/SKILL.md")).toBe("code-review");
    expect(packSlugOf("flat.md")).toBe("flat.md");
    expect(packSlugOf("")).toBe("");
  });
});

describe("技能导入 · 同名冲突策略", () => {
  const packFile = (name: string, path: string) => ({
    source: "pack",
    label: "技能包",
    path,
    name: "SKILL.md",
    content: `---\nname: ${name}\n---\n正文`,
    bytes: 10,
  });
  const existing: ExistingSkillRef[] = [
    { id: "u1", name: "手写技能", source: "user" },
    { id: "i1", name: "外部技能", source: "import", importUrl: "/Users/t/x.md" },
  ];

  it("默认 skip：同名进冲突，不覆盖任何东西", () => {
    const plan = planSkillImport([packFile("手写技能", "p/a/SKILL.md")], existing);
    expect(plan.items).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(1);
  });

  it("overwrite：可覆盖「导入/目录」来源，但手写技能仍受保护", () => {
    const overwrite = planSkillImport([packFile("外部技能", "p/a/SKILL.md")], existing, {
      onNameConflict: "overwrite",
    });
    expect(overwrite.items[0].action).toBe("update");
    expect(overwrite.items[0].targetId).toBe("i1");

    const guarded = planSkillImport([packFile("手写技能", "p/b/SKILL.md")], existing, {
      onNameConflict: "overwrite",
    });
    expect(guarded.items).toHaveLength(0);
    expect(guarded.conflicts[0].reason).toContain("手写");
  });

  it("rename：改名为「原名 (2)」新增，同批次继续递增", () => {
    const plan = planSkillImport(
      [packFile("手写技能", "p/a/SKILL.md"), packFile("手写技能", "p/b/SKILL.md")],
      existing,
      { onNameConflict: "rename" },
    );
    expect(plan.items.map((i) => i.draft.name)).toEqual(["手写技能 (2)", "手写技能 (3)"]);
    expect(plan.items[0].renameTo).toBe("手写技能 (2)");
    expect(plan.conflicts).toHaveLength(0);
  });

  it("同一文件再次导入仍走「更新」，不受冲突策略影响", () => {
    const plan = planSkillImport(
      [packFile("外部技能", "p/a/SKILL.md")].map((f) => ({ ...f, path: "/Users/t/x.md" })),
      existing,
      { onNameConflict: "rename" },
    );
    expect(plan.items[0].action).toBe("update");
    expect(plan.items[0].targetId).toBe("i1");
  });
});
