// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Card } from "../types";

/**
 * The list of collections: which repositories the app reads, and which of them
 * it may write to. A subscription is someone else's deck repository — read for
 * its cards, never committed to — which is what makes a public deck an ordinary
 * GitHub repo rather than a new protocol.
 */

let container: HTMLElement;

async function fresh() {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ tree: [] }), { status: 200 })
  ) as unknown as typeof fetch;
  const [collections, github, db] = await Promise.all([
    import("./collections"),
    import("../github"),
    import("../db"),
  ]);
  return { ...collections, ...github, ...db };
}

function mine(): void {
  localStorage.setItem(
    "repos",
    JSON.stringify([{ owner: "me", repo: "cards", branch: "main" }])
  );
}

const $ = <T extends Element>(sel: string) => container.querySelector(sel) as T;
const rows = () =>
  [...container.querySelectorAll(".collection-row")].map(
    (el) => el.getAttribute("data-repo") ?? ""
  );

function type(sel: string, value: string): void {
  const input = $<HTMLInputElement>(sel);
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

async function subscribe(
  owner: string,
  repo: string,
  branch?: string
): Promise<void> {
  $<HTMLButtonElement>(".collection-add-btn").click();
  type(".collection-owner", owner);
  type(".collection-repo", repo);
  if (branch !== undefined) type(".collection-branch", branch);
  $<HTMLButtonElement>(".collection-save").click();
  await new Promise((r) => setTimeout(r, 0));
}

describe("the collections list", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("shows the repository you write to as yours", async () => {
    mine();
    const { renderCollections } = await fresh();
    renderCollections(container, () => {});

    expect(rows()).toEqual(["me/cards"]);
    expect($(".collection-tag").textContent).toContain("yours");
  });

  it("adds a deck repository as read-only, since it is not yours to write to", async () => {
    mine();
    const { renderCollections, getRepos } = await fresh();
    renderCollections(container, () => {});

    await subscribe("someone", "shared-decks");

    expect(getRepos()).toEqual([
      { owner: "me", repo: "cards", branch: "main" },
      { owner: "someone", repo: "shared-decks", branch: "main", readOnly: true },
    ]);
  });

  it("keeps the branch that was typed", async () => {
    mine();
    const { renderCollections, getRepos } = await fresh();
    renderCollections(container, () => {});

    await subscribe("someone", "shared-decks", "trunk");

    expect(getRepos()[1].branch).toBe("trunk");
  });

  it("falls back to main for a branch left blank", async () => {
    mine();
    const { renderCollections, getRepos } = await fresh();
    renderCollections(container, () => {});

    await subscribe("someone", "shared-decks", "   ");

    expect(getRepos()[1].branch).toBe("main");
  });

  it("refuses a collection that is already in the list", async () => {
    mine();
    const { renderCollections, getRepos } = await fresh();
    renderCollections(container, () => {});

    await subscribe("me", "cards");

    expect(getRepos()).toHaveLength(1);
    expect($(".collection-error").textContent).toContain("already in the list");
  });

  it("refuses a half-filled form rather than storing an unreachable repo", async () => {
    mine();
    const { renderCollections, getRepos } = await fresh();
    renderCollections(container, () => {});

    await subscribe("someone", "");

    expect(getRepos()).toHaveLength(1);
    expect($(".collection-error").textContent).toContain("owner and a repository");
  });

  /**
   * The cards go, because a deck list still showing a collection nobody is
   * configured for is showing something that cannot be drilled. The scheduling
   * stays: it is a record of reviews that happened, and re-subscribing should
   * not hand back cards as though they had never been seen.
   */
  it("takes a removed collection's cards with it, and leaves its scheduling", async () => {
    mine();
    const { renderCollections, updateDeckFiles, getAllDeckFiles, importState } =
      await fresh();
    const card: Card = {
      deckName: "Shared",
      repo: "someone/shared-decks",
      filePath: "Shared.md",
      range: [1, 2],
      content: { type: "basic", question: "Q", answer: "A" },
      hash: "hash-1",
      familyHash: null,
    };
    await updateDeckFiles(
      [
        {
          repo: "someone/shared-decks",
          path: "Shared.md",
          sha: "sha-1",
          cards: [card],
        },
      ],
      []
    );
    await importState({
      "hash-1": {
        type: "reviewed",
        lastReviewedAt: "2026-01-01T00:00:00.000Z",
        stability: 3,
        difficulty: 5,
        intervalRaw: 3,
        intervalDays: 3,
        dueDate: "2026-02-01",
        reviewCount: 2,
      },
    });

    renderCollections(container, () => {});
    await subscribe("someone", "shared-decks");
    // The row for the collection just added, not the one for your own repo.
    container.querySelectorAll(".collection-remove")[1].dispatchEvent(
      new MouseEvent("click", { bubbles: true })
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(await getAllDeckFiles()).toEqual([]);
    const { getAllPerformances } = await import("../db");
    expect([...(await getAllPerformances()).keys()]).toEqual(["hash-1"]);
  });

  it("leaves the other collections alone when one is removed", async () => {
    mine();
    const { renderCollections, getRepos } = await fresh();
    renderCollections(container, () => {});
    await subscribe("someone", "shared-decks");

    container.querySelectorAll(".collection-remove")[1].dispatchEvent(
      new MouseEvent("click", { bubbles: true })
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(getRepos()).toEqual([{ owner: "me", repo: "cards", branch: "main" }]);
  });
});
