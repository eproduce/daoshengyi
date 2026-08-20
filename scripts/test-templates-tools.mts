// 临时测试：提示词模板数据 + ReAct 工具调用解析
import { PROMPT_TEMPLATES } from "../src/data/prompt-templates.ts";
import { parseToolCall, stripToolJson, formatToolResultPreview } from "../src/utils/tool-call.ts";

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

// DeepSeek DSML 原生 tool_call 格式（思考模式常输出），name 字段
const dsml = parseToolCall('<｜DSML｜tool_call｜>\n{"name":"list_directory","arguments":{"path":"/tmp"}}\n</｜DSML｜tool_call｜>');
assert(dsml !== null, "解析 DSML 格式工具调用");
assert(dsml?.tool === "list_directory", "DSML 用 name 字段映射 tool", JSON.stringify(dsml));
assert(dsml?.arguments?.path === "/tmp", "DSML arguments");

const dsmlHalf = parseToolCall('<|DSML|tool_call|>{"name":"read_file","arguments":{"path":"a"}}<|/DSML|tool_call|>');
assert(dsmlHalf?.tool === "read_file", "解析半角竖线 DSML");

const dsmlStripped = stripToolJson('先看<｜DSML｜tool_call｜>{"name":"x","arguments":{}}</｜DSML｜tool_call｜>然后继续');
assert(!dsmlStripped.includes('DSML') && dsmlStripped.includes('先看'), 'stripToolJson 剥离 DSML 标记');

const finalAnswer = parseToolCall('普通答案，包含 <tool_call> 字样但不是完整标签');
assert(finalAnswer === null, "不完整标签返回 null");

const toolResultText = '先看目录\n<tool_result>\n📁 src/\n├── app\n└── utils\n</tool_result>\n然后继续';
assert(stripToolJson(toolResultText).includes('先看目录') && !stripToolJson(toolResultText).includes('<tool_result>'), 'stripToolJson 去掉 tool_result 标签');

// DSML 格式裸 JSON 剥离（name 字段）
const dsmlBare = stripToolJson('{"name":"list_directory","arguments":{"path":"/tmp"}}');
assert(!dsmlBare.includes('list_directory'), 'stripToolJson 剥离 DSML 裸 JSON（name）');

const treeResult = formatToolResultPreview('directory_tree', '📁 op/\n├── app\n│   └── src\n└── docs');
assert(treeResult.includes('├── app') && treeResult.includes('└── docs'), 'directory_tree 预览保留树状结构');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
