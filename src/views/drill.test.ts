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

/** Let the drill's serialized write queue drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Reveal the current card and grade it. */
async function grade(container: HTMLElement, g: Grade): Promise<void> {
  click(container, "#reveal-btn");
  click(container, `.grade-btn[data-grade="${g}"]`);
  await settle();
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

    await grade(container, Grade.Good);

    // No End, no Done — this is the interrupted-session case.
    const perfs = await getAllPerformances();
    const reviews: Review[] = await getAllReviews();

    expect(reviews).toHaveLength(1);
    expect(reviews[0].grade).toBe(Grade.Good);
    expect(perfs.size).toBe(1);
    expect(perfs.get(reviews[0].cardHash)!.reviewCount).toBe(1);
  });

  it("keeps every graded card when the session is abandoned midway", async () => {
    const { renderDrill, getAllPerformances, getAllReviews } =
      await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2), basicCard(3)], () => {});

    // Easy does not re-queue, so each grade retires one card.
    await grade(container, Grade.Easy);
    await grade(container, Grade.Easy);

    expect(await getAllReviews()).toHaveLength(2);
    expect((await getAllPerformances()).size).toBe(2);
  });

  it("undo removes the persisted review and restores the prior state", async () => {
    const { renderDrill, getAllPerformances, getAllReviews } =
      await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

    await grade(container, Grade.Easy);
    expect(await getAllReviews()).toHaveLength(1);

    click(container, "#undo-btn");
    await settle();

    // The card was new before the grade, so its record should be gone
    // entirely rather than left behind with stale scheduling state.
    expect(await getAllReviews()).toHaveLength(0);
    expect((await getAllPerformances()).size).toBe(0);
  });

  it("undo after a second grade leaves the first review intact", async () => {
    const { renderDrill, getAllPerformances, getAllReviews } =
      await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

    await grade(container, Grade.Easy);
    await grade(container, Grade.Easy);
    expect(await getAllReviews()).toHaveLength(2);

    click(container, "#undo-btn");
    await settle();

    // The queue is shuffled, so assert the surviving review and performance
    // describe the same card rather than naming one.
    const reviews = await getAllReviews();
    const perfs = await getAllPerformances();
    expect(reviews).toHaveLength(1);
    expect(perfs.size).toBe(1);
    expect([...perfs.keys()]).toEqual([reviews[0].cardHash]);
  });

  it("a re-queued card is graded once, not twice", async () => {
    const { renderDrill, getAllReviews } = await freshDrill();
    await renderDrill(container, [basicCard(1)], () => {});

    // Forgot re-queues the card for reinforcement without further FSRS.
    await grade(container, Grade.Forgot);

    click(container, "#reveal-btn");
    click(container, '.requeue-btn[data-action="done"]');
    await settle();

    expect(await getAllReviews()).toHaveLength(1);
  });

  it("writes nothing in dry-run (demo) mode", async () => {
    const { renderDrill, getAllPerformances, getAllReviews } =
      await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {}, {
      dryRun: true,
    });

    await grade(container, Grade.Good);

    expect(await getAllReviews()).toHaveLength(0);
    expect((await getAllPerformances()).size).toBe(0);
  });
});
