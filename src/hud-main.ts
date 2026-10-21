// HUD 浮层入口（环境层 spike ①）——独立于主窗口的最小前端。
//
// 为什么单独一个入口而不是复用 `main.ts`：
// 主入口会拉起 Pinia / MCP / 本地运行时检测 / 托盘同步 / 全局监听等一整套启动副作用，
// 而 HUD 是一个常驻、需要**极快出现**的浮层（热键按下到可见不该等主应用的启动流程）。
// 独立入口的产物也是独立的（`dist/hud.html` + 它自己的 chunk），HUD 崩了不影响主窗口。
import { createApp } from "vue";
import { invoke } from "@tauri-apps/api/core";
import HudOverlay from "./components/HudOverlay.vue";
import { installGlobalErrorLog } from "./utils/error-log";

// HUD 是独立 webview：出错时控制台没人看得到，必须落本地日志（否则「点了没反应」无从查证）
installGlobalErrorLog();

/** 把 HUD 自己的渲染状态回述给 Rust（会出现在 hud_status 的事实快照里） */
function report(note: string) {
  // 两条通道都发：`hud_note` 进事实快照（结构化、好读），`debug_log` 进应用日志
  // （主窗口已在用这条，可用来区分「页面没加载」与「hud_note 这条命令没通」）
  void invoke("hud_note", { note }).catch((e) => {
    void invoke("debug_log", { msg: `[hud] hud_note 失败: ${String(e)}` }).catch(() => {});
  });
  void invoke("debug_log", { msg: `[hud] ${note}` }).catch(() => {});
}

// 白屏排查：HUD 的窗口可能是「存在、在屏、透明」但页面一行都没渲染。
// 这两种失败的原因完全不同（前者是窗口/系统，后者是页面/DOM），必须能从外部区分开。
window.addEventListener("error", (e) => report(`页面错误: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => report(`未处理拒绝: ${String(e.reason)}`));

report(
  `boot: readyState=${document.readyState} inner=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio}`,
);

try {
  createApp(HudOverlay).mount("#app");
  // 等一帧再量：挂载是同步的，但布局与样式计算要等渲染
  window.setTimeout(() => {
    const app = document.getElementById("app");
    const capsule = document.querySelector<HTMLElement>(".hud-capsule");
    const rect = capsule?.getBoundingClientRect();
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const capsuleBg = capsule ? getComputedStyle(capsule).backgroundColor : "无";
    report(
      `mounted: children=${app?.children.length ?? -1}` +
        ` capsule=${rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.x)},${Math.round(rect.y)}` : "缺失"}` +
        ` bodyBg=${bodyBg} capsuleBg=${capsuleBg} inner=${window.innerWidth}x${window.innerHeight}`,
    );
  }, 300);
} catch (err) {
  report(`mount 失败: ${String(err)}`);
}
