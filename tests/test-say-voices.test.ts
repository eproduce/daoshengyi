import { it, expect } from "vitest";
// 音色分组：真机反馈「除了 Tingting 其他音色都很奇怪」的那个 bug 的回归测试。
// 输入直接用本机 `say -v ?` 抓下来的**真实片段**（不是什么理想化样例）。
import {
  groupVoices,
  isVariantVoice,
  describeSelection,
  type SayVoice,
} from "../src/utils/say-voices.ts";

console.log("\n== 音色分组（真人音色 vs Apple 趣味变体） ==");

/** 本机实测片段：中文组 19 条里 16 条是变体，真人只有 Tingting/Meijia/Sinji */
const REAL_ZH_SLICE: SayVoice[] = [
  { name: "Eddy (中文（中国大陆）)", locale: "zh_CN", variant: true },
  { name: "Flo (中文（中国大陆）)", locale: "zh_CN", variant: true },
  { name: "Grandma (中文（中国大陆）)", locale: "zh_CN", variant: true },
  { name: "Meijia", locale: "zh_TW", variant: false },
  { name: "Sinji", locale: "zh_HK", variant: false },
  { name: "Tingting", locale: "zh_CN", variant: false },
];

it("真人中文音色与变体分开，且变体永远在最后一组", () => {
  const groups = groupVoices(REAL_ZH_SLICE);
  expect(groups.map((g) => g.id)).toEqual(["zh-main", "zh-other", "variant"]);
  expect(groups[0].voices.map((v) => v.name)).toEqual(["Tingting"]);
  expect(groups[1].voices.map((v) => v.name)).toEqual(["Meijia", "Sinji"]);
  expect(groups[2].voices.length).toBe(3);
});

it("变体组必须有「会怪」的说明 —— 不然用户还是会踩", () => {
  const variant = groupVoices(REAL_ZH_SLICE).find((g) => g.id === "variant");
  expect(variant?.hint).toContain("怪");
  // 顺带把「怎么变好」的出口写上：去系统设置下载更自然的声音
  expect(variant?.hint).toContain("系统设置");
});

it("后端没给 variant 字段时，靠名字里的括号兜底（两侧任一更新都不漏）", () => {
  const noFlag: SayVoice[] = [
    { name: "Eddy (中文（中国大陆）)", locale: "zh_CN" }, // 旧后端：没有 variant
    { name: "Tingting", locale: "zh_CN" },
  ];
  const groups = groupVoices(noFlag);
  expect(groups.map((g) => g.id)).toEqual(["zh-main", "variant"]);
  expect(isVariantVoice(noFlag[0])).toBe(true);
  expect(isVariantVoice(noFlag[1])).toBe(false);
});

it("非中文真人音色进「其它语言」组，不混进变体组", () => {
  const voices: SayVoice[] = [
    { name: "Alex", locale: "en_US", variant: false },
    { name: "Eddy (英语（美国）)", locale: "en_US", variant: true },
    { name: "Kyoko", locale: "ja_JP", variant: false },
  ];
  const groups = groupVoices(voices);
  expect(groups.map((g) => g.id)).toEqual(["other", "variant"]);
  expect(groups[0].voices.map((v) => v.name)).toEqual(["Alex", "Kyoko"]);
  expect(groups[1].voices.map((v) => v.name)).toEqual(["Eddy (英语（美国）)"]);
});

it("分组不重排组内顺序（排序是 Rust 侧职责，避免两边各排一套）", () => {
  const voices: SayVoice[] = [
    { name: "Tingting", locale: "zh_CN", variant: false },
    { name: "Alex", locale: "en_US", variant: false },
    { name: "Zoe", locale: "en_US", variant: false }, // 故意反字典序
  ];
  const groups = groupVoices(voices);
  expect(groups.find((g) => g.id === "other")?.voices.map((v) => v.name)).toEqual(["Alex", "Zoe"]);
});

it("空列表返回空组（设置页不该显示空的下拉", () => {
  expect(groupVoices([])).toEqual([]);
});

it("选中变体音色时给出提醒，选中真人音色时显示语言区域", () => {
  expect(describeSelection(REAL_ZH_SLICE, "Eddy (中文（中国大陆）)")).toContain("变体音色");
  expect(describeSelection(REAL_ZH_SLICE, "Tingting")).toBe("Tingting（zh_CN）");
  expect(describeSelection(REAL_ZH_SLICE, "")).toBe("系统默认");
  // 列表里找不到的名字（比如旧设置里存的老音色）原样显示，不瞎猜
  expect(describeSelection(REAL_ZH_SLICE, "SomeGoneVoice")).toBe("SomeGoneVoice");
});
