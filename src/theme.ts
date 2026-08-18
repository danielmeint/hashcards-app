export type Theme = "system" | "light" | "dark";

const LS_KEY = "theme";

export function getTheme(): Theme {
  const stored = localStorage.getItem(LS_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

export function setTheme(theme: Theme): void {
  if (theme === "system") localStorage.removeItem(LS_KEY);
  else localStorage.setItem(LS_KEY, theme);
  applyTheme();
}

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/** The theme actually in force, resolving "system" against the OS setting. */
export function effectiveTheme(): "light" | "dark" {
  const theme = getTheme();
  return theme === "system" ? (darkQuery.matches ? "dark" : "light") : theme;
}

/**
 * Reflect the chosen theme onto the document. The stylesheet handles the
 * system case on its own via `prefers-color-scheme`; `data-theme` is set only
 * for an explicit choice, so it can override the system preference in either
 * direction.
 *
 * Syntax highlighting comes from two CDN stylesheets rather than our tokens, so
 * the unused one is parked on a non-matching media query — which still lets it
 * download and be cached for offline use. The browser-chrome colour follows too.
 */
export function applyTheme(): void {
  const theme = getTheme();
  const root = document.documentElement;

  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);

  const dark = effectiveTheme() === "dark";

  const light = document.getElementById("hljs-light") as HTMLLinkElement | null;
  const darkSheet = document.getElementById("hljs-dark") as HTMLLinkElement | null;
  if (light) light.media = dark ? "not all" : "all";
  if (darkSheet) darkSheet.media = dark ? "all" : "not all";

  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#16181c" : "#f8f8f8");
}

/** Follow the OS while the theme is "system". */
export function watchSystemTheme(): void {
  darkQuery.addEventListener("change", () => {
    if (getTheme() === "system") applyTheme();
  });
}
