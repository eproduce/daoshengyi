import { describe, expect, it } from "vitest";
import { llamaVisionReady, localVisionHint } from "../src/utils/local-vision-hint.ts";

const ready = {
  bin_found: true,
  active_model: "llava-phi3-latest.gguf",
  has_projector: true,
};

const make = (
  over: Partial<Parameters<typeof localVisionHint>[0]> = {},
): Parameters<typeof localVisionHint>[0] => ({
  runtime: ready,
  hwVerdict: "recommended",
  busy: false,
  ...over,
});

describe("本地视觉引导横幅判定", () => {
  it("运行时已就绪 → 不引导", () => {
    expect(localVisionHint(make())).toBe("none");
  });

  it("导入/检测进行中 → 不打扰", () => {
    expect(localVisionHint(make({ busy: true, runtime: null }))).toBe("none");
  });

  it("尚未探测到状态 → 不显示", () => {
    expect(localVisionHint(make({ runtime: null }))).toBe("none");
  });

  it("缺 llama-server → 引导配置", () => {
    expect(localVisionHint(make({ runtime: { ...ready, bin_found: false } }))).toBe("deploy");
  });

  it("有二进制但没有模型 → 引导导入", () => {
    expect(localVisionHint(make({ runtime: { ...ready, active_model: "" } }))).toBe("deploy");
  });

  it("模型没有投影器（纯文本模型）→ 引导补多模态模型", () => {
    expect(localVisionHint(make({ runtime: { ...ready, has_projector: false } }))).toBe("deploy");
  });

  it("硬件不足 → 建议线上视觉 API", () => {
    expect(
      localVisionHint(
        make({ runtime: { ...ready, bin_found: false }, hwVerdict: "not_recommended" }),
      ),
    ).toBe("online-api");
  });

  it("llamaVisionReady 要求三要素齐全", () => {
    expect(llamaVisionReady(null)).toBe(false);
    expect(llamaVisionReady(ready)).toBe(true);
    expect(llamaVisionReady({ ...ready, bin_found: false })).toBe(false);
    expect(llamaVisionReady({ ...ready, active_model: "" })).toBe(false);
    expect(llamaVisionReady({ ...ready, has_projector: false })).toBe(false);
  });
});
