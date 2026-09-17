import { it, expect } from "vitest";
// S2 项目指令发现：候选路径纯函数测试（IO 部分依赖 Tauri 运行时不在此测）
import { candidateInstructionPaths } from "../src/utils/agents-md.ts";

function assert(cond: boolean, name: string, detail = "") {
  expect(cond, name + (detail ? ` · ${detail}` : "")).toBe(true);
}

console.log("\n== candidateInstructionPaths（项目指令候选路径） ==");
// 每层 AGENTS.md 优先于 道生一.md；从 cwd 向上递归
const paths = candidateInstructionPaths("/Users/wanghuan/op/daoshengyi/src/utils");
assert(
  paths[0] === "/Users/wanghuan/op/daoshengyi/src/utils/AGENTS.md",
  "第1候选 = cwd/AGENTS.md",
  paths[0],
);
assert(
  paths[1] === "/Users/wanghuan/op/daoshengyi/src/utils/道生一.md",
  "第2候选 = cwd/道生一.md",
  paths[1],
);
assert(
  paths[2] === "/Users/wanghuan/op/daoshengyi/src/utils/DECISIONS.md",
  "第3候选 = cwd/DECISIONS.md（P1-7 决策日志也作为项目级上下文）",
  paths[2],
);
assert(
  paths[3] === "/Users/wanghuan/op/daoshengyi/src/AGENTS.md",
  "第4候选 = 上层 AGENTS.md",
  paths[3],
);
assert(paths.includes("/Users/wanghuan/op/daoshengyi/AGENTS.md"), "项目根 AGENTS.md 在候选里");
assert(paths.includes("/Users/wanghuan/op/AGENTS.md"), "向上递归到父级");
assert(paths.includes("/Users/wanghuan/AGENTS.md"), "再向上到祖父级");
assert(paths.includes("/Users/AGENTS.md"), "继续向上");

// 尾斜杠清理
const paths2 = candidateInstructionPaths("/Users/wanghuan/op/");
assert(paths2[0] === "/Users/wanghuan/op/AGENTS.md", "尾斜杠被清理", paths2[0]);

// 空输入与根目录
assert(candidateInstructionPaths("").length === 0, "空 cwd 返回空数组");
assert(candidateInstructionPaths("/").length === 0, "根目录返回空数组（不再向上）");

// 每层三个候选：AGENTS.md → 道生一.md → DECISIONS.md
let layersOk = true;
for (let i = 0; i + 2 < paths.length; i += 3) {
  if (
    !paths[i].endsWith("AGENTS.md") ||
    !paths[i + 1].endsWith("道生一.md") ||
    !paths[i + 2].endsWith("DECISIONS.md")
  )
    layersOk = false;
}
assert(layersOk, "候选按层成组、AGENTS.md → 道生一.md → DECISIONS.md");
assert(paths.some((p) => p.endsWith("DECISIONS.md")), "决策日志在候选里");
it("脚本式断言（顶层执行）", () => {});
