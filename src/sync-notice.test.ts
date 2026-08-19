// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { STALE_AFTER_MS, syncNotice } from "./sync-notice";

/**
 * Sync failures used to go into `console.warn`. An expired credential produced
 * an app that kept accepting reviews indefinitely with nothing reaching GitHub
 * and no indication anything was wrong — you found out by opening another
 * device and finding weeks missing.
 *
 * The line these draw: reviews are durable locally the moment they are graded,
 * so *not yet synced* is not an emergency. Not synced for a day, while reviews
 * accumulate, is.
 */

const NOW = Date.parse("2026-08-19T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const facts = (over: Partial<Parameters<typeof syncNotice>[0]> = {}) =>
  syncNotice({
    status: { phase: "idle" },
    lastSyncedAt: ago(2 * MINUTE),
    lastPushedAt: ago(2 * MINUTE),
    unsyncedReviews: 0,
    online: true,
    now: NOW,
    ...over,
  });

describe("what the deck list says about sync", () => {
  it("says nothing before the first sync", () => {
    expect(facts({ lastSyncedAt: null, lastPushedAt: null })).toBeNull();
  });

  it("reports a healthy sync quietly", () => {
    expect(facts()).toMatchObject({ level: "info", action: null });
    expect(facts()!.text).toBe("Synced 2 minutes ago");
  });

  it("stays quiet about reviews that are merely recent", () => {
    // Graded a minute ago and not yet pushed. Nothing is wrong; the next drill
    // or the next reconnect will carry them.
    const notice = facts({ unsyncedReviews: 4, lastPushedAt: ago(3 * MINUTE) });
    expect(notice).toMatchObject({ level: "info", action: null });
  });

  it("escalates once reviews have been owed for a day", () => {
    const notice = facts({
      unsyncedReviews: 23,
      lastPushedAt: ago(STALE_AFTER_MS + HOUR),
      lastSyncedAt: ago(STALE_AFTER_MS + HOUR),
    });
    expect(notice).toMatchObject({ level: "warn", action: "retry" });
    // The count is the point. "Synced 25 hours ago" reads as a caption;
    // "23 reviews haven't reached GitHub" reads as a problem.
    expect(notice!.text).toContain("23 reviews");
  });

  it("does not warn when nothing is owed, however old the sync", () => {
    // Away for a week without drilling. There is nothing at risk.
    expect(
      facts({ unsyncedReviews: 0, lastPushedAt: ago(7 * 24 * HOUR), lastSyncedAt: ago(7 * 24 * HOUR) })
    ).toMatchObject({ level: "info", action: null });
  });

  it("treats never having pushed as maximally stale", () => {
    const notice = facts({
      unsyncedReviews: 12,
      lastPushedAt: null,
      lastSyncedAt: ago(MINUTE),
    });
    expect(notice).toMatchObject({ level: "warn" });
    expect(notice!.text).toContain("never");
  });

  it("reassures rather than alarms when offline", () => {
    const notice = facts({ unsyncedReviews: 9, online: false, lastPushedAt: ago(48 * HOUR) });
    // Drilling on a train is the normal case, not a fault, and the app knows
    // the reviews are owed.
    expect(notice).toMatchObject({ level: "info", action: null });
    expect(notice!.text).toContain("when you reconnect");
  });

  it("offers a way back in when the credential is gone", () => {
    const notice = facts({
      status: { phase: "error", message: "Your GitHub sign-in has expired.", needsSignIn: true },
      unsyncedReviews: 7,
    });
    // Not "Try again": retrying a refused credential fails identically, and a
    // button that cannot work is worse than no button.
    expect(notice).toMatchObject({ level: "error", action: "sign-in" });
    expect(notice!.text).toContain("7 reviews");
  });

  it("offers a retry for a failure that might be transient", () => {
    expect(
      facts({ status: { phase: "error", message: "GitHub API error: 500", needsSignIn: false } })
    ).toMatchObject({ level: "error", action: "retry" });
  });

  it("shows progress while syncing", () => {
    expect(
      facts({ status: { phase: "syncing", detail: "Fetching files (2/5)" } })
    ).toMatchObject({ level: "info", action: null });
  });
});
