// P-A7 权限矩阵：工具级开关 + 路径白名单（纯函数，可测试）。
// 前端 callMcpTool / callBuiltinTool 在执行前调用这些判定拦截。

/** 工具是否在禁用列表（权限矩阵工具级开关）。按精确名匹配，忽略空白项。 */
export function isToolDisabled(tool: string, disabled: string[]): boolean {
  const set = new Set(disabled.map((x) => x.trim()).filter(Boolean));
  return set.has(tool);
}

/**
 * 路径是否在允许白名单内（权限矩阵路径白名单）。
 * - 未配置白名单（空数组）→ 全部允许（写操作仍受 Rust 主目录边界约束）
 * - 配置后：路径需等于某个白名单目录，或以「目录 + /」开头（前缀匹配，支持 ~ 前缀）
 */
export function isPathAllowed(path: string, allowed: string[]): boolean {
  const dirs = allowed.map((x) => x.trim()).filter(Boolean);
  if (dirs.length === 0) return true;
  const norm = (p: string) => p.replace(/\/+$/, "");
  const p = norm(path);
  return dirs.some((d) => {
    const dir = norm(d);
    if (!dir) return false;
    return p === dir || p.startsWith(dir + "/");
  });
}

/** 取路径型参数（path / cwd / dir / root），供路径白名单统一判定。 */
export function pathArgOf(args: Record<string, unknown>): string {
  const v = args.path ?? args.cwd ?? args.dir ?? args.root;
  return typeof v === "string" ? v : "";
}
