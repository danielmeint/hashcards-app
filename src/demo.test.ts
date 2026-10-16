// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The demo runs the real app, so the one thing that has to be proven rather
 * than assumed is that it leaves the real install alone: someone with a
 * collection on this origin who opens `#demo` must find it exactly as it was.
 */

const NOW = new Date(2026, 9, 16, 9, 30);

/** What a real install had before the demo was opened. */
const REAL = {
  repos: JSON.stringify([{ owner: "me", repo: "cards", branch: "main" }]),
  theme: "dark",
  desired_retention: "0.85",
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  for (const [key, value] of Object.entries(REAL)) localStorage.setItem(key, value);
  fetchSpy = vi.fn(() => Promise.reject(new Error("no network in tests")));
  vi.stubGlobal("fetch", fetchSpy);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function databases(): Promise<string[]> {
  return (await indexedDB.databases()).map((d) => d.name ?? "");
}

async function demo() {
  const { startDemo } = await import("./demo");
  await startDemo(NOW);
  return {
    sync: await import("./sync"),
    db: await import("./db"),
    github: await import("./github"),
    settings: (await import("./settings")).settings,
    queue: await import("./inbox-queue"),
    commit: await import("./inbox-commit"),
    edits: await import("./draft-edits"),
    mode: await import("./demo-mode"),
  };
}

describe("the demo", () => {
  it("loads the starter decks, with drafts and a history that leaves cards due", async () => {
    const { sync, db } = await demo();
    const cards = await sync.loadCachedCards();
    expect(new Set(cards.map((c) => c.filePath))).toEqual(
      new Set(["Geography.md", "Maths.md", "Programming.md", "Welcome.md", "languages/Spanish.md"])
    );
    expect(cards.filter((c) => c.status === "draft").length).toBe(3);

    const reviews = await db.getAllReviews();
    expect(reviews.length).toBeGreaterThan(40);
    // Nothing on or after today: the visitor's own reviews are the first of it.
    expect(reviews.every((r) => new Date(r.reviewedAt) < new Date(2026, 9, 16))).toBe(true);
    // The Welcome deck is left new: the demo's first review is its tutorial.
    const welcome = new Set(cards.filter((c) => c.filePath === "Welcome.md").map((c) => `${c.repo}/${c.key}`));
    expect(welcome.size).toBeGreaterThan(0);
    expect(reviews.some((r) => welcome.has(r.key))).toBe(false);

    // A leech for Statistics to show: the reverse of *la sobremesa*.
    const { findLeeches } = await import("./leeches");
    const { reviewHistory } = await import("./review-state");
    const leeches = findLeeches(cards, await reviewHistory());
    expect(leeches.map((l) => l.card.content.type === "basic" && l.card.content.answer)).toContain("**la sobremesa**");

    const states = await db.getAllPerformances();
    const due = [...states.values()].filter((s) => s.dueDate <= "2026-10-16");
    expect(due.length).toBeGreaterThan(3);
  });

  it("is the same demo every time", async () => {
    const first = (await (await demo()).db.getAllReviews()).map((r) => [r.key, r.reviewedAt, r.grade]);
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    const second = (await (await demo()).db.getAllReviews()).map((r) => [r.key, r.reviewedAt, r.grade]);
    expect(second).toEqual(first);
  });

  it("writes nothing to the real database or localStorage", async () => {
    const { settings, sync, queue, commit, edits, github, mode } = await demo();

    // A session's worth of changes: settings, a review, Inbox decisions, an edit.
    settings.theme.set("light");
    settings.newCardsPerDay.set(5);
    settings.desiredRetention.set(0.95);
    await sync.syncStateOnly(mode.DEMO_REPO);
    const drafts = edits.findDrafts(await sync.loadCachedCards(), () => true);
    await queue.enqueue(
      drafts.slice(0, 2).map((d, i) => ({
        id: `op${i}`,
        action: i === 0 ? ("keep" as const) : ("discard" as const),
        repo: d.repo,
        path: d.path,
        block: edits.blockHashes(d),
        at: NOW.toISOString(),
      }))
    );
    await commit.saveInbox();
    const geo = await github.readFile(mode.DEMO_REPO, "Geography.md");
    await github.writeFile(mode.DEMO_REPO, "Geography.md", geo.text + "\n", { sha: geo.sha, message: "edit" });

    expect(Object.fromEntries(Object.entries(localStorage))).toEqual(REAL);
    const names = await databases();
    expect(names).not.toContain("hashcards");
    expect(names.filter((n) => n.startsWith("hashcards-demo-"))).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("starts from the real install's theme, but never writes it back", async () => {
    const { settings } = await demo();
    expect(settings.theme.get()).toBe("dark");
    // Collection settings are the starter's, not the real collection's.
    expect(settings.desiredRetention.get()).toBe(0.9);
    expect(settings.repos.get()).toEqual([
      { owner: "danielmeint", repo: "hashcards-starter", branch: "main" },
    ]);
  });

  it("refuses every GitHub call it has no answer for", async () => {
    const { github, mode } = await demo();
    await expect(github.inspectConnection()).rejects.toBeInstanceOf(mode.DemoOfflineError);
    await expect(github.getRef(mode.DEMO_REPO, "hashcards-data")).rejects.toBeInstanceOf(
      mode.DemoOfflineError
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("applies Inbox decisions to its own files", async () => {
    const { sync, queue, commit, edits, github, mode } = await demo();
    const [first] = edits.findDrafts(await sync.loadCachedCards(), () => true);
    await queue.enqueue([
      {
        id: "keep",
        action: "keep",
        repo: first.repo,
        path: first.path,
        block: edits.blockHashes(first),
        at: NOW.toISOString(),
      },
    ]);
    await commit.saveInbox();
    expect(await queue.pendingOps()).toEqual([]);
    const text = (await github.readFile(mode.DEMO_REPO, first.path)).text;
    expect(edits.findDrafts(await sync.loadCachedCards(), () => true)).toHaveLength(2);
    expect(text).toContain((first.cards[0].content as { question?: string; text?: string }).question ?? "");
    const kept = (await sync.loadCachedCards()).find((c) => c.key === first.cards[0].key);
    expect(kept?.status).toBe("active");
  });
});
