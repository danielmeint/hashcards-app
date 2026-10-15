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
  /** Inbox decisions queued and not yet committed (`inbox-queue.ts`). */
  pendingEdits?: number;
  /** When the oldest of them was made. */
  oldestEditAt?: string | null;
  online: boolean;
  now?: number;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const reviews = (n: number) => plural(n, "review");

/**
 * What is waiting on the device, in one phrase: "3 reviews", "2 Inbox
 * changes", or both. Inbox decisions are owed exactly as reviews are, and
 * someone who curated drafts on a train should be told so in the same breath.
 */
function owed(unsynced: number, edits: number): string {
  const parts = [
    ...(unsynced > 0 ? [reviews(unsynced)] : []),
    ...(edits > 0 ? [plural(edits, "Inbox change")] : []),
  ];
  return parts.join(" and ");
}

export function syncNotice({
  status,
  lastSyncedAt,
  lastPushedAt,
  unsyncedReviews,
  pendingEdits = 0,
  oldestEditAt = null,
  online,
  now = Date.now(),
}: SyncFacts): SyncNotice | null {
  const waiting = owed(unsyncedReviews, pendingEdits);
  const some = unsyncedReviews + pendingEdits;
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
        text: some > 0 ? `Signed out of GitHub — ${waiting} not saved.` : "Signed out of GitHub.",
        level: "error",
        action: "sign-in",
      };
    }
    return { text: `Sync failed: ${status.message}`, level: "error", action: "retry" };
  }

  // Being offline is not a failure, and saying so is reassurance rather than
  // an alarm — the reviews are on the device and the app knows they are owed.
  if (!online && some > 0) {
    return {
      text: `Offline — ${waiting} will sync when you reconnect.`,
      level: "info",
      action: null,
    };
  }

  if (unsyncedReviews > 0 && staleness(lastPushedAt, now) > STALE_AFTER_MS) {
    return {
      text: lastPushedAt
        ? `${waiting} haven't reached GitHub — last saved ${formatSyncAge(lastPushedAt, now)}.`
        : `${waiting} have never reached GitHub.`,
      level: "warn",
      action: "retry",
    };
  }
  // Measured from the decision itself: a change queued a minute ago is not
  // stale just because the last push of reviews was days back.
  if (pendingEdits > 0 && staleness(oldestEditAt, now) > STALE_AFTER_MS) {
    return {
      text: `${plural(pendingEdits, "Inbox change")} ${pendingEdits === 1 ? "hasn't" : "haven't"} reached GitHub.`,
      level: "warn",
      action: "retry",
    };
  }

  const synced = lastSyncedAt ? `Synced ${formatSyncAge(lastSyncedAt, now)}` : null;
  // A hint rides along with the ordinary line rather than replacing it: it is
  // not a reason to worry, only something to do sometime.
  const hint = status.phase === "idle" ? status.notice : undefined;
  if (hint) {
    return { text: synced ? `${synced} · ${hint}` : hint, level: "info", action: null };
  }
  return synced ? { text: synced, level: "info", action: null } : null;
}

/** Never pushed at all counts as maximally stale. */
function staleness(lastPushedAt: string | null, now: number): number {
  if (!lastPushedAt) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - new Date(lastPushedAt).getTime());
}
