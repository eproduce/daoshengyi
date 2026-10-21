/**
 * 本地视觉引导横幅的判定（纯函数，便于单测）。
 *
 * 本地视觉只有 llama.cpp 一个后端：llama-server + 带投影器（mmproj）的 GGUF 就绪即可识图。
 * 任一条件缺失就引导用户去「设置 → 本地模型」补齐；硬件不足则建议改用线上视觉 API。
 */

export interface LocalVisionHintInput {
  /** `local_runtime_status` 的结果（null = 尚未探测到） */
  runtime: {
    bin_found: boolean;
    active_model: string;
    has_projector: boolean;
  } | null;
  /** 硬件评估结论：recommended / warning / not_recommended */
  hwVerdict?: string | null;
  /** 导入 / 检测进行中 */
  busy?: boolean;
}

/** none=无需引导；deploy=引导配置本地视觉；online-api=建议配置线上视觉 API */
export type LocalVisionHint = "none" | "deploy" | "online-api";

/** llama.cpp 本地视觉是否可用：二进制 + 已导入模型 + 该模型带投影器（mmproj） */
export function llamaVisionReady(rt: LocalVisionHintInput["runtime"]): boolean {
  return rt?.bin_found === true && !!rt.active_model && rt.has_projector === true;
}

export function localVisionHint(input: LocalVisionHintInput): LocalVisionHint {
  if (input.busy) return "none"; // 导入/检测中：不打扰
  if (!input.runtime) return "none"; // 还没探测到状态
  if (llamaVisionReady(input.runtime)) return "none"; // 已能识图
  if (input.hwVerdict === "not_recommended") return "online-api"; // 硬件不足 → 走线上
  return "deploy"; // 缺 llama.cpp 或缺模型 → 引导补齐
}
