// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * A failed push used to wait for the next cold open. Drilling on a train skips
 * the push outright — the drill guards it on `navigator.onLine` — and nothing
 * remembered it was owed, so reconnecting did nothing at all.
 */

async function fresh() {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  const [autoSync, syncState, github, auth] = await Promise.all([
    import("./auto-sync"),
    import("./sync-state"),
    import("./github"),
    import("./auth"),
  ]);
  await auth.saveCredential({ kind: "pat", token: "t" });
  github.saveConfig({ owner: "me", repo: "cards", branch: "main" });
  return { ...autoSync, ...syncState };
}

/** Counts tree requests, which is one per sync attempt. */
function countSyncs(): () => number {
  let syncs = 0;
  globalThis.fetch = vi.fn(async (url: unknown) => {
    if (String(url).includes("/git/trees/")) {
      syncs++;
      return new Response(JSON.stringify({ tree: [] }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  return () => syncs;
}

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, "onLine", { value, configurable: true });
}

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { value, configurable: true });
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("retrying a sync that never landed", () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    setOnline(true);
    setVisibility("visible");
  });

  afterEach(() => {
    stop?.();
    stop = null;
  });

  it("syncs as soon as the connection comes back", async () => {
    const { startAutoSync, recordSyncSuccess } = await fresh();
    const syncs = countSyncs();
    // Synced seconds ago, so nothing else would think a sync was due.
    recordSyncSuccess(true);
    stop = startAutoSync();

    window.dispatchEvent(new Event("online"));
    await settle();

    expect(syncs()).toBe(1);
  });

  it("does not sync on every glance at the app", async () => {
    const { startAutoSync, recordSyncSuccess } = await fresh();
    const syncs = countSyncs();
    recordSyncSuccess(true);
    stop = startAutoSync();

    document.dispatchEvent(new Event("visibilitychange"));
    await settle();

    // Switching apps twice a minute must not become two requests a minute.
    expect(syncs()).toBe(0);
  });

  it("syncs on returning to the app when the last sync failed", async () => {
    const { startAutoSync, recordSyncSuccess, setSyncStatus } = await fresh();
    const syncs = countSyncs();
    recordSyncSuccess(true);
    setSyncStatus({ phase: "error", message: "GitHub API error: 500", needsSignIn: false });
    stop = startAutoSync();

    document.dispatchEvent(new Event("visibilitychange"));
    await settle();

    expect(syncs()).toBe(1);
  });

  it("leaves a signed-out app alone", async () => {
    const { startAutoSync, recordSyncSuccess, setSyncStatus } = await fresh();
    const syncs = countSyncs();
    recordSyncSuccess(true);
    setSyncStatus({ phase: "error", message: "Sign in again.", needsSignIn: true });
    stop = startAutoSync();

    document.dispatchEvent(new Event("visibilitychange"));
    await settle();

    // Nothing here can fix it, and hammering the API to be told so again is
    // just a way to get rate limited.
    expect(syncs()).toBe(0);
  });

  it("does not try while offline", async () => {
    const { startAutoSync } = await fresh();
    const syncs = countSyncs();
    setOnline(false);
    stop = startAutoSync();

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    await settle();

    expect(syncs()).toBe(0);
  });

  it("stops listening once torn down", async () => {
    const { startAutoSync } = await fresh();
    const syncs = countSyncs();
    startAutoSync()();

    window.dispatchEvent(new Event("online"));
    await settle();

    expect(syncs()).toBe(0);
  });
});
