// Agent 工作区（借鉴 DeepSeek Harness 的 workspace 概念）的**纯展示/清洗逻辑**。
//
// 起因：这个设置原本藏在「设置 → API 配置」里（与 base URL / key 混在一起），
// 但它跟 API 无关——它决定 Agent 执行命令/读文件的默认目录，属于「这次对话怎么干活」，
// 所以抽到输入框工具栏（对话框配置）常驻显示。抽出来后工具栏需要「短名显示 + 悬浮看全路径
// + 输入清洗 + 明显错误提前拦下」，这些判定全放这里做纯函数，便于单测。

/** 清洗输入：去首尾空白、去掉结尾多余的 `/`（`/` 本身保留）；空串 → null（= 不限定目录）。 */
export function normalizeWorkspace(input: string | null | undefined): string | null {
  const v = (input ?? "").trim();
  if (!v) return null;
  // 同一目录不该出现 `/a/b` 与 `/a/b/` 两种写法（沙箱 subpath 匹配、工作区缓存 key 都靠它）
  const stripped = v.length > 1 ? v.replace(/\/+$/, "") : v;
  return stripped || null;
}

/** 工具栏短名：只显示最后一级目录名（`/Users/me/op/daoshengyi` → `daoshengyi`）。未设置 → 空串。 */
export function workspaceLabel(path: string | null | undefined): string {
  const v = normalizeWorkspace(path);
  if (!v) return "";
  if (v === "/") return "/";
  if (v === "~") return "~";
  const parts = v.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? v;
}

/** 悬浮提示：完整路径 + 这个设置到底影响什么（工具栏只显示短名，全路径靠 tooltip）。 */
export function workspaceTitle(path: string | null | undefined): string {
  const v = normalizeWorkspace(path);
  return v
    ? `Agent 工作区：${v}\nAgent 执行命令、读取文件的默认目录；「工作区可写」沙箱档位也用它。点击修改`
    : "未设置 Agent 工作区（点击设置）\n空 = 不限定目录：命令与文件工具可用任意路径";
}

/**
 * 校验输入，返回错误文案（空串 = 通过）。
 * 空值不算错误——那是「清除工作区」这个合法操作。
 * 为什么必须校验：相对路径会被后端按应用自身的工作目录解析，用户以为是项目目录却指向别处，
 * 而「工作区可写」沙箱会因此放行/拦截错的地方。
 */
export function workspaceInputError(input: string | null | undefined): string {
  const v = normalizeWorkspace(input);
  if (!v) return "";
  if (!v.startsWith("/") && !v.startsWith("~")) {
    return "请填绝对路径（以 / 或 ~/ 开头）";
  }
  return "";
}

/**
 * 会话级工作区解析（借鉴 DSH：**会话头的 cwd 才是执行策略的真源**，全局设置只是新会话的默认）。
 *
 * 三态语义（这是本功能的全部复杂度所在）：
 * - `undefined` / `null`：本会话没有覆盖 → **跟随全局**
 * - `""`（空串）：本会话**明确不限定** → 覆盖掉全局默认（例如全局默认是项目目录，
 *   但这次只想问个通用问题，不希望 Agent 默认在那个项目里动手）
 * - 其他：本会话用这个目录
 */
export function resolveWorkspace(
  sessionWorkspace: string | null | undefined,
  globalWorkspace: string | null | undefined,
): string | null {
  if (sessionWorkspace === undefined || sessionWorkspace === null) {
    return normalizeWorkspace(globalWorkspace);
  }
  return normalizeWorkspace(sessionWorkspace);
}

/** 当前是「跟随全局」还是「本会话覆盖」（UI 用它决定显示哪个标签、显示哪些按钮） */
export function workspaceSource(sessionWorkspace: string | null | undefined): "global" | "session" {
  return sessionWorkspace === undefined || sessionWorkspace === null ? "global" : "session";
}
