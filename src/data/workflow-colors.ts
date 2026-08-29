import type { WorkflowNodeType } from "@/utils/workflow-engine";

// 工作流节点类型的主题色。
// palette 图例（WorkflowDialog 左侧节点库按钮）与画布节点（WorkflowNodeView）
// 必须共用这一份，避免两处颜色不一致（"图例对不上节点"）。
export const WORKFLOW_NODE_COLORS: Record<WorkflowNodeType, string> = {
  text: "#4caf50", // 绿
  llm: "#2196f3", // 蓝
  tool: "#ff9800", // 橙
  condition: "#9c27b0", // 紫
  code: "#00bcd4", // 青
  end: "#9e9e9e", // 灰
};
