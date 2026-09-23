import { it, expect } from "vitest";
import {
  CUSTOM_PRESET_ID,
  PERMISSION_PRESETS,
  matchPresetId,
  presetApplies,
  presetById,
  presetHint,
  presetWrites,
} from "../src/utils/permission-presets.ts";

// 场景（借鉴 DSH permission-presets）：把「沙箱模式 + 审批策略」两个旋钮捆成具名档位，
// 客户端只暴露一个选择器。档位本身是纯数据 + 纯函数，最容易在加/改档位时出错
// （比如命中判定漏了、yoloMode 耦合写错、缺工作区时静默不生效），故钉成单测。

it("预设表：id 唯一、字段齐全，且默认档位用 DSH 同名 key", () => {
  const ids = PERMISSION_PRESETS.map((p) => p.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const p of PERMISSION_PRESETS) {
    expect(p.label.length).toBeGreaterThan(0);
    expect(p.description.length).toBeGreaterThan(0);
  }
  expect(ids).toContain("workspace-write");
  expect(ids).toContain("danger-full-access");
  // custom 是派生的保留名，不能出现在可配置档位表里（DSH 的约定）
  expect(ids).not.toContain(CUSTOM_PRESET_ID);
});

it("matchPresetId：命中档位给 id，不匹配任何档位给 custom", () => {
  expect(matchPresetId("read-only", "manual")).toBe("read-only");
  expect(matchPresetId("workspace-write", "manual")).toBe("workspace-write");
  expect(matchPresetId("workspace-write", "smart")).toBe("workspace-write-smart");
  expect(matchPresetId("off", "yolo")).toBe("danger-full-access");
  // 组合不在表里（用户手动逐项改过）→ 必须落到 custom，不能假装某一档生效
  expect(matchPresetId("off", "manual")).toBe(CUSTOM_PRESET_ID);
  expect(matchPresetId("read-only", "smart")).toBe(CUSTOM_PRESET_ID);
  // 缺省值按设置里的默认（off + manual）解释
  expect(matchPresetId(null, null)).toBe(CUSTOM_PRESET_ID);
});

it("presetWrites：档位写穿的字段与设置面板的耦合一致（yoloMode 跟着 yolo 审批走）", () => {
  expect(presetWrites(presetById("read-only")!)).toEqual({
    sandboxMode: "read-only",
    approvalMode: "manual",
    yoloMode: false,
  });
  expect(presetWrites(presetById("workspace-write-smart")!)).toEqual({
    sandboxMode: "workspace-write",
    approvalMode: "smart",
    yoloMode: false,
  });
  // 「完全放开」= danger-full-access + never：这里必须同时打开 yoloMode，
  // 否则设置面板读到的 approvalMode=yolo 与 yoloMode=false 互相矛盾
  expect(presetWrites(presetById("danger-full-access")!)).toEqual({
    sandboxMode: "off",
    approvalMode: "yolo",
    yoloMode: true,
  });
});

it("presetApplies：只有 workspace-write 档位依赖工作区根目录", () => {
  const ws = presetById("workspace-write")!;
  expect(presetApplies(ws, "/Users/me/op")).toBe(true);
  expect(presetApplies(ws, "   ")).toBe(false);
  expect(presetApplies(ws, "")).toBe(false);
  expect(presetApplies(ws, null)).toBe(false);
  expect(presetApplies(presetById("read-only")!, "")).toBe(true);
  expect(presetApplies(presetById("danger-full-access")!, null)).toBe(true);
});

it("presetHint：缺工作区时说清「这档不生效」，高风险档位给警示，正常档无提示", () => {
  // 关键文案：后端实测行为是「workspace-write + 无工作区 → 不加沙箱」，不能让用户以为受限了
  const h = presetHint("workspace-write", "");
  expect(h).toContain("工作区");
  expect(h).toContain("不会加沙箱");
  expect(presetHint("workspace-write", "/Users/me/op")).toBe("");
  expect(presetHint("danger-full-access", null)).toContain("高风险");
  expect(presetHint("read-only", null)).toBe("");
  expect(presetHint(CUSTOM_PRESET_ID, "/Users/me/op")).toContain("自定义");
  // 未知 id 不抛错（设置里可能是旧值/手写值）
  expect(presetHint("no-such-preset", "/x")).toBe("");
});
