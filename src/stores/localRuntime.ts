// 本地推理运行时 store（llama.cpp）：
// 状态探测（llama-server / GGUF 模型）、硬件评估、模型导入（文件 / 目录）与停止。
// 外部 OpenAI 兼容服务（可选，如 Strata）由设置项配置，不在此 store 管理。
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import type { HardwareInfo } from "@/types";

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

/** 导入 GGUF 的结果（硬链接优先 → 不额外占磁盘、无需重新下载） */
export interface ImportReport {
  label: string;
  model_file: string;
  projector_file: string | null;
  embed_file: string | null;
  imported: number;
  message: string;
}

/**
 * 本地运行时 store：
 * 状态与导入结果全局共享，不随「本地模型」设置页关闭而丢失。
 */
export const useLocalRuntimeStore = defineStore("localRuntime", () => {
  const hw = ref<HardwareInfo | null>(null);
  const runtime = ref<LocalRuntimeStatus | null>(null);
  const runtimeMsg = ref("");

  /** 本地视觉是否就绪：二进制 + 已导入模型 + 该模型带投影器（mmproj） */
  const visionReady = computed(
    () =>
      runtime.value?.bin_found === true &&
      !!runtime.value.active_model &&
      runtime.value.has_projector === true,
  );

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

  function report(r: ImportReport) {
    const parts: string[] = [];
    if (r.model_file) parts.push(`模型 ${r.model_file}`);
    if (r.projector_file) parts.push(`投影器 ${r.projector_file}`);
    if (r.embed_file) parts.push(`嵌入 ${r.embed_file}`);
    const detail = parts.length ? `：${parts.join("、")}` : "";
    runtimeMsg.value = r.imported > 0 ? `✅ ${r.label}${detail}` : `✅ 模型已在目录，无需重复导入`;
    if (r.message) runtimeMsg.value += `（${r.message}）`;
  }

  /** 导入用户选择的 GGUF 文件（多选） */
  async function importFiles(paths: string[]) {
    runtimeMsg.value = "正在导入…";
    try {
      const r = await invoke<ImportReport>("local_runtime_import_gguf", { paths });
      report(r);
      await refreshRuntime();
    } catch (e) {
      runtimeMsg.value = `❌ ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** 扫描目录并导入其中的 GGUF（递归 3 层，无后缀按魔数识别） */
  async function importDir(dir: string) {
    runtimeMsg.value = "正在扫描目录…";
    try {
      const r = await invoke<ImportReport>("local_runtime_import_dir", { dir });
      report(r);
      await refreshRuntime();
    } catch (e) {
      runtimeMsg.value = `❌ ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** 立即停止 llama-server（内存立刻归还；下次识图会自动再拉起） */
  async function stopRuntime() {
    await invoke("local_runtime_stop");
    await refreshRuntime();
    runtimeMsg.value = "已停止本地运行时（空闲时本就不常驻）";
  }

  // 应用启动时初始化：首次检测
  async function init() {
    await Promise.all([refreshHardware(), refreshRuntime()]);
  }

  return {
    hw,
    runtime,
    runtimeMsg,
    visionReady,
    init,
    refreshHardware,
    refreshRuntime,
    importFiles,
    importDir,
    stopRuntime,
  };
});
