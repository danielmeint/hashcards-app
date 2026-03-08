import { marked } from "marked";
import { Card } from "./types";

const CLOZE_TAG = "CLOZE_DELETION_PLACEHOLDER";

function getImageBaseUrl(): string {
  const owner = localStorage.getItem("github_owner") || "";
  const repo = localStorage.getItem("github_repo") || "";
  const branch = localStorage.getItem("github_branch") || "main";
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;
}

function rewriteImageUrls(html: string, filePath: string): string {
  const baseUrl = getImageBaseUrl();
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

export function renderFront(card: Card): string {
  const content = card.content;
  if (content.type === "basic") {
    let html = renderMarkdown(content.question);
    html = rewriteImageUrls(html, card.filePath);
    return `<div class="rich-text">${html}</div>`;
  } else {
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
    let text = new TextDecoder().decode(combined);
    let html = renderMarkdown(text);
    html = html.replace(
      CLOZE_TAG,
      "<span class='cloze'>.............</span>"
    );
    html = rewriteImageUrls(html, card.filePath);
    return `<div class="rich-text">${html}</div>`;
  }
}

export function renderBack(card: Card): string {
  const content = card.content;
  if (content.type === "basic") {
    let html = renderMarkdown(content.answer);
    html = rewriteImageUrls(html, card.filePath);
    return `<div class="rich-text">${html}</div>`;
  } else {
    const textBytes = new TextEncoder().encode(content.text);
    const deletedBytes = textBytes.slice(content.start, content.end + 1);
    const deletedText = new TextDecoder().decode(deletedBytes);
    const deletedHtml = renderMarkdown(deletedText).replace(
      /^<p>(.*)<\/p>\s*$/,
      "$1"
    );

    const before = textBytes.slice(0, content.start);
    const after = textBytes.slice(content.end + 1);
    const tagBytes = new TextEncoder().encode(CLOZE_TAG);
    const combined = new Uint8Array(
      before.length + tagBytes.length + after.length
    );
    combined.set(before);
    combined.set(tagBytes, before.length);
    combined.set(after, before.length + tagBytes.length);
    let text = new TextDecoder().decode(combined);
    let html = renderMarkdown(text);
    html = html.replace(
      CLOZE_TAG,
      `<span class='cloze-reveal'>${deletedHtml}</span>`
    );
    html = rewriteImageUrls(html, card.filePath);
    return `<div class="rich-text">${html}</div>`;
  }
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
