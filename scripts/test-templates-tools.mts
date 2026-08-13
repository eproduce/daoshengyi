// 临时测试：提示词模板数据 + ReAct 工具调用解析
import { PROMPT_TEMPLATES } from "../src/data/prompt-templates.ts";
import { parseToolCall } from "../src/utils/tool-call.ts";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${detail}`); }
}

console.log("\n== PROMPT_TEMPLATES 完整性 ==");
assert(PROMPT_TEMPLATES.length >= 8, "至少 8 个模板", `got ${PROMPT_TEMPLATES.length}`);
const ids = new Set<string>();
let allValid = true;
for (const t of PROMPT_TEMPLATES) {
  if (!t.id || !t.name || !t.prompt || !t.description || !t.category) allValid = false;
  if (ids.has(t.id)) { allValid = false; console.error(`    重复 id: ${t.id}`); }
  ids.add(t.id);
}
assert(allValid, "所有模板字段完整且 id 唯一");

console.log("\n== parseToolCall（直接 import 真实实现） ==");

const valid = parseToolCall('需要查询\n<tool_call>\n{"server":"fetch","tool":"get","arguments":{"url":"https://x.com"}}\n</tool_call>');
assert(valid !== null, "解析合法工具调用");
assert(valid?.tool === "get", "提取 tool 名", JSON.stringify(valid));
assert(valid?.server === "fetch", "提取 server 名");
assert(valid?.arguments?.url === "https://x.com", "提取 arguments");

const noServer = parseToolCall('<tool_call>{"tool":"ping","arguments":{}}</tool_call>');
assert(noServer?.server === "default", "缺省 server 回退 default", JSON.stringify(noServer));

const noCall = parseToolCall("这是普通回答，没有工具调用");
assert(noCall === null, "无工具调用返回 null");

const badJson = parseToolCall('<tool_call>not json</tool_call>');
assert(badJson === null, "非法 JSON 返回 null");

const noTool = parseToolCall('<tool_call>{"server":"x","arguments":{}}</tool_call>');
assert(noTool === null, "缺 tool 字段返回 null");

const finalAnswer = parseToolCall('普通答案，包含 <tool_call> 字样但不是完整标签');
assert(finalAnswer === null, "不完整标签返回 null");

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
