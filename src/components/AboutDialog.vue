<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import AppLogo from "./AppLogo.vue";
import { Github } from "lucide-vue-next";

const emit = defineEmits<{ (e: "close"): void }>();

const appVersion = ref("0.1.0");

// 外部链接：优先用系统浏览器打开（Tauri 桌面环境）
async function openHome() {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open("https://github.com/eproduce/daoshengyi");
  } catch { /* 浏览器预览等环境下静默 */ }
}

function onKey(e: KeyboardEvent) { if (e.key === "Escape") emit("close"); }
onMounted(async () => {
  try { appVersion.value = await invoke<string>("app_version"); } catch { /* 保留默认值 */ }
  document.addEventListener("keydown", onKey);
});
onUnmounted(() => document.removeEventListener("keydown", onKey));
</script>

<template>
  <Teleport to="body">
    <div class="about-overlay" @click.self="emit('close')">
      <div class="about-card">
        <div class="about-logo"><AppLogo :size="72" /></div>
        <h2 class="about-name">道生一</h2>
        <div class="about-version">版本 v{{ appVersion }}</div>
        <p class="about-desc">
          AI Agent 桌面客户端：多模态对话、图片识别、MCP 插件、
          技能库、定时任务与本地模型部署。
        </p>
        <div class="about-stack">
          <span class="about-tag">Tauri 2</span>
          <span class="about-tag">Vue 3</span>
          <span class="about-tag">Rust</span>
          <span class="about-tag">TypeScript</span>
        </div>
        <div class="about-links">
          <button class="about-link" @click="openHome"><Github :size="15" /> GitHub</button>
        </div>
        <div class="about-copy">© 2026 道生一 · 道生一，一生二，二生三，三生万物</div>
        <button class="about-close" @click="emit('close')">关闭</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.about-overlay {
  position: fixed; inset: 0; z-index: 300;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.5); backdrop-filter: blur(3px);
  animation: fadeIn .18s ease;
}
.about-card {
  width: 340px; padding: 28px 28px 22px;
  background: var(--bg-elevated); border: 1px solid var(--border-color);
  border-radius: 18px; box-shadow: var(--shadow-xl);
  display: flex; flex-direction: column; align-items: center; text-align: center;
  animation: popIn .2s ease;
}
.about-logo {
  width: 88px; height: 88px; border-radius: 24px;
  background: var(--accent-light); display: flex; align-items: center;
  justify-content: center; margin-bottom: 14px; box-shadow: var(--shadow-md);
}
.about-name {
  margin: 0 0 4px; font-size: 22px; font-weight: 700; color: var(--text-primary);
  letter-spacing: -.02em;
  background: linear-gradient(135deg, var(--accent-color), #06b6d4);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  background-clip: text;
}
.about-version {
  font-size: 12px; color: var(--text-muted); margin-bottom: 14px;
  font-variant-numeric: tabular-nums;
}
.about-desc {
  font-size: 13px; line-height: 1.7; color: var(--text-secondary);
  margin: 0 0 16px;
}
.about-stack { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; margin-bottom: 18px; }
.about-tag {
  padding: 3px 10px; border-radius: 12px; font-size: 11px;
  background: var(--accent-bg); color: var(--accent-color); font-weight: 600;
}
.about-links { margin-bottom: 14px; }
.about-link {
  border: 1px solid var(--border-color); border-radius: 14px;
  background: var(--bg-secondary); color: var(--text-secondary);
  font-size: 12px; padding: 6px 14px; cursor: pointer; transition: all .15s;
}
.about-link:hover { border-color: var(--accent-color); color: var(--accent-color); background: var(--accent-bg); }
.about-copy { font-size: 11px; color: var(--text-muted); margin-bottom: 16px; }
.about-close {
  width: 100%; padding: 9px 0; border: none; border-radius: 10px;
  background: var(--accent-color); color: #fff; font-size: 13px; font-weight: 600;
  cursor: pointer; transition: opacity .15s;
}
.about-close:hover { opacity: .88; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes popIn { from { opacity: 0; transform: scale(.95); } to { opacity: 1; transform: scale(1); } }
</style>
