<script setup lang="ts">
// 工作流自定义节点：显式渲染可拖拽连线 Handle（连接点）+ 类型徽标 + 名称。
// - 所有节点顶部有 target 连接点（连线入口）
// - 非条件节点底部有 source 连接点（连线出口）
// - 条件节点底部有两个 source 连接点：蓝「T」true 分支 / 红「F」false 分支，
//   从对应连接点拖出的连线会自动带上分支标签（无需手动填）
import { Handle, Position } from "@vue-flow/core";
import type { WorkflowNode, WorkflowNodeType } from "@/utils/workflow-engine";

defineProps<{ data?: { wf?: WorkflowNode } }>();

const COLORS: Record<WorkflowNodeType, string> = {
  text: "#4caf50",
  llm: "#2196f3",
  tool: "#ff9800",
  condition: "#9c27b0",
  code: "#00bcd4",
  end: "#9e9e9e",
};
const TYPE_LABEL: Record<WorkflowNodeType, string> = {
  text: "文本", llm: "LLM", tool: "工具", condition: "条件", code: "代码", end: "结束",
};
</script>

<template>
  <div class="wf-node" :style="{ '--c': COLORS[data?.wf?.type as WorkflowNodeType] || '#999' }">
    <Handle type="target" :position="Position.Top" id="in" class="wf-handle" title="连线入口（上游）" />
    <div class="wf-node__body">
      <span class="wf-node__badge">{{ TYPE_LABEL[(data?.wf?.type as WorkflowNodeType) || "text"] }}</span>
      <span class="wf-node__label">{{ data?.wf?.label || "节点" }}</span>
    </div>
    <template v-if="data?.wf?.type === 'condition'">
      <Handle type="source" :position="Position.Bottom" id="true" :style="{ left: '30%' }" class="wf-handle wf-handle--true" title="true 分支" />
      <Handle type="source" :position="Position.Bottom" id="false" :style="{ left: '70%' }" class="wf-handle wf-handle--false" title="false 分支" />
    </template>
    <Handle v-else type="source" :position="Position.Bottom" id="out" class="wf-handle" title="连线出口（下游）" />
  </div>
</template>

<style scoped>
.wf-node {
  position: relative;
  min-width: 132px;
  padding: 8px 12px;
  border: 1.5px solid var(--c, #999);
  border-left: 4px solid var(--c, #999);
  border-radius: 10px;
  background: var(--bg-elevated, #fff);
  color: var(--text-primary, #222);
  box-shadow: 0 2px 10px rgba(0, 0, 0, .10);
  font-size: 13px;
  cursor: grab;
}
.wf-node:active { cursor: grabbing; }
.wf-node__body { display: flex; flex-direction: column; gap: 2px; }
.wf-node__badge { font-size: 10px; font-weight: 700; color: var(--c, #999); letter-spacing: .04em; text-transform: uppercase; }
.wf-node__label { font-weight: 600; line-height: 1.4; word-break: break-word; }
.wf-handle {
  width: 13px;
  height: 13px;
  background: var(--c, #999);
  border: 2px solid #fff;
  border-radius: 50%;
  box-shadow: 0 0 4px rgba(0, 0, 0, .25);
  cursor: crosshair;
}
.wf-handle:hover { transform: scale(1.25); }
.wf-handle--true { background: #2196f3; }
.wf-handle--false { background: #e53935; }
</style>
