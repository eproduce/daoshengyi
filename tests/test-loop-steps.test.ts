import { describe, it, expect } from "vitest";
import {
  BIG_WRITE_SPLIT_HINT,
  decideNativeStep,
  decideNoToolStep,
  isVagueBody,
  looksLikeBigWriteTruncation,
  type NoToolInput,
} from "../src/utils/loop-steps.ts";

/**
 * 工具循环的步进决策。**这些规则以前埋在 1,700 行的 async 函数里，一条都测不了。**
 *
 * 重点不是「每个分支都能返回」，而是**顺序**与**次数约束**：
 * - 意图未闭合必须排在正文空洞之前（否则半截标记会被当成空洞反复重试，永远补不上）；
 * - 假完成只警告一次（否则打断刚开始执行的模型）；
 * - 除计划纠偏外都要求「还有下一轮」，用完了就得如实收尾。
 */
const base = (over: Partial<NoToolInput> = {}): NoToolInput => ({
  content: "这是完整的最终答案，包含结论与要点。" + "x".repeat(80),
  round: 1,
  maxRounds: 30,
  taskMode: false,
  hasPlan: false,
  planNudged: false,
  didRealWork: true,
  fakeCompletionWarned: false,
  hasCompleteCall: false,
  hasIntent: false,
  ...over,
});

describe("decideNoToolStep：优先级", () => {
  it("正常回答 → finish（去收尾，不再纠偏）", () => {
    expect(decideNoToolStep(base()).kind).toBe("finish");
  });

  it("任务模式没建计划 → 先纠偏规划，哪怕同时存在格式问题", () => {
    const step = decideNoToolStep(
      base({ taskMode: true, hasPlan: false, hasCompleteCall: true, hasIntent: true }),
    );
    expect(step.kind).toBe("plan-nudge");
    if (step.kind === "plan-nudge") {
      expect(step.userText).toContain("plan_task");
      expect(step.assistantText).toBeTruthy();
    }
  });

  it("计划纠偏只做一次（planNudged 之后不再拦）", () => {
    const step = decideNoToolStep(base({ taskMode: true, hasPlan: false, planNudged: true }));
    expect(step.kind).not.toBe("plan-nudge");
  });

  it("有闭合标记但解析失败 → invalid-format", () => {
    expect(decideNoToolStep(base({ hasCompleteCall: true })).kind).toBe("invalid-format");
  });

  it("意图未闭合必须排在正文空洞之前（半截标记不能被当成空洞）", () => {
    // 内容同时满足「有意图」与「空洞」——顺序决定结果
    const content = "我这就去访问官网获取信息";
    expect(isVagueBody(content)).toBe(true);
    const step = decideNoToolStep(base({ content, hasIntent: true }));
    expect(step.kind).toBe("call-intent");
    if (step.kind === "call-intent") expect(step.userText).toContain("完整合法");
  });

  it("大 write_file 被截断时，意图分支给的是「分段写入」而不是「原样重试」", () => {
    const content =
      '{"tool":"write_file","arguments":{"path":"a.html","content":"' + "x".repeat(3000);
    expect(looksLikeBigWriteTruncation(content)).toBe(true);
    const step = decideNoToolStep(base({ content, hasIntent: true }));
    expect(step.kind).toBe("call-intent");
    if (step.kind === "call-intent") expect(step.userText).toBe(BIG_WRITE_SPLIT_HINT);
  });

  it("只有过程声明 → vague-body", () => {
    const step = decideNoToolStep(base({ content: "接下来我去查询相关资料" }));
    expect(step.kind).toBe("vague-body");
  });

  it("任务模式建了计划但没做实际工作 → fake-completion，且只警告一次", () => {
    const first = decideNoToolStep(base({ taskMode: true, hasPlan: true, didRealWork: false }));
    expect(first.kind).toBe("fake-completion");
    const again = decideNoToolStep(
      base({ taskMode: true, hasPlan: true, didRealWork: false, fakeCompletionWarned: true }),
    );
    expect(again.kind).toBe("finish");
  });
});

describe("decideNoToolStep：轮次边界", () => {
  it("只剩最后一轮时不再注入修正（否则永远到不了最终答案）", () => {
    const last = base({ round: 29, maxRounds: 30, hasCompleteCall: true });
    expect(decideNoToolStep(last).kind).toBe("finish");
  });

  it("但计划纠偏不受轮次限制（它本来就要靠 next-round 退出）", () => {
    const last = base({ round: 29, maxRounds: 30, taskMode: true, hasPlan: false });
    expect(decideNoToolStep(last).kind).toBe("plan-nudge");
  });
});

describe("decideNativeStep", () => {
  const n = (over = {}) => ({
    content: "",
    finishReason: "tool_calls" as string | null,
    truncatedCount: 0,
    hasPlanCall: false,
    taskMode: false,
    hasPlan: false,
    planNudged: false,
    ...over,
  });

  it("正常 → invoke", () => {
    expect(decideNativeStep(n()).kind).toBe("invoke");
  });

  it("finishReason=length 且有截断调用 → truncated（不派发空参数调用）", () => {
    const step = decideNativeStep(n({ finishReason: "length", truncatedCount: 2 }));
    expect(step.kind).toBe("truncated");
    if (step.kind === "truncated") expect(step.userText).toBe(BIG_WRITE_SPLIT_HINT);
  });

  it("截断优先于计划纠偏（否则会先逼它建计划、再撞一次同样的上限）", () => {
    const step = decideNativeStep(n({ finishReason: "length", truncatedCount: 1, taskMode: true }));
    expect(step.kind).toBe("truncated");
  });

  it("有截断但不是 length 结束（正常结束）→ 仍按正常派发", () => {
    expect(decideNativeStep(n({ finishReason: "tool_calls", truncatedCount: 1 })).kind).toBe(
      "invoke",
    );
  });

  it("任务模式没计划就调实际工具 → plan-nudge；已含 plan_task 则放行", () => {
    expect(decideNativeStep(n({ taskMode: true })).kind).toBe("plan-nudge");
    expect(decideNativeStep(n({ taskMode: true, hasPlanCall: true })).kind).toBe("invoke");
    expect(decideNativeStep(n({ taskMode: true, hasPlan: true })).kind).toBe("invoke");
    expect(decideNativeStep(n({ taskMode: true, planNudged: true })).kind).toBe("invoke");
  });
});

describe("isVagueBody", () => {
  it("空正文、只有工具卡片占位、带引导词的短声明都算空洞", () => {
    for (const s of [
      "",
      "   ",
      "### 🔧 调用工具",
      "接下来我去查询相关资料",
      "我去访问官网获取信息",
    ]) {
      expect(isVagueBody(s)).toBe(true);
    }
  });

  it("（保持既有口径）只有加粗标题、或动词不在引导词表里时不算空洞", () => {
    // 这两条不是"应该如此"，而是**现状**：改了会影响收尾判定，必须有意识地改。
    // 「读取」不在动词表里 —— 若哪天要收窄空洞判定，先改这里再看回归。
    expect(isVagueBody("**检查页面元素**")).toBe(false);
    expect(isVagueBody("我这就去读取文件")).toBe(false);
  });

  it("有结构或够长就不是空洞", () => {
    expect(isVagueBody("- 第一条\n- 第二条")).toBe(false);
    expect(isVagueBody("结论：可以集成，前提是补齐运行时。")).toBe(false);
    expect(isVagueBody("x".repeat(200))).toBe(false);
  });
});
