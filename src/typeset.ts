import { Card } from "./types";
import { applyTheme } from "./theme";

/**
 * Maths and syntax highlighting, fetched only by a collection that has any.
 *
 * KaTeX and highlight.js are ~400 KB of script and stylesheet between them, and
 * they used to be four `<link>`s and three `<script defer>`s in `index.html` —
 * downloaded, parsed and executed on every cold start, whether or not a single
 * card contained maths or a code block. Most collections contain neither.
 *
 * They stay on the CDN rather than moving into the bundle: the service worker
 * caches `cdn.jsdelivr.net` responses, so the second load of a collection that
 * does use them is offline-capable, and a collection that does not never pays.
 */

const KATEX = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist";
const HLJS = "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build";

type Katex = {
  renderMathInElement?: (el: HTMLElement, options: unknown) => void;
  hljs?: { highlightElement: (el: HTMLElement) => void };
};

const win = window as Window & Katex;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) return resolve();
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

function loadStyle(href: string, id?: string): void {
  if (id && document.getElementById(id)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  if (id) link.id = id;
  document.head.appendChild(link);
}

let math: Promise<void> | null = null;

function loadMath(): Promise<void> {
  if (win.renderMathInElement) return Promise.resolve();
  return (math ??= (async () => {
    loadStyle(`${KATEX}/katex.min.css`);
    // Sequenced, not raced: auto-render reads the `katex` global as it loads.
    await loadScript(`${KATEX}/katex.min.js`);
    await loadScript(`${KATEX}/contrib/auto-render.min.js`);
  })());
}

let highlight: Promise<void> | null = null;

function loadHighlight(): Promise<void> {
  if (win.hljs) return Promise.resolve();
  return (highlight ??= (async () => {
    // Both themes, then `applyTheme` parks the one not in use on a
    // non-matching media query — which is also what a later theme change does,
    // so switching costs no second fetch. It already tolerated these being
    // absent, which is what makes them loadable this late.
    loadStyle(`${HLJS}/styles/github.min.css`, "hljs-light");
    loadStyle(`${HLJS}/styles/github-dark.min.css`, "hljs-dark");
    applyTheme();
    await loadScript(`${HLJS}/highlight.min.js`);
  })());
}

/**
 * Whether text contains something worth loading a maths typesetter for.
 *
 * Deliberately stricter than KaTeX itself. Given `$5 to $9`, auto-render will
 * happily treat `5 to ` as maths and set it in Computer Modern — so matching
 * its rules exactly would mean fetching 300 KB in order to mangle a sentence
 * about money. Inline maths has to look like maths: a command, a superscript,
 * a subscript, braces, or a single short symbol. Display maths always counts,
 * since `$$` is not something prose does by accident.
 *
 * The cost of guessing wrong is asymmetric, which is why it leans this way. A
 * missed formula shows as the TeX the author typed. A false positive is a
 * third of a megabyte and a garbled sentence.
 */
export function hasMath(text: string): boolean {
  if (/\$\$[\s\S]+?\$\$/.test(text)) return true;
  for (const [, inner] of text.matchAll(/\$([^\s$][^$\n]*)\$/g)) {
    if (/[\\^_{}]/.test(inner)) return true;
    if (!/\s/.test(inner) && inner.length <= 8) return true;
  }
  return false;
}

/**
 * Typeset whatever this card turned out to need. Asynchronous and not waited
 * on: the card is already on screen and readable, and this is the pass that
 * makes its maths and its code look right.
 */
export function typeset(container: HTMLElement): Promise<void> {
  const jobs: Promise<void>[] = [];

  // Done in this frame when the library is already here, which after the first
  // card it always is. Only the first card of a collection can arrive before
  // its typesetter, and only if the warm-up below has not landed yet.
  if (hasMath(container.textContent ?? "")) {
    if (win.renderMathInElement) renderMath(container);
    else jobs.push(loadMath().then(() => renderMath(container)));
  }

  if (container.querySelector("pre code")) {
    if (win.hljs) highlightCode(container);
    else jobs.push(loadHighlight().then(() => highlightCode(container)));
  }

  return Promise.all(jobs).then(() => undefined);
}

function renderMath(container: HTMLElement): void {
  win.renderMathInElement?.(container, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "$", right: "$", display: false },
    ],
    throwOnError: false,
  });
}

function highlightCode(container: HTMLElement): void {
  container.querySelectorAll("pre code").forEach((block) => {
    win.hljs?.highlightElement(block as HTMLElement);
  });
}

/**
 * Fetch what the collection will need, once, in the background.
 *
 * Without this the first card with maths in it would show raw TeX for as long
 * as the network takes, and a collection that had never been drilled online
 * would have nothing cached to fall back on. With it, a collection that uses
 * neither still fetches neither.
 */
export function warmTypesetting(cards: Card[]): void {
  let wantsMath = false;
  let wantsCode = false;
  for (const card of cards) {
    const text =
      card.content.type === "basic"
        ? `${card.content.question}\n${card.content.answer}`
        : card.content.text;
    wantsMath ||= hasMath(text);
    wantsCode ||= text.includes("```");
    if (wantsMath && wantsCode) break;
  }

  const idle =
    typeof (window as any).requestIdleCallback === "function"
      ? (fn: () => void) => (window as any).requestIdleCallback(fn, { timeout: 3000 })
      : (fn: () => void) => setTimeout(fn, 1000);

  if (wantsMath || wantsCode) {
    idle(() => {
      if (wantsMath) void loadMath().catch(() => {});
      if (wantsCode) void loadHighlight().catch(() => {});
    });
  }
}
