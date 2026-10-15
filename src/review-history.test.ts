// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, vi } from "vitest";
import type { Review } from "./types";

/**
 * Since M3 the review log is every device's: this device's own grades, and
 * the events pulled from the others' files on the data branch. Leeches are
 * counted from all of it, so a card failed on two devices is failed twice.
 */
describe("reviewHistory", () => {
  it("joins this device's grades with every other device's, and leaves baselines out", async () => {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    const db = await import("./db");
    const { reviewHistory } = await import("./review-state");
    const { findLeeches } = await import("./leeches");

    await db.updatePulledFiles([
      {
        repo: "me/cards",
        path: "reviews/2026-10.laptop.jsonl",
        sha: "x",
        events: [
          { v: 2, kind: "baseline", card: "est-capital", at: "2026-09-01T10:00:00.000Z", s: 3, d: 5, reps: 4 },
          { v: 2, kind: "review", card: "est-capital", at: "2026-10-01T10:00:00.000Z", tz: 120, grade: 1 },
          { v: 2, kind: "review", card: "est-capital", at: "2026-10-02T10:00:00.000Z", tz: 120, grade: 1 },
        ],
      },
    ]);
    // One grade from this device, written as the drill writes it.
    await db.getAllReviews();
    const local: Review = {
      key: "me/cards/est-capital",
      log: "me/cards",
      tz: 120,
      cardHash: "h",
      reviewedAt: "2026-10-03T10:00:00.000Z",
      grade: 1,
      stability: 1,
      difficulty: 7,
      intervalRaw: 1,
      intervalDays: 1,
      dueDate: "2026-10-04",
    };
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("hashcards");
      open.onsuccess = () => {
        const tx = open.result.transaction("reviews", "readwrite");
        tx.objectStore("reviews").add(local);
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });

    const history = await reviewHistory();
    expect(history.map((h) => [h.key, h.reviewedAt.slice(0, 10), h.grade]).sort()).toEqual([
      ["me/cards/est-capital", "2026-10-01", 1],
      ["me/cards/est-capital", "2026-10-02", 1],
      ["me/cards/est-capital", "2026-10-03", 1],
    ]);

    const card = {
      deckName: "Capitals",
      repo: "me/cards",
      filePath: "c.md",
      range: [1, 2] as [number, number],
      content: { type: "basic" as const, question: "Estonia?", answer: "Tallinn" },
      hash: "h",
      familyHash: null,
      id: "est-capital",
      key: "est-capital",
      tags: [],
      status: "active" as const,
    };
    // Two failures on the laptop and one here: a leech, which neither
    // device's own log could have shown.
    expect(findLeeches([card], history).map((l) => l.lapses)).toEqual([3]);
  });
});
