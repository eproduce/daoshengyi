import { computed, ref, watch } from "vue";
import {
  DEFAULT_THEME_PREF,
  THEME_PREF_KEY,
  nextPrefOnToggle,
  parseThemePref,
  resolveTheme,
  type Theme,
  type ThemePref,
} from "@/utils/theme";

// 系统外观（prefers-color-scheme）。模块级单例：整应用只注册一次监听。
const media = window.matchMedia("(prefers-color-scheme: dark)");
const systemDark = ref(media.matches);
const onSystemChange = (e: MediaQueryListEvent | MediaQueryList) => {
  systemDark.value = e.matches;
};
// Safari 老版本只有 addListener；WKWebView 新版本两者都有 —— 做特性探测而不是赌版本
if (typeof media.addEventListener === "function") {
  media.addEventListener("change", onSystemChange);
} else {
  const legacy = media as MediaQueryList & { addListener?: (cb: typeof onSystemChange) => void };
  legacy.addListener?.(onSystemChange);
}

function loadPref(): ThemePref {
  const saved = parseThemePref(localStorage.getItem(THEME_PREF_KEY));
  // 没存过 → 跟随系统（老版本「首次按系统决定」的隐式行为，现在显式化并保持实时）
  return saved ?? DEFAULT_THEME_PREF;
}

const pref = ref<ThemePref>(loadPref());
/** 生效主题：偏好是 system 时由系统外观决定，系统一变立刻跟着变 */
const theme = computed<Theme>(() => resolveTheme(pref.value, systemDark.value));

function applyTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
}
applyTheme(theme.value);

// 偏好或系统外观变化 → 立刻应用（这就是「跟随系统」的实时性来源）
watch(theme, (t) => applyTheme(t));
watch(pref, (p) => {
  try {
    localStorage.setItem(THEME_PREF_KEY, p);
  } catch {
    /* 隐私模式下写入失败不影响使用 */
  }
});

export function useTheme() {
  function setThemePref(p: ThemePref) {
    pref.value = p;
  }
  function toggleTheme() {
    // 跟随系统时切成「当前生效主题的反面」，保证点一下看得出变化
    pref.value = nextPrefOnToggle(pref.value, systemDark.value);
  }
  return { theme, pref, systemDark, setThemePref, toggleTheme };
}
