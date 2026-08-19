import { marked } from "marked";
import { Card, ClozeCard } from "./types";
import { getConfig } from "./github";

const CLOZE_TAG = "CLOZE_DELETION_PLACEHOLDER";

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

function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

function richText(html: string, filePath: string): string {
  return `<div class="rich-text">${rewriteImageUrls(html, filePath)}</div>`;
}

/** Cloze text with the deletion swapped for a placeholder, spliced by byte. */
function textWithClozeTag(content: ClozeCard): string {
  const textBytes = new TextEncoder().encode(content.text);
  const before = textBytes.slice(0, content.start);
  const after = textBytes.slice(content.end + 1);
  const tagBytes = new TextEncoder().encode(CLOZE_TAG);
  const combined = new Uint8Array(
    before.length + tagBytes.length + after.length
  );
  combined.set(before);
  combined.set(tagBytes, before.length);
  combined.set(after, before.length + tagBytes.length);
  return new TextDecoder().decode(combined);
}

/** The deleted span, rendered as inline HTML rather than its own paragraph. */
function clozeAnswerHtml(content: ClozeCard): string {
  const textBytes = new TextEncoder().encode(content.text);
  const deleted = new TextDecoder().decode(
    textBytes.slice(content.start, content.end + 1)
  );
  return renderMarkdown(deleted).replace(/^<p>(.*)<\/p>\s*$/, "$1");
}

/**
 * A cloze card with both faces in one pass: the surrounding prose is identical
 * either way, so it is parsed once and the placeholder becomes a slot holding
 * the blank and the answer together. Which one shows is then a class on an
 * ancestor.
 */
function renderCloze(card: Card, content: ClozeCard): string {
  const slot =
    `<span class="cloze-slot">` +
    `<span class="cloze">.............</span>` +
    `<span class="cloze-reveal">${clozeAnswerHtml(content)}</span>` +
    `</span>`;

  const html = renderMarkdown(textWithClozeTag(content)).replace(
    CLOZE_TAG,
    slot
  );
  return richText(html, card.filePath);
}

/**
 * A card's whole body, with the answer already in the DOM but hidden. Revealing
 * is then a class toggle rather than a re-render — no second markdown parse and
 * no second KaTeX / highlight.js pass over content that has not changed.
 */
export function renderCardBody(card: Card): string {
  const content = card.content;
  if (content.type === "basic") {
    return (
      `<div class="question">${richText(renderMarkdown(content.question), card.filePath)}</div>` +
      `<div class="answer">${richText(renderMarkdown(content.answer), card.filePath)}</div>`
    );
  }
  return `<div class="prompt">${renderCloze(card, content)}</div>`;
}

export function postRender(container: HTMLElement): void {
  // KaTeX rendering
  if (typeof (window as any).renderMathInElement === "function") {
    (window as any).renderMathInElement(container, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
      ],
      throwOnError: false,
    });
  }

  // highlight.js
  if (typeof (window as any).hljs !== "undefined") {
    container.querySelectorAll("pre code").forEach((block) => {
      (window as any).hljs.highlightElement(block as HTMLElement);
    });
  }
}
