import { it, expect } from "vitest";
// 临时测试：Token 估算与费用计算
import {
  estimateTokens,
  estimateMessageTokens,
  getPricing,
  estimateCost,
  formatCost,
} from "../src/utils/tokens.ts";


function assert(cond: boolean, name: string, detail = "") {
  expect(cond, name + (detail ? ` · ${detail}` : "")).toBe(true);
}


console.log("\n== estimateTokens ==");
assert(estimateTokens("") === 0, "空字符串为 0", `got ${estimateTokens("")}`);
assert(estimateTokens("hello") === 2, "英文 hello ≈ 2", `got ${estimateTokens("hello")}`);
assert(estimateTokens("你好世界") === 4, "中文 4 字 ≈ 4", `got ${estimateTokens("你好世界")}`);
assert(estimateTokens("你好 hello 世界") === 6, "中英混合 ≈ 6", `got ${estimateTokens("你好 hello 世界")}`);
assert(estimateTokens("a") === 1, "单字符最少 1", `got ${estimateTokens("a")}`);

console.log("\n== getPricing ==");
// DeepSeek 官方价格（人民币，高峰时段）
assert(getPricing("deepseek-chat").inputMiss === 0.5 && getPricing("deepseek-chat").output === 2.0, "deepseek-chat 价格", `got ${JSON.stringify(getPricing("deepseek-chat"))}`);
assert(getPricing("deepseek-v4-flash").label === "DeepSeek V4 Flash", "deepseek-v4-flash 匹配", `got ${getPricing("deepseek-v4-flash").label}`);
assert(getPricing("deepseek-v4-flash").inputMiss === 3.0, "deepseek-v4-flash 输入价", `got ${getPricing("deepseek-v4-flash").inputMiss}`);
assert(getPricing("deepseek-v4-pro").output === 27.0, "deepseek-v4-pro 输出价", `got ${getPricing("deepseek-v4-pro").output}`);
assert(getPricing("deepseek-reasoner").inputMiss === 1.0, "deepseek-reasoner 价格", `got ${getPricing("deepseek-reasoner").inputMiss}`);
assert(getPricing("unknown-model").inputMiss === 3.0, "未知模型回退 V4 Flash 价", `got ${getPricing("unknown-model").inputMiss}`);

console.log("\n== estimateCost ==");
// deepseek-v4-flash: 1M 输入(未命中)=3.0, 1M 输出=9.0 → 12 元
const c1 = estimateCost("deepseek-v4-flash", 1_000_000, 1_000_000);
assert(Math.abs(c1 - 12.0) < 1e-6, "deepseek-v4-flash 1M/1M ≈ ¥12.0", `got ${c1}`);
// 缓存命中：输入 1M 全部命中
const c1b = estimateCost("deepseek-v4-flash", 1_000_000, 1_000_000, 1_000_000);
assert(Math.abs(c1b - 9.10) < 1e-6, "缓存命中 1M/1M ≈ ¥9.1", `got ${c1b}`);
// deepseek-chat: 1M 输入=0.5, 1M 输出=2.0 → 2.5 元
const c2 = estimateCost("deepseek-chat", 1_000_000, 1_000_000);
assert(Math.abs(c2 - 2.5) < 1e-6, "deepseek-chat 1M/1M ≈ ¥2.5", `got ${c2}`);

console.log("\n== formatCost ==");
assert(formatCost(0) === "¥0.0000", "0 费用");
assert(formatCost(1.5) === "¥1.50", "元级小数", `got ${formatCost(1.5)}`);
assert(formatCost(0.0125) === "¥0.0125", "分以下小数", `got ${formatCost(0.0125)}`);
assert(formatCost(0.00001).startsWith("¥1"), "极小值科学计数", `got ${formatCost(0.00001)}`);

console.log("\n== estimateMessageTokens ==");
assert(estimateMessageTokens("内容", "推理") === 4, "content+reasoning", `got ${estimateMessageTokens("内容", "推理")}`);
it("脚本式断言（顶层执行）", () => {});
