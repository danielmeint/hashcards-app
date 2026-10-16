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
});
