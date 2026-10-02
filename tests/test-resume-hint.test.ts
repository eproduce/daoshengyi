// 断点续跑提示单测：关键是「裸续跑指令」的识别边界（带新要求的不算）
import { describe, it, expect } from "vitest";
import { isBareContinue, resumePrompt } from "../src/utils/resume-hint";

describe("isBareContinue", () => {
  it("识别常见裸续跑指令（含标点/空白/大小写）", () => {
    for (const s of [
      "继续",
      "继续。",
      " 继续！ ",
      "接着做",
      "接着来",
      "往下做",
      "continue",
      "Continue!",
      "go on",
      "resume",
    ]) {
      expect(isBareContinue(s), s).toBe(true);
    }
  });

  it("带新要求的不算（那是新任务，别注入“别重来”）", () => {
    for (const s of [
      "继续优化 X",
      "继续，但要先跑测试",
      "接着做第 3 步的图片下载",
      "继续完善 agent 的报错处理",
      "",
      "   ",
    ]) {
      expect(isBareContinue(s), s).toBe(false);
    }
  });

  it("超长文本一律不算（即使以「继续」开头）", () => {
    expect(isBareContinue(`继续${"啊".repeat(20)}`)).toBe(false);
  });
});

describe("resumePrompt", () => {
  it("列出未完成步骤，明确“从断点接着做”", () => {
    const p = resumePrompt([
      { text: "下载 20 张图片", status: "doing" },
      { text: "生成 markdown", status: "todo" },
      { text: "校验链接", status: "done" },
    ]);
    expect(p).toContain("断点续跑");
    expect(p).toContain("不要从头重来");
    expect(p).toContain("下载 20 张图片");
    expect(p).toContain("生成 markdown");
    expect(p).not.toContain("校验链接"); // 已完成的不列
    expect(p).toContain("共 2 项");
  });

  it("没有未完成步骤时：要求核对现状、不凭空新增工作", () => {
    const p = resumePrompt([{ text: "全部做完了", status: "done" }]);
    expect(p).toContain("没有未完成");
    expect(p).toContain("不要凭空新增工作");
  });

  it("空/缺省入参不报错", () => {
    expect(resumePrompt()).toContain("断点续跑");
    expect(resumePrompt([])).toContain("断点续跑");
  });

  it("提示模型：同一失败原因不要原样重发", () => {
    const p = resumePrompt([{ text: "抓取数据", status: "todo" }]);
    expect(p).toContain("不要原样重发");
  });
});
