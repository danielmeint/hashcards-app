// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Card } from "../types";

/**
 * Startup used to await a full card sync and a full state sync before rendering
 * anything, so every cold open was a blank screen for the duration of the
 * network. The invariant here is that the deck list paints from cache without
 * touching the network, and catches up when a background sync lands.
 */

async function freshDeckList() {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  const [{ renderDeckList }, syncState] = await Promise.all([
    import("./deck-list"),
    import("../sync-state"),
  ]);
  return { renderDeckList, ...syncState };
}

function card(
  n: number,
  deckName: string,
  filePath = `${deckName}.md`
): Card {
  return {
    deckName,
    filePath,
    range: [n, n + 1],
    content: { type: "basic", question: `Q${n}`, answer: `A${n}` },
    hash: `hash-${n}`,
    familyHash: null,
  };
}

function cache(cards: Card[]): void {
  localStorage.setItem("cached_cards", JSON.stringify(cards));
}

function deckNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".deck-name")].map(
    (el) => el.textContent!
  );
}

describe("deck list", () => {
  let container: HTMLElement;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);

    fetchSpy = vi.fn(() => Promise.reject(new Error("no network in tests")));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  it("renders cached decks without touching the network", async () => {
    const { renderDeckList } = await freshDeckList();
    cache([card(1, "Alpha"), card(2, "Alpha"), card(3, "Beta")]);

    await renderDeckList(container, () => {}, () => {}, () => {});

    expect(deckNames(container)).toEqual(["Alpha", "Beta"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("distinguishes a first sync in flight from an unconfigured app", async () => {
    const { renderDeckList, setSyncStatus } = await freshDeckList();

    await renderDeckList(container, () => {}, () => {}, () => {});
    expect(container.textContent).toContain("No cards loaded");

    setSyncStatus({ phase: "syncing", detail: null });
    // Cards come from IndexedDB now, so the re-render lands a tick later.
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Loading your cards")
    );
  });

  it("surfaces a sync failure rather than swallowing it", async () => {
    const { renderDeckList, setSyncStatus } = await freshDeckList();
    cache([card(1, "Alpha")]);

    await renderDeckList(container, () => {}, () => {}, () => {});
    setSyncStatus({
      phase: "error",
      message: "Repository not found.",
      needsSignIn: false,
    });

    // The re-render is async; the status listener kicks it off.
    await vi.waitFor(() =>
      expect(container.querySelector(".sync-status")?.textContent).toContain(
        "Repository not found."
      )
    );
  });

  it("patches counts in when a background sync lands", async () => {
    const { renderDeckList, setSyncStatus } = await freshDeckList();
    cache([card(1, "Alpha")]);

    await renderDeckList(container, () => {}, () => {}, () => {});
    const counts = () => container.querySelector(".deck-counts")!.textContent!;
    expect(counts()).toContain("1 new");

    // What a completed state sync leaves behind: scheduling pulled from another
    // device, which turns an unseen card into a due review.
    const { importState } = await import("../db");
    await importState({
      "hash-1": {
        type: "reviewed",
        lastReviewedAt: "2000-01-01T00:00:00.000Z",
        stability: 1,
        difficulty: 5,
        intervalRaw: 1,
        intervalDays: 1,
        dueDate: "2000-01-02",
        reviewCount: 1,
      },
    });
    setSyncStatus({ phase: "idle" });

    await vi.waitFor(() => {
      expect(counts()).toContain("1 review");
      expect(counts()).toContain("0 new");
    });
  });

  it("stops listening once torn down, so a late sync can't repaint a view the user left", async () => {
    const { renderDeckList, setSyncStatus } = await freshDeckList();
    cache([card(1, "Alpha")]);

    const dispose = await renderDeckList(container, () => {}, () => {}, () => {});
    dispose();

    container.innerHTML = "<p>somewhere else</p>";
    setSyncStatus({ phase: "idle" });

    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("somewhere else");
  });
});

/**
 * Deck identity used to be the file's basename, so `aws/Networking.md` and
 * `misc/Networking.md` silently merged into one deck — drilling either one
 * drilled both. Identity is the path now, and the directory is what tells two
 * same-named decks apart on screen.
 */
describe("deck identity", () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("no network in tests"))
    ) as unknown as typeof fetch;
  });

  const counts = (container: HTMLElement) =>
    [...container.querySelectorAll(".deck-counts")].map((el) => el.textContent!);

  it("keeps same-named files in different directories apart", async () => {
    const { renderDeckList } = await freshDeckList();
    cache([
      card(1, "Networking", "aws/Networking.md"),
      card(2, "Networking", "aws/Networking.md"),
      card(3, "Networking", "misc/Networking.md"),
    ]);

    await renderDeckList(container, () => {}, () => {}, () => {});

    // Two decks, both displaying the same name.
    expect(deckNames(container)).toEqual(["Networking", "Networking"]);
    expect(counts(container)[0]).toContain("2 cards");
    expect(counts(container)[1]).toContain("1 cards");
  });

  it("groups decks under their directory, repo root first", async () => {
    const { renderDeckList } = await freshDeckList();
    cache([
      card(1, "DDIA", "DDIA.md"),
      card(2, "S3", "aws/S3.md"),
      card(3, "Networking", "misc/Networking.md"),
    ]);

    await renderDeckList(container, () => {}, () => {}, () => {});

    expect(
      [...container.querySelectorAll(".deck-group-name")].map(
        (el) => el.textContent
      )
    ).toEqual(["aws", "misc"]);
    // Root-level decks come first and get no header.
    expect(deckNames(container)).toEqual(["DDIA", "S3", "Networking"]);
  });

  it("drills only the file that was asked for", async () => {
    const { renderDeckList } = await freshDeckList();
    cache([
      card(1, "Networking", "aws/Networking.md"),
      card(2, "Networking", "misc/Networking.md"),
    ]);

    const drilled: Card[][] = [];
    await renderDeckList(container, (cards) => drilled.push(cards), () => {}, () => {});

    const buttons = [...container.querySelectorAll(".deck-drill-btn")];
    (buttons[0] as HTMLButtonElement).click();

    expect(drilled).toHaveLength(1);
    expect(drilled[0].map((c) => c.filePath)).toEqual(["aws/Networking.md"]);
  });

  it("shows each deck's real supply but promises only what the budget allows", async () => {
    const { renderDeckList } = await freshDeckList();
    localStorage.setItem("new_cards_per_day", "2");
    cache([
      card(1, "A", "a.md"),
      card(2, "A", "a.md"),
      card(3, "A", "a.md"),
      card(4, "B", "b.md"),
      card(5, "B", "b.md"),
      card(6, "B", "b.md"),
    ]);

    await renderDeckList(container, () => {}, () => {}, () => {});

    // Per deck: genuine supply, three each.
    expect(counts(container)[0]).toContain("3 new");
    expect(counts(container)[1]).toContain("3 new");
    // The button has to promise what pressing it actually gives. Clamping each
    // deck to the global budget and adding them up said "4 new" here.
    expect(container.querySelector("#drill-all")!.textContent).toContain(
      "2 new"
    );
  });

  it("hands the drill only as many new cards as the budget allows", async () => {
    const { renderDeckList } = await freshDeckList();
    localStorage.setItem("new_cards_per_day", "2");
    cache([
      card(1, "A", "a.md"),
      card(2, "A", "a.md"),
      card(3, "B", "b.md"),
      card(4, "B", "b.md"),
    ]);

    const drilled: Card[][] = [];
    await renderDeckList(container, (cards) => drilled.push(cards), () => {}, () => {});
    (container.querySelector("#drill-all") as HTMLButtonElement).click();

    expect(drilled[0]).toHaveLength(2);
  });
});
