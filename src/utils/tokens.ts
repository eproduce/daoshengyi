/**
 * Token 估算与费用计算工具
 * 说明：本地估算，无法精确等同服务商计费，仅作参考
 */

/// 估算文本的 token 数
/// 经验法则：中文约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  let latinBuf = 0;

  const flush = () => {
    if (latinBuf > 0) {
      tokens += Math.ceil(latinBuf / 4);
      latinBuf = 0;
    }
  };

  for (const ch of text) {
    // CJK 统一表意文字、全角字符
    if (/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(ch)) {
      flush();
      tokens += 1;
    } else {
      latinBuf += 1;
    }
  }
  flush();
  return Math.max(1, tokens);
}

/// 估算单条消息的 token（含思考内容）
export function estimateMessageTokens(content: string, reasoning?: string): number {
  return estimateTokens(content) + estimateTokens(reasoning || "");
}

// --- 模型价格表（人民币 元 / 1M tokens）---
// 数据来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// 采用高峰时段价格（保守估算），输入区分缓存命中/未命中
interface Pricing {
  inputHit: number;   // 缓存命中输入价（元/1M）
  inputMiss: number;  // 缓存未命中输入价（元/1M）
  output: number;     // 输出价（元/1M）
  label: string;
}

const MODEL_PRICING: { match: string; p: Pricing }[] = [
  { match: "deepseek-v4-pro", p: { inputHit: 0.30, inputMiss: 9.0, output: 27.0, label: "DeepSeek V4 Pro" } },
  { match: "deepseek-v4-flash", p: { inputHit: 0.10, inputMiss: 3.0, output: 9.0, label: "DeepSeek V4 Flash" } },
  { match: "deepseek-v4", p: { inputHit: 0.10, inputMiss: 3.0, output: 9.0, label: "DeepSeek V4" } },
  { match: "deepseek-reasoner", p: { inputHit: 0.25, inputMiss: 1.0, output: 4.0, label: "DeepSeek R1" } },
  { match: "deepseek-r1", p: { inputHit: 0.25, inputMiss: 1.0, output: 4.0, label: "DeepSeek R1" } },
  { match: "deepseek-chat", p: { inputHit: 0.10, inputMiss: 0.5, output: 2.0, label: "DeepSeek V3" } },
  { match: "deepseek-v3", p: { inputHit: 0.10, inputMiss: 0.5, output: 2.0, label: "DeepSeek V3" } },
  { match: "deepseek", p: { inputHit: 0.10, inputMiss: 3.0, output: 9.0, label: "DeepSeek" } },
];

/// 根据模型名匹配价格（未命中时按 DeepSeek V4 Flash 默认价）
export function getPricing(model: string): Pricing {
  const m = model.toLowerCase();
  for (const item of MODEL_PRICING) {
    if (m.includes(item.match)) return item.p;
  }
  return { inputHit: 0.10, inputMiss: 3.0, output: 9.0, label: model };
}

/// 估算费用（人民币 元）
/// 输入 token 无法区分缓存命中，默认按未命中价（保守）；可传入缓存命中 token 数提高精度
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheHitInputTokens = 0,
): number {
  const p = getPricing(model);
  const hit = Math.min(cacheHitInputTokens, inputTokens);
  const miss = Math.max(0, inputTokens - hit);
  const hitCost = (hit / 1_000_000) * p.inputHit;
  const missCost = (miss / 1_000_000) * p.inputMiss;
  const outCost = (outputTokens / 1_000_000) * p.output;
  return hitCost + missCost + outCost;
}

/// 格式化费用显示（人民币）
export function formatCost(cost: number): string {
  if (!cost || cost <= 0) return "¥0.0000";
  if (cost < 0.0001) return `¥${cost.toExponential(2)}`;
  if (cost >= 1) return `¥${cost.toFixed(2)}`;
  return `¥${cost.toFixed(4)}`;
}
