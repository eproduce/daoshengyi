// 系统托盘状态同步：把「任务进度 + 当前上下文」实时推送给人机界面外的系统层。
//
// 设计要点：
// - 前端负责组装载荷 + 节流（400ms trailing，且只在「签名」变化时才推），Rust 侧负责
//   渲染到托盘标题/菜单（并再做一次序列化去重）。逐 token 变化的流式正文不参与签名，
//   否则会疯狂重建菜单。
// - 签名只包含「会发生语义变化」的字段：阶段、任务标题、步骤状态、当前工具、队列长度。
// - 工作期间每 5s 心跳一次，用于刷新底部「已耗时」；结束瞬间保持 8s「已完成」再清空，
//   让用户离开窗口后回来还能看到刚完成什么。

import { computed, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useChatStore } from "@/stores/chat";

/// 与 Rust `TrayStatus` 对齐的载荷
interface TrayStatusPayload {
  phase: "idle" | "working" | "paused" | "done";
  title: string;
  progress: string;
  steps: { text: string; status: string }[];
  tool: string;
  meta: string;
}

const THROTTLE_MS = 400;
const HEARTBEAT_MS = 5000;
const DONE_LINGER_MS = 8000;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}分${String(s % 60).padStart(2, "0")}秒` : `${s}秒`;
}

/// 启动托盘状态同步（在 app 挂载后调用一次；Pinia 已激活）
export function startTrayStatusSync(): void {
  if (!isTauri()) return;
  const chat = useChatStore();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let linger: ReturnType<typeof setTimeout> | null = null;
  let lastSent = "";
  /// 已完成状态：由 isStreaming true→false 触发，短暂展示
  let doneSnapshot: { title: string; progress: string; steps: TrayStatusPayload["steps"] } | null =
    null;
  let turnStart = 0;

  /// 组装当前载荷
  function build(): TrayStatusPayload {
    const plan = chat.taskPlan;
    const steps = (plan?.steps ?? []).slice(0, 8).map((s) => ({
      text: s.text,
      status: s.status as string,
    }));
    const doneCount = (plan?.steps ?? []).filter((s) => s.status === "done").length;
    const total = plan?.steps.length ?? 0;

    // 阶段判定：流式中 = working；否则若有「刚完成」快照 = done；其余 idle
    let phase: TrayStatusPayload["phase"] = "idle";
    if (chat.isStreaming) phase = "working";
    else if (doneSnapshot) phase = "done";

    const title = doneSnapshot?.title || plan?.title || "";
    const progress = doneSnapshot?.progress || (total > 0 ? `${doneCount}/${total}` : "");
    const activeSteps = doneSnapshot?.steps ?? steps;

    const metaParts: string[] = [];
    if (chat.isStreaming && turnStart > 0) metaParts.push(formatDuration(Date.now() - turnStart));
    if (total > 0) metaParts.push(`${doneCount}/${total} 步`);
    if (chat.pendingCount > 0) metaParts.push(`队列 ${chat.pendingCount}`);
    const subs = chat.subagents.filter((s) => s.status === "running").length;
    if (subs > 0) metaParts.push(`子代理 ${subs}`);

    return {
      phase,
      title,
      progress,
      steps: activeSteps,
      // 已完成/空闲时不显示「正在调用工具」，避免状态自相矛盾
      tool: phase === "working" ? chat.currentToolLabel : "",
      meta: metaParts.join(" · "),
    };
  }

  /// 组装 + 去重 + 推送（真正发送只在内容变化时发生）
  function flush(): void {
    const payload = build();
    const key = JSON.stringify(payload);
    if (key === lastSent) return;
    lastSent = key;
    invoke("tray_set_status", { status: payload }).catch(() => {
      /* 托盘为增值功能，失败静默 */
    });
  }

  /// 节流调度：400ms 内的多次变化合并为一次推送
  function schedule(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, THROTTLE_MS);
  }

  // 参与签名的字段（不含流式正文/token 数等高频变化项）
  const signature = computed(() =>
    JSON.stringify({
      streaming: chat.isStreaming,
      planId: chat.taskPlan?.id ?? "",
      planTitle: chat.taskPlan?.title ?? "",
      steps: (chat.taskPlan?.steps ?? []).map((s) => `${s.status}:${s.text}`),
      tool: chat.currentToolLabel,
      queue: chat.pendingCount,
      subs: chat.subagents.filter((s) => s.status === "running").length,
      done: doneSnapshot !== null,
    }),
  );

  // 工作期间心跳刷新耗时；空闲时清掉
  function syncHeartbeat(): void {
    if (chat.isStreaming && !heartbeat) {
      heartbeat = setInterval(() => {
        if (chat.isStreaming) flush();
      }, HEARTBEAT_MS);
    } else if (!chat.isStreaming && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  // 流式开始/结束：记录起点、生成「已完成」快照并停留片刻
  watch(
    () => chat.isStreaming,
    (streaming, wasStreaming) => {
      if (streaming) {
        turnStart = Date.now();
        if (linger) {
          clearTimeout(linger);
          linger = null;
        }
        doneSnapshot = null;
      } else if (wasStreaming) {
        const plan = chat.taskPlan;
        if (plan && plan.steps.length > 0) {
          const doneCount = plan.steps.filter((s) => s.status === "done").length;
          doneSnapshot = {
            title: plan.title,
            progress: `${doneCount}/${plan.steps.length}`,
            steps: plan.steps
              .slice(0, 8)
              .map((s) => ({ text: s.text, status: s.status as string })),
          };
          linger = setTimeout(() => {
            doneSnapshot = null;
            linger = null;
            flush();
          }, DONE_LINGER_MS);
        }
      }
      syncHeartbeat();
      schedule();
    },
  );

  watch(signature, schedule);

  // 初始推送一次（清空/恢复托盘标题，避免上一次运行残留）
  flush();
}

/// 供测试/复用：把 Markdown 之外的载荷字段做一次规范化（当前仅保留透传）
export type { TrayStatusPayload };
