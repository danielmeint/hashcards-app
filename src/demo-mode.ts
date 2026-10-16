/**
 * Demo mode: the whole app, on the starter decks, with nothing kept.
 *
 * The demo runs the real views, the real drill and the real scheduler, so what
 * a visitor tries is the app and not a mock of it. What it must never do is
 * touch anything real: someone who already uses hashcards on this origin and
 * opens `#demo` must find their collection exactly as they left it. So the
 * three things the app persists through are swapped out before anything else
 * runs, here, in one place:
 *
 * - **localStorage** (`settings.ts`) becomes a `Map` in memory.
 * - **IndexedDB** (`db.ts`) becomes a database of its own, named afresh for
 *   each demo session, so it never shares a store with the real one — or with
 *   another demo tab — and a reload starts from nothing.
 * - **GitHub** (`github.ts`) becomes the files below. Reading, writing and
 *   deleting a deck work on them; any other API call refuses, so a code path
 *   that forgot about the demo fails loudly instead of reaching a real repo.
 *
 * This module is deliberately tiny and imports nothing: `settings.ts` and
 * `db.ts` sit under everything else, and both ask it which world they are in.
 */

let active = false;

export function isDemo(): boolean {
  return active;
}

// --- localStorage ---------------------------------------------------------------

type KeyValue = Pick<Storage, "getItem" | "setItem" | "removeItem">;

let memory: Map<string, string> | null = null;

const memoryStore: KeyValue = {
  getItem: (key) => memory?.get(key) ?? null,
  setItem: (key, value) => void memory?.set(key, String(value)),
  removeItem: (key) => void memory?.delete(key),
};

/** Where settings are kept: the browser's storage, or the demo's memory. */
export function keyValueStore(): KeyValue {
  return memory ? memoryStore : localStorage;
}

/**
 * Device preferences the demo starts from, copied from the real install and
 * never written back. Someone with a dark theme should not get a light demo,
 * and switching the demo to light must not switch them.
 */
const BORROWED_KEYS = ["theme", "haptic_feedback"];

// --- IndexedDB ------------------------------------------------------------------

export const REAL_DB = "hashcards";
const DEMO_DB_PREFIX = "hashcards-demo-";

let dbName = REAL_DB;

export function databaseName(): string {
  return dbName;
}

/**
 * Demo databases from earlier sessions, deleted in the background. A tab
 * still running one keeps it until it closes: a delete waits for open
 * connections, so this never pulls a store out from under a live demo.
 */
async function forgetEarlierDemos(current: string): Promise<void> {
  if (typeof indexedDB === "undefined" || !indexedDB.databases) return;
  try {
    for (const { name } of await indexedDB.databases()) {
      if (name?.startsWith(DEMO_DB_PREFIX) && name !== current) indexedDB.deleteDatabase(name);
    }
  } catch {
    // Housekeeping only; an old demo database left behind costs a few KB.
  }
}

// --- GitHub ---------------------------------------------------------------------

export type DemoFile = { text: string; sha: string };

const files = new Map<string, DemoFile>();
let shas = 0;

/**
 * The repository the demo stands in for: the template its decks are published
 * as. Only ever a name here — nothing is fetched from it — but it is the right
 * one, so a "view on GitHub" link from the demo lands on the real file.
 */
export const DEMO_REPO = { owner: "danielmeint", repo: "hashcards-starter", branch: "main" };

/**
 * The demo's repository: a path → text map with the one rule of the real
 * contents API the app relies on, that a write based on a stale SHA is refused
 * rather than overwriting what changed. A refusal is `null` / `false` here;
 * `github.ts` turns it into the `ConflictError` a real one would be.
 */
export const demoFiles = {
  list(): string[] {
    return [...files.keys()].sort();
  },
  read(path: string): DemoFile | null {
    return files.get(path) ?? null;
  },
  /** Write `text` at `path` on top of `sha` (none for a new file); its new SHA. */
  write(path: string, text: string, sha?: string): string | null {
    if (files.get(path)?.sha !== sha) return null;
    const next = `demo-${++shas}`;
    files.set(path, { text, sha: next });
    return next;
  },
  remove(path: string, sha: string): boolean {
    if (files.get(path)?.sha !== sha) return false;
    files.delete(path);
    return true;
  },
};

// --- Entering it ----------------------------------------------------------------

/**
 * Switch this page into the demo, before anything has read a setting or
 * opened the database. There is no way back short of a reload: modules cache
 * what they read, and a page that had been both would be neither.
 */
export function enterDemo(seed: Record<string, string>): void {
  if (active) return;
  active = true;

  memory = new Map();
  for (const key of BORROWED_KEYS) {
    let value: string | null = null;
    try {
      value = localStorage.getItem(key);
    } catch {
      // Storage blocked: the demo runs on defaults.
    }
    if (value !== null) memory.set(key, value);
  }

  dbName = `${DEMO_DB_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  void forgetEarlierDemos(dbName);

  files.clear();
  for (const [path, text] of Object.entries(seed)) demoFiles.write(path, text);
}

/** The thrown error for any GitHub call the demo has no answer for. */
export class DemoOfflineError extends Error {
  constructor() {
    super("The demo never talks to GitHub.");
  }
}
