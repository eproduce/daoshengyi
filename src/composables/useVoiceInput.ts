// 语音输入（耳朵）的前端状态机 —— 与 Rust `voice.rs` 的事件一一对应。
//
// 分工（故意这样切）：
// - **音频与推理全在 Rust**：WKWebView 的麦克风兼容性 + 离线模型都不该进前端；
// - **前端只管「什么时候开麦、转写进哪儿」**：草稿由输入框持有，本 composable 不碰它，
//   只把 `voice://final` 交回去（`onFinal`），这样「进草稿」和「自动提交」两个语义
//   都有唯一落点，不会出现第二条发消息的路径；
// - **绝不常驻录音**：`idle` 即关麦（可以 `lsof` 验证）；连续模式下念完才再开麦。

import { computed, ref, type Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getSettings } from "@/api/appSettings";
import { listenWithRetry } from "@/utils/event-listen";
import { levelBarHeight, permissionHint, phaseLabel } from "@/utils/voice";

export interface VoiceModelsStatus {
  asr: boolean;
  vad: boolean;
  punct: boolean;
  dir: string;
}

/** `voice_status` 的返回（Rust 侧结构体未做 camelCase 改名，键就是 snake_case） */
export interface VoiceStatus {
  phase: string;
  mode: string;
  permission: string;
  device: string;
  sample_rate: number;
  models: VoiceModelsStatus;
  last_wav: string;
  last_error: string;
  asr_loaded: boolean;
}

interface FinalPayload {
  text: string;
  wav: string;
  mode: string;
  seconds: number;
}

interface LevelPayload {
  rms: number;
  peak: number;
  speaking: boolean;
}

export interface UseVoiceInputOptions {
  /** 一轮识别结果（已去空白）。`continuous` = 连续对话模式 */
  onFinal?: (text: string, mode: string) => void;
  /** 需要提示用户的错误（已本地化文案） */
  onError?: (message: string) => void;
}

const BAR_COUNT = 5;

export function useVoiceInput(opts: UseVoiceInputOptions = {}) {
  const status = ref<VoiceStatus | null>(null);
  const phase = ref("idle");
  const mode = ref("ptt");
  const rms = ref(0);
  const speechDetected = ref(false);
  /** TTS 正在出声（半双工：此时不开麦） */
  const ttsSpeaking = ref(false);
  const error = ref("");
  /** 正在执行开始/停止命令（防止连点开出两条流） */
  const busy = ref(false);
  /** 连续对话模式进行中（用户显式开启，静音超时自动结束） */
  const continuous = ref(false);

  const listening = computed(() => phase.value === "listening");
  const transcribing = computed(() => phase.value === "thinking" || phase.value === "transcribing");
  const active = computed(
    () => listening.value || transcribing.value || phase.value === "starting",
  );
  const phaseText = computed(() => phaseLabel(phase.value));
  const modelsReady = computed(() => !!status.value?.models.asr);
  const permission = computed(() => status.value?.permission ?? "unknown");
  const permissionNote = computed(() => permissionHint(permission.value));
  const bars = computed(() =>
    Array.from({ length: BAR_COUNT }, (_, i) => levelBarHeight(rms.value, i, BAR_COUNT)),
  );

  let unlisteners: Array<() => void> = [];
  let disposed = false;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;

  function report(message: string) {
    error.value = message;
    opts.onError?.(message);
  }

  function applyStatus(next: VoiceStatus) {
    status.value = next;
    phase.value = next.phase || "idle";
    mode.value = next.mode || "ptt";
    if (next.phase === "idle") {
      rms.value = 0;
      speechDetected.value = false;
    }
  }

  async function refresh() {
    try {
      applyStatus(await invoke<VoiceStatus>("voice_status"));
    } catch (e) {
      console.warn("[voice] 读取语音状态失败:", e);
    }
  }

  /** 注册事件监听（幂等；`main.ts` 之外的组件在挂载时调用一次即可） */
  async function init() {
    if (unlisteners.length) return;
    const off = (fn: (() => void) | null) => {
      if (fn) unlisteners.push(fn);
    };
    off(
      await listenWithRetry<VoiceStatus>("voice://state", (e) => {
        if (e.payload) applyStatus(e.payload);
      }),
    );
    off(
      await listenWithRetry<LevelPayload>("voice://level", (e) => {
        rms.value = Number(e.payload?.rms) || 0;
        speechDetected.value = !!e.payload?.speaking;
      }),
    );
    off(
      await listenWithRetry<FinalPayload>("voice://final", (e) => {
        const p = e.payload;
        if (!p?.text) return;
        error.value = "";
        // 连续模式且「不自动发送」时，Rust 说完就收麦了 —— 继续显示「连续对话中」会骗人
        // （用户以为还在听，其实设备已关）。
        if (p.mode === "continuous" && !getSettings().voiceAutoSend) continuous.value = false;
        opts.onFinal?.(p.text, p.mode || mode.value);
      }),
    );
    off(
      await listenWithRetry<{ message: string }>("voice://error", (e) => {
        if (e.payload?.message) report(e.payload.message);
      }),
    );
    off(
      await listenWithRetry<{ reason: string; dropped: number }>("voice://idle", (e) => {
        // 会话窗口到期：Rust 已关麦（这是预期行为，不是错误）
        if (e.payload?.reason === "silence") continuous.value = false;
      }),
    );
    off(
      await listenWithRetry<{ stage: string }>("voice://speaking", (e) => {
        const stage = e.payload?.stage;
        ttsSpeaking.value = stage === "start";
        if (stage === "start") {
          // 半双工：刚开始出声就不能继续听（外放会被自己听见）
          cancelResume();
          if (continuous.value && listening.value) void invoke("voice_cancel");
          return;
        }
        // 念完 → 回到聆听（用户不用再按键）
        scheduleResume();
      }),
    );
    await refresh();
  }

  function cancelResume() {
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
  }

  /** 连续会话里「念完 → 回到聆听」。延迟让 afplay/say 真正释放音频设备 */
  function scheduleResume(delayMs = 260) {
    cancelResume();
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      if (disposed || !continuous.value) return;
      if (!getSettings().voiceAutoSend) return;
      if (active.value || busy.value) return;
      void start("continuous").catch(() => undefined);
    }, delayMs);
  }

  /** 一轮对话结束（且没在朗读）时接着听。TTS 关掉时没有任何 speaking 事件，
   *  只能由「回合结束」这个信号把会话续上 —— 否则默认配置下连续对话只能问一句。 */
  function resumeAfterTurn() {
    if (!continuous.value) return;
    if (ttsSpeaking.value) return;
    scheduleResume(600);
  }

  async function start(which: "ptt" | "continuous") {
    if (busy.value) return;
    const settings = getSettings();
    if (!settings.voiceEnabled) {
      report("语音输入未开启（设置 → 通知与呈现 → 语音输入）");
      return;
    }
    if (ttsSpeaking.value) await stopSpeech();
    busy.value = true;
    try {
      const next = await invoke<VoiceStatus>("voice_start", {
        mode: which,
        idleTimeoutMs: settings.voiceSessionWindowMs,
        silenceMs: settings.voiceSilenceMs,
      });
      applyStatus(next);
      continuous.value = which === "continuous";
      error.value = "";
    } catch (e) {
      report(String(e));
    } finally {
      busy.value = false;
    }
  }

  /** 开始 push-to-talk（按住说话：按下） */
  async function holdStart() {
    await start("ptt");
  }

  /** 松开：停止采集并转写 */
  async function holdEnd() {
    if (!listening.value && !active.value) return;
    try {
      await invoke("voice_stop");
    } catch (e) {
      report(String(e));
    }
  }

  /** 连续对话（免按键）：再点一次 = 全停 */
  async function toggleContinuous() {
    if (continuous.value || active.value) {
      await stopAll();
      return;
    }
    await start("continuous");
  }

  async function stopSpeech() {
    ttsSpeaking.value = false;
    try {
      await invoke<boolean>("surface_stop_speech");
    } catch (e) {
      console.warn("[voice] 停止播报失败:", e);
    }
  }

  /** 一键全停：停播报 + 丢弃本轮 + 关麦（一个动作解决三件事） */
  async function stopAll() {
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
    continuous.value = false;
    await stopSpeech();
    try {
      await invoke("voice_cancel");
    } catch (e) {
      console.warn("[voice] 取消语音失败:", e);
    }
    phase.value = "idle";
    rms.value = 0;
    speechDetected.value = false;
  }

  /** 组件卸载：必须关麦（否则用户以为走了，麦克风还亮着） */
  async function dispose() {
    disposed = true;
    if (resumeTimer) clearTimeout(resumeTimer);
    for (const off of unlisteners) {
      try {
        off();
      } catch {
        /* 已注销 */
      }
    }
    unlisteners = [];
    if (active.value) {
      try {
        await invoke("voice_cancel");
      } catch {
        /* 忽略：卸载路径不弹窗 */
      }
    }
  }

  return {
    status: status as Ref<VoiceStatus | null>,
    phase,
    mode,
    rms,
    speechDetected,
    ttsSpeaking,
    error,
    busy,
    continuous,
    listening,
    transcribing,
    active,
    phaseText,
    modelsReady,
    permission,
    permissionNote,
    bars,
    init,
    refresh,
    holdStart,
    holdEnd,
    toggleContinuous,
    resumeAfterTurn,
    stopSpeech,
    stopAll,
    dispose,
  };
}

export type VoiceInput = ReturnType<typeof useVoiceInput>;
