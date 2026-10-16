import { Card } from "./types";
import { getMedia } from "./db";

/**
 * Images and audio that cards point at (docs/history/ROADMAP.md 1.4).
 *
 * They used to be left to the browser: a relative `src` was rewritten to
 * `raw.githubusercontent.com` and fetched by the `<img>` itself. That host
 * wants authentication for a private repository, which an `<img>` cannot send,
 * and it is not there at all offline. Now sync fetches each file a card
 * references through the authenticated API and keeps the bytes, and a drill
 * turns them into object URLs before its first card is drawn — so rendering
 * stays synchronous and never touches the network.
 */

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
};

/** The media type a path's extension stands for, or null if it is not media. */
export function mediaType(path: string): string | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return TYPES[ext] ?? null;
}

export function isAudio(path: string): boolean {
  return mediaType(path)?.startsWith("audio/") ?? false;
}

/**
 * The repository path a card's `![](src)` refers to, or null when it is not in
 * the repository at all (a full URL, a data URI).
 *
 * Per the card format: `@/` is the repository root, anything else is relative
 * to the directory of the deck file holding the card.
 */
export function resolveMediaPath(src: string, filePath: string): string | null {
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) return null;

  let path: string;
  try {
    // Markdown hands over `my%20diagram.png` for a file named with a space.
    path = decodeURI(src);
  } catch {
    path = src;
  }

  let parts: string[];
  if (path.startsWith("@/")) parts = path.slice(2).split("/");
  else if (path.startsWith("/")) parts = path.slice(1).split("/");
  else parts = [...filePath.split("/").slice(0, -1), ...path.split("/")];

  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // Above the repository root is nowhere a sync could fetch from.
      if (resolved.length === 0) return null;
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.length > 0 ? resolved.join("/") : null;
}

/** Every repository path a card references media at. */
export function mediaRefs(card: Pick<Card, "content" | "filePath">): string[] {
  const text =
    card.content.type === "basic"
      ? `${card.content.question}\n${card.content.answer}`
      : card.content.text;
  const refs = new Set<string>();
  // `![alt](src "title")` — the src runs to the first space or close paren,
  // which is also where marked ends it. Angle-bracketed srcs may hold spaces.
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))/g)) {
    const path = resolveMediaPath(m[1] ?? m[2], card.filePath);
    if (path && mediaType(path)) refs.add(path);
  }
  return [...refs];
}

const urls = new Map<string, string>();
const key = (repo: string, path: string) => `${repo}\u0000${path}`;

/**
 * Object URLs for every stored file these cards reference, made before a drill
 * draws anything so that `mediaUrl` can answer synchronously.
 *
 * Kept for the life of the page rather than revoked per drill: a URL is a
 * handle on bytes already in memory, and the next drill most likely wants the
 * same ones.
 */
export async function prepareMedia(cards: Card[]): Promise<void> {
  const wanted = new Set<string>();
  const missing: [string, string][] = [];
  for (const card of cards) {
    for (const path of mediaRefs(card)) {
      const k = key(card.repo, path);
      if (urls.has(k) || wanted.has(k)) continue;
      wanted.add(k);
      missing.push([card.repo, path]);
    }
  }
  await Promise.all(
    missing.map(async ([repo, path]) => {
      const stored = await getMedia(repo, path);
      if (!stored) return;
      const blob = new Blob([stored.bytes], { type: stored.type });
      urls.set(key(repo, path), URL.createObjectURL(blob));
    })
  );
}

/** The local URL for a stored file, if `prepareMedia` found one. */
export function mediaUrl(repo: string, path: string): string | null {
  return urls.get(key(repo, path)) ?? null;
}

/** Drop a file's URL, for when sync has replaced or removed its bytes. */
export function forgetMediaUrl(repo: string, path: string): void {
  const k = key(repo, path);
  const url = urls.get(k);
  if (url) URL.revokeObjectURL(url);
  urls.delete(k);
}
