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
    repo: "someone/cards",
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

/**
 * Editing a card mid-drill changes the hash of the card you are part-way
 * through, and the session holds hashes in six places. These say what happens
 * to each of them, without a sheet or a repo in sight.
 */
describe("a card rewritten during the drill", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  /** What an edit makes of `card(n)`: the same slot, a different identity. */
  function rewritten(n: number): Card {
    return { ...card(n), hash: `hash-${n}-v2`, content: { type: "basic", question: `Q${n}!`, answer: `A${n}` } };
  }

  it("takes the old card's place rather than going to the back", async () => {
    const { createSession } = await fresh();
    // Three cards, so "in its slot" and "at the end of the queue" are
    // different answers — with one card they are the same place.
    const session = await createSession([card(1), card(2), card(3)]);
    const front = session.current!;
    const behind = session.next!.hash;
    const before = session.progress;

    session.replaceCard(front.hash, { ...front, hash: "rewritten" }, true);

    expect(session.current!.hash).toBe("rewritten");
    expect(session.next!.hash).toBe(behind);
    expect(session.progress).toBe(before);
  });

  it("hides the answer again, since the card is not the one that was read", async () => {
    const { createSession } = await fresh();
    const session = await createSession([card(1)]);
    session.reveal();

    session.replaceCard("hash-1", rewritten(1), true);

    expect(session.revealed).toBe(false);
  });

  it("carries the scheduling across, so the intervals do not reset", async () => {
    const { createSession } = await fresh();
    const perf = new Map([
      [
        "hash-1",
        {
          type: "reviewed" as const,
          lastReviewedAt: "2026-01-01T00:00:00.000Z",
          stability: 40,
          difficulty: 5,
          intervalRaw: 40,
          intervalDays: 40,
          dueDate: "2026-02-10",
          reviewCount: 6,
        },
      ],
    ]);
    const session = await createSession([card(1)], { cache: perf });
    const was = session.previews();

    session.replaceCard("hash-1", rewritten(1), true);

    expect(session.previews()).toEqual(was);
  });

  it("starts the card over when the edit gave up its history", async () => {
    const { createSession } = await fresh();
    const perf = new Map([
      [
        "hash-1",
        {
          type: "reviewed" as const,
          lastReviewedAt: "2026-01-01T00:00:00.000Z",
          stability: 40,
          difficulty: 5,
          intervalRaw: 40,
          intervalDays: 40,
          dueDate: "2026-02-10",
          reviewCount: 6,
        },
      ],
    ]);
    const session = await createSession([card(1)], { cache: perf });
    const was = session.previews();

    session.replaceCard("hash-1", rewritten(1), false);

    // A card nothing has seen is offered in days, not the six weeks a stability
    // of 40 had earned.
    expect(session.previews()).not.toEqual(was);
  });

  it("leaves the queue when the edit deleted it", async () => {
    const { createSession } = await fresh();
    const session = await createSession([card(1), card(2)]);
    const going = session.current!.hash;

    session.replaceCard(going, null, false);

    expect(session.current!.hash).not.toBe(going);
    expect(session.next).toBeNull();
  });

  /**
   * The progress bar counts completions against the size of the queue. A card
   * that left without ever being answered has to leave the denominator too, or
   * the bar stops one card short of full for the rest of the session.
   */
  it("shrinks the total when a card is deleted, so progress can still reach 1", async () => {
    const { createSession } = await fresh();
    const session = await createSession([card(1), card(2)]);

    session.replaceCard(session.current!.hash, null, false);
    session.reveal();
    session.grade(Grade.Easy);

    expect(session.progress).toBe(1);
  });

  it("does not charge the new-card budget twice for a card graded before the edit", async () => {
    const { createSession, getIntroducedToday } = await fresh();
    // Forgot sends the card to the back, so it comes round again — this time
    // wearing the hash the edit gave it.
    const session = await createSession([card(1)]);
    session.reveal();
    session.grade(Grade.Forgot);
    expect(getIntroducedToday()).toBe(1);

    session.replaceCard("hash-1", rewritten(1), true);
    session.reveal();
    session.requeue(false);

    expect(getIntroducedToday()).toBe(1);
  });

  it("keeps a re-queued card in reinforcement rather than sending it back to FSRS", async () => {
    const { createSession } = await fresh();
    const session = await createSession([card(1)]);
    session.reveal();
    session.grade(Grade.Forgot);
    expect(session.requeued).toBe(true);

    session.replaceCard("hash-1", rewritten(1), true);

    expect(session.requeued).toBe(true);
  });

  /**
   * Undo reverses a grade by writing the card's earlier scheduling back, and
   * after an edit there is no longer one card that scheduling belongs to. The
   * grade itself stays in the review log — it happened.
   */
  it("gives up undo for the card it replaced, and only for that card", async () => {
    const { createSession } = await fresh();
    const session = await createSession([card(1), card(2)]);
    const first = session.current!.hash;
    session.reveal();
    session.grade(Grade.Easy);
    const second = session.current!.hash;
    session.reveal();
    session.grade(Grade.Forgot);
    await settle();

    session.replaceCard(second, rewritten(2), true);
    expect(session.canUndo).toBe(true);
    expect(session.undoTarget).toBe(first);

    await session.undo();
    expect(session.current!.hash).toBe(first);
    expect(session.canUndo).toBe(false);
  });

  it("records the new hash in the position a resume would pick up", async () => {
    const { createSession } = await fresh();
    const { loadSession } = await import("../../db");
    const session = await createSession([card(1)]);

    session.replaceCard("hash-1", rewritten(1), true);
    await settle();

    expect((await loadSession())!.queue).toEqual(["hash-1-v2"]);
  });

  it("ignores a card that is not in the queue", async () => {
    const { createSession } = await fresh();
    const session = await createSession([card(1)]);

    session.replaceCard("hash-9", rewritten(9), true);

    expect(session.current!.hash).toBe("hash-1");
  });
});
