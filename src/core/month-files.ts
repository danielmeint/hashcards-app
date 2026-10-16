import { ReviewLogEvent, fallbackTz, serializeFile } from "./events";
import { compareEvents } from "./replay";
import { dayAt } from "./schedule";

/**
 * How events are filed on the `hashcards-data` branch (PLAN-1.0 §2.3):
 *
 *     reviews/2026-10.<device>.jsonl
 *
 * One file per writer per month, so no two writers ever touch the same file
 * and there is nothing to merge. The app (`review-log.ts`), `hc migrate` and
 * `hc import anki` all file events through here, which is what keeps their
 * files readable by each other.
 *
 * A device's name is the eight hex digits `deviceId()` makes. Tools that write
 * history on a collection's behalf use names no device can have, so that no
 * device ever mistakes their files for its own (a device rebuilds its own
 * files from its local log, and would overwrite them):
 */

/** `hc migrate`: the v1 state file and review logs, carried over. */
export const MIGRATED_DEVICE = "v1";
/** `hc import anki`: the Anki collection's review log. */
export const ANKI_DEVICE = "anki";
/**
 * `hc migrate` and `hc relink`: the `link` events they write (PLAN-1.0 §2.7).
 * Unlike the others, appended to: each run adds to the month's file.
 */
export const HC_DEVICE = "hc";

/** Where the data branch keeps review files. */
export const REVIEWS_DIR = "reviews";

/**
 * The month an event is filed under: its local month, in the timezone it was
 * recorded in, so the same event lands in the same file whichever device
 * writes it.
 */
export function monthOf(event: ReviewLogEvent): string {
  return dayAt(event.at, event.tz ?? fallbackTz(event.at)).slice(0, 7);
}

export function monthFilePath(month: string, device: string): string {
  return `${REVIEWS_DIR}/${month}.${device}.jsonl`;
}

/** A device's file name, or null for anything that is not one. */
export function parseMonthFilePath(path: string): { month: string; device: string } | null {
  const m = /^reviews\/(\d{4}-\d{2})\.([^/]+)\.jsonl$/.exec(path);
  return m ? { month: m[1], device: m[2] } : null;
}

/** One writer's events, grouped into the files they belong in, in replay order. */
export function monthFiles(
  events: readonly ReviewLogEvent[],
  device: string
): Map<string, string> {
  const byMonth = new Map<string, ReviewLogEvent[]>();
  for (const event of events) {
    const month = monthOf(event);
    const list = byMonth.get(month);
    if (list) list.push(event);
    else byMonth.set(month, [event]);
  }
  const files = new Map<string, string>();
  for (const month of [...byMonth.keys()].sort()) {
    const sorted = [...byMonth.get(month)!].sort(compareEvents);
    files.set(monthFilePath(month, device), serializeFile(sorted));
  }
  return files;
}
