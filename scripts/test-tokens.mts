// 临时测试：Token 估算与费用计算
import {
  estimateTokens,
  estimateMessageTokens,
  getPricing,
  estimateCost,
  formatCost,
} from "../src/utils/tokens.ts";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

console.log("\n== estimateTokens ==");
assert(estimateTokens("") === 0, "空字符串为 0", `got ${estimateTokens("")}`);
assert(estimateTokens("hello") === 2, "英文 hello ≈ 2", `got ${estimateTokens("hello")}`);
assert(estimateTokens("你好世界") === 4, "中文 4 字 ≈ 4", `got ${estimateTokens("你好世界")}`);
assert(estimateTokens("你好 hello 世界") === 6, "中英混合 ≈ 6", `got ${estimateTokens("你好 hello 世界")}`);
assert(estimateTokens("a") === 1, "单字符最少 1", `got ${estimateTokens("a")}`);

console.log("\n== getPricing ==");
assert(getPricing("deepseek-chat").input === 0.27, "deepseek-chat 价格", `got ${getPricing("deepseek-chat").input}`);
assert(getPricing("deepseek-v4-flash").label === "DeepSeek V4", "deepseek-v4-flash 匹配 V4", `got ${getPricing("deepseek-v4-flash").label}`);
assert(getPricing("deepseek-v4-pro").label === "DeepSeek V4", "deepseek-v4-pro 匹配 V4", `got ${getPricing("deepseek-v4-pro").label}`);
assert(getPricing("deepseek-reasoner").output === 2.19, "deepseek-reasoner 价格", `got ${getPricing("deepseek-reasoner").output}`);
assert(getPricing("unknown-model").input === 0.28, "未知模型回退 DeepSeek V4 默认价", `got ${getPricing("unknown-model").input}`);

console.log("\n== estimateCost ==");
// deepseek-v4: 1M input=0.28, 1M output=0.42
const c1 = estimateCost("deepseek-v4-flash", 1_000_000, 1_000_000);
assert(Math.abs(c1 - 0.70) < 1e-6, "deepseek-v4 1M/1M ≈ $0.70", `got ${c1}`);
const c2 = estimateCost("deepseek-chat", 1_000_000, 1_000_000);
assert(Math.abs(c2 - 1.37) < 1e-6, "deepseek-chat 1M/1M ≈ $1.37", `got ${c2}`);

console.log("\n== formatCost ==");
assert(formatCost(0) === "$0.0000", "0 费用");
assert(formatCost(0.0125) === "$0.0125", "常规小数", `got ${formatCost(0.0125)}`);
assert(formatCost(0.00001).startsWith("$1"), "极小值科学计数", `got ${formatCost(0.00001)}`);

console.log("\n== estimateMessageTokens ==");
assert(estimateMessageTokens("内容", "推理") === 4, "content+reasoning", `got ${estimateMessageTokens("内容", "推理")}`);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
