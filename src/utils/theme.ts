// 主题偏好的纯逻辑（零依赖、可单测）。
//
// 关键区分：**偏好（pref）** vs **生效主题（theme）**。
//   pref = "system" | "light" | "dark"（用户的选择，持久化这个）
//   theme = "light" | "dark"（真正写进 <html data-theme> 的值）
// 老版本只存 light/dark（且**没点过就不写**），所以「没存过值」的老用户会自然落到
// 跟随系统 —— 正是他们原本的隐式行为；显式选过的人保持原样。

export type Theme = "light" | "dark";
export type ThemePref = "system" | "light" | "dark";

/** 持久化键（沿用旧键，值扩展出 "system"，向后兼容） */
export const THEME_PREF_KEY = "daoshengyi_theme";

/** 默认偏好：跟随系统 */
export const DEFAULT_THEME_PREF: ThemePref = "system";

/** 解析已存值；无法识别（含旧数据/脏数据）返回 null，由调用方决定默认 */
export function parseThemePref(raw: string | null | undefined): ThemePref | null {
  if (raw === "system" || raw === "light" || raw === "dark") return raw;
  return null;
}

/** 偏好 + 系统当前明暗 → 生效主题（唯一需要判断的地方，其余代码只看结果） */
export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

/**
 * 点「切换主题」后的**新偏好**。
 * 注意不能简单地 light↔dark 互换：跟随系统时用户点一下必须**看得出变化**，
 * 所以切成「当前生效主题的反面」并记为显式偏好。
 */
export function nextPrefOnToggle(pref: ThemePref, systemDark: boolean): ThemePref {
  return resolveTheme(pref, systemDark) === "dark" ? "light" : "dark";
}

/** 偏好的人类可读名（设置页与提示用同一套文案） */
export function themePrefLabel(pref: ThemePref): string {
  return pref === "system" ? "跟随系统" : pref === "dark" ? "深色" : "浅色";
}

/** 状态说明：跟随系统时要顺带告诉用户「系统当前是深/浅色」，否则看不出为什么是这个色 */
export function themePrefHint(pref: ThemePref, systemDark: boolean): string {
  if (pref !== "system") return `已固定为${themePrefLabel(pref)}，不随系统外观变化`;
  return `跟随系统（系统当前为${systemDark ? "深色" : "浅色"}）；系统外观变化时应用会立刻跟着变`;
}
