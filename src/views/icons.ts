import { html, svg, TemplateResult } from "lit-html";

/**
 * Stroke icons, inline so they inherit `currentColor` and scale with the
 * control around them. Unicode glyphs (⟳ ⚙ ✕) used to stand in for these and
 * rendered at whatever size the platform's fallback font felt like.
 *
 * Stroke width lives in the stylesheet (`.icon`), so a context can thicken one
 * without a second copy of the path.
 */
const PATHS = {
  plus: svg`<path d="M5 12h14"/><path d="M12 5v14"/>`,
  chart: svg`<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>`,
  settings: svg`<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>`,
  x: svg`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
  undo: svg`<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>`,
  edit: svg`<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>`,
  back: svg`<path d="m15 18-6-6 6-6"/>`,
  chevron: svg`<path d="m9 18 6-6-6-6"/>`,
  check: svg`<path d="M20 6 9 17l-5-5"/>`,
  inbox: svg`<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/>`,
  trash: svg`<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>`,
  skip: svg`<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>`,
  external: svg`<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`,
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 22): TemplateResult {
  return html`<svg
    class="icon icon-${name}"
    aria-hidden="true"
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
  >${PATHS[name]}</svg>`;
}
