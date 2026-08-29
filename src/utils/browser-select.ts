// Puppeteer 浏览器多内核选择逻辑（纯函数，可测试）。
// 输入：detect_browsers 探测到的本机浏览器列表 + 用户设置的 browserEngine；
// 输出：应使用的浏览器可执行路径（null = 无可用 Chromium 系，调用方回退 Edge）。
// 选择优先级：
//   1. 用户显式选择（browserEngine !== "auto"）且该浏览器已安装
//   2. 系统默认浏览器（is_default，排除 webkit——puppeteer 不支持 Safari/WebKit）
//   3. 推荐序：chrome > edge > chromium > brave

export interface BrowserInfo {
  id: string;
  name: string;
  path: string;
  is_default: boolean;
}

// 推荐序（auto 模式：默认浏览器之后按此回退）
export const BROWSER_PRIORITY = ["chrome", "edge", "chromium", "brave"];

/** 从浏览器列表中按 engine 选择应使用的浏览器（返回可执行路径，null=无可用）。 */
export function pickBrowserPath(list: BrowserInfo[], engine: string): string | null {
  const byId = (id: string) => list.find((b) => b.id === id);
  // 1. 用户显式选择
  if (engine && engine !== "auto") {
    const b = byId(engine);
    if (b) return b.path;
  }
  // 2. 系统默认浏览器（仅 Chromium 系；webkit=Safari puppeteer 不支持）
  const def = list.find((b) => b.is_default && b.id !== "webkit");
  if (def) return def.path;
  // 3. 推荐序回退
  for (const id of BROWSER_PRIORITY) {
    const b = byId(id);
    if (b) return b.path;
  }
  return null;
}

/** 各浏览器可读名称（供 UI 展示）。 */
export function browserName(list: BrowserInfo[], id: string | undefined): string | null {
  if (!id) return null;
  const b = list.find((x) => x.id === id);
  return b ? b.name : null;
}
