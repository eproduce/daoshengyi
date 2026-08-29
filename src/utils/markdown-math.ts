// 数学公式 + Markdown 表格渲染预处理（从 ChatMessage.vue 抽取为独立可测试模块）
//
// 背景：模型输出常不规范——表格里写字面 |（绝对值/集合）、全角竖线 ｜、裸数学（x^n、1/x）、
// Unicode 数学符号（√、−、≠）。这里做多层容错预处理，产出规范化 markdown，再由 marked + KaTeX
// 渲染（见 utils/katex-marked.ts）。
//
// ⚠️ 约束：
//   - 全程禁用 lookbehind（WKWebView/Safari 旧内核不支持），用捕获组/前瞻
//   - 顺序正则在"一个字符串"上堆叠容易互相干扰（顾此失彼）——改动前务必跑
//     `node scripts/test-markdown-math.mts`，并覆盖：无空格分隔行 |---|、带空格 | --- |、
//     全角竖线 ｜、绝对值 |x|、集合 {x | x}、货币 $5、公式 $...$、代码块保护等
//
// 处理顺序（不可随意调整）：
//   1. protectCodeSpans：占位保护代码块/行内代码（其 $ | 不参与后续处理）
//   2. 全角竖线 ｜(U+FF5C) → " | "（两侧补空格成为列分隔符）
//   3. CJK 与 $ 紧贴补空格（否则 "设$x^2$" 不被识别）
//   4. \(...\) → $...$、\[...\] → $$...$$ 归一化
//   5. $...$ 内 | → \vert（KaTeX 渲染 |；避免被当表格列分隔符切碎单元格）
//   6. 占位保护公式段（$...$ / $$...$$）
//   7. 占位保护表格分隔行（整行只含 | - : 空格；否则其 | 紧贴 - 被第 8 步误转义）
//   8. 内容竖线转义：$ 外紧贴非空白的 |（绝对值 |x|）→ \|
//   9. 货币 $ 转义：$5 / $100 / $1,000.50 → \$
//  10. 恢复公式段
//  11. wrapBareMathInTables：表格单元格裸数学自动包裹（x^n → $x^n$ 等）+ Unicode → KaTeX 命令
//  12. restore：恢复代码块

const MATH_PH = "\u0000";
const CJK_ADJACENT = "\\u4e00-\\u9fa5\\u3000-\\u303f\\uff00-\\uffef";

function protectCodeSpans(s: string) {
  const blocks: string[] = [];
  const text = s
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (m) => { blocks.push(m); return `${MATH_PH}b${blocks.length - 1}${MATH_PH}`; })
    .replace(/`+[^`\n]*?`+/g, (m) => { blocks.push(m); return `${MATH_PH}i${blocks.length - 1}${MATH_PH}`; });
  return {
    text,
    restore(t: string) {
      return t.replace(new RegExp(`${MATH_PH}[bi](\\d+)${MATH_PH}`, "g"), (_, idx) => blocks[Number(idx)]);
    },
  };
}

/** 数学公式与表格竖线的规范化预处理（返回可直接喂给 marked 的 markdown）。 */
export function normalizeMath(s: string): string {
  const { text, restore } = protectCodeSpans(s);
  const mathBlocks: string[] = [];
  const sepRows: string[] = [];
  const out = text
    // 全角竖线 ｜(U+FF5C) → 半角 | 且两侧补空格：模型常写全角竖线作表格列分隔符，
    // GFM 只认半角 |；补空格让转出的 | 成为「两侧空白」的列分隔符，不被内容竖线转义误判
    .replace(/\uff5c/g, " | ")
    // 中文（含全角标点）与 $ 紧贴 → 补空格，让 inline 公式能被识别
    .replace(new RegExp(`([${CJK_ADJACENT}])(\\$+)`, "g"), "$1 $2")
    .replace(new RegExp(`(\\$+)([${CJK_ADJACENT}])`, "g"), "$1 $2")
    // \(...\) → $...$
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => `$${body.trim()}$`)
    // \[...\] → 块级 $$...$$
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => `\n\n$$\n${body.trim()}\n$$\n\n`)
    // $...$ 内 | → \vert（KaTeX 渲染 |；避免被当表格列分隔符切碎单元格）。
    // \vert 后必须带空格（否则 \vertG 被解析成不存在的命令 vertG）。先 $$ 再 $。
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, body: string) => `$$${body.replace(/\|/g, "\\vert ") }$$`)
    .replace(/\$([^$\n]+?)\$/g, (_, body: string) => `$${body.replace(/\|/g, "\\vert ") }$`)
    // 占位保护公式段（内部已是 \vert，无需再动）
    .replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*?\$/g, (m) => {
      mathBlocks.push(m); return `${MATH_PH}m${mathBlocks.length - 1}${MATH_PH}`;
    })
    // 占位保护表格分隔行（整行只含 | - : 空格）：其 | 紧贴 -，会被下方内容竖线转义误伤成
    // \|，导致 wrapBareMathInTables 识别不了表格块 → 裸数学包裹失效（顾此失彼的根因）
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, (m) => {
      sepRows.push(m); return `${MATH_PH}s${sepRows.length - 1}${MATH_PH}`;
    })
    // 内容竖线转义：$ 外紧贴非空白的 |（绝对值 |x|、|f'(x)|）→ \|（marked 表格内按转义
    // 竖线处理、不切分）；两侧空白的 |（列分隔符 `| A |`、集合 {x | x}）保持不变
    .replace(/[^\s|]\||\|(?=[^\s|])/g, (m) => (m.length === 2 ? m[0] + "\\|" : "\\|"))
    // 恢复表格分隔行
    .replace(new RegExp(`${MATH_PH}s(\\d+)${MATH_PH}`, "g"), (_, i: string) => sepRows[Number(i)])
    // 货币/普通数字 $ 转义：$5 / $100 / $1,000.50 → \$xxx，避免被当公式起点
    // 替换串 \\$$$1 = 字面反斜杠 + 字面$（$$）+ 捕获组1（$1）
    .replace(/\$(\d[\d,]*(?:\.\d+)?)/g, "\\$$$1")
    // 恢复公式段
    .replace(new RegExp(`${MATH_PH}m(\\d+)${MATH_PH}`, "g"), (_, i: string) => mathBlocks[Number(i)]);
  // 表格单元格裸数学自动包裹：恢复公式段后、恢复代码块前执行（含 $ 的单元格跳过）
  return restore(wrapBareMathInTables(out));
}

const MATH_FN_RE = /(?:^|[^A-Za-z])(?:ln|log|lg|sin|cos|tan|sec|csc|cot|exp|sinh|cosh|tanh|arcsin|arccos|arctan)(?=$|[^A-Za-z])/;

/** 是否含中文（含中文的单元格不做裸数学包裹，避免误判）。 */
export function hasChinese(t: string): boolean {
  return /[\u4e00-\u9fa5]/.test(t);
}

/** 是否为"纯数学且含强数学特征"（^ 上标、√ ∫ ∑ ∞ π、≠ ≤ ≥、−、希腊字母、函数词）。 */
export function isBareMath(t: string): boolean {
  if (!t || t.length > 60) return false;
  return /[\^√∫∑∞π≠≤≥−]/.test(t) || /[\u0370-\u03ff]/.test(t) || MATH_FN_RE.test(t);
}

/** 表格单元格裸数学自动包裹：识别表格块，对纯数学单元格自动包 $...$ 让 KaTeX 渲染。 */
export function wrapBareMathInTables(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const next = lines[i + 1] ?? "";
    const isSep = /^\s*\|?[\s:|-]+\|?\s*$/.test(next) && next.includes("|") && next.includes("-");
    if (lines[i].includes("|") && isSep) {
      // 表头也走裸数学包裹（纯数学表头如「∫ x dx」应渲染成 KaTeX；含中文的表头安全跳过）
      out.push(wrapRowMath(lines[i])); out.push(next); i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        out.push(wrapRowMath(lines[i])); i++;
      }
    } else { out.push(lines[i]); i++; }
  }
  return out.join("\n");
}

function wrapRowMath(row: string): string {
  // 先占位转义竖线 \|，避免按 | split 时把转义竖线当列分隔符
  const esc = row.replace(/\\\|/g, "\u0001");
  return esc.split("|").map((cell) => {
    const restored = cell.replace(/\u0001/g, "\\|");
    const t = restored.trim();
    if (!t || t.includes("$") || hasChinese(t)) return restored;
    if (isBareMath(t)) {
      // Unicode 数学符号 → KaTeX 命令（KaTeX 不认 √/∞/∑/≠/≤/≥/− 等裸 Unicode）；
      // markdown 转义竖线 \| → KaTeX \vert（否则成双竖线范数）
      const math = t
        .replace(/\\\|/g, "\\vert ")
        .replace(/−/g, "-")
        .replace(/√\(([^()]*)\)/g, "\\sqrt{$1}")
        .replace(/√/g, "\\sqrt ")
        .replace(/∞/g, "\\infty")
        .replace(/∑/g, "\\sum")
        .replace(/≠/g, "\\neq")
        .replace(/≤/g, "\\le")
        .replace(/≥/g, "\\ge");
      return restored.replace(t, `$${math}$`);
    }
    return restored;
  }).join("|");
}
