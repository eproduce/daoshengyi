// 「本会话内不再询问」的作用域规则（纯函数 + 单测）。
//
// 为什么不是「每个工具名各管各的」：
// 用户勾选时想表达的是「别再为这类操作打断我」。实测反馈（「勾选好像没有效果」）——
// 勾了 `replace_string` 之后，Agent 改用 `insert_string` / `apply_patch` 又被问，
// 用户只会认为勾选无效。所以同一「类」操作勾一次即整类放行。
//
// 但**编辑与删除刻意分成两类**：删除更有破坏性，不该被「改内容」的放行顺带覆盖
// （否则用户只是想让改文件别打断，却连带放行了删文件）。

/** 「改内容」类：勾一次覆盖这一类全部工具 */
export const EDIT_TOOLS: readonly string[] = ["replace_string", "insert_string", "apply_patch"];

/** 「删除」类：单独一类（破坏性更强，不与其他类合并） */
export const DELETE_TOOLS: readonly string[] = ["delete_file"];

const GROUPS: readonly (readonly string[])[] = [EDIT_TOOLS, DELETE_TOOLS];

/** 该工具所属的「类」；不属于任何类（或未收录）时返回 undefined */
export function toolGroup(tool: string): readonly string[] | undefined {
  return GROUPS.find((g) => g.includes(tool));
}

/**
 * 该工具是否已被本会话放行。
 * 判定规则：**自身被放行，或同类中任意一个被放行**（这是「勾一次别整类」的落点）。
 * 不属于任何类的工具只按精确名匹配（保持原有语义，例如 run_command / 权限规则里的任意工具名）。
 */
export function permitsSatisfy(permits: Iterable<string>, tool: string): boolean {
  const set = permits instanceof Set ? permits : new Set(permits);
  if (set.has(tool)) return true;
  const group = toolGroup(tool);
  return !!group && group.some((t) => set.has(t));
}

/**
 * 弹窗上那行勾选文案：**如实说明**这次勾选会放行哪些工具。
 * 含糊的「不再询问」会让人以为「全都放行了」，反过来含糊的「只不再询问 X」又会让人
 * 以为「勾了没用」——两种误解都要避免，所以把范围写在字面上。
 */
export function permitLabel(tool: string): string {
  const group = toolGroup(tool);
  if (!group || group.length <= 1) return `本会话内不再询问 ${tool}`;
  return `本会话内不再询问这类文件编辑（${group.join(" / ")}）`;
}
