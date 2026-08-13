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

// --- 模型价格表（美元 / 1M tokens）---
interface Pricing { input: number; output: number; label: string; }

const MODEL_PRICING: { match: string; p: Pricing }[] = [
  { match: "deepseek-reasoner", p: { input: 0.55, output: 2.19, label: "DeepSeek R1" } },
  { match: "deepseek-r1", p: { input: 0.55, output: 2.19, label: "DeepSeek R1" } },
  { match: "deepseek-chat", p: { input: 0.27, output: 1.10, label: "DeepSeek V3" } },
  { match: "deepseek-v3", p: { input: 0.27, output: 1.10, label: "DeepSeek V3" } },
  { match: "deepseek-v4", p: { input: 0.28, output: 0.42, label: "DeepSeek V4" } },
  { match: "deepseek", p: { input: 0.28, output: 0.42, label: "DeepSeek" } },
];

/// 根据模型名匹配价格（未命中时按 DeepSeek V4 默认价）
export function getPricing(model: string): Pricing {
  const m = model.toLowerCase();
  for (const item of MODEL_PRICING) {
    if (m.includes(item.match)) return item.p;
  }
  return { input: 0.28, output: 0.42, label: model };
}

/// 估算费用（美元）
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = getPricing(model);
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

/// 格式化费用显示
export function formatCost(cost: number): string {
  if (!cost || cost <= 0) return "$0.0000";
  if (cost < 0.0001) return `$${cost.toExponential(2)}`;
  return `$${cost.toFixed(4)}`;
}
