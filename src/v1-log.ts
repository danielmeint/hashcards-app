import { Review } from "./types";
import { localDay } from "./fsrs";

/**
 * The v1 review log's line format, kept for collections that have not been
 * migrated yet (PLAN-1.0 M4). Until then the app keeps writing exactly what it
 * always wrote there, so a device still on an older version reads it as before.
 *
 * Its own module because both the writer (`review-log.ts`) and the database
 * upgrade (`db.ts`, which has to tell which reviews already reached a v1 log)
 * need it, and neither should import the other.
 */

export const REVIEW_LOG_DIR = "hashcards-reviews";

/** One review as a v1 line. Short keys: these files only grow. */
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

/** `YYYY-MM` of a review, in local time like every other day in v1. */
export function v1MonthOf(review: Review): string {
  return localDay(new Date(review.reviewedAt)).slice(0, 7);
}

/** Where `pushReviewLog` records what it last wrote to a month file. */
export const v1PushedKey = (repo: string, month: string) =>
  `review_log:${repo}:${month}`;
