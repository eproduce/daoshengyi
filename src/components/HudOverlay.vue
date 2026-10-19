<!--
  HUD 浮层内容（环境层）：**展示 IR 的渲染端**。

  两种形态（同一个窗口，按有没有内容自动切）：
  - **有展示内容** → 渲染 IR（标题 + 一句话 / 关键数字 / 小图 / 键值 / 时间轴 …），
    这是给用户看的样子：一眼能看完、几秒后自动淡出。
  - **没有内容** → 显示自检胶囊（窗口的 AppKit 真实状态 + 点击计数）。
    这不是"调试残留"：浮层最常见的问题恰恰是「窗口在、但什么都没画」，
    没有它就只能靠猜（spike 阶段正是靠它定位到「锁屏遮挡导致不渲染」）。

  为什么要监听事件 + 主动拉一次：事件是「推」，而 HUD 可能刚被创建、监听还没挂上 —— 
  推过去的会丢。所以挂载后必须再 `hud_last_ir` 拉一次，否则会出现「第一次不显示、第二次才显示」。
-->
<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { listenWithRetry } from "@/utils/event-listen";
import {
  degradeForSurface,
  hudHideDelay,
  parseDisplayIr,
  type DisplayBody,
  type DisplayIr,
} from "@/utils/display-ir";

/** 与 Rust 侧 `hud::AppKitFacts` 一一对应（serde camelCase） */
interface AppKitFacts {
  isVisible: boolean;
  isOccluded: boolean;
  ignoresMouseEvents: boolean;
  isOpaque: boolean;
  level: number;
  levelName: string;
  styleMask: number;
  hasShadow: boolean;
  isKeyWindow: boolean;
}

interface HudFacts {
  exists: boolean;
  visible: boolean;
  frontendNote: string | null;
  verdict: string[];
  appkit: AppKitFacts | null;
}

/** HUD 高度有限：列表类内容只画前几行，其余折成一句提示 */
const MAX_ROWS = 4;

const facts = ref<HudFacts | null>(null);
const current = ref<DisplayIr | null>(null);
const clicks = ref(0);
const error = ref("");
let hideTimer: number | undefined;

/** 交给 HUD 渲染的形态（降级由纯函数负责，这里不做判断） */
const view = computed(() => (current.value ? degradeForSurface(current.value, "hud") : null));
const body = computed<DisplayBody>(() => view.value?.body ?? {});
const ak = computed(() => facts.value?.appkit ?? null);
const passthrough = computed(() => ak.value?.ignoresMouseEvents ?? false);

const headLine = computed(() => {
  const v = view.value;
  if (!v) return "道生一 · 桌面环境层";
  return v.title ?? (v.kind === "speech" ? "" : kindLabel(v.kind));
});

const metricText = computed(() => {
  const b = body.value;
  if (b.value === undefined) return "";
  return `${b.value}${b.unit ?? ""}${b.delta ? `  ${b.delta}` : ""}`;
});

/** 图表/键值/时间轴/表格：统一折成「标签 + 数值」的行，HUD 上只画前几行 */
const rows = computed(() => {
  const b = body.value;
  if (b.series?.length) {
    const max = Math.max(...b.series.map((s) => Math.abs(s.value)), 1);
    return b.series.slice(0, MAX_ROWS).map((s) => ({
      label: s.label,
      value: String(s.value),
      ratio: Math.abs(s.value) / max,
    }));
  }
  if (b.items?.length) {
    return b.items.slice(0, MAX_ROWS).map((i) => ({ label: i.key, value: i.value, ratio: null }));
  }
  if (b.steps?.length) {
    return b.steps.slice(0, MAX_ROWS).map((s) => ({
      label: `${statusMark(s.status)}${s.label}`,
      value: s.detail ?? "",
      ratio: null,
    }));
  }
  if (b.rows?.length) {
    return b.rows.slice(0, MAX_ROWS).map((r) => ({
      label: r[0] ?? "",
      value: r.slice(1).join(" ｜ "),
      ratio: null,
    }));
  }
  return [];
});

const overflowHint = computed(() => {
  const b = body.value;
  const total = b.series?.length ?? b.items?.length ?? b.steps?.length ?? b.rows?.length ?? 0;
  return total > MAX_ROWS ? `（共 ${total} 项，完整内容见会话）` : "";
});

const textLine = computed(() => body.value.text ?? "");

/** 自检胶囊用：只显示需要人注意的结论 */
const alarms = computed(() => (facts.value?.verdict ?? []).filter((l) => !l.startsWith("✅")));

function kindLabel(kind: DisplayIr["kind"]): string {
  const map: Partial<Record<DisplayIr["kind"], string>> = {
    card: "结果",
    metric: "指标",
    chart: "图表",
    kv: "明细",
    timeline: "进度",
    table: "表格",
    callout: "提示",
    code: "代码",
    speech: "播报",
    page: "产物",
  };
  return map[kind] ?? "结果";
}

function statusMark(status?: string): string {
  if (status === "done" || status === "ok") return "✅ ";
  if (status === "doing" || status === "running") return "◐ ";
  if (status === "failed" || status === "error") return "❌ ";
  return "• ";
}

function show(ir: DisplayIr) {
  current.value = ir;
  if (hideTimer) window.clearTimeout(hideTimer);
  // 任何 life 都必须有淡出定时器：浮层没有“永久驻留”这种状态
  hideTimer = window.setTimeout(() => {
    current.value = null;
    void invoke("hud_spike", { action: "hide" }).catch(() => {});
  }, hudHideDelay(ir.life));
}

async function refreshFacts() {
  try {
    facts.value = await invoke<HudFacts>("hud_spike", { action: "status" });
  } catch (e) {
    error.value = String(e);
  }
}

async function pullLastIr() {
  try {
    const raw = await invoke<unknown>("hud_last_ir");
    if (!raw) return;
    const { ir } = parseDisplayIr(raw);
    show(ir);
  } catch {
    /* 没有历史内容属于正常情况（首次启动） */
  }
}

function onMouseDown() {
  clicks.value += 1;
}

let timer: number | undefined;

onMounted(() => {
  void pullLastIr();
  void refreshFacts();
  // 自检胶囊每秒刷新；有内容时不必轮询（内容由事件驱动）
  timer = window.setInterval(() => {
    if (!current.value) void refreshFacts();
  }, 1500);
  void listenWithRetry<unknown>("surface://hud", (e) => {
    const { ir } = parseDisplayIr(e.payload);
    show(ir);
  });
});

onUnmounted(() => {
  if (timer) window.clearInterval(timer);
  if (hideTimer) window.clearTimeout(hideTimer);
});
</script>

<template>
  <div class="hud-root">
    <div class="hud-capsule" @mousedown="onMouseDown">
      <!-- ① 有展示内容：渲染 IR -->
      <template v-if="view">
        <div class="row head">
          <span class="dot" />
          <span class="name">{{ headLine }}</span>
          <span class="spacer" />
          <span class="tag">{{ passthrough ? "点击穿透" : "可点击" }}</span>
        </div>

        <div v-if="view.kind === 'metric'" class="metric">{{ metricText }}</div>

        <div v-else-if="rows.length" class="rows">
          <div v-for="r in rows" :key="r.label" class="kv-row">
            <span class="kv-key">{{ r.label }}</span>
            <span v-if="r.ratio !== null" class="bar">
              <i :style="{ width: `${Math.round(r.ratio * 100)}%` }" />
            </span>
            <span class="kv-val">{{ r.value }}</span>
          </div>
        </div>

        <div v-else-if="body.code" class="code mono">{{ body.code.split("\n")[0] }}</div>

        <div v-else-if="textLine" class="text">{{ textLine }}</div>

        <div v-else-if="body.lines?.length" class="text">{{ body.lines.join(" ｜ ") }}</div>

        <div v-if="overflowHint" class="hint">{{ overflowHint }}</div>
      </template>

      <!-- ② 没有内容：自检胶囊（窗口在、但什么都没画时，这是唯一的线索） -->
      <template v-else>
        <div class="row head">
          <span class="dot" />
          <span class="name">道生一 · 桌面环境层</span>
          <span class="spacer" />
          <span class="tag" :class="{ warn: passthrough }">
            {{ passthrough ? "点击穿透" : "可点击" }}
          </span>
          <span class="count mono">点击 {{ clicks }}</span>
        </div>
        <div class="row wave-row">
          <div class="wave"><i v-for="n in 26" :key="n" /></div>
          <span class="hint">待命：有结论时会显示在这里</span>
        </div>
        <div class="row mono fact">
          上屏 isVisible={{ ak?.isVisible }} · 透明 isOpaque={{ ak?.isOpaque }} · 穿透
          ignoresMouseEvents={{ ak?.ignoresMouseEvents }}
        </div>
        <div class="row mono fact">
          层级 level={{ ak?.level }}({{ ak?.levelName }}) · 边框 {{ ak?.styleMask }} · 阴影
          {{ ak?.hasShadow }} · 焦点 isKeyWindow={{ ak?.isKeyWindow }}
        </div>
        <div v-if="alarms.length" class="row mono alarm">{{ alarms.join(" ｜ ") }}</div>
        <div v-if="error" class="row mono alarm">IPC 错误：{{ error }}</div>
      </template>
    </div>
  </div>
</template>

<style>
/* HUD 是独立 webview：必须自己把 html/body 抹成透明，否则整窗是一块白底
   （窗口已经 transparent，但 webview 默认画白背景 → 表现为「透明窗口没用」） */
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
  overflow: hidden;
  border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: linear-gradient(180deg, rgba(30, 33, 42, 0.9), rgba(20, 22, 29, 0.82));
  /* 只做内阴影：外阴影会被 380×132 的透明窗口边界硬切一刀，
     表现为胶囊四周一圈灰色方框（窗口本身已 shadow=false，画不出柔和投影） */
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
  /* 不用 backdrop-filter：实测在透明窗口上它什么也糊不到（只能采样页面内部，
     而页面里除了胶囊空无一物）—— 详见 docs/HUD_SPIKE.md §4.4 */
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
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tag {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  white-space: nowrap;
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

.metric {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.5px;
  line-height: 1.1;
  color: #ffffff;
}

.text {
  font-size: 12px;
  line-height: 1.45;
  color: rgba(233, 236, 243, 0.9);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}

.kv-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  line-height: 1.3;
}

.kv-key {
  flex: 0 0 88px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgba(233, 236, 243, 0.72);
}

.bar {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.09);
  overflow: hidden;
}

.bar i {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, #4f8ff7, #6aa6ff);
}

.kv-val {
  flex: 0 0 auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #ffffff;
}

.code {
  font-size: 11px;
  color: #9fd0ff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  height: 8px;
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
