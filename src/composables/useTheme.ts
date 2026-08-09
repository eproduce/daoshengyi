import { ref, watch } from "vue";

export type Theme = "light" | "dark";

const THEME_KEY = "daoshengyi_theme";

const theme = ref<Theme>(loadTheme());

function loadTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
}

export function useTheme() {
  applyTheme(theme.value);

  watch(theme, (t) => {
    localStorage.setItem(THEME_KEY, t);
    applyTheme(t);
  });

  function toggleTheme() {
    theme.value = theme.value === "light" ? "dark" : "light";
  }

  return { theme, toggleTheme };
}
