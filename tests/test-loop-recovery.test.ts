import { describe, it, expect } from "vitest";
import { classifyRoundError, planCoercionMessage } from "../src/utils/loop-recovery.ts";

/**
 * 主循环的纠偏/降级判定。
 *
 * 最关键的是 `classifyRoundError`：一旦误判成「不支持 tools」，原生工具会被**永久**
 * 降级为文本语法（`nativeDegraded` 不回滚），整轮对话的工具调用质量立刻下降。
 * 原实现是 `/tool|function|tool_calls/i.test(msg) || /argument/i.test(msg)`，
 * 下面这些「含 tool 字样但其实和 tools 无关」的错误全被误伤。
 */
describe("classifyRoundError：不该降级的情形", () => {
  const noDegrade: Array<[string, string]> = [
    [
      "context-overflow",
      "This model's maximum context length is 65536 tokens. However, your messages resulted in 70000 tokens. Please reduce the length of the messages or tools.",
    ],
    ["context-overflow", "prompt is too long: 210000 tokens > 200000 maximum"],
    ["context-overflow", "上下文已超出模型长度限制"],
    ["transient", "[429] Rate limit reached for requests"],
    ["transient", "read timeout after 60000ms while streaming tool_calls"],
    ["transient", "ECONNRESET"],
    ["transient", "服务繁忙，请稍后再试（tool_calls 未返回）"],
    ["auth", "[401] Incorrect API key provided"],
    ["auth", "余额不足，请充值"],
    ["other", "模型未返回任何内容"],
  ];

  for (const [kind, msg] of noDegrade) {
    it(`${kind}：${msg.slice(0, 42)}…`, () => {
      const v = classifyRoundError(msg);
      expect(v.degradeNativeTools).toBe(false);
      expect(v.kind).toBe(kind);
    });
  }
});

describe("classifyRoundError：该降级的情形", () => {
  const degrade = [
    "This model does not support tools",
    "Tool calling is not supported for this endpoint",
    "unsupported parameter: 'tools'",
    "unknown field 'tools'",
    "该模型不支持工具调用",
  ];
  for (const msg of degrade) {
    it(`native-unsupported：${msg}`, () => {
      const v = classifyRoundError(msg);
      expect(v.degradeNativeTools).toBe(true);
      expect(v.kind).toBe("native-unsupported");
    });
  }

  it("裸 400 + tools 字样仍按参数错误降级（网关常见报法）", () => {
    expect(
      classifyRoundError("[400] invalid request: tools[0].function.name is invalid")
        .degradeNativeTools,
    ).toBe(true);
  });

  it("空消息不降级，也不抛错", () => {
    expect(classifyRoundError("")).toEqual({ kind: "other", degradeNativeTools: false });
    expect(classifyRoundError(undefined as unknown as string).degradeNativeTools).toBe(false);
  });

  it("优先级：上下文超长压过「不支持 tools」措辞", () => {
    const v = classifyRoundError("maximum context length exceeded; please reduce tools");
    expect(v.kind).toBe("context-overflow");
    expect(v.degradeNativeTools).toBe(false);
  });
});

describe("planCoercionMessage：三份话术收敛为一份", () => {
  it("三种场景都带确定的下一步（plan_task 与参数示例）", () => {
    for (const reason of ["native-calls", "text-call", "no-call"] as const) {
      const m = planCoercionMessage(reason);
      expect(m).toContain("【任务模式】");
      expect(m).toContain("plan_task");
      expect(m).toContain("plan_update");
      expect(m).toContain('"steps"');
    }
  });

  it("原生路径强调「用原生工具调用」，避免退回文本卡片语法", () => {
    expect(planCoercionMessage("native-calls")).toContain("用原生工具调用");
    expect(planCoercionMessage("text-call")).not.toContain("用原生工具调用");
  });

  it("每个场景说明各自的被拦原因（模型才知道要改什么）", () => {
    expect(planCoercionMessage("native-calls")).toContain("直接要调用实际工作工具");
    expect(planCoercionMessage("text-call")).toContain("正准备执行实际工作");
    expect(planCoercionMessage("no-call")).toContain("不要继续空想");
  });
});
