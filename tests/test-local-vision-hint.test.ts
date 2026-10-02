import { describe, it, expect } from "vitest";
import {
  localVisionHint,
  llamaVisionReady,
  ollamaVisionReady,
  type LocalVisionHintInput,
} from "../src/utils/local-vision-hint.ts";

const base: LocalVisionHintInput = {
  status: { installed: false, running: false, installing: false, models: [] },
  runtime: { bin_found: false, active_model: "", has_projector: false },
  hwVerdict: "recommended",
  busy: false,
};

/** 组装输入，只覆盖关心的字段 */
const make = (o: Partial<LocalVisionHintInput>): LocalVisionHintInput => ({ ...base, ...o });

const llamaReady = { bin_found: true, active_model: "qwen2-vl.gguf", has_projector: true };
const ollamaReady = {
  installed: true,
  running: true,
  installing: false,
  models: ["llava-phi3:latest"],
};

describe("localVisionHint：本地视觉引导横幅判定", () => {
  // 回归（2026-10-02）：llama.cpp 已能识图时不该再催用户「一键部署 Ollama」
  it("llama.cpp 本地视觉就绪 → 不引导（即便 Ollama 完全没装）", () => {
    expect(localVisionHint(make({ runtime: llamaReady }))).toBe("none");
  });

  it("回退链路 Ollama 就绪 → 不引导（即便没装 llama.cpp）", () => {
    expect(localVisionHint(make({ status: ollamaReady }))).toBe("none");
  });

  it("两者都没就绪 + 硬件允许 → 引导配置（首选 llama.cpp）", () => {
    expect(
      localVisionHint(
        make({ runtime: { bin_found: false, active_model: "", has_projector: false } }),
      ),
    ).toBe("deploy");
    // 有 llama-server 但只导入了纯文本模型（无投影器）→ 仍需引导去补多模态模型
    expect(
      localVisionHint(
        make({
          runtime: { bin_found: true, active_model: "llama-3-8b.gguf", has_projector: false },
        }),
      ),
    ).toBe("deploy");
    // 装了二进制但一个模型都没导入
    expect(
      localVisionHint(
        make({ runtime: { bin_found: true, active_model: "", has_projector: false } }),
      ),
    ).toBe("deploy");
  });

  it("硬件不足 → 建议线上视觉 API（而不是劝本地部署）", () => {
    expect(localVisionHint(make({ hwVerdict: "not_recommended" }))).toBe("online-api");
    // 但硬件不足 + llama.cpp 已就绪 → 已能识图，不再提线上 API
    expect(localVisionHint(make({ hwVerdict: "not_recommended", runtime: llamaReady }))).toBe(
      "none",
    );
  });

  it("部署 / 导入进行中 → 不打扰", () => {
    expect(localVisionHint(make({ busy: true }))).toBe("none");
    expect(
      localVisionHint(
        make({
          busy: true,
          status: { installed: false, running: false, installing: true, models: [] },
        }),
      ),
    ).toBe("none");
  });

  it("Ollama 正在安装中 → 不打扰（避免重复引导）", () => {
    expect(
      localVisionHint(
        make({ status: { installed: false, running: false, installing: true, models: [] } }),
      ),
    ).toBe("none");
  });

  it("状态尚未探测到 → 不显示横幅", () => {
    expect(localVisionHint(make({ status: null }))).toBe("none");
  });

  // 回归（2026-10-02 用户实测）：Ollama 已装、llava-phi3 就在磁盘上，只是**服务没开着**，
  // 就被判「未配置」并一直弹引导横幅催着重新下载 2GB 模型。服务其实会在识图时按需自启。
  it("Ollama 装了 + 视觉模型在盘上 → 就绪（服务没跑也算）", () => {
    expect(
      localVisionHint(
        make({
          status: { installed: true, running: false, installing: false, models: ["llava-phi3"] },
        }),
      ),
    ).toBe("none");
    // Rust 侧给权威标志位（离线读到 manifests）时同样判就绪
    expect(
      localVisionHint(
        make({
          status: {
            installed: true,
            running: false,
            installing: false,
            models: [],
            ollama_vision_ready: true,
          },
        }),
      ),
    ).toBe("none");
  });

  it("Ollama 装了但没有视觉模型 → 仍需引导", () => {
    expect(
      localVisionHint(
        make({
          status: { installed: true, running: true, installing: false, models: ["qwen2.5:7b"] },
        }),
      ),
    ).toBe("deploy");
    // 没装 Ollama
    expect(
      localVisionHint(
        make({ status: { installed: false, running: false, installing: false, models: [] } }),
      ),
    ).toBe("deploy");
  });
});

describe("两个就绪判定各自独立可用", () => {
  it("llamaVisionReady 要求二进制 + 模型 + 投影器三者齐备", () => {
    expect(llamaVisionReady(null)).toBe(false);
    expect(llamaVisionReady(llamaReady)).toBe(true);
    expect(llamaVisionReady({ ...llamaReady, has_projector: false })).toBe(false);
    expect(llamaVisionReady({ ...llamaReady, bin_found: false })).toBe(false);
    expect(llamaVisionReady({ ...llamaReady, active_model: "" })).toBe(false);
  });

  it("ollamaVisionReady 要求已安装 + 有视觉模型（不要求服务在跑）", () => {
    expect(ollamaVisionReady(null)).toBe(false);
    expect(ollamaVisionReady(ollamaReady)).toBe(true);
    // 服务没开也算就绪：识图时会按需自启（ensure_ollama_server）
    expect(ollamaVisionReady({ ...ollamaReady, running: false })).toBe(true);
    // 没有视觉模型 → 未就绪
    expect(ollamaVisionReady({ ...ollamaReady, models: [] })).toBe(false);
    // 没装 Ollama → 未就绪（即便标志位为真也不认，避免脏状态）
    expect(ollamaVisionReady({ ...ollamaReady, installed: false })).toBe(false);
    // Rust 侧权威标志位优先
    expect(
      ollamaVisionReady({
        installed: true,
        running: false,
        installing: false,
        models: [],
        ollama_vision_ready: true,
      }),
    ).toBe(true);
  });
});
