<script setup lang="ts">
import { computed } from "vue";
import { useChatStore } from "../stores/chat";
import { ListChecks, Circle, Loader2, CheckCircle2, XCircle, X } from "lucide-vue-next";

const chat = useChatStore();
const plan = computed(() => chat.taskPlan);
const doneCount = computed(() => plan.value?.steps.filter((s) => s.status === "done").length ?? 0);
const totalCount = computed(() => plan.value?.steps.length ?? 0);
const percent = computed(() => (totalCount.value ? Math.round((doneCount.value / totalCount.value) * 100) : 0));
const allDone = computed(() => totalCount.value > 0 && doneCount.value === totalCount.value);

function close() {
  chat.setTaskPlan(null);
}
</script>

<template>
  <div v-if="plan" class="task-plan" :class="{ 'task-plan--done': allDone }">
    <div class="task-plan__header">
      <ListChecks :size="15" class="lucide task-plan__logo" />
      <span class="task-plan__title">{{ plan.title }}</span>
      <span class="task-plan__count" :class="{ 'task-plan__count--done': allDone }">
        {{ allDone ? "✅ 全部完成" : `${doneCount}/${totalCount}` }}
      </span>
      <button class="task-plan__close" title="关闭计划" @click="close"><X :size="14" class="lucide" /></button>
    </div>
    <div class="task-plan__bar">
      <div class="task-plan__bar-fill" :style="{ width: percent + '%' }" />
    </div>
    <ul class="task-plan__steps">
      <li
        v-for="(step, i) in plan.steps"
        :key="i"
        class="task-plan__step"
        :class="`step--${step.status}`"
      >
        <CheckCircle2 v-if="step.status === 'done'" :size="14" class="lucide step__icon step__icon--done" />
        <Loader2 v-else-if="step.status === 'doing'" :size="14" class="lucide step__icon step__icon--doing spin" />
        <XCircle v-else-if="step.status === 'failed'" :size="14" class="lucide step__icon step__icon--failed" />
        <Circle v-else :size="14" class="lucide step__icon step__icon--pending" />
        <span class="step__text" :class="{ 'step__text--done': step.status === 'done' }">{{ step.text }}</span>
        <span class="step__tag" :class="`step__tag--${step.status}`">
          {{ step.status === "done" ? "完成" : step.status === "doing" ? "进行中" : step.status === "failed" ? "失败" : "待办" }}
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.task-plan {
  margin: 0 auto 14px;
  max-width: 860px;
  width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--border-color, #333);
  border-radius: 10px;
  background: var(--bg-secondary, #1c1c22);
  font-size: 13px;
}
.task-plan--done { border-color: rgba(52, 211, 153, 0.4); }
.task-plan__header { display: flex; align-items: center; gap: 8px; }
.task-plan__logo { color: var(--accent-color, #4f8cff); }
.task-plan__title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-plan__count { color: var(--text-secondary, #999); font-size: 12px; flex-shrink: 0; }
.task-plan__count--done { color: #34d399; font-weight: 600; }
.task-plan__close {
  background: none; border: none; color: var(--text-secondary, #999);
  cursor: pointer; padding: 2px; display: flex; flex-shrink: 0;
}
.task-plan__close:hover { color: var(--text-primary, #eee); }
.task-plan__bar { height: 4px; border-radius: 2px; background: var(--bg-hover, #2a2a31); margin: 8px 0; overflow: hidden; }
.task-plan__bar-fill {
  height: 100%; border-radius: 2px;
  background: linear-gradient(90deg, var(--accent-color, #4f8cff), #22c55e);
  transition: width 0.3s ease;
}
.task-plan__steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.task-plan__step { display: flex; align-items: center; gap: 8px; }
.step__icon--done { color: #34d399; }
.step__icon--doing { color: var(--accent-color, #4f8cff); }
.step__icon--failed { color: #f87171; }
.step__icon--pending { color: var(--text-secondary, #666); }
.step__text { flex: 1; }
.step__text--done { text-decoration: line-through; color: var(--text-secondary, #999); }
.step__tag { font-size: 11px; padding: 1px 6px; border-radius: 6px; background: var(--bg-hover, #2a2a31); color: var(--text-secondary, #999); flex-shrink: 0; }
.step__tag--done { background: rgba(52, 211, 153, 0.15); color: #34d399; }
.step__tag--doing { background: rgba(79, 140, 255, 0.15); color: #7eb0ff; }
.step__tag--failed { background: rgba(248, 113, 113, 0.15); color: #f87171; }
.spin { animation: ds-spin 1s linear infinite; }
@keyframes ds-spin { to { transform: rotate(360deg); } }
</style>
