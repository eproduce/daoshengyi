<script setup lang="ts">
// 工作流自定义节点：显式渲染可拖拽连线 Handle（连接点）+ 类型徽标 + 名称 + 运行状态。
// - 所有节点顶部有 target 连接点（连线入口）
// - 非条件节点底部有 source 连接点（连线出口）
// - 条件节点底部有两个 source 连接点：蓝「T」true 分支 / 红「F」false 分支，
//   从对应连接点拖出的连线会自动带上分支标签（无需手动填）
// - 运行状态 runStatus：waiting 待执行 / running 执行中 / done 成功 / error 失败 / skipped 跳过
import { Handle, Position } from "@vue-flow/core";
import type { WorkflowNode, WorkflowNodeType } from "@/utils/workflow-engine";
import { WORKFLOW_NODE_COLORS } from "@/data/workflow-colors";

defineProps<{ data?: { wf?: WorkflowNode } }>();

const COLORS = WORKFLOW_NODE_COLORS;
const TYPE_LABEL: Record<WorkflowNodeType, string> = {
  text: "文本", llm: "LLM", tool: "工具", condition: "条件", code: "代码", end: "结束",
};
</script>

<template>
  <div class="wf-node" :class="`wf-node--${data?.wf?.runStatus || 'waiting'}`" :style="{ '--c': COLORS[data?.wf?.type as WorkflowNodeType] || '#999' }">
    <Handle type="target" :position="Position.Top" id="in" class="wf-handle" title="连线入口（上游）" />
    <div class="wf-node__body">
      <div class="wf-node__row">
        <span class="wf-node__badge">{{ TYPE_LABEL[(data?.wf?.type as WorkflowNodeType) || "text"] }}</span>
        <!-- 运行状态徽标 -->
        <span v-if="data?.wf?.runStatus && data?.wf?.runStatus !== 'waiting'" class="wf-node__run" :class="`wf-node__run--${data.wf.runStatus}`" :title="`运行：${data.wf.runStatus}`">
          <span v-if="data.wf.runStatus === 'running'" class="wf-node__spin">◐</span>
          <template v-else-if="data.wf.runStatus === 'done'">✓</template>
          <template v-else-if="data.wf.runStatus === 'error'">✗</template>
          <template v-else-if="data.wf.runStatus === 'skipped'">⏭</template>
        </span>
      </div>
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
.wf-node__row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.wf-node__badge { font-size: 10px; font-weight: 700; color: var(--c, #999); letter-spacing: .04em; text-transform: uppercase; }
.wf-node__label { font-weight: 600; line-height: 1.4; word-break: break-word; }
/* 运行状态徽标：执行中旋转 / 成功绿 / 失败红 / 跳过灰 */
.wf-node__run {
  font-size: 11px; font-weight: 700; line-height: 1; padding: 2px 5px; border-radius: 8px;
  color: #fff; flex-shrink: 0;
}
.wf-node__run--running { background: #ff9800; }
.wf-node__run--done { background: #2e7d32; }
.wf-node__run--error { background: #c62828; }
.wf-node__run--skipped { background: #757575; }
.wf-node__spin { display: inline-block; animation: wf-spin 0.9s linear infinite; }
@keyframes wf-spin { to { transform: rotate(360deg); } }
/* 节点边框随运行状态变色 */
.wf-node--running { border-color: #ff9800; box-shadow: 0 0 0 2px rgba(255,152,0,.25); }
.wf-node--error { border-color: #c62828; box-shadow: 0 0 0 2px rgba(198,40,40,.2); }
.wf-node--done { border-color: #2e7d32; }
.wf-node--skipped { opacity: .55; }
.wf-handle {
  width: 13px;
  height: 13px;
  background: var(--c, #999);
  border: 2px solid #fff;
  border-radius: 50%;
  box-shadow: 0 0 4px rgba(0, 0, 0, .25);
  cursor: crosshair;
}
/* hover 放大用伪元素实现（围绕 handle 中心原地放大，零偏移）：
   vue-flow 用 transform: translate(...) 给 Handle 定位居中，若直接对 handle 本体
   做 transform/scale，会与定位位移叠加导致端点偏移（用户反馈）。
   伪元素 inset:-2px 外扩覆盖 handle 的 2px 白边并自带白边（box-sizing:border-box），
   其中心 = handle 视觉中心，缩放原点即该中心 → 放大时中心纹丝不动；
   同时避免原固定白环"腰斩"放大圆造成的偏移观感。 */
.wf-handle::after {
  content: "";
  position: absolute;
  inset: -2px;
  box-sizing: border-box;
  border-radius: 50%;
  border: 2px solid #fff;
  background: inherit;
  box-shadow: 0 0 6px rgba(0, 0, 0, .25);
  opacity: 0;
  transform: scale(1);
  pointer-events: none;
  transition: opacity .12s ease, transform .12s ease;
}
.wf-handle:hover::after { opacity: 1; transform: scale(1.3); }
.wf-handle--true { background: #2196f3; }
.wf-handle--false { background: #e53935; }
</style>
