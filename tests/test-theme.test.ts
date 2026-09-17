// 主题偏好纯逻辑单测。
// 重点：① 无效/旧数据不炸（返回 null 让调用方用默认）② 「跟随系统」必须由系统值决定
// ③ 切主题时从「跟随系统」出发要能看出变化（否则用户点一下没反应）
import { describe, it, expect } from "vitest";
import {
  DEFAULT_THEME_PREF,
  parseThemePref,
  resolveTheme,
  nextPrefOnToggle,
  themePrefLabel,
  themePrefHint,
  THEME_PREF_KEY,
  type ThemePref,
} from "../src/utils/theme";

describe("parseThemePref", () => {
  it("识别三种合法偏好", () => {
    expect(parseThemePref("system")).toBe("system");
    expect(parseThemePref("light")).toBe("light");
    expect(parseThemePref("dark")).toBe("dark");
  });

  it("旧数据/脏数据返回 null（不抛错、不猜）", () => {
    expect(parseThemePref(null)).toBeNull();
    expect(parseThemePref(undefined)).toBeNull();
    expect(parseThemePref("")).toBeNull();
    expect(parseThemePref("Dark")).toBeNull(); // 大小写不宽容，避免前端写出脏值
    expect(parseThemePref("auto")).toBeNull();
    expect(parseThemePref("{}")).toBeNull();
  });

  it("默认偏好是跟随系统", () => {
    expect(DEFAULT_THEME_PREF).toBe("system");
  });

  it("持久化键沿用旧键（老用户的选择不丢）", () => {
    expect(THEME_PREF_KEY).toBe("daoshengyi_theme");
  });
});

describe("resolveTheme", () => {
  it("跟随系统：由系统明暗决定", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("显式偏好：不受系统影响", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });
});

describe("nextPrefOnToggle", () => {
  it("从跟随系统出发：切到当前生效主题的反面（系统深 → 浅色）", () => {
    expect(nextPrefOnToggle("system", true)).toBe("light");
    expect(nextPrefOnToggle("system", false)).toBe("dark");
  });

  it("显式偏好之间正常互换", () => {
    expect(nextPrefOnToggle("light", true)).toBe("dark");
    expect(nextPrefOnToggle("dark", false)).toBe("light");
  });

  it("连续两次切换回到起点（可逆）", () => {
    const once = nextPrefOnToggle("system", true);
    expect(nextPrefOnToggle(once, true)).toBe("dark"); // system→light→dark
  });
});

describe("文案", () => {
  it("label 三种偏好都有中文名", () => {
    expect(themePrefLabel("system")).toBe("跟随系统");
    expect(themePrefLabel("light")).toBe("浅色");
    expect(themePrefLabel("dark")).toBe("深色");
    for (const p of ["system", "light", "dark"] as ThemePref[]) {
      expect(themePrefLabel(p).length).toBeGreaterThan(0);
    }
  });

  it("跟随系统时要说明系统当前是深还是浅（否则用户不知道为何是这个色）", () => {
    expect(themePrefHint("system", true)).toContain("深色");
    expect(themePrefHint("system", false)).toContain("浅色");
    expect(themePrefHint("system", true)).toContain("立刻");
    // 显式偏好则明确说明不随系统变
    expect(themePrefHint("dark", false)).toContain("不随系统");
    expect(themePrefHint("light", true)).toContain("不随系统");
  });
});
