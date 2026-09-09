import { it, expect } from "vitest";
// S3 技能包渐进式披露路由：纯函数测试（路由清单 / 命中判定 / topN 选择）
import {
  buildSkillRoutingTable,
  scoreSkillMatch,
  matchSkillsForMessage,
  skillKeywordsOf,
} from "../src/utils/skill-router.ts";
import type { Skill } from "../src/types/index.ts";

console.log("\n== S3 skill-router（渐进披露路由纯函数） ==");

function makeSkill(p: Partial<Skill>): Skill {
  const now = Date.now();
  return {
    id: p.id || "s",
    name: p.name || "测试技能",
    description: p.description || "",
    prompt: p.prompt || "专家指令正文",
    enabled: true,
    category: p.category || "通用",
    source: "catalog",
    createdAt: now,
    updatedAt: now,
    ...p,
  };
}

const codeReview = makeSkill({
  id: "code-review",
  name: "代码审查",
  description: "资深代码审查专家，检查安全漏洞、性能问题和最佳实践",
  tags: ["代码", "审查", "安全"],
  whenToUse: "需要审查代码安全/质量时",
});
const shellExpert = makeSkill({
  id: "shell-expert",
  name: "Shell 专家",
  description: "精通 bash/zsh 脚本",
  tags: ["shell", "bash", "命令行"],
});
const gitMaster = makeSkill({
  id: "git-master",
  name: "Git 大师",
  description: "Git 工作流专家",
  tags: ["git", "版本控制", "工作流"],
});

it("buildSkillRoutingTable：空列表返回空串", () => {
  expect(buildSkillRoutingTable([])).toBe("");
});

it("buildSkillRoutingTable：每技能一行，含名称与描述/whenToUse", () => {
  const table = buildSkillRoutingTable([codeReview, gitMaster]);
  expect(table).toContain("代码审查");
  expect(table).toContain("需要审查代码安全/质量时"); // whenToUse 优先于 description
  expect(table).toContain("Git 大师");
  // 不包含正文
  expect(table).not.toContain("专家指令正文");
  expect(table.split("\n").length).toBe(2);
});

it("skillKeywordsOf：name 进 strong，tags 进 weak", () => {
  const { strong, weak } = skillKeywordsOf(codeReview);
  expect(strong).toContain("代码审查");
  expect(weak).toContain("代码");
  expect(weak).toContain("审查");
});

it("scoreSkillMatch：无关请求为 0", () => {
  expect(scoreSkillMatch("今天天气怎么样", codeReview)).toBe(0);
  expect(scoreSkillMatch("", codeReview)).toBe(0);
});

it("scoreSkillMatch：命中 tag 有分，直呼技能名更高", () => {
  const byTag = scoreSkillMatch("请审查这段代码的安全性", codeReview);
  expect(byTag).toBeGreaterThan(0);
  const byName = scoreSkillMatch("用代码审查帮我看看", codeReview);
  expect(byName).toBeGreaterThan(byTag);
});

it("matchSkillsForMessage：命中相关技能并按分排序取 topN", () => {
  const skills = [codeReview, shellExpert, gitMaster];
  const hits = matchSkillsForMessage("帮我提交 git 变更", skills, 2);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.some((s) => s.id === "git-master")).toBe(true);
});

it("matchSkillsForMessage：maxHits 截断", () => {
  const skills = [codeReview, shellExpert];
  // 请求同时含代码/审查/shell
  const hits = matchSkillsForMessage("用 shell 写脚本审查代码", skills, 1);
  expect(hits.length).toBeLessThanOrEqual(1);
});

it("matchSkillsForMessage：全部无关返回空", () => {
  const skills = [codeReview, shellExpert];
  expect(matchSkillsForMessage("推荐一部电影", skills, 2)).toEqual([]);
});

it("无 tags 的自定义技能回退 description 短语命中", () => {
  const custom = makeSkill({
    id: "custom",
    name: "周报助手",
    description: "生成周报，汇总进度",
  });
  expect(scoreSkillMatch("帮我生成周报", custom)).toBeGreaterThan(0);
  expect(scoreSkillMatch("推荐一部电影", custom)).toBe(0);
});
