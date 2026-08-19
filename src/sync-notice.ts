import { SyncStatus, formatSyncAge } from "./sync-state";

/**
 * What the deck list should say about sync, in one pure function.
 *
 * The rule this encodes: reviews are durable locally the moment they are
 * graded, so a sync that has not happened yet is not an emergency — but one
 * that has not happened *for a day, while reviews pile up* is the failure this
 * app must never keep quiet about. You discover it otherwise by opening another
 * device and finding weeks missing.
 */

export type SyncNotice = {
  text: string;
  level: "info" | "warn" | "error";
  /** What the user can do about it, if anything. */
  action: "sign-in" | "retry" | null;
};

/** Past this, unpushed reviews stop being in flight and start being a problem. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type SyncFacts = {
  status: SyncStatus;
  lastSyncedAt: string | null;
  /** When review state was last known to be on GitHub. */
  lastPushedAt: string | null;
  /** Reviews recorded since then. */
  unsyncedReviews: number;
  online: boolean;
  now?: number;
};

const reviews = (n: number) => `${n} review${n === 1 ? "" : "s"}`;

export function syncNotice({
  status,
  lastSyncedAt,
  lastPushedAt,
  unsyncedReviews,
  online,
  now = Date.now(),
}: SyncFacts): SyncNotice | null {
  if (status.phase === "syncing") {
    return {
      text: status.detail ? `Syncing — ${status.detail.toLowerCase()}` : "Syncing…",
      level: "info",
      action: null,
    };
  }

  if (status.phase === "error") {
    // Retrying a refused credential fails identically, so don't offer it.
    if (status.needsSignIn) {
      return {
        text:
          unsyncedReviews > 0
            ? `Signed out of GitHub — ${reviews(unsyncedReviews)} not saved.`
            : "Signed out of GitHub.",
        level: "error",
        action: "sign-in",
      };
    }
    return { text: `Sync failed: ${status.message}`, level: "error", action: "retry" };
  }

  // Being offline is not a failure, and saying so is reassurance rather than
  // an alarm — the reviews are on the device and the app knows they are owed.
  if (!online && unsyncedReviews > 0) {
    return {
      text: `Offline — ${reviews(unsyncedReviews)} will sync when you reconnect.`,
      level: "info",
      action: null,
    };
  }

  if (unsyncedReviews > 0 && staleness(lastPushedAt, now) > STALE_AFTER_MS) {
    return {
      text: lastPushedAt
        ? `${reviews(unsyncedReviews)} haven't reached GitHub — last saved ${formatSyncAge(lastPushedAt, now)}.`
        : `${reviews(unsyncedReviews)} have never reached GitHub.`,
      level: "warn",
      action: "retry",
    };
  }

  return lastSyncedAt
    ? { text: `Synced ${formatSyncAge(lastSyncedAt, now)}`, level: "info", action: null }
    : null;
}

/** Never pushed at all counts as maximally stale. */
function staleness(lastPushedAt: string | null, now: number): number {
  if (!lastPushedAt) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - new Date(lastPushedAt).getTime());
}
