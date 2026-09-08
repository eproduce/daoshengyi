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
 * 计算浮层锚点位置：默认在元素下方 gap 处居中；下方放不下则翻到上方；
 * 左右超出视口时夹紧（保证浮层完整可见）。estW/estH 为浮层实际宽高。
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
  // 中心锚点；浮层宽度可能超出左右 → 夹紧（translateX(-50%) 校正后的中心允许范围）
  const minC = margin + estW / 2;
  const maxC = viewportW - margin - estW / 2;
  const left = Math.min(Math.max(r.left + (r.right - r.left) / 2, minC), Math.max(minC, maxC));
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
    t.style.left = `${p.left}px`;
    t.style.top = `${p.top}px`;
    t.style.transform = "translateX(-50%)";
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
