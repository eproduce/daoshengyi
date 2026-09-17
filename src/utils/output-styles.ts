// P1-8 输出风格（吸收自 DSH 生态的 output styles 思路）。
//
// ## 为什么
//
// 「说得简短点」「讲清原理」「按审阅口吻给意见」这类诉求，用自然语言每次说一遍很累，
// 而且模型会忘。做成**一次设置、全会话生效**的风格档，写在系统提示里最稳。
//
// ## 设计约束
//
// - **不叠加**：切换风格时**替换**已有风格段，而不是追加（否则「简短」和「详细」会同时生效，
//   模型只能随机选一个）。用一个固定标记段实现幂等。
// - **不改写原有提示**：只在末尾追加一段，作用域明确写清「以下规则优先于上面的通用要求」。
// - **fail-safe**：未知风格 id / 缺省风格 → 原样返回（不因配置写错而破坏系统提示）。

export interface OutputStyle {
  id: string;
  /** 设置面板里显示的名字 */
  label: string;
  /** 一句话说明（面板里做副标题） */
  hint: string;
  /** 注入系统提示的正文（空串 = 不加约束，跟随原有风格） */
  body: string;
}

/** 风格段标记：用于幂等替换（切换风格不会叠加） */
export const STYLE_MARKER = "## 输出风格（当前设置，优先于上面的通用要求）";

export const DEFAULT_STYLE_ID = "default";

export const OUTPUT_STYLES: OutputStyle[] = [
  {
    id: DEFAULT_STYLE_ID,
    label: "默认",
    hint: "跟随模型自身风格，不加额外约束",
    body: "",
  },
  {
    id: "concise",
    label: "简洁",
    hint: "结论先行、要点化，去掉复述与客套",
    body:
      "- **结论先行**：第一段就说结果（做了什么/查到什么），不要「好的，我来帮你…」这类铺垫。\n" +
      "- **要点化**：能用列表就不用长段落；同类信息合并成一行。\n" +
      "- **不复述**：不重复用户的问题、不重复工具返回的原文（只引用关键行）。\n" +
      "- 仍必须包含：关键数字、文件路径、命令、以及「没做什么/还有什么没做完」。",
  },
  {
    id: "detailed",
    label: "详细",
    hint: "结论 + 依据与权衡 + 边界条件",
    body:
      "- 结构：**结论** → **依据**（数据/代码位置/命令输出）→ **权衡**（为什么选它、排除了什么）→ **边界**（不适用场景、未验证部分）。\n" +
      "- 关键判断要给出可复核的出处（文件路径 + 行号、命令 + 输出片段）。\n" +
      "- 不确定的地方要**明说是推测**，不要用肯定的语气掩盖不确定性。",
  },
  {
    id: "teaching",
    label: "教学",
    hint: "讲清原理、给最小例子、点出常见坑",
    body:
      "- 先给**一句话原理**（为什么这样设计/为什么会出问题），再给做法。\n" +
      "- 给**最小可运行例子**（必要时代码片段），避免只讲抽象概念。\n" +
      "- 主动点出**常见坑**（易错点、易混淆概念），并说明怎么验证。",
  },
  {
    id: "review",
    label: "审阅",
    hint: "先列问题与风险，再给建议；不直接改",
    body:
      "- 口吻按**代码审阅**：先列**问题与风险**（按严重度排序：正确性 > 安全 > 性能 > 可维护性），再给建议。\n" +
      "- 每条问题给出：位置（文件:行）、为什么是问题、建议怎么改（可给代码片段）。\n" +
      "- **默认不动手改**：除用户明确要求，先给意见让用户决定。\n" +
      "- 没发现问题时也要说明**审阅范围**（看了哪些文件），不要用「看起来没问题」含糊收尾。",
  },
];

/// 按 id 取风格；未知/空 id → null
export function getOutputStyle(id: string | null | undefined): OutputStyle | null {
  if (!id) return null;
  return OUTPUT_STYLES.find((s) => s.id === id) ?? null;
}

/// 该风格是否需要注入（默认风格/未知风格都不用）
export function needsStyleInjection(id: string | null | undefined): boolean {
  const s = getOutputStyle(id);
  return !!s && !!s.body;
}

/// 剥掉提示里已有的风格段（含标记行到下一个同级标题之前）
export function stripStyleSection(prompt: string): string {
  const text = prompt ?? "";
  const idx = text.indexOf(STYLE_MARKER);
  if (idx < 0) return text;
  const rest = text.slice(idx + STYLE_MARKER.length);
  // 下一个 `## ` 标题（不含标记行自身）视为风格段结束
  const next = rest.search(/\n##\s/);
  const after = next >= 0 ? rest.slice(next + 1) : "";
  const head = text.slice(0, idx).replace(/\s+$/, "");
  return after ? `${head}\n\n${after}`.replace(/\s+$/, "") : head;
}

/// 渲染风格段（正文为空返回空串）
export function styleSection(style: OutputStyle): string {
  if (!style.body) return "";
  return `${STYLE_MARKER}\n${style.body}`;
}

/**
 * 把风格应用到系统提示：
 * - 默认/未知风格 → 先**剥掉**已有风格段并返回（切回默认要真的生效）
 * - 其他风格 → 剥掉旧的再追加新的（**幂等**，反复切换不会堆叠）
 */
export function applyOutputStyle(prompt: string, styleId: string | null | undefined): string {
  const base = stripStyleSection(prompt ?? "");
  const style = getOutputStyle(styleId);
  if (!style || !style.body) return base;
  const section = styleSection(style);
  return base.trim() ? `${base.trimEnd()}\n\n${section}` : section;
}
