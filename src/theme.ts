import { settings } from "./settings";

export type Theme = "system" | "light" | "dark";

export function getTheme(): Theme {
  return settings.theme.get();
}

export function setTheme(theme: Theme): void {
  settings.theme.set(theme);
  applyTheme();
}

/**
 * Asked for on first use rather than at import. A module that touches a browser
 * API while it is being loaded can only be imported by something that has one,
 * which made every test that reached this file transitively need a `matchMedia`
 * it had no other use for.
 */
let darkQuery: MediaQueryList | null = null;

function systemPrefersDark(): MediaQueryList | null {
  if (darkQuery === null && typeof window.matchMedia === "function") {
    darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  }
  return darkQuery;
}

/** The theme actually in force, resolving "system" against the OS setting. */
export function effectiveTheme(): "light" | "dark" {
  const theme = getTheme();
  if (theme !== "system") return theme;
  return systemPrefersDark()?.matches ? "dark" : "light";
}

/**
 * Reflect the chosen theme onto the document. The stylesheet handles the
 * system case on its own via `prefers-color-scheme`; `data-theme` is set only
 * for an explicit choice, so it can override the system preference in either
 * direction.
 *
 * Syntax highlighting comes from two CDN stylesheets rather than our tokens, so
 * the unused one is parked on a non-matching media query — which still lets it
 * download and be cached for offline use. Neither exists until a card with code
 * in it asks for them (`src/typeset.ts`), which is why their absence is not a
 * problem here. The browser-chrome colour follows too.
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
  systemPrefersDark()?.addEventListener("change", () => {
    if (getTheme() === "system") applyTheme();
  });
}
