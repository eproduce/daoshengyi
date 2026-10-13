<!--
  HUD 浮层内容（spike ①）——「胶囊」形态的最小实现。

  这个组件的真正产出不是 UI，而是**可被截图取证的界面**：
  它把自己窗口的 AppKit 真实状态（透明/穿透/层级/边框/阴影/焦点）显示在自己身上，
  于是「透明是否生效」「点击是否穿透」都能靠一张截图 + 一次点击自证，
  不需要旁人相信我口述结论。

  布局上刻意让胶囊**不铺满窗口**（四周留 8px、圆角 18px）：
  多出来的透明像素是像素级验证的落点 —— 若窗口其实是白底/黑底，
  这些角落会由「与桌面一致」变成「与桌面不同」，一眼就能看出来
  （见 `scripts/hud-spike-verify.swift`）。
-->
<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { computed, onMounted, ref } from "vue";

/** 与 Rust 侧 `hud::AppKitFacts` 一一对应（serde camelCase） */
interface AppKitFacts {
  isVisible: boolean;
  isOccluded: boolean;
  ignoresMouseEvents: boolean;
  isOpaque: boolean;
  alphaValue: number;
  level: number;
  levelName: string;
  styleMask: number;
  styleNames: string[];
  hasShadow: boolean;
  collectionBehavior: number;
  collectionNames: string[];
  isKeyWindow: boolean;
  canBecomeKeyWindow: boolean;
}

/** 与 Rust 侧 `hud::HudFacts` 一一对应 */
interface HudFacts {
  exists: boolean;
  visible: boolean;
  focused: boolean;
  position: [number, number];
  size: [number, number];
  scaleFactor: number;
  monitorName: string;
  workAreaLogical: [number, number, number, number];
  clickThroughRequested: boolean;
  allWorkspacesRequested: boolean;
  appkit: AppKitFacts | null;
  verdict: string[];
  visibleTauri: boolean;
  frontendNote: string | null;
}

const facts = ref<HudFacts | null>(null);
const error = ref("");
/** 只有「穿透关闭」时点到这里才会涨 —— 这就是点击穿透的现场证据 */
const clicks = ref(0);

const ak = computed(() => facts.value?.appkit ?? null);
const passthrough = computed(() => ak.value?.ignoresMouseEvents ?? false);

/** 只显示需要人注意的结论（❌/⚠️）；全绿时不啰嗦 */
const alarms = computed(() => (facts.value?.verdict ?? []).filter((l) => !l.startsWith("✅")));

const transparencyLine = computed(() => {
  const a = ak.value;
  if (!a) return "AppKit 事实：不可用（非 macOS 或回读超时）";
  return `上屏 isVisible=${a.isVisible} · 透明 isOpaque=${a.isOpaque} · 穿透 ignoresMouseEvents=${a.ignoresMouseEvents}`;
});

const geometryLine = computed(() => {
  const f = facts.value;
  const a = f?.appkit;
  if (!f) return "等待第一次回读…";
  const pos = f.position.map((n) => Math.round(n)).join(",");
  const level = a ? `level=${a.level}(${a.levelName})` : "level=?";
  const border = a ? `styleMask=${a.styleMask}` : "styleMask=?";
  const shadow = a ? `hasShadow=${a.hasShadow}` : "hasShadow=?";
  const spaces = a && a.collectionNames.length > 0 ? a.collectionNames.join("+") : "单 Space";
  return `位置 ${pos} · ${level} · ${border} · ${shadow} · ${spaces}`;
});

/** 语录式波形：确定性伪随机（同一 seed 稳定），只为视觉，不代表真实音量 */
const barHeights = computed(() =>
  Array.from({ length: 26 }, (_, i) => {
    const wave = Math.sin(i * 0.7 + clicks.value * 0.3) * 0.5 + 0.5;
    return `${Math.round(5 + wave * 17)}px`;
  }),
);

async function refresh(action = "status") {
  try {
    facts.value = await invoke<HudFacts>("hud_spike", { action });
    error.value = "";
  } catch (e) {
    error.value = String(e);
  }
}

function onCapsuleMouseDown() {
  clicks.value += 1;
}

onMounted(() => {
  void refresh();
  // 每 1.5s 刷新一次回读值：手动切穿透开关后，界面上的事实会自己跟上
  window.setInterval(() => void refresh(), 1500);
});
</script>

<template>
  <div class="hud-root">
    <div class="hud-capsule" @mousedown="onCapsuleMouseDown">
      <div class="row head">
        <span class="dot" />
        <span class="name">道生一 · 桌面环境层</span>
        <span class="tag" :class="{ warn: passthrough }">
          {{ passthrough ? "点击穿透" : "可点击" }}
        </span>
        <span class="spacer" />
        <span class="count mono">点击 {{ clicks }}</span>
      </div>

      <div class="row wave-row">
        <div class="wave">
          <i v-for="(h, i) in barHeights" :key="i" :style="{ height: h }" />
        </div>
        <span class="hint">按住热键说一句 → 落到草稿（不自动发送）</span>
      </div>

      <div class="row mono fact">{{ transparencyLine }}</div>
      <div class="row mono fact">{{ geometryLine }}</div>

      <div v-if="alarms.length" class="row mono alarm">{{ alarms.join(" ｜ ") }}</div>
      <div v-if="error" class="row mono alarm">IPC 错误：{{ error }}</div>
    </div>
  </div>
</template>

<style>
/* HUD 是独立 webview：必须自己把 html/body 抹成透明，否则整屏是一块白底
   （窗口已经 transparent，但 webview 默认会画白背景 → 表现为「透明窗口没用」） */
html,
body {
  margin: 0;
  padding: 0;
  background: transparent;
  overflow: hidden;
  cursor: default;
  -webkit-user-select: none;
  user-select: none;
}
</style>

<style scoped>
.hud-root {
  /* 四周留出的透明边：像素级验证靠它判断窗口有没有白底 */
  padding: 8px;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", sans-serif;
  color: #e9ecf3;
}

.hud-capsule {
  height: 116px;
  box-sizing: border-box;
  padding: 9px 12px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  /* 半透明玻璃：透出桌面 → 透明本身也是视觉证据 */
  background: linear-gradient(180deg, rgba(30, 33, 42, 0.9), rgba(20, 22, 29, 0.82));
  /* backdrop-filter（毛玻璃）暂不启用：它要采样「窗口背后的内容」，而 Tauri 的透明窗口
     在滚动/截图/被遮挡等场景下能否稳定拿到背景，本机还没验证过。
     不验证就先不用 —— 浮层一旦在某些场景下变糊或变透明，属于最难查的那类问题。
     （待办：屏幕解锁后单独验证 backdrop-filter 与 Tauri windowEffects 两条路线） */
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.38);
}

.row {
  display: flex;
  align-items: center;
  min-height: 0;
}

.head {
  gap: 7px;
  font-size: 12px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #4f8ff7;
  box-shadow: 0 0 8px rgba(79, 143, 247, 0.9);
}

.name {
  font-weight: 600;
  letter-spacing: 0.2px;
}

.tag {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  background: rgba(79, 143, 247, 0.22);
  border: 1px solid rgba(79, 143, 247, 0.5);
}

.tag.warn {
  background: rgba(240, 178, 60, 0.2);
  border-color: rgba(240, 178, 60, 0.5);
}

.spacer {
  flex: 1;
}

.wave-row {
  gap: 10px;
}

.wave {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 22px;
}

.wave i {
  width: 2px;
  border-radius: 2px;
  background: linear-gradient(180deg, #6aa6ff, #3f7ae0);
}

.hint {
  font-size: 10px;
  color: rgba(233, 236, 243, 0.62);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.fact {
  font-size: 10px;
  color: rgba(233, 236, 243, 0.72);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.count {
  font-size: 10px;
  color: rgba(233, 236, 243, 0.55);
}

.alarm {
  font-size: 10px;
  color: #ffd479;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
