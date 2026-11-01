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
  familyHash: `hash-${n}`,
  legacyKey: null, key: `k${n}`, tags: [], status: "active",
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

/** The app's key for `card(n)`. */
const keyOf = (n: number) => `someone/cards/k${n}`;

const review = (n: number, grade: Grade, offset: number): Review => ({
  key: keyOf(n),
  log: "someone/cards",
  tz: 0,
  cardHash: `hash-${n}`,
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
      [keyOf(1)]: performance(today),
      [keyOf(2)]: performance(today),
      [keyOf(3)]: performance(day(30).slice(0, 10)),
    });
    const { orderOf, compareOrder } = await import("../core/replay");
    // Card 1 has failed enough to be a leech; card 2 has not.
    for (const [n, grades] of [
      [1, [Grade.Forgot, Grade.Forgot, Grade.Forgot, Grade.Good]],
      [2, [Grade.Good, Grade.Easy]],
    ] as const) {
      for (const [i, grade] of grades.entries()) {
        const state = {
          ...performance(today),
          lastDay: today,
          lastGrade: null,
          key: keyOf(n),
          group: "someone/cards",
          card: `k${n}`,
        };
        const at = day(-grades.length + i);
        const event = { v: 2, kind: "review", card: `k${n}`, at, tz: 0, grade } as const;
        await stats.persistReview(review(n, grade, -grades.length + i), state, orderOf(event), {
          queue: [],
          requeued: [],
          completed: [],
          gradedNew: [],
          totalCards: 1,
          startedAt: day(-1),
        }, compareOrder);
      }
    }
    return stats;
  }

  it("counts every device's reviews, and only cards that still exist", async () => {
    const stats = await freshStats();
    await seedCards(stats, [card(1), card(2)]);
    // This device graded card 1 yesterday; a laptop graded card 2 today and
    // the day before, and a card since deleted.
    const { utcOffsetMinutes: tzOf } = await import("../core/schedule");
    await stats.importReviews([{ ...review(1, Grade.Good, -1), tz: tzOf(day(-1)) }]);
    // In this machine's zone, so "today" here is today there.
    const { utcOffsetMinutes } = await import("../core/schedule");
    const at = (offset: number) => ({ at: day(offset), tz: utcOffsetMinutes(day(offset)) });
    const events = [
      { v: 2 as const, kind: "review" as const, card: "k2", ...at(0), grade: 1 as const },
      { v: 2 as const, kind: "review" as const, card: "k2", ...at(-2), grade: 3 as const },
      { v: 2 as const, kind: "review" as const, card: "gone", ...at(-3), grade: 4 as const },
    ];
    await stats.updatePulledFiles([{ repo: "someone/cards", path: "reviews/2026-10.laptop1.jsonl", sha: "s", events }]);
    const { refreshStates } = await import("../review-state");
    await refreshStates();

    await stats.renderStats(container, () => {});

    expect(text(container, ".grades-panel .panel-head span")).toBe("4 reviews");
    const boxes = Object.fromEntries(
      [...container.querySelectorAll(".stat-box")].map((box) => [
        box.querySelector(".stat-label")?.textContent,
        box.querySelector(".stat-value")?.textContent,
      ])
    );
    // Today, yesterday (here), two days ago, three days ago: an unbroken run.
    expect(boxes.streak).toBe("4 days");
    // The deleted card's schedule is in the replay, but it is not a card.
    expect(boxes.cards).toBe("2");
    expect(boxes.learned).toBe("2");
  });

  it("counts what is known, learned and due", async () => {
    const { renderStats } = await seed();

    await renderStats(container, () => {});

    const boxes = [...container.querySelectorAll(".stat-box")].map((box) => [
      box.querySelector(".stat-label")?.textContent,
      box.querySelector(".stat-value")?.textContent,
    ]);
    expect(boxes).toContainEqual(["cards", "4"]);
    expect(boxes).toContainEqual(["learned", "3"]);
    expect(boxes).toContainEqual(["due today", "2"]);
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
    // A fortnight, starting today — "Next 14 days" on screen.
    expect(container.querySelectorAll("#forecast .forecast-bar-wrapper")).toHaveLength(14);
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

  describe("for some of the decks", () => {
    const at = (n: number, filePath: string, deckName: string): Card => ({ ...card(n), filePath, deckName });

    async function seedDecks() {
      const stats = await freshStats();
      const cards = [
        at(1, "Geo.md", "Geo"),
        at(2, "lang/Spanish.md", "Spanish"),
        at(3, "lang/es/Verbs.md", "Verbs"),
        { ...at(4, "lang/Drafts.md", "Drafts"), status: "draft" as const },
      ];
      await stats.updateDeckFiles(
        cards.map((c) => ({ repo: c.repo, path: c.filePath, sha: c.filePath, cards: [c] })),
        []
      );
      const { loadCards } = await import("../sync");
      await loadCards();
      // Every card reviewed once: Geo yesterday, Spanish twice.
      await stats.importReviews([
        review(1, Grade.Good, -1),
        review(2, Grade.Forgot, -2),
        review(2, Grade.Good, -1),
        review(3, Grade.Easy, -1),
      ]);
      const today = new Date().toISOString().slice(0, 10);
      await stats.importState({
        [keyOf(1)]: performance(today),
        [keyOf(2)]: performance(day(30).slice(0, 10)),
      });
      return stats;
    }

    const pick = async (container: HTMLElement, label: string) => {
      const select = container.querySelector("#stats-scope") as HTMLSelectElement;
      const option = [...select.options].find((o) => o.textContent!.trim() === label)!;
      select.value = option.value;
      select.dispatchEvent(new Event("change"));
    };
    const box = (container: HTMLElement, label: string) =>
      [...container.querySelectorAll(".stat-box")]
        .find((b) => b.querySelector(".stat-label")?.textContent === label)
        ?.querySelector(".stat-value")?.textContent;

    it("offers every deck, under its folder as on Today, and each folder whole", async () => {
      const { renderStats } = await seedDecks();
      await renderStats(container, () => {});

      const select = container.querySelector("#stats-scope") as HTMLSelectElement;
      expect([...select.querySelectorAll(":scope > option")].map((o) => o.textContent!.trim())).toEqual([
        "All decks",
        "Geo",
      ]);
      expect(
        [...select.querySelectorAll("optgroup")].map((g) => [
          g.label,
          [...g.querySelectorAll("option")].map((o) => o.textContent!.trim()),
        ])
      ).toEqual([
        ["lang", ["All of lang", "Spanish"]],
        ["lang · es", ["All of lang · es", "Verbs"]],
      ]);
    });

    it("narrows every number to the folder or deck picked, reviews included", async () => {
      const { renderStats } = await seedDecks();
      await renderStats(container, () => {});
      expect(box(container, "cards")).toBe("3");
      expect(text(container, ".grades-panel .panel-head span")).toBe("4 reviews");

      // A folder takes its subfolders with it.
      // The view re-reads and repaints.
      await pick(container, "All of lang");
      await vi.waitFor(() => expect(box(container, "cards")).toBe("2"));
      expect(box(container, "learned")).toBe("1");
      expect(text(container, ".grades-panel .panel-head span")).toBe("3 reviews");

      await pick(container, "Geo");
      await vi.waitFor(() => expect(box(container, "cards")).toBe("1"));
      expect(box(container, "due today")).toBe("1");
      expect(text(container, ".grades-panel .panel-head span")).toBe("1 review");

      // Kept for the next visit, as long as that deck is still there.
      await renderStats(container, () => {});
      expect(box(container, "cards")).toBe("1");

      expect(
        (container.querySelector("#stats-scope") as HTMLSelectElement).selectedOptions[0].textContent!.trim()
      ).toBe("Geo");

      await pick(container, "All decks");
      await vi.waitFor(() => expect(box(container, "cards")).toBe("3"));
    });

    it("has nothing to pick for a collection of one deck", async () => {
      const { renderStats } = await seed();
      await renderStats(container, () => {});
      expect(container.querySelector("#stats-scope")).toBeNull();
    });
  });

  it("goes back", async () => {
    const { renderStats } = await seed();
    let backs = 0;

    await renderStats(container, () => backs++);
    (container.querySelector("#back-btn") as HTMLButtonElement).click();

    expect(backs).toBe(1);
  });
});
