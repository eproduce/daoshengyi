<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 28 });
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 64 64"
    class="app-logo"
    aria-hidden="true"
  >
    <!-- 与系统 Dock 图标同源造型（scripts/gen-icons.cjs：圆点"道"+横条"一"），
         颜色随明暗主题切换（--logo-*），避免固定深色在浅色主题下显得突兀 -->
    <rect width="64" height="64" rx="14" class="logo-bg" />
    <!-- 点 — 道 -->
    <circle cx="32" cy="18" r="3.5" class="logo-fg" opacity="0.9" />
    <!-- 一 — 生一 -->
    <rect x="16" y="34" width="32" height="5" rx="2.5" class="logo-fg" opacity="0.85" />
  </svg>
</template>

<style scoped>
.app-logo {
  display: block; flex-shrink: 0;
  /* 轻微投影让图标方块在背景上更有"独立图标"的层次感 */
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.14));
}
.logo-bg {
  fill: var(--logo-bg);
  stroke: var(--logo-border, transparent);
  stroke-width: 1;
}
.logo-fg { fill: var(--logo-fg); }
</style>
