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
