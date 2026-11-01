// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

/**
 * One budget, one count: the new cards started today on any device, read
 * from the merged log, not a counter on this one.
 */

async function fresh() {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  vi.resetModules();
  const db = await import("./db");
  const budget = await import("./new-card-budget");
  return { db, budget };
}

const review = (card: string, at: string) => ({ v: 2 as const, kind: "review" as const, card, at, tz: 120, grade: 3 as const });

describe("today's new cards", () => {
  it("counts cards started today on another device, and only those", async () => {
    const { db, budget } = await fresh();
    await db.updatePulledFiles([
      {
        repo: "me/cards",
        path: "reviews/2026-10.phone.jsonl",
        sha: "x",
        events: [
          // Started today on the phone: two of them, one graded twice.
          review("a", "2026-10-17T07:00:00.000Z"),
          review("a", "2026-10-17T07:05:00.000Z"),
          review("b", "2026-10-17T08:00:00.000Z"),
          // Started yesterday, reviewed again today: not new today.
          review("c", "2026-10-16T08:00:00.000Z"),
          review("c", "2026-10-17T08:00:00.000Z"),
          // History carried over as a baseline: not new either.
          { v: 2, kind: "baseline", card: "d", at: "2026-09-01T10:00:00.000Z", s: 3, d: 5, reps: 4 },
          review("d", "2026-10-17T09:00:00.000Z"),
          // 23:30 UTC on the 16th is the 17th in UTC+2, where it was given.
          { ...review("e", "2026-10-16T23:30:00.000Z"), tz: 120 },
        ],
      },
    ]);
    await budget.refreshIntroduced("2026-10-17");
    expect(budget.getIntroducedToday("2026-10-17")).toBe(3);
    localStorage.setItem("new_cards_per_day", "5");
    expect(budget.remainingBudget("2026-10-17")).toBe(2);
  });

  it("follows the drill between refreshes, and a reset starts this device from zero", async () => {
    const { db, budget } = await fresh();
    await db.updatePulledFiles([
      { repo: "me/cards", path: "reviews/2026-10.phone.jsonl", sha: "x", events: [review("a", "2026-10-17T07:00:00.000Z")] },
    ]);
    await budget.refreshIntroduced("2026-10-17");
    budget.recordIntroduced("2026-10-17", "me/cards/b", true);
    expect(budget.getIntroducedToday("2026-10-17")).toBe(2);
    budget.recordIntroduced("2026-10-17", "me/cards/b", false);
    expect(budget.getIntroducedToday("2026-10-17")).toBe(1);

    budget.resetIntroduced("2026-10-17");
    expect(budget.getIntroducedToday("2026-10-17")).toBe(0);
    budget.recordIntroduced("2026-10-17", "me/cards/c", true);
    expect(budget.getIntroducedToday("2026-10-17")).toBe(1);
    // Tomorrow, the reset is gone with the day.
    expect(budget.getIntroducedToday("2026-10-18")).toBe(0);
  });

  it("drops the old per-device counter, which would otherwise read as a count", async () => {
    const { budget } = await fresh();
    localStorage.setItem("new_cards_introduced", JSON.stringify({ date: "2026-10-17", count: 20 }));
    await budget.refreshIntroduced("2026-10-17");
    expect(localStorage.getItem("new_cards_introduced")).toBeNull();
    expect(budget.getIntroducedToday("2026-10-17")).toBe(0);
  });

  describe("in groups", () => {
    const limits = [{ name: "interview", decks: ["interview/**"], newPerDay: 2 }];
    const deckCard = (n: number, filePath: string) => ({
      deckName: "d",
      repo: "me/cards",
      filePath,
      range: [n, n] as [number, number],
      content: { type: "basic" as const, question: `Q${n}`, answer: `A${n}` },
      hash: `hash-${n}`,
      familyHash: `hash-${n}`,
      legacyKey: null,
      key: `h:${String(n).padStart(16, "0")}`,
      tags: [],
      status: "active" as const,
    });

    it("spends a group's budget on the cards started in its decks, on any device", async () => {
      const { db, budget } = await fresh();
      localStorage.setItem("new_cards_per_day", "10");
      localStorage.setItem("new_card_limits", JSON.stringify(limits));
      const cards = [deckCard(1, "interview/sd.md"), deckCard(2, "interview/algo/x.md"), deckCard(3, "Geo.md")];
      await db.updateDeckFiles(
        cards.map((c) => ({ repo: c.repo, path: c.filePath, sha: c.filePath, cards: [c] })),
        []
      );
      await db.updatePulledFiles([
        {
          repo: "me/cards",
          path: "reviews/2026-10.phone.jsonl",
          sha: "x",
          events: [
            review(cards[0].key, "2026-10-17T07:00:00.000Z"),
            review(cards[2].key, "2026-10-17T07:01:00.000Z"),
            // A card no deck has any more: the collection's, and no group's.
            review("h:ffffffffffffffff", "2026-10-17T07:02:00.000Z"),
          ],
        },
      ]);
      // Without cards to hand, the deck store says which deck each is in.
      await budget.refreshIntroduced("2026-10-17");
      expect(budget.getIntroducedToday("2026-10-17")).toBe(3);
      expect(budget.remainingBudget("2026-10-17")).toBe(7);
      expect(budget.remainingFor("interview/new.md", "2026-10-17")).toBe(1);
      expect(budget.remainingFor("Geo.md", "2026-10-17")).toBe(7);

      // The drill's first grade in the group spends the rest of it.
      budget.recordIntroduced("2026-10-17", "me/cards/" + cards[1].key, true, cards[1].filePath);
      expect(budget.remainingFor("interview/new.md", "2026-10-17")).toBe(0);
      budget.recordIntroduced("2026-10-17", "me/cards/" + cards[1].key, false);
      expect(budget.remainingFor("interview/new.md", "2026-10-17")).toBe(1);
    });

    it("introduces a group's cards only while both it and the collection have budget", async () => {
      const { budget } = await fresh();
      localStorage.setItem("new_cards_per_day", "3");
      localStorage.setItem("new_card_limits", JSON.stringify(limits));
      const cards = [
        deckCard(1, "interview/a.md"),
        deckCard(2, "interview/a.md"),
        deckCard(3, "interview/b/c.md"),
        deckCard(4, "Geo.md"),
        deckCard(5, "Geo.md"),
      ];
      const picked = budget.selectDueCards(cards, new Map(), "2026-10-17");
      expect(picked.map((c) => c.range[0])).toEqual([1, 2, 4]);
    });

    it("starts every group from zero at a Reset, too", async () => {
      const { budget } = await fresh();
      localStorage.setItem("new_cards_per_day", "10");
      localStorage.setItem("new_card_limits", JSON.stringify(limits));
      budget.recordIntroduced("2026-10-17", "me/cards/a", true, "interview/a.md");
      budget.recordIntroduced("2026-10-17", "me/cards/b", true, "interview/b.md");
      expect(budget.remainingFor("interview/c.md", "2026-10-17")).toBe(0);

      budget.resetIntroduced("2026-10-17");
      expect(budget.remainingFor("interview/c.md", "2026-10-17")).toBe(2);
      budget.recordIntroduced("2026-10-17", "me/cards/c", true, "interview/c.md");
      expect(budget.remainingFor("interview/c.md", "2026-10-17")).toBe(1);
      expect(budget.getIntroducedToday("2026-10-17")).toBe(1);
    });

    it("still honours a Reset made before groups, which kept only a count", async () => {
      const { budget } = await fresh();
      budget.recordIntroduced("2026-10-17", "me/cards/a", true);
      budget.recordIntroduced("2026-10-17", "me/cards/b", true);
      localStorage.setItem("new_cards_reset", JSON.stringify({ date: "2026-10-17", count: 1 }));
      expect(budget.getIntroducedToday("2026-10-17")).toBe(1);
    });
  });
});
