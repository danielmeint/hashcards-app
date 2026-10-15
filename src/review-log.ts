import { Card, Review } from "./types";
import { GitHubConfig, getRepos, readFileIfPresent, repoKey, writeFile } from "./github";
import { getAllReviews, getMeta, groupOf, markV1Pushed, setMeta, stateKey } from "./db";
import { keyInLog } from "./card-key";
import { ReviewEvent } from "./core/events";
import { settings } from "./settings";
import {
  REVIEWS_DIR,
  monthFilePath,
  monthFiles,
  monthOf,
  parseMonthFilePath,
} from "./core/month-files";
import { REVIEW_LOG_DIR, logLine, v1MonthOf, v1PushedKey } from "./v1-log";

/**
 * Every graded review, kept in the repository: since M3, the source of truth
 * that every card's state is replayed from (PLAN-1.0 §2.4).
 *
 * Each device writes its own files, one per month, on the collection's
 * `hashcards-data` branch:
 *
 *     reviews/2026-10.<device>.jsonl
 *
 * so no two devices ever write the same file and there is nothing to merge.
 * A file is rebuilt from the local log rather than appended to, which makes a
 * push idempotent and lets an undo that happens before it simply never appear
 * — and one after it rewrite the file without that line. Past months stop
 * changing, so a push touches at most the current one.
 *
 * A collection not yet migrated (M4) still gets the v1 files it always had,
 * under `hashcards-reviews/` on its main branch, from `pushReviewLog` below.
 */

export { REVIEW_LOG_DIR, logLine };

// Filing events into month files is shared with `hc`, so it lives in core.
export { REVIEWS_DIR, monthOf, monthFilePath, parseMonthFilePath, monthFiles };

/** A short random name for this device, made once and kept. */
export function deviceId(): string {
  let id = settings.deviceId.get();
  if (!id) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    settings.deviceId.set(id);
  }
  return id;
}

/** Where a grade of `card` is recorded, and what it is called there. */
export type LogTarget = {
  /** `stateKey(card)`: what the app calls it locally. */
  key: string;
  /** The collection whose log it goes in; empty for "this device only". */
  log: string;
  /** The key as that log spells it. */
  card: string;
  /** Which replay it belongs to (`groupOf`). */
  group: string;
};

/**
 * Your own cards are logged in their own collection. A subscribed card is
 * logged in yours — the first collection you can write to — under its
 * qualified key, since you never write to someone else's repository. With
 * nothing writable at all, the review stays on this device.
 */
export function logTarget(card: Pick<Card, "repo" | "key" | "hash">): LogTarget {
  const key = stateKey(card);
  const repos = getRepos();
  const own = repos.find((r) => repoKey(r) === card.repo);
  const log =
    own && !own.readOnly
      ? card.repo
      : (() => {
          const mine = repos.find((r) => !r.readOnly);
          return mine ? repoKey(mine) : "";
        })();
  const inLog = keyInLog(log, key);
  return { key, log, card: inLog, group: groupOf(log, inLog) };
}

/** A recorded review as the v2 event it is. */
export function reviewEvent(review: Review): ReviewEvent {
  return {
    v: 2,
    kind: "review",
    card: keyInLog(review.log, review.key),
    at: review.reviewedAt,
    tz: review.tz,
    grade: review.grade,
    ...(review.durationMs !== undefined ? { ms: review.durationMs } : {}),
  };
}

// --- v1, for collections that have not been migrated -------------------------

/**
 * Bring this device's v1 log files in `config` in line with its reviews of
 * that collection's cards, exactly as before M3: same paths, same lines. Each
 * written review is marked, so that after migration the data branch does not
 * get it a second time.
 */
export async function pushReviewLog(config: GitHubConfig): Promise<void> {
  const key = repoKey(config);
  const mine = (await getAllReviews()).filter((r) => r.log === key);

  const byMonth = new Map<string, Review[]>();
  for (const review of mine) {
    const month = v1MonthOf(review);
    byMonth.set(month, [...(byMonth.get(month) ?? []), review]);
  }

  const device = deviceId();
  for (const [month, reviews] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
    reviews.sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
    const text = reviews.map(logLine).join("\n") + "\n";
    // What this device last wrote there. Nothing new since means no request.
    if ((await getMeta<string>(v1PushedKey(key, month))) === text) continue;

    const path = `${REVIEW_LOG_DIR}/${month}.${device}.jsonl`;
    const existing = await readFileIfPresent(config, path);
    if (existing?.text !== text) {
      await writeFile(config, path, text, {
        sha: existing?.sha,
        message: `Log reviews for ${month}`,
      });
    }
    await setMeta(v1PushedKey(key, month), text);
    await markV1Pushed(reviews);
  }
}
