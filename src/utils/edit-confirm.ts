// 文件编辑确认（P-A4）的**请求构造**：把「工具 → 确认弹窗载荷」这件小事收敛成一处。
//
// 原文里这段逻辑被复制了 4 份（`apply_patch` / `replace_string` / `insert_string` / `delete_file`），
// 每份都要手写 `kind` / `path` / `diff` / `summary` / `edits` / `tool` / `args` / `rememberLabel`
// 八个字段 —— 少写一个不会报错，只会让弹窗少显示一块内容（或让「本会话不再确认」失效），
// 属于「静默降级」类缺陷。构造器 + 单测比四份复制更可靠。

/** 用户看到的编辑确认请求（`DiffConfirmDialog` 的输入） */
export interface EditConfirmRequest {
  /** edit = 展示 diff；delete = 展示路径 */
  kind: "edit" | "delete";
  path: string;
  /** edit：unified diff 文本 */
  diff?: string;
  /** edit：Rust 预览给出的摘要（如 `+3 −1`） */
  summary?: string;
  /** edit：确认后要真正应用的编辑操作（原样回传 Rust） */
  edits?: Record<string, unknown>[];
  /** 触发本次确认的工具名（会话级权限记忆按它记） */
  tool: string;
  /** 工具原始参数（审计/弹窗展示用） */
  args: Record<string, unknown>;
  /** 勾选「本会话不再确认」后显示的文案 */
  rememberLabel?: string;
}

/** Rust `apply_edits(preview=true)` 的返回（字段可能不全，按可缺省处理） */
export interface EditPreviewResult {
  path?: string;
  diff?: string;
  summary?: string;
  new_len?: number;
}

export interface EditConfirmInput {
  tool: string;
  path: string;
  args: Record<string, unknown>;
  rememberLabel?: string;
  /** edit 工具：预览结果（delete 不需要） */
  preview?: EditPreviewResult;
  /** edit 工具：待应用的编辑 */
  edits?: Record<string, unknown>[];
}

/**
 * 构造确认请求。
 *
 * 不变量：
 * - `path` 以**预览返回的 path** 为准（Rust 可能做了 `~` 展开）；缺失时退回入参路径；
 * - `kind` 由是否给了 preview 决定（有 preview = 编辑，无 = 删除）；
 * - `edits` 必须原样带上 —— 用户点「应用」后 Rust 用的是**这一份**，不能再拼一遍。
 */
export function buildEditConfirmRequest(input: EditConfirmInput): EditConfirmRequest {
  const isEdit = !!input.preview;
  const req: EditConfirmRequest = {
    kind: isEdit ? "edit" : "delete",
    path: input.preview?.path || input.path,
    tool: input.tool,
    args: input.args,
    ...(input.rememberLabel ? { rememberLabel: input.rememberLabel } : {}),
  };
  if (isEdit) {
    req.diff = input.preview?.diff ?? "";
    req.summary = input.preview?.summary ?? "";
    req.edits = input.edits ?? [];
  }
  return req;
}

/** 用户拒绝编辑时的统一话术（写给模型：要它确认后再来，而不是原样重试） */
export function editRefusalMessage(path: string): string {
  return `⚠️ 用户拒绝了本次文件编辑（${path}），文件未改动。请与用户确认后再尝试，或改用其它方式。`;
}

/** 用户拒绝删除时的统一话术 */
export function deleteRefusalMessage(path: string): string {
  return `⚠️ 用户拒绝了删除文件（${path}），文件未删除。`;
}
