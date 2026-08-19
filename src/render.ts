import type { Marked, Token, TokenizerAndRendererExtension } from "marked";
import { Card, ClozeCard } from "./types";
import { getConfig } from "./github";

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
    markdown = new Marked({ extensions: [clozeExtension] });
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

function renderMarkdown(text: string): string {
  if (!markdown) {
    throw new Error("Markdown is not loaded yet — await loadMarkdown() first.");
  }
  return markdown.parse(text, { async: false }) as string;
}

/**
 * Where a relative image path resolves to, or `null` when there is no repo to
 * resolve it against.
 *
 * This used to read `github_owner`, `github_repo` and `github_branch` out of
 * `localStorage` itself, with its own defaults — a second reading of the
 * configuration that disagreed with `getConfig()` about the unconfigured case.
 * `getConfig()` says "there is no repo"; this said the repo was `""`, and built
 * `https://raw.githubusercontent.com///main/diagram.png`, which is a 404 with
 * extra steps. Now there is one reading, and no repo means the `src` is left
 * exactly as the card wrote it.
 */
function imageBaseUrl(): string | null {
  const config = getConfig();
  if (!config) return null;
  return `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${config.branch}`;
}

function rewriteImageUrls(html: string, filePath: string): string {
  const baseUrl = imageBaseUrl();
  if (!baseUrl) return html;

  const dir = filePath.includes("/")
    ? filePath.substring(0, filePath.lastIndexOf("/"))
    : "";

  return html.replace(
    /(<img\s+[^>]*src=")(?!https?:\/\/)([^"]+)(")/g,
    (_match, pre, src, post) => {
      const fullPath = dir ? `${dir}/${src}` : src;
      return `${pre}${baseUrl}/${fullPath}${post}`;
    }
  );
}

function richText(html: string, filePath: string): string {
  return `<div class="rich-text">${rewriteImageUrls(html, filePath)}</div>`;
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
      `<div class="question">${richText(renderMarkdown(content.question), card.filePath)}</div>` +
      `<div class="answer">${richText(renderMarkdown(content.answer), card.filePath)}</div>`
    );
  }
  return `<div class="prompt">${richText(
    renderMarkdown(withClozeMarkers(content)),
    card.filePath
  )}</div>`;
}
