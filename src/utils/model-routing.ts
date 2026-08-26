// P-A12 多模型路由：按任务类型自动选模型（纯函数，可测试）。
// 优先级：routing[taskType]（专门配置）→ auxiliaryProfileId（辅助模型）→ ""（跟随主模型）。

export const TASK_TYPES = ["chat", "coding", "summarize", "search"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** 解析某任务类型应使用的 Profile id；返回 "" 表示跟随主模型。 */
export function routeProfileId(
  taskType: string,
  routing: Record<string, string> | undefined,
  auxiliaryProfileId: string,
): string {
  const t = (routing?.[taskType] || "").trim();
  if (t) return t;
  if (auxiliaryProfileId) return auxiliaryProfileId;
  return "";
}
