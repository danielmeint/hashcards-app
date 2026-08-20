// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Card, Grade, Review } from "../types";

/**
 * The stats view had no tests, which is exactly why it is not the place to
 * learn a new way of building views. These are the safety net for that
 * conversion: what the numbers say, and that every section is on screen.
 */

async function freshStats() {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  const [{ renderStats }, db] = await Promise.all([
    import("./stats"),
    import("../db"),
  ]);
  return { renderStats, ...db };
}

const card = (n: number, question = `Q${n}`): Card => ({
  deckName: "aws",
  repo: "someone/cards",
  filePath: "aws.md",
  range: [n, n + 1],
  content: { type: "basic", question, answer: `A${n}` },
  hash: `hash-${n}`,
  familyHash: null,
});

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString();

const performance = (dueDate: string) => ({
  type: "reviewed" as const,
  lastReviewedAt: day(-1),
  stability: 4,
  difficulty: 6,
  intervalRaw: 3,
  intervalDays: 3,
  dueDate,
  reviewCount: 4,
});

const review = (hash: string, grade: Grade, offset: number): Review => ({
  cardHash: hash,
  reviewedAt: day(offset),
  grade,
  stability: 4,
  difficulty: 6,
  intervalRaw: 3,
  intervalDays: 3,
  dueDate: day(1).slice(0, 10),
});

const text = (container: HTMLElement, selector: string) =>
  container.querySelector(selector)?.textContent?.trim();

describe("the stats view", () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  /** Cards where the app reads them: the deck store, keyed by collection. */
  async function seedCards(
    db: { updateDeckFiles: typeof import("../db").updateDeckFiles },
    cards: Card[]
  ): Promise<void> {
    await db.updateDeckFiles(
      [{ repo: cards[0].repo, path: cards[0].filePath, sha: "sha-1", cards }],
      []
    );
    const { loadCards } = await import("../sync");
    await loadCards();
  }

  async function seed() {
    const stats = await freshStats();
    await seedCards(stats, [card(1), card(2), card(3), card(4)]);
    const today = new Date().toISOString().slice(0, 10);
    await stats.importState({
      "hash-1": performance(today),
      "hash-2": performance(today),
      "hash-3": performance(day(30).slice(0, 10)),
    });
    // hash-1 has failed enough to be a leech; hash-2 has not.
    for (const [hash, grades] of [
      ["hash-1", [Grade.Forgot, Grade.Forgot, Grade.Forgot, Grade.Good]],
      ["hash-2", [Grade.Good, Grade.Easy]],
    ] as const) {
      for (const [i, grade] of grades.entries()) {
        await stats.persistReview(hash, performance(today), review(hash, grade, -grades.length + i), {
          queue: [],
          requeued: [],
          completed: [],
          gradedNew: [],
          totalCards: 1,
          startedAt: day(-1),
        });
      }
    }
    return stats;
  }

  it("counts what is known, learned and due", async () => {
    const { renderStats } = await seed();

    await renderStats(container, () => {});

    const boxes = [...container.querySelectorAll(".stat-box")].map((box) => [
      box.querySelector(".stat-label")?.textContent,
      box.querySelector(".stat-value")?.textContent,
    ]);
    expect(boxes).toContainEqual(["Total cards", "4"]);
    expect(boxes).toContainEqual(["Learned", "3"]);
    expect(boxes).toContainEqual(["Due today", "2"]);
  });

  it("lists the card that keeps failing, with a way to rewrite it", async () => {
    const { renderStats } = await seed();
    localStorage.setItem("github_owner", "me");
    localStorage.setItem("github_repo", "cards");

    await renderStats(container, () => {});

    expect(text(container, ".leech-text")).toBe("Q1");
    expect(text(container, ".leech-meta")).toContain("3 of 4 reviews failed");
    expect(container.querySelector(".leech-edit")).not.toBeNull();
  });

  it("draws a cell for every day of the heatmap and a bar for every forecast day", async () => {
    const { renderStats } = await seed();

    await renderStats(container, () => {});

    const cells = container.querySelectorAll("#heatmap .heatmap-cell");
    expect(cells.length % 7).toBe(0);
    expect(cells.length).toBeGreaterThan(180);
    // Today plus a fortnight.
    expect(container.querySelectorAll("#forecast .forecast-bar-wrapper")).toHaveLength(15);
    expect(text(container, "#forecast .forecast-bar-label")).toBe("Today");
  });

  it("breaks the last month down by grade", async () => {
    const { renderStats } = await seed();

    await renderStats(container, () => {});

    const rows = [...container.querySelectorAll(".grade-row")].map((row) => [
      row.querySelector(".grade-label")?.textContent?.trim(),
      row.querySelector(".grade-count")?.textContent?.trim(),
    ]);
    expect(rows).toEqual([
      ["Forgot", "3"],
      ["Hard", "0"],
      ["Good", "2"],
      ["Easy", "1"],
    ]);
  });

  it("says so rather than drawing an empty chart when nothing has been reviewed", async () => {
    const { renderStats } = await freshStats();
    await seedCards(await import("../db"), [card(1)]);

    await renderStats(container, () => {});

    expect(container.textContent).toContain("No reviews in the last 30 days");
    expect(container.textContent).toContain("Nothing has failed");
  });

  it("goes back", async () => {
    const { renderStats } = await seed();
    let backs = 0;

    await renderStats(container, () => backs++);
    (container.querySelector("#back-btn") as HTMLButtonElement).click();

    expect(backs).toBe(1);
  });
});
