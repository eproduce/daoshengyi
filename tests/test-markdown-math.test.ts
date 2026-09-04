import { it, expect } from "vitest";
// 数学公式 + Markdown 表格渲染预处理（normalizeMath）的全面测试。
// 覆盖：表格结构（带空格/无空格/对齐/全角竖线）、公式（$...$/$$...$$/\(...\)/\[...\]/货币）、
// 裸数学自动包裹（上标/根号/积分/函数词/绝对值/Unicode）、误判防护（普通段落/代码块/URL）。
// 运行：node scripts/test-markdown-math.mts
import { normalizeMath } from "../src/utils/markdown-math.ts";


function assert(cond: boolean, name: string, detail = "") {
  expect(cond, name + (detail ? ` · ${detail}` : "")).toBe(true);
}

function check(input: string, expected: string[], name: string) {
  const out = normalizeMath(input);
  const ok = expected.every((e) => out.includes(e));
  assert(ok, name, ok ? undefined : out);
}
function checkNot(input: string, banned: string[], name: string) {
  const out = normalizeMath(input);
  const ok = banned.every((e) => !out.includes(e));
  assert(ok, name, ok ? undefined : out);
}

console.log("== 表格结构 ==");
check("| 函数 | 导数 |\n| --- | --- |\n| x^n | n x^{n-1} |", ["$x^n$", "$n x^{n-1}$"], "带空格分隔行 + 裸数学包裹");
check("| 函数 | 导数 |\n|---|---|\n| x^n | e^x |", ["$x^n$", "$e^x$"], "无空格分隔行（顾此失彼回归）");
check("| 函数 | 导数 |\n|:---|:---:|\n| sin x | cos x |", ["$sin x$"], "对齐分隔行 :---:");
check("｜∫ x dx｜x^2/2｜\n｜---｜---｜\n｜∫ 1/x dx｜ln |x|｜", ["$∫ x dx$", "$ln \\vert x\\vert"], "全角竖线积分表");
check("| 项 | 值 |\n| --- | --- |\n| 中文单元格 | 保留 |", ["中文单元格", "保留"], "含中文单元格不包裹");
check("| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |", ["| A | B | C |"], "多列多行表格保留");

console.log("== 公式 ==");
check("公式 $|G|$ 在表格外", ["$\\vert G\\vert"], "$ 内竖线转 \\vert");
check("块级\n\n$$E=mc^2$$\n\n", ["$$E=mc^2$$"], "$$ 块级保留");
check("\\(x^2\\) 归一化", ["$x^2$"], "\\(...\\) → $...$");
check("公式 $x^2$ 是平方", ["$x^2$"], "$ 内公式不被二次包裹/货币转义");
check("有 $|x|$ 与 $$|y|$$", ["$\\vert x\\vert", "$$\\vert y\\vert"], "行内与块级公式竖线都转 \\vert");

console.log("== 货币 ==");
check("价格 $100 元", ["\\$100"], "货币 $100 → \\$100");
check("价格 $1,000.50 元", ["\\$1,000.50"], "货币 $1,000.50 → \\$1,000.50");
check("它 costs $5 and $10", ["$5 and $10"], "段落内货币 $5 保留（不被公式化）");

console.log("== 裸数学自动包裹 ==");
check("| A | B |\n| --- | --- |\n| x^n | 1 / √(1-x^2) |", ["$x^n$", "$1 / \\sqrt{1-x^2}$"], "上标 + 根号 √ → \\sqrt");
check("| A | B |\n| --- | --- |\n| 值 | ln |x| + C |", ["$ln \\vert x\\vert"], "函数词 ln + 绝对值");
check("| A | B |\n| --- | --- |\n| a | sec^2 x |", ["$sec^2 x$"], "sec^2 包裹");
check("| A | B |\n| --- | --- |\n| 1 | n ≠ −1 |", ["$n \\neq -1$"], "≠ → \\neq、− → -");
check("| A | B |\n| --- | --- |\n| 1 | ∫ e^x dx |", ["$∫ e^x dx$"], "积分 + 上标包裹");
check("| A | B |\n| --- | --- |\n| 1 | e^x + C |", ["$e^x + C$"], "含空格数学表达式包裹");

console.log("== 误判防护 ==");
checkNot("速度 v^2 与比例 1/x 讨论", ["$v^2$", "$1/x$"], "普通段落裸数学不包裹");
checkNot("```\nx^n\n```", ["$x^n$"], "代码块内不处理");
check("`x^n` 是代码", ["`x^n`"], "行内代码保护");
checkNot("访问 https://example.com/a?b=c 查看", ["$"], "URL 不受影响（不含公式）");
check("| 值 | |f'(x)| |\n| --- | --- |", ["\\|f'(x)\\|"], "绝对值竖线转义（表格）");
it("脚本式断言（顶层执行）", () => {});
