// 一次性审计：对齐「工具说明 / 参数 schema / 实际实现」三份来源，专找
// 「自文档承诺了、代码却没实现」这类缺陷（模型侧完全无法自救，只会反复重试烧轮次）。
//
// 用法：node scripts/audit-tools.mjs
// 说明：builtin-params.ts / builtin-tools.ts 是**零依赖的纯数据模块**，
//       这里用 esbuild 就地转译 + data: URL 真加载（不用正则去猜对象结构）。
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

async function loadTsPureData(relPath) {
  const js = transformSync(read(relPath), { loader: "ts", format: "esm", target: "es2022" }).code;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

const { BUILTIN_PARAMETERS } = await loadTsPureData("src/data/builtin-params.ts");
const { BUILTIN_TOOLS } = await loadTsPureData("src/data/builtin-tools.ts");

const chatSrc = read("src/stores/chat.ts");
const detSrc = read("src/utils/deterministic-tools.ts");

/** 确定性工具（另一处分发）的名字表 */
const detNames = new Set(
  (detSrc.match(/DETERMINISTIC_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "")
    .match(/"([a-z0-9_]+)"/g)
    ?.map((s) => s.slice(1, -1)) ?? [],
);

/** chat.ts 里 callBuiltinTool 的 case 分支 → 读取了哪些 args.X
 *  注意：case 有 `case "x": {` 与不带花括号两种写法，正则不能强求 `{`。 */
const caseRe = /\n    case "([a-z0-9_]+)":/g;
const impl = new Map();
{
  const all = [];
  let m;
  while ((m = caseRe.exec(chatSrc)) !== null) all.push({ tool: m[1], start: m.index });
  for (let i = 0; i < all.length; i++) {
    const end = i + 1 < all.length ? all[i + 1].start : chatSrc.length;
    const body = chatSrc.slice(all[i].start, end);
    impl.set(all[i].tool, {
      keys: [...new Set([...body.matchAll(/args\.([a-zA-Z0-9_]+)/g)].map((x) => x[1]))],
    });
  }
}

const docs = new Map(BUILTIN_TOOLS.map((t) => [t.name, t.desc]));
const schemaKeys = (name) => Object.keys(BUILTIN_PARAMETERS[name]?.properties ?? {});

const rows = [];
const push = (cat, text) => rows.push([cat, text]);

// A / B：说明有、schema 或实现没有
for (const name of docs.keys()) {
  if (!BUILTIN_PARAMETERS[name]) push("A", `${name} —— 有说明但无参数 schema（模型看不到参数）`);
  const inChat = impl.has(name);
  const inDet = detNames.has(name);
  if (!inChat && !inDet) push("B", `${name} —— 有说明但两处分发都没有实现`);
}

// C：说明里写了的参数、schema 未声明
for (const [name, desc] of docs) {
  if (!BUILTIN_PARAMETERS[name]) continue;
  const keys = schemaKeys(name);
  const whole = JSON.stringify(BUILTIN_PARAMETERS[name]);
  const argSeg = desc.match(/参数\s*(\{[\s\S]*?\})/)?.[1] ?? "";
  const mentioned = [...new Set([...argSeg.matchAll(/"([a-z0-9_]{2,})"\s*:/gi)].map((x) => x[1]))];
  // 嵌套字段（如 tasks[].role、graph.nodes[].id）在整份 schema JSON 里能找到 → 不算缺失
  const missing = mentioned.filter((k) => !keys.includes(k) && !whole.includes(`"${k}":`));
  if (missing.length)
    push(
      "C",
      `${name} —— 说明写 ${missing.join(", ")}；schema 只有 ${keys.join(", ") || "（无）"}`,
    );
}

// D：schema 声明了、但实现里**完全不出现**该参数名（文档承诺 vs 未实现）
for (const name of Object.keys(BUILTIN_PARAMETERS)) {
  const unread = schemaKeys(name).filter((k) => {
    const re = new RegExp(`["'\`]${k}["'\`]|\\b${k}\\b`);
    return !re.test(chatSrc) && !re.test(detSrc);
  });
  if (unread.length) push("D", `${name} —— ${unread.join(", ")}`);
}

// E：实现读了、schema 未声明（模型不知道能传，可靠性靠别名兜底）
for (const [name, info] of impl) {
  if (!BUILTIN_PARAMETERS[name]) continue;
  const keys = schemaKeys(name);
  const undeclared = info.keys.filter((k) => !keys.includes(k) && !/[A-Z]/.test(k));
  if (undeclared.length) push("E", `${name} —— ${undeclared.join(", ")}`);
}

const titles = {
  A: "A. 有说明但无参数 schema",
  B: "B. 有说明但两处分发都没实现",
  C: "C. 说明里写了、schema 未声明",
  D: "D. schema 声明了、实现里完全不出现（最可疑）",
  E: "E. 实现读了、schema 未声明（模型不知道能传）",
};

console.log(
  `工具说明 ${docs.size} / 参数 schema ${Object.keys(BUILTIN_PARAMETERS).length} / ` +
    `chat 分发 ${impl.size} / 确定性工具 ${detNames.size}\n`,
);
for (const cat of ["A", "B", "C", "D", "E"]) {
  const list = rows.filter((r) => r[0] === cat);
  console.log(`=== ${titles[cat]}：${list.length} 项 ===`);
  for (const [, text] of list) console.log(`  - ${text}`);
  console.log("");
}
