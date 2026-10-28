import { it, expect } from "vitest";
// 语音输入（耳朵）：把「转写接进草稿」这类边界做成纯函数，这里钉住行为。
// 真实文本形态来自 SenseVoice 的实际输出（带标点、无空格、中英混说）。
import {
  appendTranscript,
  levelPercent,
  levelBarHeight,
  phaseLabel,
  permissionHint,
} from "../src/utils/voice.ts";

console.log("\n== 语音输入：草稿拼接 / 电平 / 文案 ==");

it("中文接中文不加空格（加了就是错字）", () => {
  expect(appendTranscript("道生一", "看看今天改了哪些文件")).toBe("道生一看看今天改了哪些文件");
});

it("中文接英文加空格，且不留前导空格", () => {
  expect(appendTranscript("先跑", "npm test")).toBe("先跑 npm test");
  expect(appendTranscript("", "  npm test  ")).toBe("npm test");
});

it("英文接中文加空格（否则粘成一个词）", () => {
  expect(appendTranscript("run", "测试")).toBe("run 测试");
});

it("草稿已以空白结尾时不重复加空格", () => {
  expect(appendTranscript("帮我看看：\n", "这个报错")).toBe("帮我看看：\n这个报错");
  expect(appendTranscript("hello ", "world")).toBe("hello world");
});

it("空转写不改动草稿", () => {
  expect(appendTranscript("原样", "")).toBe("原样");
  expect(appendTranscript("", "")).toBe("");
});

it("电平映射：静音为 0、正常说话拉到中高、卡在 0~1", () => {
  expect(levelPercent(0)).toBe(0);
  expect(levelPercent(-1)).toBe(0);
  expect(levelPercent(Number.NaN)).toBe(0);
  // 实测：正常说话 RMS 0.02~0.15 —— 不该趴在底部
  expect(levelPercent(0.02)).toBeGreaterThan(0.25);
  expect(levelPercent(0.15)).toBeGreaterThan(0.7);
  // 削顶不外溢
  expect(levelPercent(5)).toBe(1);
});

it("电平柱：中心最高、两侧更低，且都在 0~1", () => {
  const rms = 0.05;
  const heights = [0, 1, 2, 3, 4].map((i) => levelBarHeight(rms, i, 5));
  expect(heights[2]).toBeGreaterThan(heights[1]);
  expect(heights[1]).toBeGreaterThan(heights[0]);
  expect(heights[2]).toBeGreaterThan(heights[3]);
  for (const h of heights) {
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(1);
  }
});

it("相位文案覆盖 Rust 侧全部 phase，未知值原样回显", () => {
  expect(phaseLabel("listening")).toBe("正在聆听");
  expect(phaseLabel("thinking")).toBe("正在识别");
  expect(phaseLabel("")).toBe("空闲");
  expect(phaseLabel("weird")).toBe("weird");
});

it("授权状态：已授权不提示，拒绝时给出可照做的路径", () => {
  expect(permissionHint("authorized")).toBeNull();
  expect(permissionHint("denied")).toContain("系统设置");
  expect(permissionHint("denied")).toContain("麦克风");
  expect(permissionHint("not_determined")).toContain("允许");
  expect(permissionHint("restricted")).toContain("限制");
  expect(permissionHint("unknown")).toContain("无法读取");
});
