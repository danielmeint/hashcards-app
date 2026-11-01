import { globMatch, globProblem } from "./glob";

/**
 * New-card limits for groups of decks, `[limits.<name>]` in `hashcards.toml`:
 *
 *     [limits.interview]
 *     decks = ["interview/**"]
 *     new_per_day = 5
 *
 * A deck belongs to the first group whose globs match its path (in file
 * order), or to none. A new card is introduced only while its group has
 * budget left *and* the collection's `[review] new_per_day` does, as a
 * subdeck's limit sits under its parent's in Anki. What a group has spent is
 * its cards started today, from the review log, so every device agrees.
 *
 * Shared by the app and `hc`, so the two read a group and pick new cards the
 * same way.
 */

export type NewCardLimit = {
  name: string;
  /** Globs over deck paths (`core/glob.ts`). */
  decks: string[];
  newPerDay: number;
};

const KEYS = new Set(["decks", "new_per_day"]);

/**
 * One `[limits.<name>]` table. A group with something wrong in it is not used
 * (its decks fall back to the collection's budget alone) and `problems` says
 * why; an unknown key is reported but does not stop the group.
 */
export function readLimit(
  name: string,
  table: Record<string, unknown>
): { limit: NewCardLimit | null; problems: string[] } {
  const problems: string[] = [];
  const at = `[limits.${name}]`;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return { limit: null, problems: [`${at}: a group's name is letters, digits, '_' and '-'`] };
  }
  for (const key of Object.keys(table)) {
    if (!KEYS.has(key)) problems.push(`${at} has no key '${key}': only decks and new_per_day`);
  }

  let ok = true;
  const decks = table.decks;
  if (decks === undefined) {
    problems.push(`${at} needs decks, a list of globs`);
    ok = false;
  } else if (!Array.isArray(decks) || decks.length === 0 || !decks.every((d) => typeof d === "string")) {
    problems.push(`${at} decks must be a non-empty array of glob strings, got ${JSON.stringify(decks)}`);
    ok = false;
  } else {
    for (const glob of decks as string[]) {
      const problem = globProblem(glob);
      if (problem) {
        problems.push(`${at} decks: ${problem}`);
        ok = false;
      }
    }
  }

  const perDay = table.new_per_day;
  if (perDay === undefined) {
    problems.push(`${at} needs new_per_day, a whole number ≥ 0`);
    ok = false;
  } else if (typeof perDay !== "number" || !Number.isInteger(perDay) || perDay < 0) {
    problems.push(`${at} new_per_day must be a whole number ≥ 0, got ${JSON.stringify(perDay)}`);
    ok = false;
  }

  return {
    limit: ok ? { name, decks: decks as string[], newPerDay: perDay as number } : null,
    problems,
  };
}

/** The group a deck at `path` belongs to: the first that matches it. */
export function limitFor(path: string, limits: readonly NewCardLimit[]): NewCardLimit | null {
  return limits.find((limit) => limit.decks.some((glob) => globMatch(glob, path))) ?? null;
}

/** What today's new cards may still use: the collection's budget and each group's. */
export type NewCardBudget = {
  total: number;
  /** Group name → its budget left. A deck in no group has only `total`. */
  byLimit: Map<string, number>;
  limits: readonly NewCardLimit[];
};

/**
 * The budget left after the cards already started today. `started` holds one
 * deck path per started card, or null for a card no deck has any more (it
 * still counts against the collection's budget, and against no group).
 */
export function newCardBudget(
  perDay: number,
  limits: readonly NewCardLimit[],
  started: Iterable<string | null>
): NewCardBudget {
  const spent = new Map<string, number>();
  let total = 0;
  for (const path of started) {
    total++;
    const limit = path === null ? null : limitFor(path, limits);
    if (limit) spent.set(limit.name, (spent.get(limit.name) ?? 0) + 1);
  }
  return {
    total: Math.max(0, perDay - total),
    byLimit: new Map(limits.map((l) => [l.name, Math.max(0, l.newPerDay - (spent.get(l.name) ?? 0))])),
    limits,
  };
}

/** How many new cards a deck at `path` may still introduce today. */
export function budgetFor(path: string, budget: NewCardBudget): number {
  const limit = limitFor(path, budget.limits);
  return limit ? Math.min(budget.total, budget.byLimit.get(limit.name) ?? 0) : budget.total;
}

/**
 * The new cards to introduce, in the order given: each while both its
 * group's budget and the collection's last. A full group skips only its own
 * cards, so later decks still fill what the collection allows.
 */
export function pickNew<T>(unseen: readonly T[], pathOf: (card: T) => string, budget: NewCardBudget): T[] {
  let total = budget.total;
  const byLimit = new Map(budget.byLimit);
  const picked: T[] = [];
  for (const card of unseen) {
    if (total <= 0) break;
    const limit = limitFor(pathOf(card), budget.limits);
    if (limit) {
      const left = byLimit.get(limit.name) ?? 0;
      if (left <= 0) continue;
      byLimit.set(limit.name, left - 1);
    }
    total--;
    picked.push(card);
  }
  return picked;
}
