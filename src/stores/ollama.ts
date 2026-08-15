import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { HardwareInfo } from "@/types";

export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  installing: boolean;
  models: string[];
}

/**
 * Ollama 全局管理 store：
 * 部署任务与下载进度监听不随「本地模型」界面关闭而中断。
 * 监听在应用启动时注册（main.ts 调用 init()），部署进行中关闭界面，
 * 后台继续下载；重新打开界面时从 store 恢复进度显示。
 */
export const useOllamaStore = defineStore("ollama", () => {
  const status = ref<OllamaStatus | null>(null);
  const hw = ref<HardwareInfo | null>(null);
  const busy = ref(false);
  const progress = ref("");
  const percent = ref<number | null>(null);
  let unlisten: (() => void) | null = null;

  const hasLlava = computed(
    () => status.value?.models.some((m) => m.includes("llava-phi3")) ?? false
  );

  // 注册全局进度监听（只注册一次，应用生命周期内持续接收）
  function ensureListen() {
    if (unlisten) return;
    listen<{ text?: string; percent?: number } | string>("ollama-progress", (e) => {
      const p = e.payload;
      if (typeof p === "string") {
        progress.value = p;
        return;
      }
      if (typeof p.text === "string") progress.value = p.text;
      if (typeof p.percent === "number") percent.value = p.percent;
    })
      .then((u) => { unlisten = u; })
      .catch(() => {});
  }

  async function refreshStatus() {
    try {
      status.value = await invoke<OllamaStatus>("ollama_status");
    } catch { status.value = null; }
  }

  async function refreshHardware() {
    try {
      hw.value = await invoke<HardwareInfo>("check_hardware");
    } catch { hw.value = null; }
  }

  // 应用启动时初始化：注册监听 + 首次检测
  async function init() {
    ensureListen();
    await Promise.all([refreshStatus(), refreshHardware()]);
  }

  async function deploy() {
    if (busy.value) return;
    busy.value = true;
    progress.value = "";
    percent.value = null;
    try {
      await invoke("ollama_setup");
      await refreshStatus();
    } catch (e) {
      progress.value = e instanceof Error ? e.message : String(e);
    }
    busy.value = false;
  }

  return { status, hw, busy, progress, percent, hasLlava, init, refreshStatus, refreshHardware, deploy };
});
