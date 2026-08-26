// 临时测试：提示词模板数据 + ReAct 工具调用解析
import { PROMPT_TEMPLATES } from "../src/data/prompt-templates.ts";
import { parseToolCall, stripToolJson, formatToolResultPreview, hasCompleteToolCall, visibleText } from "../src/utils/tool-call.ts";
import { withBrowserLock, browserLockIdle } from "../src/utils/browser-lock.ts";
import { BUILTIN_TOOLS, BUILTIN_TOOL_NAMES, validBuiltinTools } from "../src/data/builtin-tools.ts";
import { AGENT_ROLES, getRoleById, roleAllowedToolNames, invalidRoleTools } from "../src/data/roles-catalog.ts";
import { embeddingSource, isOllamaBase } from "../src/utils/embed-provider.ts";
import { isToolDisabled, isPathAllowed, pathArgOf } from "../src/utils/permissions.ts";
import { buildReviewPrompt, parseReviewActions } from "../src/utils/memory-review.ts";
import { routeProfileId } from "../src/utils/model-routing.ts";

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

// 截图里的双竖线 + 空格变体：< | | DSML | | tool_call >
const dsmlSpacePipes = parseToolCall('< | | DSML | | tool_call >{"name":"list_dir","arguments":{"path":"/tmp"}}< / | | DSML | | tool_call >');
assert(dsmlSpacePipes?.tool === "list_dir", "解析双竖线+空格 DSML 变体", JSON.stringify(dsmlSpacePipes));
assert(dsmlSpacePipes?.arguments?.path === "/tmp", "双竖线变体 arguments");

const dsmlMulti = stripToolJson('块一<｜DSML｜tool_call｜>{"name":"a","arguments":{}}</｜DSML｜tool_call｜>中<|DSML|tool_call|>{"name":"b","arguments":{}}<|/DSML|tool_call|>块二');
assert(!dsmlMulti.includes('DSML') && dsmlMulti.includes('块一') && dsmlMulti.includes('中') && dsmlMulti.includes('块二'), 'stripToolJson 剥离多处 DSML 块');

// 流式可见正文：剔除工具调用标记（含未闭合半截），不闪现乱码
assert(visibleText('先看<｜DSML｜tool_call｜>{"name":"a","arguments":{}}</｜DSML｜tool_call｜>再答') === '先看', 'visibleText 剔除已闭合 DSML 块');
assert(visibleText('再看<｜DSML｜tool_') === '再看', 'visibleText 截断未闭合 DSML 开标记（半截）');
assert(visibleText('正文<tool_call>{"server":"a","tool":"b","arguments":{}}</tool_call>尾') === '正文', 'visibleText 剔除标准 tool_call 块');
assert(visibleText('连续块一<｜DSML｜tool_call｜>{"name":"a","arguments":{}}</｜DSML｜tool_call｜>中<｜DSML｜tool_call｜>') === '连续块一', 'visibleText 多工具块只留第一块前正文');
assert(visibleText('普通回复：这是一个测试。') === '普通回复：这是一个测试。', 'visibleText 无工具调用时原样保留');

// 工具调用闭合标记检测（流式停止条件）：标准 + DSML 各变体
assert(hasCompleteToolCall('<tool_call>{"server":"a","tool":"b","arguments":{}}</tool_call>'), '识别标准闭合标记');
assert(hasCompleteToolCall('<｜DSML｜tool_call｜>{"name":"a","arguments":{}}</｜DSML｜tool_call｜>'), '识别 DSML 闭合标记');
assert(hasCompleteToolCall('<|DSML|tool_call|>{"name":"a","arguments":{}}<|/DSML|tool_call|>'), '识别半角 DSML 闭合标记');
assert(hasCompleteToolCall('< | | DSML | | tool_call >{"name":"a","arguments":{}}< / | | DSML | | tool_call >'), '识别双竖线+空格 DSML 闭合标记');
assert(!hasCompleteToolCall('<tool_call>{"server":"a","tool":"b","arguments":{}}'), '半截 JSON 未闭合返回 false');

// 模型手写伪卡片（### 🔧 调用工具 + 参数 JSON）：也要能提取执行 + 识别闭合
const fakeCard = '### 🔧 调用工具：`directory_tree`\n\n<details><summary>参数</summary>\n\n```json\n{"path":"/Users/x/src"}\n```\n\n</details>';
assert(hasCompleteToolCall(fakeCard), '识别伪卡片闭合（</details>）');
const fakeParsed = parseToolCall(fakeCard);
assert(fakeParsed?.tool === "directory_tree" && fakeParsed?.arguments?.path === "/Users/x/src", '从伪卡片提取工具调用', JSON.stringify(fakeParsed));
assert(!hasCompleteToolCall('### 🔧 调用工具：`directory_tree`\n<details><summary>参数</summary>'), '伪卡片未闭合返回 false');

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

// 浏览器串行锁（P-M2 并行子代理安全）：并发 puppeteer 操作必须严格 FIFO 串行，
// 且前一个失败不能锁死队列（finally 释放）
console.log("\n== withBrowserLock 浏览器串行锁 ==");
{
  const order: string[] = [];
  await Promise.all([
    withBrowserLock(async () => { order.push("a-start"); await new Promise(r => setTimeout(r, 30)); order.push("a-end"); }),
    withBrowserLock(async () => { order.push("b-start"); order.push("b-end"); }),
  ]);
  assert(order.join(",") === "a-start,a-end,b-start,b-end", "并发操作严格串行（FIFO）", order.join(","));

  const order2: string[] = [];
  const p1 = withBrowserLock(async () => { order2.push("x"); throw new Error("boom"); });
  const p2 = withBrowserLock(async () => { order2.push("y"); });
  await Promise.allSettled([p1, p2]);
  assert(order2.join(",") === "x,y", "前一个失败后队列继续（不锁死）", order2.join(","));

  // 三个并发：保持插入顺序
  const order3: string[] = [];
  await Promise.all([
    withBrowserLock(async () => { order3.push("1"); await new Promise(r => setTimeout(r, 10)); }),
    withBrowserLock(async () => { order3.push("2"); await new Promise(r => setTimeout(r, 5)); }),
    withBrowserLock(async () => { order3.push("3"); }),
  ]);
  assert(order3.join(",") === "1,2,3", "三操作保持队列顺序", order3.join(","));
  await browserLockIdle();
}

// P-M3 角色目录 + P-M4 汇总格式（纯数据/纯函数，node 可测）
console.log("\n== P-M3 角色分工（roles-catalog / builtin-tools） ==");
{
  const ids = new Set(AGENT_ROLES.map(r => r.id));
  assert(ids.size === AGENT_ROLES.length, "角色 id 唯一", `got ${AGENT_ROLES.length}`);
  const required = ["planner", "executor", "verifier", "reviewer", "researcher"];
  assert(required.every(id => ids.has(id)), "包含 5 个核心角色（规划/执行/验证/评审/研究）", [...ids].join(","));
  let allFields = true;
  for (const r of AGENT_ROLES) {
    if (!r.id || !r.name || !r.emoji || !r.desc || !r.sysPrompt || !Array.isArray(r.tools) || r.tools.length === 0) allFields = false;
  }
  assert(allFields, "所有角色字段完整且 tools 非空");
  const bad = invalidRoleTools();
  assert(bad.length === 0, "角色 tools 都引用真实内置工具名", JSON.stringify(bad));
  assert(getRoleById("executor")?.name === "执行者", "getRoleById 命中角色");
  assert(getRoleById("nope") === undefined, "getRoleById 未知角色返回 undefined");
  assert(roleAllowedToolNames("researcher").includes("web_search"), "roleAllowedToolNames 返回角色工具集");
  assert(roleAllowedToolNames(undefined).length === 0, "未指定角色工具集为空=不限");

  // 内置工具目录完整性
  const names = new Set(BUILTIN_TOOL_NAMES);
  assert(names.size === BUILTIN_TOOLS.length, "内置工具名唯一", `${BUILTIN_TOOLS.length}`);
  assert(BUILTIN_TOOLS.every(t => t.name && t.desc), "每个工具 name+desc 完整");
  assert(validBuiltinTools(["web_search", "not_a_tool"]).join() === "not_a_tool", "validBuiltinTools 找出不存在工具");
}

console.log("\n== P-M4 汇总仲裁（formatParallelResults 语义） ==");
{
  // 用与 chat.ts 相同的纯逻辑复现：乱序输入 → 按 idx 稳定输出
  const sortByIdx = (rs: { idx: number }[]) => [...rs].sort((a, b) => a.idx - b.idx).map(r => r.idx);
  assert(sortByIdx([{ idx: 2 }, { idx: 0 }, { idx: 1 }]).join(",") === "0,1,2", "乱序结果按原始 idx 重排");
  // 角色工具集必须包含规划/执行所需关键工具（防目录退化）
  assert(roleAllowedToolNames("executor").includes("run_tests"), "执行者含 run_tests（验证循环）");
  assert(roleAllowedToolNames("executor").includes("git"), "执行者含 git");
  assert(!roleAllowedToolNames("researcher").includes("git"), "研究助手不含 git（工具集约束隔离）");
  assert(!roleAllowedToolNames("planner").includes("replace_string"), "规划者不含编辑工具（只规划不改动）");
}

console.log("\n== P-A6 本地 embedding 提供方判定 ==");
{
  assert(embeddingSource("http://localhost:11434/v1") === "ollama", "本地 Ollama /v1 → ollama");
  assert(embeddingSource("http://127.0.0.1:11434") === "ollama", "127.0.0.1 Ollama → ollama");
  assert(embeddingSource("https://api.deepseek.com") === "ollama", "DeepSeek → ollama（用本地 Ollama 补语义）");
  assert(embeddingSource("https://api.openai.com/v1") === "openai", "OpenAI → openai");
  assert(embeddingSource("https://dashscope.aliyuncs.com/compatible-mode/v1") === "openai", "通义兼容端点 → openai");
  assert(embeddingSource("") === "none", "空 baseUrl → none");
  assert(isOllamaBase("http://localhost:11434/v1") === true, "isOllamaBase 命中本地 Ollama");
  assert(isOllamaBase("https://api.deepseek.com") === false, "isOllamaBase 排除 DeepSeek（字面 Ollama 才认）");
}

console.log("\n== P-A7 权限矩阵（工具开关 + 路径白名单） ==");
{
  assert(isToolDisabled("write_file", ["write_file", "delete_file"]) === true, "禁用工具命中");
  assert(isToolDisabled("git", ["write_file"]) === false, "未禁用工具放行");
  assert(isToolDisabled("web_search", [" "]) === false, "空白配置不拦截");
  assert(isPathAllowed("/Users/x/op/a.ts", []) === true, "未配置白名单 → 放行");
  assert(isPathAllowed("/Users/x/op/a.ts", ["/Users/x/op"]) === true, "白名单前缀命中");
  assert(isPathAllowed("/Users/x/op/sub/a.ts", ["/Users/x/op"]) === true, "白名单子目录命中");
  assert(isPathAllowed("/Users/x/other/a.ts", ["/Users/x/op"]) === false, "白名单外路径拦截");
  assert(isPathAllowed("~/Pictures/shot.png", ["~/Pictures"]) === true, "~ 前缀命中");
  assert(pathArgOf({ cwd: "/a" }) === "/a", "pathArgOf 取 cwd");
  assert(pathArgOf({ url: "https://x" }) === "", "pathArgOf 无路径参数返回空");
}

console.log("\n== P-A9 记忆复习（提示词 + 动作解析） ==");
{
  const prompt = buildReviewPrompt([{ id: "a", fact: "用户喜欢简洁回答", fact_type: "preference", importance: 9 }]);
  assert(prompt.includes("id=a") && prompt.includes("delete") && prompt.includes("merge"), "提示词含事实 id 与动作说明");
  const acts = parseReviewActions('[{"action":"delete","id":"a","reason":"过时"},{"action":"merge","from_id":"b","into_id":"c"}]');
  assert(acts.length === 2, "解析 delete + merge（from_id 兼容）", JSON.stringify(acts));
  assert(acts[0].action === "delete" && acts[0].id === "a", "delete 动作");
  assert(acts[1].action === "merge" && acts[1].id === "b" && acts[1].intoId === "c", "merge 动作 with intoId");
  assert(parseReviewActions("```json\n[]\n```").length === 0, "空结果 [] 解析为空");
  assert(parseReviewActions("not json").length === 0, "非法 JSON 容错返回空");
  assert(parseReviewActions('[{"action":"nope","id":"a"},{"action":"delete"}]').length === 0, "非法动作/缺 id 跳过");
}

console.log("\n== P-A12 多模型路由（按任务类型选模型） ==");
{
  assert(routeProfileId("coding", { coding: "local" }, "aux") === "local", "任务类型专门配置优先");
  assert(routeProfileId("search", { coding: "local" }, "aux") === "aux", "未配置任务类型回退辅助模型");
  assert(routeProfileId("summarize", undefined, "") === "", "无配置无辅助 → 跟随主模型");
  assert(routeProfileId("chat", { coding: "local" }, "aux") === "aux", "chat 未专门配置 → 辅助模型");
  assert(routeProfileId("coding", { coding: "  " }, "aux") === "aux", "空白配置按未配置处理");
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
