/**
 * Card IDs and the keys built from them (PLAN-1.0 §2.2).
 *
 * An ID is what a person or an agent writes in the file (`ID: est-capital`). A
 * key is what the review log refers to: one ID can name several cards — a
 * basic card and its reverse, or every deletion in a cloze block — so the key
 * says which of them. A card with no ID still needs a key, and falls back to
 * its v1 content hash, which is exactly as stable as v1 identity ever was.
 */

/**
 * Lowercase letters, digits and `-`, 2–64 long, not starting with `-`.
 *
 * No `:` and no `/`, which is what lets a key be split without escaping. The
 * two-character minimum is what keeps `h:` (the hash fallback) from ever
 * meaning an ID called `h`.
 */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** How much of the v1 hash an `h:` key keeps: 64 bits, plenty for one collection. */
const HASH_KEY_LENGTH = 16;

export type CardKey =
  | { kind: "basic"; id: string }
  | { kind: "reverse"; id: string }
  /** `n` is 1-based, in order of appearance in the block. */
  | { kind: "cloze"; id: string; n: number }
  /** A card with no ID: the first 16 hex digits of its v1 hash. */
  | { kind: "hash"; hash: string };

/**
 * The key as the review log writes it. `repo` (`owner/repo`) prefixes a card
 * from a subscribed collection, as it is recorded in *your* log.
 */
export function formatKey(key: CardKey, repo?: string): string {
  const local = (() => {
    switch (key.kind) {
      case "basic":
        return key.id;
      case "reverse":
        return `${key.id}:r`;
      case "cloze":
        return `${key.id}:${key.n}`;
      case "hash":
        return `h:${key.hash.slice(0, HASH_KEY_LENGTH)}`;
    }
  })();
  return repo ? `${repo}/${local}` : local;
}

/**
 * The inverse of `formatKey`, or null for anything it could not have written.
 * Strict on purpose: a key that does not parse is a corrupt log line, and
 * guessing at it would attach someone's reviews to the wrong card.
 */
export function parseKey(text: string): (CardKey & { repo?: string }) | null {
  let repo: string | undefined;
  let local = text;
  const slash = text.lastIndexOf("/");
  if (slash !== -1) {
    repo = text.slice(0, slash);
    local = text.slice(slash + 1);
    // `owner/repo`, exactly: neither half empty, no third segment.
    if (!/^[^/]+\/[^/]+$/.test(repo)) return null;
  }
  const withRepo = <T extends CardKey>(key: T) => (repo ? { ...key, repo } : key);

  const [head, suffix, ...rest] = local.split(":");
  if (rest.length > 0) return null;
  if (head === "h" && suffix !== undefined) {
    return new RegExp(`^[0-9a-f]{${HASH_KEY_LENGTH}}$`).test(suffix)
      ? withRepo({ kind: "hash", hash: suffix })
      : null;
  }
  if (!isValidId(head)) return null;
  if (suffix === undefined) return withRepo({ kind: "basic", id: head });
  if (suffix === "r") return withRepo({ kind: "reverse", id: head });
  if (/^[1-9][0-9]*$/.test(suffix)) {
    return withRepo({ kind: "cloze", id: head, n: Number(suffix) });
  }
  return null;
}
