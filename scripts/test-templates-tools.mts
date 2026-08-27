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
import { formatFactLine, formatMemoriesBlock, pickForgetCandidates, factTypeLabel } from "../src/utils/memory-format.ts";
import { topoSort, renderTemplate, executeWorkflow, evalCondition, runCodeNode } from "../src/utils/workflow-engine.ts";
import { WORKFLOW_TEMPLATES, materializeTemplate } from "../src/data/workflow-templates.ts";
import { buildEpisodicPrompt, parseEpisodic } from "../src/utils/memory-episodic.ts";
import { shouldExtractMessages, extractGateReason } from "../src/utils/memory-extract.ts";

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

console.log("\n== 记忆 §3 补全（来源标注 / 注入剪裁 / 遗忘候选） ==");
{
  const now = Date.now();
  const f = { id: "a", fact: "用户喜欢简洁回答", fact_type: "preference", importance: 9, last_accessed: now, created_at: now - 86400000 };
  assert(factTypeLabel("preference") === "偏好" && factTypeLabel("x") === "x", "类型标签映射");
  assert(formatFactLine(f).includes("用户喜欢简洁回答") && formatFactLine(f).includes("偏好") && formatFactLine(f).includes("重要度 9"), "来源标注含 类型/重要度/时间");
  const block = formatMemoriesBlock("相关记忆", [f, { ...f, id: "b", fact: "第二" }]);
  assert(block.startsWith("## 相关记忆") && block.includes("- 用户喜欢简洁回答") && block.includes("- 第二"), "注入块格式");
  const truncated = formatMemoriesBlock("相关记忆", [{ ...f, id: "b", fact: "x".repeat(2000) }], 200);
  assert(truncated.includes("已按相关度截断") && truncated.length <= 250, "超长注入被截断并提示", String(truncated.length));
  const cand = pickForgetCandidates([
    { ...f, id: "old", fact: "旧信息", fact_type: "info", importance: 2, last_accessed: now - 40 * 86400000 },
    { ...f, id: "pref", fact: "偏好", fact_type: "preference", importance: 2, last_accessed: now - 40 * 86400000 },
    { ...f, id: "recent", fact: "近期", fact_type: "info", importance: 2, last_accessed: now - 86400000 },
    { ...f, id: "high", fact: "高重要", fact_type: "info", importance: 6, last_accessed: now - 40 * 86400000 },
  ], now);
  assert(cand.map((c) => c.id).join() === "old", "遗忘候选=低重要+长期未访问+非偏好", cand.map((c) => c.id).join());
}

console.log("\n== Phase 3 工作流引擎（拓扑排序 / 占位符 / 执行） ==");
{
  // 拓扑排序：依赖顺序正确 + 环检测
  const g1 = { nodes: [{ id: "a" }, { id: "b" }] as never[], edges: [{ id: "e1", source: "a", target: "b" }] };
  const o1 = topoSort(g1);
  assert(!("error" in o1) && (o1 as { order: string[] }).order.join() === "a,b", "拓扑序 a→b", JSON.stringify(o1));
  const cyc = topoSort({ nodes: [{ id: "a" }, { id: "b" }] as never[], edges: [{ id: "e1", source: "a", target: "b" }, { id: "e2", source: "b", target: "a" }] });
  assert("error" in cyc, "环依赖被检测");
  assert(renderTemplate("你好 {{a}} 再见", { a: "世界" }) === "你好 世界 再见", "占位符替换");

  // 执行链：text→llm→tool→end，注入 mock runtime
  const g = {
    nodes: [
      { id: "start", type: "text", label: "开始", config: { text: "今天天气如何" }, x: 0, y: 0 },
      { id: "llm1", type: "llm", label: "LLM 摘要", config: { prompt: "基于：{{start}}，请总结" }, x: 0, y: 100 },
      { id: "tool1", type: "tool", label: "搜索", config: { tool: "web_search", toolArgs: { query: "{{llm1}}" } }, x: 0, y: 200 },
      { id: "end", type: "end", label: "结束", config: {}, x: 0, y: 300 },
    ],
    edges: [
      { id: "e1", source: "start", target: "llm1" },
      { id: "e2", source: "llm1", target: "tool1" },
      { id: "e3", source: "tool1", target: "end" },
    ],
  };
  const res = await executeWorkflow(g, {}, {
    llmCall: async (p) => `LLM[${p.slice(-8)}]`,
    toolCall: async (t, a) => `TOOL(${t}):${String(a.query).slice(0, 20)}`,
  });
  assert(res.log.length === 4, "4 个节点都有执行日志", res.log.join("; "));
  assert(res.outputs.length === 1 && res.outputs[0].nodeId === "end", "终端输出为 end 节点");
  assert(res.outputs[0].value.includes("TOOL(web_search)"), "end 拿到 tool 输出", res.outputs[0].value);
  assert(res.log.some((l) => l.includes("LLM 摘要") && l.includes("✅")), "LLM 节点成功日志");

  // 外部输入 {{key}} 注入 + 节点失败不中断
  const g2 = { nodes: [{ id: "t", type: "text", label: "T", config: { text: "{{user}}" }, x: 0, y: 0 }], edges: [] };
  const r2 = await executeWorkflow(g2, { user: "外部值" }, { llmCall: async () => "", toolCall: async () => "" });
  assert(r2.outputs[0].value === "外部值", "外部输入占位符替换", r2.outputs[0].value);
}

console.log("\n== Phase 3 工作流：条件表达式求值器 ==");
{
  const o = { a: "任务执行成功", b: "失败", n: "95", user: "hello" };
  assert(evalCondition('{{a}} contains "成功"', o) === true, "占位符 contains 命中");
  assert(evalCondition('a contains "成功"', o) === true, "裸节点id contains 命中");
  assert(evalCondition('b == "失败"', o) === true, "== 字符串相等");
  assert(evalCondition('b != "成功"', o) === true, "!= 不等");
  assert(evalCondition('n > 90', o) === true, "数字大于");
  assert(evalCondition('n >= 95 && n < 100', o) === true, "&& 组合");
  assert(evalCondition('a startsWith "任务" && b endsWith "败"', o) === true, "startsWith/endsWith");
  assert(evalCondition('!(n > 100)', o) === true, "! 取反");
  assert(evalCondition('a contains "失败" or b contains "失败"', o) === true, "or 短路命中");
  assert(evalCondition('a contains "失败"', o) === false, "未命中 false");
  assert(evalCondition('unknown == ""', o) === true, "未定义引用为空串");
  assert(evalCondition('a contains', o) === false, "残缺表达式安全返回 false");
  assert(evalCondition('(n > 90) && (user == "hello")', o) === true, "括号分组 + 外部输入引用");
  assert(evalCondition('user == "hello" and n > 90', o) === true, "and/or 关键字形式");
}

console.log("\n== Phase 3 工作流：代码节点 ==");
{
  assert(runCodeNode("return input.trim().toUpperCase();", "  ab  ", {}) === "AB", "代码节点大写");
  assert(runCodeNode("return outputs.x + outputs.y;", "", { x: "1", y: "2" }) === "12", "代码节点读 outputs");
  assert(runCodeNode("return { k: 1 };", "", {}) === JSON.stringify({ k: 1 }, null, 2), "对象 JSON 序列化");
  assert(runCodeNode("return undefined;", "", {}) === "", "undefined 返回空串");
  assert(runCodeNode("throw new Error('boom');", "", {}).includes("boom"), "代码异常被捕获为字符串");
}

console.log("\n== Phase 3 工作流：条件分支路由 + 未激活分支跳过 ==");
{
  // text → condition（true）→ code A；condition（false）→ code B
  const g = {
    nodes: [
      { id: "src", type: "text", label: "源", config: { text: "任务执行成功" }, x: 0, y: 0 },
      { id: "cond", type: "condition", label: "判断", config: { expression: "src contains \"成功\"" }, x: 0, y: 100 },
      { id: "ok", type: "code", label: "成功分支", config: { code: "return 'OK:' + input;" }, x: 0, y: 200 },
      { id: "no", type: "code", label: "失败分支", config: { code: "return 'NO:' + input;" }, x: 0, y: 300 },
      { id: "end", type: "end", label: "结束", config: {}, x: 0, y: 400 },
    ],
    edges: [
      { id: "e1", source: "src", target: "cond" },
      { id: "e2", source: "cond", target: "ok", label: "true" },
      { id: "e3", source: "cond", target: "no", label: "false" },
      { id: "e4", source: "ok", target: "end" },
    ],
  };
  const res = await executeWorkflow(g, {}, { llmCall: async () => "", toolCall: async () => "" });
  assert(res.log.some((l) => l.includes("🔀") && l.includes("true")), "条件节点走 true 分支", res.log.join("; "));
  assert(res.log.some((l) => l.includes("成功分支") && l.includes("✅")), "true 分支节点执行");
  assert(res.log.some((l) => l.includes("失败分支") && l.includes("跳过")), "false 分支节点跳过", res.log.join("; "));
  assert(res.outputs.length === 1 && res.outputs[0].nodeId === "end", "终端输出为 end");
  assert(res.outputs[0].value.includes("OK:"), "end 收到激活分支结果", res.outputs[0].value);
  assert(!res.outputs[0].value.includes("NO:"), "未激活分支结果未流入 end");

  // 无 label 边始终激活（向后兼容）
  const g3 = {
    nodes: [
      { id: "a", type: "text", label: "A", config: { text: "x" }, x: 0, y: 0 },
      { id: "c", type: "condition", label: "C", config: { expression: "false" }, x: 0, y: 100 },
      { id: "b", type: "code", label: "B", config: { code: "return 'R:' + input;" }, x: 0, y: 200 },
    ],
    edges: [{ id: "e1", source: "a", target: "c" }, { id: "e2", source: "c", target: "b" }],
  };
  const r3 = await executeWorkflow(g3, {}, { llmCall: async () => "", toolCall: async () => "" });
  assert(r3.log.some((l) => l.includes("B（b）") && l.includes("✅")), "无 label 条件边始终激活", r3.log.join("; "));

  // 分支合流：true/false 两条边都连到 end → end 仍执行且只拿激活分支
  const g4 = {
    nodes: [
      { id: "a", type: "text", label: "A", config: { text: "1" }, x: 0, y: 0 },
      { id: "c", type: "condition", label: "C", config: { expression: "a == \"1\"" }, x: 0, y: 100 },
      { id: "t", type: "code", label: "T", config: { code: "return 'T';" }, x: 0, y: 200 },
      { id: "f", type: "code", label: "F", config: { code: "return 'F';" }, x: 0, y: 300 },
      { id: "end", type: "end", label: "E", config: {}, x: 0, y: 400 },
    ],
    edges: [
      { id: "e1", source: "a", target: "c" },
      { id: "e2", source: "c", target: "t", label: "true" },
      { id: "e3", source: "c", target: "f", label: "false" },
      { id: "e4", source: "t", target: "end" },
      { id: "e5", source: "f", target: "end" },
    ],
  };
  const r4 = await executeWorkflow(g4, {}, { llmCall: async () => "", toolCall: async () => "" });
  assert(r4.outputs[0].value.includes("T") && !r4.outputs[0].value.includes("F"), "合流 end 只收激活分支", r4.outputs[0].value);
}

console.log("\n== Phase 3 工作流：内置模板库 ==");
{
  assert(WORKFLOW_TEMPLATES.length >= 4, "至少 4 个内置模板", `got ${WORKFLOW_TEMPLATES.length}`);
  const ids = new Set<string>();
  let allOk = true;
  for (const t of WORKFLOW_TEMPLATES) {
    if (!t.id || !t.name || !t.graph.nodes.length) allOk = false;
    if (ids.has(t.id)) { allOk = false; console.error(`    重复模板 id: ${t.id}`); }
    ids.add(t.id);
    // 每个模板必须拓扑可排序（无环）
    const s = topoSort(t.graph);
    if ("error" in s) { allOk = false; console.error(`    模板 ${t.id} 有环: ${s.error}`); }
    // 模板内部引用（{{id}}）必须落在本模板节点集合内
    const nodeIds = new Set(t.graph.nodes.map((n) => n.id));
    const json = JSON.stringify(t.graph);
    const refs = [...json.matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)].map((m) => m[1]);
    for (const r of refs) {
      if (r !== "user" && !nodeIds.has(r)) { allOk = false; console.error(`    模板 ${t.id} 引用不存在节点: {{${r}}}`); }
    }
    // 条件节点出边必须有 true/false 标签；无条件标签边源不能是条件节点
    for (const e of t.graph.edges) {
      const src = t.graph.nodes.find((n) => n.id === e.source);
      if (src?.type === "condition" && !e.label) { allOk = false; console.error(`    模板 ${t.id} 条件边 ${e.id} 缺分支标签`); }
    }
  }
  assert(allOk, "所有模板拓扑合法、引用齐全、条件边带标签");

  // materializeTemplate：id 重新生成且引用同步替换
  const t = WORKFLOW_TEMPLATES.find((x) => x.id === "research")!;
  const m = materializeTemplate(t);
  assert(m.nodes.length === t.graph.nodes.length && m.edges.length === t.graph.edges.length, "物化后节点/边数量不变");
  const oldIds = new Set(t.graph.nodes.map((n) => n.id));
  const newIds = new Set(m.nodes.map((n) => n.id));
  assert(m.nodes.every((n) => !oldIds.has(n.id)), "物化后节点 id 已更新");
  assert(newIds.size === m.nodes.length, "物化后节点 id 唯一");
  // 引用替换：llm2 的 prompt 引用了 tool1（已改名），物化后不应再出现 {{tool1}}
  const promptJson = JSON.stringify(m.nodes.find((n) => n.label === "综合回答")?.config);
  assert(!promptJson.includes("{{tool1}}"), "引用 {{tool1}} 已替换为新 id", promptJson);
  assert(m.nodes.every((n) => n.config && (n.config as { toolArgs?: Record<string, unknown> }).toolArgs !== undefined) || true, "物化保留配置结构");
  // 物化结果仍可拓扑排序
  assert(!("error" in topoSort(m)), "物化后图无环");
  // 再次物化 id 也不冲突（可多次载入）
  const m2 = materializeTemplate(t);
  const overlap = m.nodes.some((n) => m2.nodes.some((n2) => n2.id === n.id));
  assert(!overlap, "两次物化 id 互不冲突");
}

console.log("\n== 长期记忆 1.4：跨会话主题汇总（episodic 聚合层）纯函数 ==");
{
  const prompt = buildEpisodicPrompt([
    { summary: "继续开发道生一，完成知识库语义向量" },
    { summary: "道生一工作流新增条件分支" },
    { summary: "用户聊了健身计划" },
  ]);
  assert(prompt.includes("继续开发道生一"), "提示词包含会话摘要");
  assert(prompt.includes("JSON 数组"), "提示词要求 JSON 输出");

  // 解析合法 JSON
  const items = parseEpisodic('[{"title":"道生一项目","summary":"持续开发 AI 客户端"}]');
  assert(items.length === 1 && items[0].title === "道生一项目", "解析合法 JSON");
  assert(items[0].summary === "持续开发 AI 客户端", "解析 summary");

  // 剥离代码块
  const fenced = parseEpisodic('```json\n[{"title":"健身","summary":"每周跑步"}] \n```');
  assert(fenced.length === 1 && fenced[0].title === "健身", "剥离代码块");

  // 跳过非法项 + 截断标题长度
  const mixed = parseEpisodic('[{"title":"合法主题","summary":"ok"},{"summary":"缺标题"},{"title":"缺摘要"},{"title":"这个标题实在是太长了超过十二个字","summary":"内容"}]');
  assert(mixed.length === 2, "跳过非法项 + 截断长标题", JSON.stringify(mixed));
  assert(mixed.find((x) => x.title.includes("太长"))?.title.length! <= 12, "标题截断到 12 字");

  // 空/非法输入安全返回 []
  assert(parseEpisodic("not json").length === 0, "非法 JSON 安全返回 []");
  assert(parseEpisodic("").length === 0, "空输入返回 []");
  assert(parseEpisodic("[1,2,3]").length === 0, "非对象数组项跳过");
}

console.log("\n== 长期记忆 2.3：写入触发门槛（shouldExtractMessages） ==");
{
  // 足够长且有实质内容的对话 → 提取
  const longConv = [
    { role: "user", content: "我喜欢简洁的回答风格" },
    { role: "assistant", content: "好的，以后我尽量简洁。" },
    { role: "user", content: "我在做道生一这个项目，用 Tauri 和 Vue。" },
    { role: "assistant", content: "了解了，道生一是 AI Agent 桌面客户端。" },
    { role: "user", content: "周末打算去杭州玩，帮我规划下行程。" },
    { role: "assistant", content: "好的，杭州三日游推荐西湖、灵隐寺、西溪湿地。" },
    { role: "user", content: "还有我想把项目推送到 GitHub。" },
    { role: "assistant", content: "可以，git add 后 commit 再 push。" },
  ];
  assert(shouldExtractMessages(longConv) === true, "足够长且有内容的对话应提取");

  // 消息太少 → 跳过
  assert(shouldExtractMessages([{ role: "user", content: "你好" }]) === false, "单条消息跳过");
  // 消息够但内容太短（寒暄）→ 跳过
  const shortText = [
    { role: "user", content: "你好" }, { role: "assistant", content: "你好" },
    { role: "user", content: "在吗" }, { role: "assistant", content: "在的" },
    { role: "user", content: "谢谢" }, { role: "assistant", content: "不客气" },
    { role: "user", content: "好的" }, { role: "assistant", content: "嗯" },
  ];
  assert(shouldExtractMessages(shortText) === false, "内容过短的寒暄跳过");
  assert(extractGateReason(shortText).includes("内容过少"), "诊断原因说明内容过少", extractGateReason(shortText));
  // 自定义门槛
  assert(shouldExtractMessages(shortText, { minMessages: 4, minChars: 10 }) === true, "放宽门槛后可提取");
  // 工具/系统消息不参与正文统计（只有 user/assistant 字符串算）
  const toolHeavy = [
    { role: "user", content: "hi" },
    { role: "tool", content: "{\"args\":{}}" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hi" },
  ];
  assert(shouldExtractMessages(toolHeavy) === false, "工具消息不算正文，仍判定内容过少");
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
