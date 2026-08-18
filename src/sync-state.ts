/**
 * Sync used to run in front of the first paint, so its only progress channel
 * was the fact that you were still staring at a blank page. Now that it runs
 * behind the UI it needs somewhere to report from: the runner publishes here,
 * views subscribe.
 */

export type SyncStatus =
  | { phase: "idle" }
  | { phase: "syncing"; detail: string | null }
  | { phase: "error"; message: string };

const LS_LAST_SYNC = "last_synced_at";

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
  return localStorage.getItem(LS_LAST_SYNC);
}

export function recordSyncSuccess(at: string = new Date().toISOString()): void {
  localStorage.setItem(LS_LAST_SYNC, at);
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
