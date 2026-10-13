import type { Marked, Token, Tokens, TokenizerAndRendererExtension } from "marked";
import { Card, ClozeCard } from "./types";
import { repoFor } from "./github";
import { isAudio, mediaUrl, resolveMediaPath } from "./media";

/**
 * Card text into HTML.
 *
 * Markdown is loaded on demand rather than bundled. It is needed only to draw a
 * card, which means only inside a drill, and `renderDrill` is already async —
 * so the await happens once, at the door, and everything past it stays
 * synchronous.
 */

/** Wraps the deleted span of a cloze card, for the tokenizer below to find. */
const CLOZE_OPEN = "";
const CLOZE_CLOSE = "";

let markdown: Marked | null = null;
let loading: Promise<Marked> | null = null;

export function loadMarkdown(): Promise<Marked> {
  return (loading ??= import("marked").then(({ Marked }) => {
    markdown = new Marked({
      extensions: [clozeExtension],
      renderer: { image: renderMedia },
    });
    return markdown;
  }));
}

/**
 * A cloze deletion is a token, not a string substitution.
 *
 * It used to be: splice the literal `CLOZE_DELETION_PLACEHOLDER` into the
 * source, render, then `String.replace` that word for the slot HTML. Two ways
 * that goes wrong. `replace` with a string takes the *first* occurrence, so a
 * card whose own text contained that word lost the wrong one. And the
 * replacement is a pattern, not a literal — an answer containing `$&` or `$'`
 * was spliced into itself.
 *
 * As a tokenizer the answer's markdown is parsed in the same pass as the prose
 * around it, which also retires the regex that used to unwrap the `<p>` a
 * second parse put around it.
 */
type ClozeToken = { type: "cloze"; raw: string; tokens: Token[] };

const clozeExtension: TokenizerAndRendererExtension = {
  name: "cloze",
  level: "inline",
  start(src) {
    const at = src.indexOf(CLOZE_OPEN);
    return at === -1 ? undefined : at;
  },
  tokenizer(src) {
    if (!src.startsWith(CLOZE_OPEN)) return undefined;
    const end = src.indexOf(CLOZE_CLOSE);
    if (end === -1) return undefined;
    const answer = src.slice(CLOZE_OPEN.length, end);
    return {
      type: "cloze",
      raw: src.slice(0, end + CLOZE_CLOSE.length),
      tokens: this.lexer.inlineTokens(answer),
    } satisfies ClozeToken;
  },
  renderer(token) {
    const answer = this.parser.parseInline((token as ClozeToken).tokens);
    return (
      `<span class="cloze-slot">` +
      `<span class="cloze">.............</span>` +
      `<span class="cloze-reveal">${answer}</span>` +
      `</span>`
    );
  },
};

/**
 * The card being rendered, for `renderMedia` to resolve paths against. Set and
 * cleared around one synchronous parse, so it can never describe another card.
 */
let rendering: Pick<Card, "repo" | "filePath"> | null = null;

function renderMarkdown(text: string, card: Pick<Card, "repo" | "filePath">): string {
  if (!markdown) {
    throw new Error("Markdown is not loaded yet — await loadMarkdown() first.");
  }
  rendering = card;
  try {
    return markdown.parse(text, { async: false }) as string;
  } finally {
    rendering = null;
  }
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * `![alt](src)` as an image, or as a player when the file is audio.
 *
 * This used to be a regex over the finished HTML, rewriting every relative
 * `<img src>` to `raw.githubusercontent.com` under whichever repository was
 * configured first — so a subscribed collection's images pointed into yours,
 * `@/` paths were not understood, and a private repository's were a 401. Now
 * the path is resolved here, against the card's own file and repository, to
 * the copy sync stored. Only a file sync does not have (yet) falls back to
 * GitHub, which still serves a public repository.
 */
function renderMedia({ href, title, text }: Tokens.Image): string {
  const card = rendering;
  const path = card ? resolveMediaPath(href, card.filePath) : null;
  let src = href;
  if (card && path) {
    const config = repoFor(card.repo);
    src =
      mediaUrl(card.repo, path) ??
      (config
        ? `https://raw.githubusercontent.com/${card.repo}/${config.branch}/${encodeURI(path)}`
        : href);
  }
  const titled = title ? ` title="${escapeAttr(title)}"` : "";
  if (isAudio(path ?? href)) {
    return `<audio controls preload="metadata" src="${escapeAttr(src)}"${titled}></audio>`;
  }
  return `<img src="${escapeAttr(src)}" alt="${escapeAttr(text)}"${titled}>`;
}

function richText(html: string): string {
  return `<div class="rich-text">${html}</div>`;
}

/** The card's text with the deleted span wrapped, spliced by byte. */
function withClozeMarkers(content: ClozeCard): string {
  const bytes = new TextEncoder().encode(content.text);
  const decoder = new TextDecoder();
  const before = decoder.decode(bytes.slice(0, content.start));
  const deleted = decoder.decode(bytes.slice(content.start, content.end + 1));
  const after = decoder.decode(bytes.slice(content.end + 1));
  return `${before}${CLOZE_OPEN}${deleted}${CLOZE_CLOSE}${after}`;
}

/**
 * A card's whole body, with the answer already in the DOM but hidden. Revealing
 * is then a class toggle rather than a re-render — no second markdown parse and
 * no second KaTeX / highlight.js pass over content that has not changed.
 *
 * A cloze card gets both faces from one parse: the surrounding prose is
 * identical either way, and the deletion becomes a slot holding the blank and
 * the answer together. Which one shows is a class on an ancestor.
 */
export function renderCardBody(card: Card): string {
  const content = card.content;
  if (content.type === "basic") {
    return (
      `<div class="question">${richText(renderMarkdown(content.question, card))}</div>` +
      `<div class="answer">${richText(renderMarkdown(content.answer, card))}</div>`
    );
  }
  return `<div class="prompt">${richText(
    renderMarkdown(withClozeMarkers(content), card)
  )}</div>`;
}
