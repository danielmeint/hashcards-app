import type { Theme } from "./theme";

/**
 * Everything this app keeps in `localStorage`, in one place.
 *
 * There were nine keys, named by string literal at each use, spread across
 * `github.ts`, `theme.ts`, `new-card-budget.ts` and `sync-state.ts` — with
 * `render.ts` reading three of them a second time, on its own, with different
 * defaults. Nothing validated a value and nothing could migrate one.
 *
 * Each setting owns its key, its default and how it survives a round trip
 * through a string. The accessors elsewhere stay where they are and delegate
 * here: this is about there being one definition of `github_branch`, not about
 * every caller learning a new API.
 *
 * IndexedDB holds everything larger — cards, reviews, credentials, the tree
 * ETag. The rule is that `localStorage` holds what must be readable
 * synchronously during the first paint, and nothing else.
 */

type Codec<T> = {
  read(raw: string | null): T;
  /** The string to store, or `null` to remove the key entirely. */
  write(value: T): string | null;
};

export type Setting<T> = {
  get(): T;
  set(value: T): void;
  remove(): void;
};

function setting<T>(key: string, codec: Codec<T>): Setting<T> {
  return {
    get: () => codec.read(localStorage.getItem(key)),
    set: (value) => {
      const raw = codec.write(value);
      if (raw === null) localStorage.removeItem(key);
      else localStorage.setItem(key, raw);
    },
    remove: () => localStorage.removeItem(key),
  };
}

const text = (fallback: string): Codec<string> => ({
  read: (raw) => raw ?? fallback,
  write: (value) => value,
});

const optionalText: Codec<string | null> = {
  read: (raw) => raw,
  write: (value) => value,
};

/** Absent means the default; only the exact string `"false"` means off. */
const flag = (fallback: boolean): Codec<boolean> => ({
  read: (raw) => (raw === null ? fallback : raw !== "false"),
  write: (value) => String(value),
});

const count = (fallback: number): Codec<number> => ({
  // A corrupt value used to parse to NaN and travel: `remainingBudget` became
  // NaN, and the deck list quietly offered no new cards at all.
  read: (raw) => {
    const parsed = parseInt(raw ?? "", 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  },
  write: (value) => String(value),
});

function json<T>(fallback: T): Codec<T> {
  return {
    read: (raw) => {
      if (raw === null) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    },
    write: (value) => JSON.stringify(value),
  };
}

/** "system" is the absence of a choice, so it is stored as the absence of a key. */
const theme: Codec<Theme> = {
  read: (raw) => (raw === "light" || raw === "dark" ? raw : "system"),
  write: (value) => (value === "system" ? null : value),
};

/** New cards charged against today's budget, and the day that was. */
export type IntroducedToday = { date: string; count: number };

export const settings = {
  owner: setting("github_owner", text("")),
  repo: setting("github_repo", text("")),
  branch: setting("github_branch", text("main")),
  newCardsPerDay: setting("new_cards_per_day", count(20)),
  introducedToday: setting(
    "new_cards_introduced",
    json<IntroducedToday | null>(null)
  ),
  intervalFuzz: setting("interval_fuzz", flag(true)),
  hapticFeedback: setting("haptic_feedback", flag(true)),
  theme: setting("theme", theme),
  /** The deck quick capture offers first — where the last card went. */
  lastDeckPath: setting("last_deck_path", optionalText),
  lastSyncedAt: setting("last_synced_at", optionalText),
  lastPushedAt: setting("last_pushed_at", optionalText),
};

/**
 * Keys that exist only to be migrated away from. Listed here so that "what does
 * this app keep in localStorage" has one honest answer, including the parts it
 * is in the middle of leaving behind.
 */
export const legacy = {
  /** The pasted token, before sign-in replaced it (4.1). */
  pat: setting("github_pat", optionalText),
  /** The 5 MB card blob, before the deck store replaced it (2.4). */
  cards: setting("cached_cards", optionalText),
};
