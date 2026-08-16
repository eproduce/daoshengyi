<script setup lang="ts">
import { ref, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";

interface Diag {
  os: string;
  arch: string;
  app_version: string;
  mem_total_mb: number;
  mem_used_percent: number;
  disk_total_gb: number;
  disk_free_gb: number;
  uptime: string;
  log_tail: string;
}

const diag = ref<Diag | null>(null);
const error = ref("");
const loading = ref(false);

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    diag.value = await invoke<Diag>("system_diagnostics");
  } catch (e) {
    error.value = `获取诊断失败: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

function fmtMem(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}
</script>

<template>
  <div class="health-panel">
    <div class="health-panel__head">
      <h3>🩺 运行时诊断</h3>
      <button class="btn-icon" :disabled="loading" title="刷新" @click="refresh">{{ loading ? "…" : "⟳" }}</button>
    </div>
    <p v-if="error" class="health-error">{{ error }}</p>

    <!-- 系统信息 -->
    <div v-if="diag" class="health-grid">
      <div class="health-cell"><span class="health-label">系统</span>{{ diag.os }} · {{ diag.arch }}</div>
      <div class="health-cell"><span class="health-label">应用版本</span>v{{ diag.app_version }}</div>
      <div class="health-cell">
        <span class="health-label">内存</span>{{ fmtMem(diag.mem_total_mb) }} · 已用 {{ diag.mem_used_percent }}%
        <div class="mini-bar"><div class="mini-bar__fill" :style="{ width: diag.mem_used_percent + '%' }"></div></div>
      </div>
      <div class="health-cell">
        <span class="health-label">磁盘</span>可用 {{ diag.disk_free_gb }} GB / {{ diag.disk_total_gb }} GB
        <div class="mini-bar"><div class="mini-bar__fill" :style="{ width: (diag.disk_free_gb / Math.max(1, diag.disk_total_gb)) * 100 + '%' }"></div></div>
      </div>
      <div class="health-cell"><span class="health-label">运行时长</span>{{ diag.uptime }}</div>
    </div>

    <!-- 日志查看 -->
    <div class="health-log">
      <div class="health-log__title">应用日志（尾部）</div>
      <pre v-if="diag" class="health-log__body">{{ diag.log_tail }}</pre>
      <pre v-else class="health-log__body">加载中…</pre>
    </div>
  </div>
</template>

<style scoped>
.health-panel { display: flex; flex-direction: column; gap: 12px; }
.health-panel__head { display: flex; align-items: center; justify-content: space-between; }
.health-panel__head h3 { margin: 0; font-size: 14px; }
.btn-icon {
  width: 28px; height: 28px; border: none; border-radius: 6px;
  background: var(--bg-secondary, #1a1a30); color: var(--text-secondary, #aaa);
  font-size: 15px; cursor: pointer;
}
.health-error { color: #f87171; font-size: 12px; margin: 0; }

.health-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.health-cell {
  background: #151528; border: 1px solid #2a2a45; border-radius: 8px;
  padding: 10px; font-size: 12px; color: #ddd; line-height: 1.6;
}
.health-label { display: block; font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.04em; }
.mini-bar { height: 6px; background: #22223a; border-radius: 3px; margin-top: 5px; overflow: hidden; }
.mini-bar__fill { height: 100%; background: linear-gradient(90deg, #4ade80, #22c55e); border-radius: 3px; }

.health-log { display: flex; flex-direction: column; min-height: 0; }
.health-log__title { font-size: 12px; color: #bbb; margin-bottom: 6px; }
.health-log__body {
  flex: 1; background: #0d0d1a; border: 1px solid #2a2a45; border-radius: 8px;
  padding: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; line-height: 1.5; color: #9fe6a0; overflow: auto;
  white-space: pre-wrap; word-break: break-all; max-height: 300px;
}
</style>
