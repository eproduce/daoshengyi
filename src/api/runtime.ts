import { invoke } from "@tauri-apps/api/core";

/**
 * 产物渲染运行时（生成 HTML 讲解页要用的 Node）。
 *
 * 用户没装 Node 时不再「功能直接不可用」：宿主自带一份受管运行时，首次使用时下载并**校验
 * 官方 SHASUMS256** 后才解出 `bin/node`。这里给设置页一个显式入口——让用户在第一次要
 * 出页面之前就把它下好，而不是等到点「用 HTML 回答」时干等 48 MB。
 */
export interface HtmlRuntimeStatus {
  ready: boolean;
  /** system（用户自己装的）/ managed（自带的）/ none */
  source: string;
  path: string;
  version: string;
  platform: string | null;
  managedPath: string;
}

export async function htmlRuntimeStatus(): Promise<HtmlRuntimeStatus> {
  return invoke<HtmlRuntimeStatus>("ensure_html_runtime", { install: false });
}

/** 已就绪则直接返回；否则下载自带运行时（幂等：下载中重复调用会命中同一份缓存）。 */
export async function ensureHtmlRuntime(): Promise<HtmlRuntimeStatus> {
  return invoke<HtmlRuntimeStatus>("ensure_html_runtime", { install: true });
}

/** 人话状态：设置页直接显示这一行 */
export function describeRuntime(s: HtmlRuntimeStatus | null): string {
  if (!s) return "尚未检测";
  if (!s.ready) {
    return s.platform
      ? "未安装 Node——可在这里下载自带运行时（约 48 MB，一次性，之后离线可用）"
      : "当前平台不支持自动安装，请自行安装 Node ≥ 20";
  }
  const where = s.source === "managed" ? "道生一自带" : "系统已安装";
  return `已就绪：${where} Node ${s.version}`;
}
