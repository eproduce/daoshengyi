/**
 * 本地视觉引导横幅的判定（纯函数，便于单测）。
 *
 * ## 背景（2026-10-02）
 * llama.cpp 已成为本地视觉的**首选**后端（`pick_vision_backend` 的 auto：llama.cpp 就绪
 * 就用它，Ollama 退为回退）。但引导横幅原先只判断「Ollama 是否就绪」——
 * 用户明明已经装好 llama.cpp + 导入多模态模型、识图完全可用，横幅还在催他“一键部署
 * Ollama + llava-phi3”（约 2GB 白下）。这里把判定收口成一处，并按新的优先级重写。
 *
 * ## 判定顺序（先判“已就绪”，再判“该引导谁”）
 * 1. 部署/导入进行中 → 不打扰
 * 2. 还没探测到状态 → 不显示
 * 3. **llama.cpp 本地视觉真的可用**（llama-server + 已导入模型 + 带投影器）→ 不引导
 * 4. 回退链路 Ollama 就绪（已安装 + 服务在跑 + 有 llava-phi3）→ 不引导
 * 5. 硬件评估为 not_recommended → 建议线上视觉 API
 * 6. 其余 → 引导配置本地视觉（首选 llama.cpp，Ollama 作回退）
 *
 * 第 3 步刻意**不**用 `status.vision_backend === "llamacpp"` 代替：那个只代表「llama.cpp
 * 可用」（有二进制 + 任一非嵌入 GGUF）；导入的若是纯文本模型，视觉照样跑不起来，那种情况
 * 恰恰更需要继续引导用户去补一个带投影器的多模态模型。
 */

export interface LocalVisionHintInput {
  /** `ollama_status` 的结果（null = 尚未探测到） */
  status: {
    installed: boolean;
    running: boolean;
    installing: boolean;
    models?: string[];
  } | null;
  /** `local_runtime_status` 的结果（null = 尚未探测到） */
  runtime: {
    bin_found: boolean;
    active_model: string;
    has_projector: boolean;
  } | null;
  /** 硬件评估结论：recommended / warning / not_recommended */
  hwVerdict?: string | null;
  /** 部署 / 导入进行中 */
  busy?: boolean;
}

/** none=无需引导；deploy=引导配置本地视觉；online-api=建议配置线上视觉 API */
export type LocalVisionHint = "none" | "deploy" | "online-api";

/** 回退链路（Ollama）是否已就绪 */
const OLLAMA_VISION_MODEL = "llava-phi3";

/** llama.cpp 本地视觉是否可用：二进制 + 已导入模型 + 该模型带投影器（mmproj） */
export function llamaVisionReady(rt: LocalVisionHintInput["runtime"]): boolean {
  return rt?.bin_found === true && !!rt.active_model && rt.has_projector === true;
}

/** 回退链路（Ollama）是否已就绪 */
export function ollamaVisionReady(status: LocalVisionHintInput["status"]): boolean {
  if (!status) return false;
  const hasModel = status.models?.some((m) => m.includes(OLLAMA_VISION_MODEL)) ?? false;
  return status.installed && status.running && hasModel;
}

export function localVisionHint(input: LocalVisionHintInput): LocalVisionHint {
  if (input.busy) return "none"; // 部署/导入中：不打扰
  if (!input.status) return "none"; // 还没探测到状态
  if (llamaVisionReady(input.runtime)) return "none"; // 首选后端已能识图
  if (ollamaVisionReady(input.status)) return "none"; // 回退链路已能识图
  if (input.status.installing) return "none"; // Ollama 正在安装：不打扰
  if (input.hwVerdict === "not_recommended") return "online-api"; // 硬件不足 → 走线上
  return "deploy"; // recommended / warning 都允许本地部署
}
