import { Review } from "./types";
import { GitHubConfig, readFileIfPresent, repoKey, writeFile } from "./github";
import { getAllOrigins, getAllReviews, getMeta, setMeta } from "./db";
import { localDay } from "./fsrs";
import { settings } from "./settings";

/**
 * Every graded review, kept in the repository alongside the cards.
 *
 * The state file holds where each card *is*: its latest stability, difficulty
 * and due date. Fitting FSRS's parameters to a person needs where each card
 * *has been* — every grade, and when — and that used to live only in the
 * IndexedDB of the device that recorded it, split across phones and gone with
 * a reinstall.
 *
 * Each device writes its own files, one per month:
 *
 *     hashcards-reviews/2026-10.<device>.jsonl
 *
 * so no two devices ever write the same file and there is nothing to merge.
 * A file is rebuilt from the local log rather than appended to, which makes a
 * push idempotent and lets an undo that happens before it simply never appear.
 * Past months stop changing, so a sync touches at most the current one.
 */

export const REVIEW_LOG_DIR = "hashcards-reviews";

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

/** One review as a line of the log. Short keys: these files only grow. */
export function logLine(review: Review): string {
  return JSON.stringify({
    card: review.cardHash,
    at: review.reviewedAt,
    grade: review.grade,
    s: review.stability,
    d: review.difficulty,
    ...(review.durationMs !== undefined ? { ms: review.durationMs } : {}),
  });
}

/** `YYYY-MM` of a review, in local time like every other day in the app. */
function monthOf(review: Review): string {
  return localDay(new Date(review.reviewedAt)).slice(0, 7);
}

const pushedKey = (repo: string, month: string) =>
  `review_log:${repo}:${month}`;

/**
 * Bring this device's log files in `config` in line with its local reviews of
 * that collection's cards. `holds` is the set of card hashes the collection has
 * now; a review also belongs to it when its card was last seen there, the same
 * rule the state file uses, so a card that has since been edited or moved
 * keeps its history.
 */
export async function pushReviewLog(
  config: GitHubConfig,
  holds: Set<string>
): Promise<void> {
  const key = repoKey(config);
  const origins = await getAllOrigins();
  const mine = (await getAllReviews()).filter(
    (r) => holds.has(r.cardHash) || origins.get(r.cardHash) === key
  );

  const byMonth = new Map<string, Review[]>();
  for (const review of mine) {
    const month = monthOf(review);
    byMonth.set(month, [...(byMonth.get(month) ?? []), review]);
  }

  const device = deviceId();
  for (const [month, reviews] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
    reviews.sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
    const text = reviews.map(logLine).join("\n") + "\n";
    // What this device last wrote there. Nothing new since means no request.
    if ((await getMeta<string>(pushedKey(key, month))) === text) continue;

    const path = `${REVIEW_LOG_DIR}/${month}.${device}.jsonl`;
    const existing = await readFileIfPresent(config, path);
    if (existing?.text !== text) {
      await writeFile(config, path, text, {
        sha: existing?.sha,
        message: `Log reviews for ${month}`,
      });
    }
    await setMeta(pushedKey(key, month), text);
  }
}
