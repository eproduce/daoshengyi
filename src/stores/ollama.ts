// Ollama 本地模型 store：一键部署 / 状态探测 / 视觉模型拉取 / OCR。
// 管理部署进度（断点续传）、服务状态、硬件检测与本地视觉/OCR 能力开关。
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
  /** 本地运行时（llama.cpp）：llama-server + 模型都就绪 */
  local_runtime_ready?: boolean;
  /** 当前实际会用的视觉后端：llamacpp | ollama */
  vision_backend?: string;
}

/** 嵌入（语义检索）子系统状态 */
export interface EmbedRuntimeStatus {
  bin_found: boolean;
  model_found: boolean;
  model: string;
  serving: boolean;
  port: number;
}

/** llama.cpp 运行时状态（来自 local_runtime_status 命令） */
export interface LocalRuntimeStatus {
  bin_found: boolean;
  bin_path: string;
  models_dir: string;
  models: string[];
  serving: boolean;
  idle_secs: number | null;
  port: number;
  idle_kill_secs: number;
  active_model: string;
  has_projector: boolean;
  embed: EmbedRuntimeStatus;
}

/** 从 Ollama 导入模型的结果（硬链接优先 → 不额外占磁盘、无需重新下载） */
export interface ImportReport {
  label: string;
  model_file: string;
  projector_file: string | null;
  model_mb: number;
  embed_file: string | null;
  embed_mb: number | null;
  model_link: string;
  projector_link: string | null;
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
  // llama.cpp 运行时（P0-资源）：状态 + 导入结果文本
  const runtime = ref<LocalRuntimeStatus | null>(null);
  const runtimeMsg = ref("");
  let unlisten: (() => void) | null = null;

  const hasLlava = computed(
    () => status.value?.models.some((m) => m.includes("llava-phi3")) ?? false,
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
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
  }

  async function refreshStatus() {
    try {
      status.value = await invoke<OllamaStatus>("ollama_status");
    } catch {
      status.value = null;
    }
  }

  async function refreshHardware() {
    try {
      hw.value = await invoke<HardwareInfo>("check_hardware");
    } catch {
      hw.value = null;
    }
  }

  async function refreshRuntime() {
    try {
      runtime.value = await invoke<LocalRuntimeStatus>("local_runtime_status");
    } catch {
      runtime.value = null;
    }
  }

  /// 从 Ollama 模型库导入模型（硬链接，零下载、不额外占盘）：多模态 + 嵌入一次尽量都拿上
  async function importFromOllama() {
    runtimeMsg.value = "正在导入…";
    try {
      const r = await invoke<ImportReport>("local_runtime_import_ollama");
      const linkText = (k: string) =>
        k === "hardlink" ? "硬链接（零额外磁盘）" : k === "copy" ? "复制" : "已存在，跳过";
      const parts: string[] = [];
      if (r.model_file)
        parts.push(`多模态 ${r.model_file}（${r.model_mb} MB，${linkText(r.model_link)}）`);
      // 嵌入模型单独说清楚：它决定语义检索能不能用
      if (r.embed_file) parts.push(`嵌入 ${r.embed_file}（${r.embed_mb ?? 0} MB，语义检索已可用）`);
      runtimeMsg.value = parts.length
        ? `✅ 已导入：${parts.join("；")}`
        : `✅ ${r.label} 已在模型目录，无需重复导入`;
      await Promise.all([refreshRuntime(), refreshStatus()]);
    } catch (e) {
      runtimeMsg.value = `❌ ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /// 立即停止 llama-server（内存立刻归还；下次识图会自动再拉起）
  async function stopRuntime() {
    await invoke("local_runtime_stop");
    await refreshRuntime();
    runtimeMsg.value = "已停止本地运行时（空闲时本就不常驻）";
  }

  // 应用启动时初始化：注册监听 + 首次检测
  async function init() {
    ensureListen();
    await Promise.all([refreshStatus(), refreshHardware(), refreshRuntime()]);
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

  return {
    status,
    hw,
    busy,
    progress,
    percent,
    hasLlava,
    runtime,
    runtimeMsg,
    init,
    refreshStatus,
    refreshHardware,
    refreshRuntime,
    importFromOllama,
    stopRuntime,
    deploy,
  };
});
