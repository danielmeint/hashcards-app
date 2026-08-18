// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Card, Grade } from "../../types";

/**
 * The drill's rules, driven through the session API rather than through
 * buttons. jsdom is still here for localStorage, which the settings and the
 * new-card budget live in — but nothing below touches an element, so these say
 * what the drill *does* rather than what it renders.
 */

async function fresh() {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  const [{ createSession }, budget] = await Promise.all([
    import("./session"),
    import("../../new-card-budget"),
  ]);
  return { createSession, ...budget };
}

function card(n: number, familyHash: string | null = null): Card {
  return {
    deckName: "Test",
    filePath: "test.md",
    range: [n, n + 1],
    content: { type: "basic", question: `Q${n}`, answer: `A${n}` },
    hash: `hash-${n}`,
    familyHash,
  };
}

/** Drain the serialized write queue. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("drill session", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("buries cloze siblings, asking one card per family", async () => {
    const { createSession } = await fresh();
    const session = await createSession([
      card(1, "family-a"),
      card(2, "family-a"),
      card(3, "family-a"),
      card(4, "family-b"),
      card(5),
    ]);

    // Three of one family, one of another, one standalone: three questions.
    const asked: string[] = [];
    while (!session.finished) {
      asked.push(session.current!.hash);
      session.reveal();
      session.grade(Grade.Easy);
    }

    expect(asked).toHaveLength(3);
  });

  it("keeps every card when none share a family", async () => {
    const { createSession } = await fresh();
    const session = await createSession([card(1), card(2), card(3)]);

    const asked = new Set<string>();
    while (!session.finished) {
      asked.add(session.current!.hash);
      session.reveal();
      session.grade(Grade.Easy);
    }

    expect(asked.size).toBe(3);
  });

  it("charges a new card to today's budget once, and refunds it on undo", async () => {
    const { createSession, getIntroducedToday } = await fresh();
    const session = await createSession([card(1), card(2)]);

    expect(getIntroducedToday()).toBe(0);

    session.reveal();
    session.grade(Grade.Easy);
    await settle();
    expect(getIntroducedToday()).toBe(1);

    await session.undo();
    expect(getIntroducedToday()).toBe(0);
  });

  it("does not charge the budget twice for a re-queued card", async () => {
    const { createSession, getIntroducedToday } = await fresh();
    const session = await createSession([card(1)]);

    // Forgot sends the card round again for reinforcement.
    session.reveal();
    session.grade(Grade.Forgot);
    await settle();
    expect(session.requeued).toBe(true);

    session.reveal();
    session.requeue(false); // Got it

    await settle();
    expect(getIntroducedToday()).toBe(1);
  });

  it("restores the pre-grade schedule on undo, not the graded one", async () => {
    const { createSession } = await fresh();
    const session = await createSession([card(1), card(2)]);

    session.reveal();
    const before = session.previews();

    session.grade(Grade.Easy);
    await settle();
    await session.undo();

    // Same card, same starting state: the intervals on offer are unchanged.
    // Reading the graded state back instead would offer a different set.
    session.reveal();
    expect(session.previews()).toEqual(before);
  });

  it("reports progress over the whole session, not just this sitting", async () => {
    const { createSession } = await fresh();
    const cards = [card(1), card(2), card(3), card(4)];
    const session = await createSession(cards, {
      resume: {
        queue: ["hash-3", "hash-4"],
        requeued: [],
        completed: ["hash-1", "hash-2"],
        gradedNew: ["hash-1", "hash-2"],
        totalCards: 4,
        startedAt: new Date().toISOString(),
      },
    });

    // Two of four already answered before the app was reopened.
    expect(session.progress).toBe(0.5);
    session.reveal();
    session.grade(Grade.Easy);
    expect(session.progress).toBe(0.75);
  });

  it("keeps the queue order it was resumed with", async () => {
    const { createSession } = await fresh();
    const cards = [card(1), card(2), card(3)];
    const session = await createSession(cards, {
      resume: {
        queue: ["hash-3", "hash-1"],
        requeued: [],
        completed: ["hash-2"],
        gradedNew: [],
        totalCards: 3,
        startedAt: new Date().toISOString(),
      },
    });

    expect(session.current!.hash).toBe("hash-3");
    expect(session.next!.hash).toBe("hash-1");
  });

  it("ignores a grade before the answer is showing", async () => {
    const { createSession } = await fresh();
    const session = await createSession([card(1), card(2)]);
    const first = session.current;

    session.grade(Grade.Easy);

    expect(session.current).toBe(first);
    expect(session.canUndo).toBe(false);
  });

  it("touches neither the store nor the budget in dry-run", async () => {
    const { createSession, getIntroducedToday } = await fresh();
    const { getAllReviews, loadSession } = await import("../../db");
    const session = await createSession([card(1), card(2)], { dryRun: true });

    session.reveal();
    session.grade(Grade.Good);
    await settle();

    expect(await getAllReviews()).toHaveLength(0);
    expect(await loadSession()).toBeNull();
    expect(getIntroducedToday()).toBe(0);
  });
});
