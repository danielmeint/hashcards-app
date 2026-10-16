import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFile as parseLog } from "../src/core/events";
import type { BaselineEvent, LinkEvent, ReviewLogEvent, ScheduleEvent } from "../src/core/events";
import { replay, resolveLinks } from "../src/core/replay";
import type { CardState } from "../src/core/replay";
import type { ParsedCard } from "../src/types";
import { formerKeys } from "../src/card-key";
import type { Config } from "./config";

/**
 * A card repo's review history, read with plain `git` and the file system.
 *
 * Two layouts, and the CLI reads both the same way:
 *
 * - **v2** (PLAN-1.0 §2.3): `reviews/*.jsonl` on the orphan `hashcards-data`
 *   branch, read with `git ls-tree` and `git show`. The branch need not be
 *   checked out — and in a fresh clone it exists only as
 *   `origin/hashcards-data`, which is read just the same.
 * - **v1**, until M4 migrates it: `hashcards-state.json` and
 *   `hashcards-reviews/*.jsonl` on the working tree. The state file says where
 *   each card *was* at its last review, so each entry becomes a `baseline`
 *   event; the log lines become v1 review events. Both are keyed by the v1
 *   content hash, mapped here to the card's key.
 *
 * A repo with a data branch is read from it alone, even if v1 files are still
 * on `main`: migration rewrites them onto the branch, and reading both would
 * apply every review twice. No branch and no v1 files is simply no history.
 */

export const DATA_BRANCH = "hashcards-data";
export const STATE_FILE = "hashcards-state.json";
export const V1_LOG_DIR = "hashcards-reviews";

export type HistorySource =
  | { kind: "data-branch"; ref: string; files: number }
  | { kind: "v1"; stateFile: boolean; files: number }
  | { kind: "none" };

export type History = {
  /**
   * Every event that schedules, under the key its card has now: v1 hashes
   * mapped to keys, and `link` events (PLAN-1.0 §2.7) applied and left out.
   */
  events: ScheduleEvent[];
  source: HistorySource;
  /** Lines and entries that could not be read. Never fatal. */
  warnings: string[];
};

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1 << 30,
    });
  } catch {
    return null;
  }
}

/**
 * The data branch's ref: the local one, or the remote's when there is no local
 * one or the local one is only behind it (devices push there, and a stale
 * local branch would read old history and build commits that cannot be
 * pushed). Null when there is neither.
 */
export function dataRef(repo: string): string | null {
  const local = `refs/heads/${DATA_BRANCH}`;
  const remote = `refs/remotes/origin/${DATA_BRANCH}`;
  const exists = (ref: string) => git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== null;
  const hasLocal = exists(local);
  const hasRemote = exists(remote);
  if (hasLocal && hasRemote) {
    const behind =
      git(repo, ["merge-base", "--is-ancestor", local, remote]) !== null &&
      git(repo, ["rev-parse", local]) !== git(repo, ["rev-parse", remote]);
    return behind ? remote : local;
  }
  return hasLocal ? local : hasRemote ? remote : null;
}

const V1_HASH = /^[0-9a-f]{64}$/;

/**
 * A card may have history under keys it no longer has (PLAN-1.0 §2.7): the
 * key its `ID:` line gave it, while files had them, and the `h:` key of its v1
 * hash. Until `hc migrate` writes links for real, those are links — dated at
 * the epoch, so any real link wins. The app does the same (`formerKeys`).
 */
export function legacyLinks(cards: readonly ParsedCard[]): LinkEvent[] {
  return cards.flatMap((card) =>
    formerKeys(card).map((from): LinkEvent => ({ v: 2, kind: "link", card: card.key, from, at: "1970-01-01T00:00:00.000Z" }))
  );
}

export function loadHistory(repo: string, cards: readonly ParsedCard[]): History {
  const raw = loadRawHistory(repo, cards);
  return { ...raw, events: resolveLinks([...raw.events, ...legacyLinks(cards)]) };
}

/** The history as the files have it: links not applied, legacy IDs not read. */
export function loadRawHistory(
  repo: string,
  cards: readonly ParsedCard[]
): Omit<History, "events"> & { events: ReviewLogEvent[] } {
  const warnings: string[] = [];
  // A v1 hash names a card by its content. The card's key is what replay and
  // every command use, so translate; a hash no card has any more keeps its
  // `h:` key, which is what its history would be filed under after migration.
  const byHash = new Map<string, string>();
  for (const card of cards) if (!byHash.has(card.hash)) byHash.set(card.hash, card.key);
  const keyOf = (card: string) =>
    V1_HASH.test(card) ? (byHash.get(card) ?? `h:${card.slice(0, 16)}`) : card;
  const rekey = <T extends ReviewLogEvent>(e: T): T => ({ ...e, card: keyOf(e.card) });

  const readLog = (name: string, text: string): ReviewLogEvent[] => {
    const { events, errors } = parseLog(text);
    for (const e of errors) warnings.push(`${name}:${e.line}: ${e.error}`);
    return events.map(rekey);
  };

  const ref = dataRef(repo);
  if (ref) {
    const listing = git(repo, ["ls-tree", "-r", "--name-only", "-z", ref, "--", "reviews"]) ?? "";
    const paths = listing.split("\0").filter((p) => p.endsWith(".jsonl"));
    const events = paths.flatMap((path) => {
      const text = git(repo, ["show", `${ref}:${path}`]);
      if (text === null) {
        warnings.push(`${DATA_BRANCH}:${path}: could not be read`);
        return [];
      }
      return readLog(`${DATA_BRANCH}:${path}`, text);
    });
    return { events, source: { kind: "data-branch", ref, files: paths.length }, warnings };
  }

  // v1: the log first, so baselines can borrow the grade of the review they
  // were taken at — the same-day rule needs to know whether it was a lapse.
  let logNames: string[] = [];
  try {
    logNames = readdirSync(join(repo, V1_LOG_DIR)).filter((n) => n.endsWith(".jsonl")).sort();
  } catch {
    // No log directory: a v1 repo from before the log existed, or not v1 at all.
  }
  const events = logNames.flatMap((name) =>
    readLog(`${V1_LOG_DIR}/${name}`, readFileSync(join(repo, V1_LOG_DIR, name), "utf8"))
  );

  let stateText: string | null = null;
  try {
    stateText = readFileSync(join(repo, STATE_FILE), "utf8");
  } catch {
    // No state file.
  }
  if (stateText !== null) {
    const gradeAt = new Map<string, 1 | 2 | 3 | 4>();
    for (const e of events) if (e.kind === "review") gradeAt.set(`${e.card} ${e.at}`, e.grade);
    events.push(...baselines(stateText, keyOf, gradeAt, warnings));
  }

  if (stateText === null && logNames.length === 0) {
    return { events: [], source: { kind: "none" }, warnings };
  }
  return {
    events,
    source: { kind: "v1", stateFile: stateText !== null, files: logNames.length },
    warnings,
  };
}

/** One baseline per `hashcards-state.json` entry. */
function baselines(
  text: string,
  keyOf: (card: string) => string,
  gradeAt: Map<string, 1 | 2 | 3 | 4>,
  warnings: string[]
): BaselineEvent[] {
  let state: { cards?: Record<string, Record<string, unknown>> };
  try {
    state = JSON.parse(text);
  } catch {
    warnings.push(`${STATE_FILE}: not valid JSON`);
    return [];
  }
  const out: BaselineEvent[] = [];
  for (const [hash, entry] of Object.entries(state.cards ?? {})) {
    const { lastReviewedAt: at, stability: s, difficulty: d, reviewCount: reps } = entry;
    const ok =
      V1_HASH.test(hash) &&
      typeof at === "string" &&
      Number.isFinite(Date.parse(at)) &&
      typeof s === "number" &&
      s > 0 &&
      typeof d === "number" &&
      d >= 1 &&
      d <= 10 &&
      typeof reps === "number";
    if (!ok) {
      warnings.push(`${STATE_FILE}: unreadable entry for ${hash.slice(0, 16)}`);
      continue;
    }
    const card = keyOf(hash);
    const grade = gradeAt.get(`${card} ${at}`);
    out.push({
      v: 2,
      kind: "baseline",
      card,
      at: at as string,
      s: s as number,
      d: d as number,
      reps: reps as number,
      ...(grade ? { grade } : {}),
      src: "v1",
    });
  }
  return out;
}

/** Every card's state after replaying the history under the repo's settings. */
export function replayHistory(history: History, config: Config): Map<string, CardState> {
  return replay(history.events, {
    retention: config.review.desiredRetention,
    fuzz: config.review.fuzz,
  });
}

/** Human description of where history came from. */
export function describeSource(source: HistorySource): string {
  switch (source.kind) {
    case "data-branch":
      return `${source.ref.replace(/^refs\/(heads|remotes)\//, "")} (${source.files} log files)`;
    case "v1":
      return `v1 ${source.stateFile ? STATE_FILE + " + " : ""}${source.files} ${V1_LOG_DIR} files`;
    case "none":
      return "no review history yet";
  }
}
