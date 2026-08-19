// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  adoptLegacySyncTimestamp,
  formatSyncAge,
  getLastPushedAt,
  getLastSyncedAt,
  recordSyncSuccess,
} from "./sync-state";

describe("formatSyncAge", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it("collapses the last minute or so into 'just now'", () => {
    expect(formatSyncAge(ago(0), now)).toBe("just now");
    expect(formatSyncAge(ago(80 * SECOND), now)).toBe("just now");
  });

  it("reports minutes, hours and days", () => {
    expect(formatSyncAge(ago(5 * MINUTE), now)).toBe("5 minutes ago");
    expect(formatSyncAge(ago(3 * HOUR), now)).toBe("3 hours ago");
    expect(formatSyncAge(ago(4 * DAY), now)).toBe("4 days ago");
  });

  it("singularizes", () => {
    expect(formatSyncAge(ago(2 * MINUTE), now)).toBe("2 minutes ago");
    expect(formatSyncAge(ago(1 * HOUR), now)).toBe("1 hour ago");
    expect(formatSyncAge(ago(1 * DAY), now)).toBe("1 day ago");
  });

  // A device whose clock is behind the one that wrote the timestamp would
  // otherwise render "-3 minutes ago".
  it("never reports a sync in the future", () => {
    expect(formatSyncAge(ago(-10 * MINUTE), now)).toBe("just now");
  });
});

describe("when state was last known to be on GitHub", () => {
  it("is not advanced by a sync that pushed nothing", () => {
    localStorage.clear();
    recordSyncSuccess(false, "2026-08-19T10:00:00.000Z");

    // The deck list may say "synced just now" — a pull is a sync — but nothing
    // may claim the reviews on this device are safe, because they are not.
    expect(getLastSyncedAt()).toBe("2026-08-19T10:00:00.000Z");
    expect(getLastPushedAt()).toBeNull();
  });

  it("adopts the old single timestamp, so an upgrade does not open on a warning", () => {
    localStorage.clear();
    // An install from before the two were told apart. Its timestamp was only
    // ever written after a sync that pushed.
    localStorage.setItem("last_synced_at", "2026-08-18T09:00:00.000Z");

    adoptLegacySyncTimestamp();

    expect(getLastPushedAt()).toBe("2026-08-18T09:00:00.000Z");
  });

  it("leaves a fresh install with nothing to adopt", () => {
    localStorage.clear();
    adoptLegacySyncTimestamp();
    expect(getLastPushedAt()).toBeNull();
  });
});
