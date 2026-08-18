// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Card, Grade, Review } from "../types";

/**
 * Reviews used to be held in memory for the whole session and written only when
 * the user pressed End, so a drill interrupted by a crash or a reclaimed tab
 * lost every answer in it. The invariant these tests protect is that a graded
 * card is durable immediately, whether or not the session is ever finished.
 */

/**
 * `db.ts` memoizes its connection, so a clean database also needs a clean
 * module registry — otherwise the cached handle outlives the reset.
 */
async function freshDrill() {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  const [{ renderDrill }, db] = await Promise.all([
    import("./drill"),
    import("../db"),
  ]);
  return { renderDrill, ...db };
}

function basicCard(n: number): Card {
  return {
    deckName: "Test",
    filePath: "test.md",
    range: [n, n + 1],
    content: { type: "basic", question: `Q${n}`, answer: `A${n}` },
    hash: `hash-${n}`,
    familyHash: null,
  };
}

function click(container: HTMLElement, selector: string): void {
  const el = container.querySelector(selector) as HTMLButtonElement | null;
  if (!el) throw new Error(`No element matching ${selector}`);
  el.click();
}

/**
 * Drain the drill's serialized write queue. Only sound for asserting that
 * nothing was written — for anything else use `waitFor`, which does not assume
 * how many event-loop turns an IndexedDB write takes.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Poll until `predicate` holds, so tests never guess at write timing. */
async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string
): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Reveal the current card and grade it. */
function grade(container: HTMLElement, g: Grade): void {
  click(container, "#reveal-btn");
  click(container, `.grade-btn[data-grade="${g}"]`);
}

describe("drill persistence", () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("persists a grade without the session being ended", async () => {
    const { renderDrill, getAllPerformances, getAllReviews } =
      await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2), basicCard(3)], () => {});

    grade(container, Grade.Good);

    // No End, no Done — this is the interrupted-session case.
    const reviews: Review[] = await waitFor(
      getAllReviews,
      (r) => r.length === 1,
      "the grade to be persisted"
    );
    const perfs = await getAllPerformances();

    expect(reviews[0].grade).toBe(Grade.Good);
    expect(perfs.size).toBe(1);
    expect(perfs.get(reviews[0].cardHash)!.reviewCount).toBe(1);
  });

  it("keeps every graded card when the session is abandoned midway", async () => {
    const { renderDrill, getAllPerformances, getAllReviews } =
      await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2), basicCard(3)], () => {});

    // Easy does not re-queue, so each grade retires one card.
    grade(container, Grade.Easy);
    await waitFor(getAllReviews, (r) => r.length === 1, "first grade");
    grade(container, Grade.Easy);
    await waitFor(getAllReviews, (r) => r.length === 2, "second grade");

    expect((await getAllPerformances()).size).toBe(2);
  });

  it("undo removes the persisted review and restores the prior state", async () => {
    const { renderDrill, getAllPerformances, getAllReviews } =
      await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

    grade(container, Grade.Easy);
    await waitFor(getAllReviews, (r) => r.length === 1, "the grade");

    click(container, "#undo-btn");

    // The card was new before the grade, so its record should be gone
    // entirely rather than left behind with stale scheduling state.
    await waitFor(getAllReviews, (r) => r.length === 0, "the undo");
    expect((await getAllPerformances()).size).toBe(0);
  });

  it("undo after a second grade leaves the first review intact", async () => {
    const { renderDrill, getAllPerformances, getAllReviews } =
      await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

    grade(container, Grade.Easy);
    await waitFor(getAllReviews, (r) => r.length === 1, "first grade");
    grade(container, Grade.Easy);
    await waitFor(getAllReviews, (r) => r.length === 2, "second grade");

    click(container, "#undo-btn");

    // The queue is shuffled, so assert the surviving review and performance
    // describe the same card rather than naming one.
    const reviews = await waitFor(
      getAllReviews,
      (r) => r.length === 1,
      "the undo"
    );
    const perfs = await getAllPerformances();
    expect(perfs.size).toBe(1);
    expect([...perfs.keys()]).toEqual([reviews[0].cardHash]);
  });

  it("a re-queued card is graded once, not twice", async () => {
    const { renderDrill, getAllReviews } = await freshDrill();
    await renderDrill(container, [basicCard(1)], () => {});

    // Forgot re-queues the card for reinforcement without further FSRS.
    grade(container, Grade.Forgot);
    await waitFor(getAllReviews, (r) => r.length === 1, "the grade");

    click(container, "#reveal-btn");
    click(container, '.requeue-btn[data-action="done"]');
    await settle();

    expect(await getAllReviews()).toHaveLength(1);
  });

  it("records drill position and clears it when the session ends", async () => {
    const { renderDrill, getAllReviews, loadSession } = await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2), basicCard(3)], () => {});

    grade(container, Grade.Easy);
    await waitFor(getAllReviews, (r) => r.length === 1, "the grade");

    const session = await waitFor(
      loadSession,
      (s) => s !== null && s.queue.length === 2,
      "the drill position"
    );
    expect(session!.completed).toHaveLength(1);
    expect(session!.totalCards).toBe(3);

    click(container, "#end-btn");
    await waitFor(loadSession, (s) => s === null, "the session to be cleared");
  });

  it("resumes an interrupted drill without re-asking graded cards", async () => {
    const { renderDrill, getAllReviews, loadSession } = await freshDrill();
    const cards = [basicCard(1), basicCard(2), basicCard(3)];
    await renderDrill(container, cards, () => {});

    grade(container, Grade.Easy);
    const session = await waitFor(
      loadSession,
      (s) => s !== null && s.queue.length === 2,
      "the drill position"
    );

    // Simulate a reopen: fresh container, same database, restored position.
    document.body.innerHTML = "";
    const resumed = document.createElement("div");
    document.body.appendChild(resumed);
    await renderDrill(resumed, cards, () => {}, { resume: session! });

    grade(resumed, Grade.Easy);
    await waitFor(getAllReviews, (r) => r.length === 2, "fourth grade");
    grade(resumed, Grade.Easy);

    const reviews = await waitFor(
      getAllReviews,
      (r) => r.length === 3,
      "the drill to finish"
    );

    // Every card graded exactly once across the two sittings.
    expect(new Set(reviews.map((r) => r.cardHash)).size).toBe(3);
  });

  it("drops cards that have left the repo when resuming", async () => {
    const { renderDrill, getAllReviews, loadSession } = await freshDrill();
    const cards = [basicCard(1), basicCard(2), basicCard(3)];
    await renderDrill(container, cards, () => {});

    grade(container, Grade.Easy);
    const session = await waitFor(
      loadSession,
      (s) => s !== null && s.queue.length === 2,
      "the drill position"
    );

    // One of the queued cards no longer exists in the synced card set.
    const survivors = cards.filter((c) => c.hash !== session!.queue[0]);

    document.body.innerHTML = "";
    const resumed = document.createElement("div");
    document.body.appendChild(resumed);
    await renderDrill(resumed, survivors, () => {}, { resume: session! });

    grade(resumed, Grade.Easy);
    const reviews = await waitFor(
      getAllReviews,
      (r) => r.length === 2,
      "the remaining card"
    );
    expect(reviews.map((r) => r.cardHash)).not.toContain(session!.queue[0]);
  });

  it("writes nothing in dry-run (demo) mode", async () => {
    const { renderDrill, getAllPerformances, getAllReviews } =
      await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {}, {
      dryRun: true,
    });

    grade(container, Grade.Good);
    await settle();

    expect(await getAllReviews()).toHaveLength(0);
    expect((await getAllPerformances()).size).toBe(0);
  });
});
