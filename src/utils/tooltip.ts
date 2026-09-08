// 全局自定义 Tooltip：用统一深色小浮层替代浏览器原生 title 提示。
// 特性：
// - 更快出现、样式统一（深色圆角小浮层）、支持翻转避免溢出视口；
// - 事件委托（pointerover/pointerout 捕获阶段）+ 单例浮层，无需逐元素改造模板；
// - 接管所有带 title 的元素：显示前移除原生 title（避免与系统提示双重），
//   文本保留到 aria-label 供读屏使用；滚动/缩放自动隐藏；
// - 延迟可调：默认 DEFAULT_TOOLTIP_DELAY（毫秒）；元素可用 data-tip-delay 单独覆盖；
// - 某元素想保留原生提示：加 data-tip-no-custom。

export const DEFAULT_TOOLTIP_DELAY = 200;

const SELECTOR = "[title], [data-orig-title]";

// ---- 纯函数（可测） ----

/** 解析提示文本：优先 title，其次此前备份的 data-orig-title */
export function tipText(title: string | null | undefined, orig: string | null | undefined): string {
  return (title || orig || "").trim();
}

/** 解析延迟（毫秒）：data-tip-delay 数字合法则用之，否则回退默认 */
export function parseTipDelay(raw: string | null | undefined, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.round(n);
  return fallback;
}

export interface TipRect {
  left: number;
  top: number;
  /** 是否翻到元素上方 */
  above: boolean;
}

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 计算浮层位置（left/top 为浮层左上角，最终以原尺寸渲染、不依赖 translateX）：
 * 默认在元素下方 gap 处、与元素水平居中；下方放不下则翻到上方；
 * 水平方向整体夹紧在视口内（边缘时贴边移动整块浮层，不压窄宽度、避免文字折行）。
 * estW/estH 为浮层实际宽高。
 */
export function computeTipRect(
  r: RectLike,
  viewportW: number,
  viewportH: number,
  estW: number,
  estH: number,
  gap = 8,
): TipRect {
  const margin = 8;
  let top = r.bottom + gap;
  let above = false;
  if (top + estH > viewportH - margin) {
    above = true;
    top = r.top - gap - estH;
    if (top < margin) top = margin;
  }
  // 水平：先按元素中心对齐，再整体夹到 [margin, viewportW-margin-estW]；
  // 视口窄到放不下整块时（上限 < margin）退化为贴左边缘，也不压缩文字宽度。
  const centerX = r.left + (r.right - r.left) / 2;
  const maxL = viewportW - margin - estW;
  const left = Math.min(Math.max(centerX - estW / 2, margin), Math.max(margin, maxL));
  return { left, top, above };
}

// ---- 浮层展示（DOM） ----

let tipEl: HTMLDivElement | null = null;
let curOrigin: Element | null = null;
let showTimer: number | undefined;
let hideTimer: number | undefined;
let initialized = false;

function tip(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "app-tip";
    tipEl.setAttribute("role", "tooltip");
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function textOf(origin: HTMLElement): string {
  return tipText(origin.getAttribute("title"), origin.getAttribute("data-orig-title"));
}

function show(origin: HTMLElement, delay: number) {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }
  showTimer = window.setTimeout(() => {
    const text = textOf(origin);
    if (!text) return;
    // 移除原生 title 防双重（文本备份到 data-orig-title + aria-label）
    if (origin.hasAttribute("title")) {
      origin.setAttribute("data-orig-title", text);
      origin.removeAttribute("title");
      origin.setAttribute("aria-label", text);
    }
    const t = tip();
    t.textContent = text;
    const maxW = Math.min(280, window.innerWidth - 24);
    t.style.maxWidth = `${maxW}px`;
    // 先移出视口再测量，避免闪现于错误位置
    t.style.left = "-9999px";
    t.style.top = "-9999px";
    t.style.transform = "none";
    t.classList.add("app-tip--show");
    const r = origin.getBoundingClientRect();
    const p = computeTipRect(r, window.innerWidth, window.innerHeight, t.offsetWidth, t.offsetHeight);
    // 锁定测量宽度 + 直接按左上角定位（不再 translateX(-50%)）：
    // 防止边缘钳位后浏览器按剩余空间二次布局，把文字压窄成多行。
    t.style.width = `${t.offsetWidth}px`;
    t.style.transform = "none";
    t.style.left = `${p.left}px`;
    t.style.top = `${p.top}px`;
    curOrigin = origin;
  }, Math.max(0, delay));
}

function hideNow() {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = undefined;
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }
  if (tipEl) tipEl.classList.remove("app-tip--show");
  curOrigin = null;
}

/** 安装全局 tooltip 接管（幂等；main.ts 启动时调用一次） */
export function initGlobalTooltips(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  document.addEventListener(
    "pointerover",
    (e) => {
      const el = e.target as Element | null;
      const origin = el?.closest?.(SELECTOR) as HTMLElement | null;
      if (!origin || origin === curOrigin) return;
      if (origin.dataset?.tipNoCustom === "true") return;
      hideNow();
      const delay = parseTipDelay(origin.dataset?.tipDelay, DEFAULT_TOOLTIP_DELAY);
      show(origin, delay);
    },
    true,
  );
  document.addEventListener(
    "pointerout",
    () => {
      if (!curOrigin) return;
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => hideNow(), 60);
    },
    true,
  );
  // 任何滚动/缩放都隐藏（元素已移动，避免浮层错位）
  document.addEventListener("scroll", hideNow, true);
  window.addEventListener("resize", hideNow, { passive: true });
}
