// 对话框封装：优先 Tauri dialog 插件（原生对话框，可正常关闭）；
// WKWebView 下 window.alert/confirm 有已知的「弹窗关不掉/无响应」问题，故不用。
// 非 Tauri 环境（浏览器预览）回退 window.alert/confirm。

export async function notify(text: string, kind: "warning" | "info" | "error" = "warning"): Promise<void> {
  try {
    const { message } = await import("@tauri-apps/plugin-dialog");
    await message(text, { title: "道生一", kind });
  } catch {
    window.alert(text);
  }
}

export async function askConfirm(text: string, kind: "warning" | "info" | "error" = "warning"): Promise<boolean> {
  try {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return await ask(text, { title: "道生一", kind });
  } catch {
    return window.confirm(text);
  }
}
