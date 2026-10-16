/**
 * The time, as the rest of the world has it rather than as this device does.
 *
 * Review order is time order (`compareEvents`), and the gap between reviews is
 * what FSRS schedules from. A phone whose clock is a day fast dates its
 * reviews tomorrow: an honest device's review today then sorts *before* it,
 * and the card's schedule is computed from the wrong history on every device.
 *
 * So the app keeps the difference between its clock and the server's, measured
 * on every sync, and dates reviews, links and "today" by the corrected time. Its
 * own origin answers the question, because a same-origin response is the one
 * whose `Date` header a page may read; GitHub's API does not expose it.
 * Offline, the last difference measured still applies.
 *
 * This module only holds the offset; measuring and keeping it is the app's
 * (`clock-sync.ts`), so the CLI, which shares `fsrs.ts`, gets the plain clock.
 */

/** Below this, the gap is measurement noise (`Date` has whole seconds). */
export const SKEW_TOLERANCE_MS = 60_000;
/** Past this, the device's clock is worth mentioning, not just correcting. */
export const SKEW_NOTICE_MS = 5 * 60_000;

let offsetMs = 0;

/** The server's clock minus this device's, in ms. */
export function clockOffset(): number {
  return offsetMs;
}

export function setClockOffset(ms: number): void {
  offsetMs = Number.isFinite(ms) ? ms : 0;
}

/** Now, corrected. Use wherever a time is recorded or a day decided. */
export function now(): Date {
  return new Date(Date.now() + offsetMs);
}

/**
 * The offset to keep, given a server `Date` and when the request was sent and
 * answered by the device's clock: zero within the tolerance, so that a correct
 * clock is left exactly alone.
 */
export function offsetFrom(serverDate: string, sentAt: number, receivedAt: number): number | null {
  const server = Date.parse(serverDate);
  if (!Number.isFinite(server)) return null;
  // The header is truncated to the second; the midpoint is our best guess at
  // the instant it was stamped.
  const offset = server + 500 - (sentAt + receivedAt) / 2;
  return Math.abs(offset) < SKEW_TOLERANCE_MS ? 0 : Math.round(offset);
}

/** "fast by 26 hours", or null when the clock is close enough not to mention. */
export function skewNotice(offset: number = offsetMs): string | null {
  if (Math.abs(offset) < SKEW_NOTICE_MS) return null;
  const minutes = Math.round(Math.abs(offset) / 60_000);
  const amount =
    minutes < 90
      ? `${minutes} minutes`
      : minutes < 48 * 60
        ? `${Math.round(minutes / 60)} hours`
        : `${Math.round(minutes / 1440)} days`;
  // A positive offset means the server is ahead: the device is slow.
  return `This device's clock is ${offset > 0 ? "slow" : "fast"} by ${amount}; reviews are dated by the correct time.`;
}
