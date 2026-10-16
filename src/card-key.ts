/**
 * Card keys: what the review log calls a card (PLAN-1.0 §2.2).
 *
 * A card is its text (§2.7), so its key is its content hash, `h:` and the
 * first 16 hex digits. That is all a key is now.
 *
 * The first 1.0 builds also had `ID:` lines, and keys made from them
 * (`est-capital`, `est-capital:r`, `est-capital:2`). Those still appear in
 * logs written then, and a file that still has `ID:` lines tells the parser
 * which of them each card used to be (`legacyKey`), so the ID forms are kept
 * here for reading — nothing writes a new one.
 */

/** A card's key: its content hash (§2.7), shortened. */
export function hashKey(hash: string): string {
  return formatKey({ kind: "hash", hash });
}

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

/** How much of a hash an `h:` key keeps: 64 bits, plenty for one collection. */
const HASH_KEY_LENGTH = 16;

export type CardKey =
  | { kind: "basic"; id: string }
  | { kind: "reverse"; id: string }
  /** `n` is 1-based, in order of appearance in the block. */
  | { kind: "cloze"; id: string; n: number }
  /** A card's content hash (or, in logs from before §2.7, its v1 hash), shortened. */
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

/**
 * A key as the app holds it locally: always `owner/repo/<key>`.
 *
 * A review log names a card relative to the collection it belongs to — your
 * own cards bare (`est-capital`), a subscribed collection's with its repo in
 * front. Read into one device that holds several collections, bare keys would
 * collide (two repos can each have an `est-capital`), so locally every key is
 * qualified by the log it came from. One that already names a repo keeps it.
 */
export function qualifyKey(log: string, key: string): string {
  return key.includes("/") || log === "" ? key : `${log}/${key}`;
}

/**
 * The inverse, for writing: a qualified key as the log of `log` spells it.
 * Bare when the card is that collection's own, qualified otherwise.
 */
export function keyInLog(log: string, qualified: string): string {
  return log !== "" && qualified.startsWith(`${log}/`)
    ? qualified.slice(log.length + 1)
    : qualified;
}

/**
 * What the app calls a card locally: `owner/repo/<key>`.
 *
 * The key alone (`est-capital`, `h:…`) is only unique within one collection,
 * and a device holds several. A card cached before keys existed has none, so
 * it falls back to the `h:` key its hash gives — exactly what the parser would
 * have produced for it, since a card from then had no ID.
 */
export function stateKey(card: { repo: string; key: string; hash: string }): string {
  const key = card.key || formatKey({ kind: "hash", hash: card.hash });
  return card.repo === "" ? key : `${card.repo}/${key}`;
}

/**
 * Keys `card` had before PLAN-1.0 §2.7, which its history may still be filed
 * under: the one its legacy `ID:` line gave it, and the `h:` key of its v1
 * hash, which is what it was before 1.0. Readers of the log treat both as
 * linked to the card's key until real links are written.
 */
export function formerKeys(card: { key: string; hash: string; legacyKey: string | null }): string[] {
  if (!card.key) return [];
  const keys = [card.legacyKey, formatKey({ kind: "hash", hash: card.hash })];
  return keys.filter((k): k is string => k !== null && k !== card.key);
}
