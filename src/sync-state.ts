/**
 * Sync used to run in front of the first paint, so its only progress channel
 * was the fact that you were still staring at a blank page. Now that it runs
 * behind the UI it needs somewhere to report from: the runner publishes here,
 * views subscribe.
 */

import { settings } from "./settings";

export type SyncStatus =
  | { phase: "idle" }
  | { phase: "syncing"; detail: string | null }
  | {
      phase: "error";
      message: string;
      /**
       * The credential is gone or refused, so retrying will fail identically.
       * A view showing this should offer a way back in, not a Try again.
       */
      needsSignIn: boolean;
    };


let status: SyncStatus = { phase: "idle" };
const listeners = new Set<(status: SyncStatus) => void>();

export function getSyncStatus(): SyncStatus {
  return status;
}

export function setSyncStatus(next: SyncStatus): void {
  status = next;
  // Over a copy: a listener that re-renders its view resubscribes, and a Set
  // visits entries added during its own iteration — which is an infinite loop,
  // not a missed notification.
  for (const listener of [...listeners]) listener(status);
}

/** Subscribe to status changes. Returns an unsubscribe. */
export function onSyncStatus(listener: (status: SyncStatus) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLastSyncedAt(): string | null {
  return settings.lastSyncedAt.get();
}

/**
 * When review state was last known to be on GitHub — which is not the same
 * question as when a sync last succeeded. A sync that only pulls, or one that
 * declines to push, leaves this where it was, and that gap is what tells the
 * deck list there are reviews it should be worried about.
 */
export function getLastPushedAt(): string | null {
  return settings.lastPushedAt.get();
}

/**
 * Installs from before the two timestamps were told apart recorded only
 * `last_synced_at`, and it was written after a sync that did push. Adopt it.
 *
 * Called once at startup rather than lazily on read, because after the first
 * sync of a session the two are no longer distinguishable: a pull-only sync
 * writes `last_synced_at` too, and a lazy fallback would read that as proof of
 * a push that never happened. Skipping this instead opens an upgraded install
 * on a warning that every review it has ever taken is unsynced.
 */
export function adoptLegacySyncTimestamp(): void {
  if (settings.lastPushedAt.get() !== null) return;
  const legacy = settings.lastSyncedAt.get();
  if (legacy) settings.lastPushedAt.set(legacy);
}

export function recordSyncSuccess(
  inStepWithRemote: boolean,
  at: string = new Date().toISOString()
): void {
  settings.lastSyncedAt.set(at);
  if (inStepWithRemote) settings.lastPushedAt.set(at);
}

/**
 * Coarse on purpose. The question this answers is "is my review state safely on
 * GitHub?", and for that "2 hours ago" and "just now" are the only distinctions
 * that matter.
 */
export function formatSyncAge(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return "just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
