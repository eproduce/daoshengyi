// 对话框封装（P1-11 改造）：优先**应用内自绘弹窗**，长文案会结构化排版
//（命令等宽块可复制、键值行、列表；危险操作红色按钮且默认焦点在「取消」）——
// 见 `components/ConfirmDialog.vue` 与 `stores/appDialog.ts`。
//
// 为什么改：原来直接走 Tauri 原生对话框（macOS 系统 Alert），调用方传的却是
// 「多行 + $ 命令 + emoji」的长文案 → 系统弹窗里是一大坨等宽纯文本，又长又割裂。
//
// 兜底顺序：应用内弹窗 → Tauri 原生对话框 → window.alert/confirm。
// 最后一级仅在非 Tauri 环境（浏览器预览）使用：WKWebView 下 window.alert/confirm
// 有已知的「弹窗关不掉/无响应」问题。

import { appDialogHost, useAppDialogStore } from "@/stores/appDialog";
import { deriveDialogUi, type DialogTone } from "@/utils/dialog-format";

type DialogKind = "warning" | "info" | "error";

function toneOf(kind: DialogKind): DialogTone {
  if (kind === "error") return "error";
  if (kind === "warning") return "warning";
  return "info";
}

/** 取应用内弹窗 store；未挂载 / Pinia 未就绪 → null（调用方回退原生） */
function appDialog() {
  if (!appDialogHost.ready) return null;
  try {
    return useAppDialogStore();
  } catch {
    return null;
  }
}

async function nativeNotify(text: string, kind: DialogKind): Promise<void> {
  try {
    const { message } = await import("@tauri-apps/plugin-dialog");
    await message(text, { title: "道生一", kind });
  } catch {
    window.alert(text);
  }
}

async function nativeConfirm(text: string, kind: DialogKind): Promise<boolean> {
  try {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return await ask(text, { title: "道生一", kind });
  } catch {
    return window.confirm(text);
  }
}

export async function notify(text: string, kind: DialogKind = "warning"): Promise<void> {
  const st = appDialog();
  if (st) {
    await st.request({
      kind: "notify",
      raw: text,
      tone: toneOf(kind),
      confirmText: "知道了",
    });
    return;
  }
  await nativeNotify(text, kind);
}

export async function askConfirm(text: string, kind: DialogKind = "warning"): Promise<boolean> {
  const st = appDialog();
  if (st) {
    const ui = deriveDialogUi(text, toneOf(kind));
    return st.request({
      kind: "confirm",
      raw: text,
      tone: ui.tone,
      danger: ui.danger,
      confirmText: ui.confirmText,
      cancelText: "取消",
    });
  }
  return nativeConfirm(text, kind);
}
