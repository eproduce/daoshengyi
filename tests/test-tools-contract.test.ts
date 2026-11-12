/// <reference types="vite/client" />

import { describe, it, expect } from "vitest";
import { BUILTIN_PARAMETERS } from "../src/data/builtin-params.ts";
import { BUILTIN_TOOLS } from "../src/data/builtin-tools.ts";

/**
 * 工具「契约」测试：说明 / 参数 schema / 实现三者必须对齐。
 *
 * ## 为什么需要
 * 本仓库最高产的一类缺陷是**「自文档教模型这么用，代码却没实现」**——
 * 模型侧完全无法自救，只会反复重试烧轮次。已踩过的实例：
 *   - 工具说明写着「可加长超时参数」，但 `browser_evaluate` 当时根本没有该参数
 *   - `code_stats` / `code_delete` 的 properties 是空的，实现却要求 `root`
 *     （模型只能从 desc 猜，且别名映射因「无可映射的规范名」整体失效）
 *   - `verify-receipts` 的注释与实现不一致（见 tests/test-no-lookbehind.test.ts）
 *
 * ## 覆盖的不变量
 *   A. 说明 ↔ schema 双向一一对应（有说明必须有 schema，反之亦然）
 *   B. 每个有说明的工具都能在实现里找到分发入口（否则模型调用即「未知内置工具」）
 *   D. schema 声明的每个参数名都必须真的出现在实现里（承诺了就得有人读）
 *   F. properties 为空的工具，其分发不得读取任何 args.X
 *      （空 schema + 需要参数 = code_stats 那类缺陷）
 *
 * 说明：C（desc 里写了参数、schema 未声明）刻意不做断言——存在**故意**只在 desc 里
 * 描述结构的工具（如 workflow_create 的 graph.nodes），由人工判断更合适；
 * 探查用脚本 `scripts/audit-tools.mjs` 会把它列出来供 review。
 */

const SOURCES = import.meta.glob("../src/**/*.{ts,vue}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const chatSrc = SOURCES["../src/stores/chat.ts"] ?? "";
const toolsSrc = SOURCES["../src/data/builtin-tools.ts"] ?? "";

/**
 * 不变量：「模型可见即已记录」的**前半句** —— 正文里不许有 UI 卡片。
 *
 * 2026-11-10 修复前的真实故障：轮末把 `toolChain`（`### 🔧 调用工具` + `<details>`）拼进
 * `assistantMsg.content`，而下一轮又把 `content` 原样发给模型 → 模型在历史里看到「自己」
 * 写过卡片，就当成合法写法模仿（伪卡片 → 工具不执行 → 回复中断），只能靠提示词反复压制。
 *
 * 修好后卡片只存在于两处：UI 折叠组（读 `message.tools`）与导出（`db.rs::render_tool_cards`
 * 从 `tools` 派生）。这条测试钉住「不再拼回去」——这是**源文本契约**，因为 `chat.ts` 的
 * sendMessage 依赖 Tauri IPC，无法在单测里跑整轮。
 */
describe("正文装配契约：工具卡片不得进入 model-visible 的 content", () => {
  it("chat.ts 不再把 toolChain 拼进 content", () => {
    expect(chatSrc).not.toContain("toolChain.join(");
    expect(chatSrc).toContain("composeAssistantContent(finalText");
  });

  it("回合统计是作用域实例，不是模块级全局（并行子代理不串扰）", () => {
    // 主回合只有一份实例；子代理自己创建（≥2 处 createTurnStats：主回合 + runSubagentLoop）
    expect((chatSrc.match(/createTurnStats\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // 旧的四件套全局必须消失
    for (const name of ["turnToolOk", "turnToolFail", "turnFailedTools", "turnFailStreak"]) {
      expect(chatSrc).not.toContain(name);
    }
    // 子代理的两个工具调用点都要传自己的 stats
    expect((chatSrc.match(/callToolStoppable\([^)]*subStats\)/g) ?? []).length).toBe(2);
  });

  it("answer_html 把版式原型与反 slop 自查写进工具描述（否则模型只会铺同款卡片）", () => {
    const desc = toolsSrc.match(/name: "answer_html",[\s\S]*?\n {2}\},/)?.[0] ?? "";
    expect(desc).not.toBe("");
    for (const need of [
      "版式原型",
      ".dsy-hero",
      ".dsy-kpis",
      ".dsy-matrix",
      ".dsy-split",
      "卡片套装",
      "紫色/彩虹渐变",
      "把大胆花在一处",
    ]) {
      expect(desc).toContain(need);
    }
    // 元件表与反 slop 清单不能重复堆第二份（说两遍＝模型两头都不遵守）
    expect((desc.match(/版式原型/g) ?? []).length).toBe(1);
  });

  it("任务模式的「先建计划」话术只有一份（不再 native/text 各抄一遍）", () => {
    // 三处调用点共用 planCoercionMessage，正文里不得再出现手写话术
    expect((chatSrc.match(/planCoercionMessage\(/g) ?? []).length).toBe(3);
    expect(chatSrc).not.toContain("【任务模式】，但还没有创建任务计划");
  });

  it("原生 tools 降级判定走分类器，不用裸 /tool|function/ 宽匹配", () => {
    expect(chatSrc).toContain("classifyRoundError(");
    expect(chatSrc).not.toMatch(/tool\|function\|tool_calls/);
  });

  it("工作流查找只有一份实现（不再两处手抄 id/名称解析）", () => {
    expect(chatSrc).not.toContain('"workflow_get", {\n          id: Number(nameOrId)');
    expect((chatSrc.match(/resolveWorkflow\(nameOrId/g) ?? []).length).toBe(2);
    expect(chatSrc).not.toContain("未找到工作流「${nameOrId}」，可先");
  });

  it("编辑确认只有一份构造（四个工具不再各抄八个字段）", () => {
    expect((chatSrc.match(/buildEditConfirmRequest\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // 手写载荷的标志：kind 只能由构造器决定
    expect(chatSrc).not.toContain('kind: "edit",\n          path');
  });

  it("请求装配只有一份实现（chat.ts 不再内联拼 rustMsgs 历史）", () => {
    // 装配抽到 utils/agent-request.ts 后：主循环只调用，不再自己遍历历史
    expect(chatSrc).not.toContain("histAll.filter");
    expect(chatSrc).not.toContain("[本次补充上下文]");
    expect(chatSrc).toContain("assembleRequest(conv.messages");
    expect(chatSrc).toContain("appendVolatileContext(rustMsgs, volatileCtx)");
    expect(chatSrc).toContain("pruneToBudget(");
  });

  it("工具结果后处理只有一份实现（原生 / 文本 / 子代理三条路都走 foldToolResult）", () => {
    // 此前文本路径与子代理用的是 truncateToolResult（只脱敏 + 硬截断）：没压缩、中段直接丢
    expect(chatSrc).not.toContain("truncateToolResult");
    const calls = chatSrc.match(/foldToolResult\(/g) ?? [];
    // 定义 1 处 + 6 个调用点（原生 2、文本 2、子代理 2）
    expect(calls.length).toBeGreaterThanOrEqual(7);
  });

  it("中断错误写进正文（而不是塞进 toolChain 等拼接）", () => {
    expect(chatSrc).toContain("回复生成中断");
    expect(chatSrc).not.toContain("让 finally 只拼 toolChain");
  });
});

const detSrc = SOURCES["../src/utils/deterministic-tools.ts"] ?? "";
const implSrc = `${chatSrc}\n${detSrc}`;

/** 确定性工具（另一处分发）的名字表 */
const detNames = new Set(
  (detSrc.match(/DETERMINISTIC_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "")
    .match(/"([a-z0-9_]+)"/g)
    ?.map((s) => s.slice(1, -1)) ?? [],
);

/** 某个工具在 chat.ts 的分发里读取的 args.X（按 case 分支切段） */
function readArgs(tool: string): string[] {
  const all = [...chatSrc.matchAll(/\n {4}case "([a-z0-9_]+)":/g)].map((m) => ({
    tool: m[1],
    start: m.index,
  }));
  const i = all.findIndex((x) => x.tool === tool);
  if (i < 0) return [];
  const body = chatSrc.slice(all[i].start, i + 1 < all.length ? all[i + 1].start : chatSrc.length);
  return [...new Set([...body.matchAll(/args\.([a-zA-Z0-9_]+)/g)].map((x) => x[1]))];
}

const schemaProps = (name: string): string[] =>
  Object.keys((BUILTIN_PARAMETERS[name]?.properties ?? {}) as Record<string, unknown>);

/** 有意不对外宣传的「兼容别名」工具：有分发 + 有 schema，但不出现在工具说明里
 *  （模型凭训练先验可能直接这么调，我们只保证接得住，不主动引导）。 */
const HIDDEN_COMPAT_TOOLS = ["list_directory", "read_multiple_files"];

describe("工具契约：说明 ↔ schema ↔ 实现三者对齐", () => {
  it("自查：能读到实现源码与工具表（防止路径写错导致空跑）", () => {
    expect(chatSrc.length).toBeGreaterThan(100_000);
    expect(detSrc.length).toBeGreaterThan(10_000);
    expect(BUILTIN_TOOLS.length).toBeGreaterThan(50);
    expect(Object.keys(BUILTIN_PARAMETERS).length).toBeGreaterThan(50);
  });

  it("A. 说明与参数 schema 一一对应（隐藏兼容别名除外）", () => {
    const docNames = BUILTIN_TOOLS.map((t) => t.name);
    const noSchema = docNames.filter((n) => !BUILTIN_PARAMETERS[n]);
    const noDoc = Object.keys(BUILTIN_PARAMETERS).filter(
      (n) => !docNames.includes(n) && !HIDDEN_COMPAT_TOOLS.includes(n),
    );
    expect({ 有说明但无schema: noSchema, 有schema但无说明: noDoc }).toEqual({
      有说明但无schema: [],
      有schema但无说明: [],
    });
  });

  it("B. 每个工具都能在实现里找到分发入口", () => {
    const missing = BUILTIN_TOOLS.map((t) => t.name).filter((n) => {
      if (detNames.has(n)) return false; // 走确定性工具分发
      return !new RegExp(`case\\s+"${n}"`).test(chatSrc);
    });
    expect(missing, `这些工具在说明里存在但没有任何分发实现：${missing.join(", ")}`).toEqual([]);
  });

  it("D. schema 声明的参数都真的被实现读取过", () => {
    const ghosts: string[] = [];
    for (const name of Object.keys(BUILTIN_PARAMETERS)) {
      for (const key of schemaProps(name)) {
        // 参数名要么以 "key" 出现，要么以 .key / args.key 出现
        const re = new RegExp(`["'\`]${key}["'\`]|\\b${key}\\b`);
        if (!re.test(implSrc)) ghosts.push(`${name}.${key}`);
      }
    }
    expect(ghosts, `schema 承诺了但实现里根本不出现的参数：\n${ghosts.join("\n")}`).toEqual([]);
  });

  it("F. properties 为空的工具，分发里不得读取参数", () => {
    const bad: string[] = [];
    for (const name of Object.keys(BUILTIN_PARAMETERS)) {
      if (schemaProps(name).length > 0) continue;
      // 无参工具：说明里也不该出现「参数 {...}」示例（`参数 {}` 是明示无参，不算）
      const doc = BUILTIN_TOOLS.find((t) => t.name === name)?.desc ?? "";
      if (/参数\s*\{\s*["“a-z_]/i.test(doc)) bad.push(`${name}（说明里写了参数但 schema 为空）`);
      const used = readArgs(name);
      if (used.length) bad.push(`${name}（schema 为空但实现读了 args.${used.join(", args.")}）`);
    }
    expect(bad, `空 schema 却有参数：\n${bad.join("\n")}`).toEqual([]);
  });

  // G：有分发却没 schema 的工具会走「无 schema 的全局别名映射」——那条路径上任何
  // 别名命中都是猜测，且 ALIASES 里混着别的工具的规范参数名（script→command、
  // value→input），会静默改坏参数。历史上 list_directory / read_multiple_files 正是如此。
  it("G. 每个分发 case 都有参数 schema", () => {
    const cases = [
      ...new Set([...chatSrc.matchAll(/\n {4}case "([a-z0-9_]+)":/g)].map((m) => m[1])),
    ];
    const noSchema = cases.filter((c) => !BUILTIN_PARAMETERS[c]);
    expect(noSchema, `这些工具有分发但缺 schema：${noSchema.join(", ")}`).toEqual([]);
  });
});

/**
 * `answer_html`（方案 B：HTML 讲解页）的两条产品约定，单测钉住防回归：
 *   H. **触发策略 = 每次显式要求**：说明与系统提示词都必须写清楚「用户明说才出页」，
 *      否则会退化成上游技能那种 always-on（有结论就弹一页），把普通问答都变成页面。
 *   I. **渲染必须走宿主命令**：前端只做参数搬运 + `invoke("answer_html")`，
 *      不在前端拼 `node …` shell 命令 —— 否则会绕开沙箱/审计/超时管线
 *      （历史教训：run_tests / git_operation 就曾因自己起进程而绕过沙箱）。
 */
describe("answer_html：触发策略与渲染链路", () => {
  const desc = BUILTIN_TOOLS.find((t) => t.name === "answer_html")?.desc ?? "";

  it("H. 触发策略写死在说明与系统提示词里（每次显式要求）", () => {
    expect(desc).toContain("仅当用户明确要求");
    expect(chatSrc).toContain("HTML 讲解页（answer_html）使用要点");
    expect(chatSrc).toContain("触发：每次显式要求");
  });

  it("I. 前端只搬运参数、渲染交给宿主命令（不自己拼 node 命令）", () => {
    const start = chatSrc.indexOf('case "answer_html"');
    expect(start).toBeGreaterThan(0);
    const body = chatSrc.slice(start, start + 1600);
    expect(body).toContain("invoke<");
    expect(body).toContain('"answer_html"');
    expect(body).toContain("args.out_path");
    expect(body).not.toMatch(/node\s+.*am\.mjs/); // 不在前端拼命令行
  });
});

describe("产物渲染运行时：没装 Node 也能出页面", () => {
  it("前端只经 ensure_html_runtime 这一个命令，不自己拼下载逻辑", () => {
    const api = SOURCES["../src/api/runtime.ts"] ?? "";
    expect(api).toContain('invoke<HtmlRuntimeStatus>("ensure_html_runtime"');
    // 两种调用都必须带 install 参数（缺了后端无法区分「查状态」与「安装」）
    expect((api.match(/ensure_html_runtime/g) ?? []).length).toBe(2);
    expect(api).toContain("install: false");
    expect(api).toContain("install: true");
  });

  it("设置页能说明「为什么需要 / 装在哪」，而不是静默等 48MB", () => {
    const ui = SOURCES["../src/components/SettingsDialog.vue"] ?? "";
    expect(ui).toContain("产物渲染运行时");
    expect(ui).toContain("installHtmlRuntime");
    expect(ui).toContain("managedPath");
  });
});
