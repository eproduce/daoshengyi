<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 28 });
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 48 48"
    class="app-logo"
    aria-hidden="true"
  >
    <!-- 圆角方形背景 -->
    <rect class="logo-bg" x="5" y="5" width="38" height="38" rx="9" />
    <!-- 顶部菱形（道） -->
    <polygon class="logo-fg" points="24,11 27.5,14.5 24,18 20.5,14.5" />
    <!-- 底部横线（一） -->
    <rect class="logo-fg" x="14" y="26" width="20" height="4" rx="2" />
  </svg>
</template>

<style scoped>
.app-logo { display: block; flex-shrink: 0; }
.logo-bg {
  fill: var(--logo-bg);
  stroke: var(--logo-border, transparent);
  stroke-width: 1;
}
.logo-fg { fill: var(--logo-fg); }
</style>
