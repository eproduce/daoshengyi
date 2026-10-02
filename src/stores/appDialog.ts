// 应用内确认/提示弹窗的请求队列（P1-11，2026-10-02）
//
// 用户反馈「操作确认的弹窗看起来很 low」：原来走 Tauri 的 macOS 原生 Alert，
// 而调用方传的是「多行 + 命令 + emoji」的长文案 → 系统弹窗里就是一大坨纯文本。
// 现在改为应用内自绘弹窗（`components/ConfirmDialog.vue`），本 store 负责：
//   · 队列化（同一时刻只显示一条，避免叠一排）
//   · 同文案复用同一个 Promise（Agent 重复问时不叠加弹窗）
//   · 队列过长时直接拒绝（返回 false），绝不把界面堵死
//   · 宿主未挂载时由调用方回退到系统对话框（见 utils/dialog.ts）

import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { parseDialogText, type DialogBlock, type DialogTone } from "@/utils/dialog-format";

export interface DialogRequestInput {
  kind: "confirm" | "notify";
  raw: string;
  tone?: DialogTone;
  danger?: boolean;
  confirmText?: string;
  cancelText?: string;
}

export interface AppDialogItem {
  id: number;
  kind: "confirm" | "notify";
  raw: string;
  tone: DialogTone;
  title: string;
  blocks: DialogBlock[];
  danger: boolean;
  confirmText: string;
  cancelText: string;
}

/** 队列上限：超过就直接拒绝，宁可让 Agent 走安全默认，也不把界面堵成一排弹窗 */
const MAX_QUEUE = 6;

/** 宿主组件是否已挂载（未挂载时调用方回退系统原生对话框） */
export const appDialogHost = { ready: false };

export const useAppDialogStore = defineStore("appDialog", () => {
  const queue = ref<AppDialogItem[]>([]);
  const current = computed(() => queue.value[0] ?? null);
  let seq = 0;
  /** 同文案的待决请求（key=原文）→ 共用同一个 Promise 与同一个决定 */
  const inflight = new Map<string, { id: number; promise: Promise<boolean> }>();
  const resolvers = new Map<number, (ok: boolean) => void>();

  function request(opts: DialogRequestInput): Promise<boolean> {
    const raw = String(opts.raw ?? "");
    const dup = inflight.get(raw);
    if (dup) return dup.promise;
    if (queue.value.length >= MAX_QUEUE) {
      console.warn("[dialog] 待确认请求过多，已自动拒绝一条：", raw.slice(0, 80));
      return Promise.resolve(false);
    }
    const parsed = parseDialogText(raw, opts.tone ?? "info");
    const id = ++seq;
    const promise = new Promise<boolean>((resolve) => resolvers.set(id, resolve));
    queue.value.push({
      id,
      kind: opts.kind,
      raw,
      tone: opts.tone ?? parsed.tone,
      title: parsed.title,
      blocks: parsed.blocks,
      danger: !!opts.danger,
      confirmText: opts.confirmText ?? (opts.kind === "notify" ? "知道了" : "确认"),
      cancelText: opts.cancelText ?? "取消",
    });
    inflight.set(raw, { id, promise });
    return promise;
  }

  /** 用户作出选择：出队 + resolve（同一文案的重复请求共用决定） */
  function settle(id: number, ok: boolean): void {
    const idx = queue.value.findIndex((q) => q.id === id);
    if (idx >= 0) {
      const [item] = queue.value.splice(idx, 1);
      inflight.delete(item.raw);
    }
    const r = resolvers.get(id);
    if (r) {
      resolvers.delete(id);
      r(ok);
    }
  }

  /** 仅供测试/卸载清理：把剩余请求按「否 / 关闭」处理，避免 Promise 永久挂起 */
  function settleAll(ok = false): void {
    for (const item of [...queue.value]) settle(item.id, ok);
  }

  return { queue, current, request, settle, settleAll };
});
