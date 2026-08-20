import { getRepos } from "./github";
import { syncEverything } from "./sync";
import { getLastSyncedAt, getSyncStatus } from "./sync-state";

/**
 * Keeps trying, so a failed push is not a failure that lasts until the next
 * cold open.
 *
 * Before this the only triggers were launching the app, finishing a drill, and
 * pressing the button. Drill on a train and the push is skipped outright — the
 * drill's own sync is guarded on `navigator.onLine` — and nothing remembers it
 * was owed. Reconnecting, or coming back to a backgrounded tab, did nothing at
 * all. Both are the moments a sync is most likely to work and most likely to be
 * wanted.
 *
 * There is no timer here on purpose: a backgrounded PWA does not run them
 * reliably, so a retry loop built on one is a retry loop that mostly does not
 * happen. These two events are what actually fire.
 */

/** How stale a sync must be before merely looking at the app retries it. */
export const REVISIT_AFTER_MS = 5 * 60_000;

export function startAutoSync(): () => void {
  // Reconnecting is worth a sync unconditionally. Returning to the tab is only
  // worth one if something is actually outstanding, or it would fire on every
  // app switch.
  const onOnline = () => attempt(true);
  const onVisible = () => {
    if (document.visibilityState === "visible") attempt(false);
  };

  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

function attempt(force: boolean): void {
  if (getRepos().length === 0 || !navigator.onLine) return;
  if (!force && !outstanding()) return;
  // Fire and forget: sync single-flights, reports through `sync-state`, and
  // resolves false rather than rejecting.
  void syncEverything();
}

function outstanding(): boolean {
  const status = getSyncStatus();
  // A signed-out app cannot fix itself by trying again.
  if (status.phase === "error") return !status.needsSignIn;
  if (status.phase === "syncing") return false;
  const last = getLastSyncedAt();
  return !last || Date.now() - new Date(last).getTime() > REVISIT_AFTER_MS;
}
