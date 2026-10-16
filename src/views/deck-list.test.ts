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
    repo: "someone/cards",
    filePath,
    range: [n, n + 1],
    content: { type: "basic", question: `Q${n}`, answer: `A${n}` },
    hash: `hash-${n}`,
    familyHash: `hash-${n}`,
    legacyKey: null, key: "", tags: [], status: "active",
  };
}

/**
 * Put cards where the app actually reads them. This used to write the retired
 * `cached_cards` blob and lean on the database upgrade to carry it across,
 * which stopped describing anything real once deck files were keyed by
 * collection.
 */
async function cache(cards: Card[]): Promise<void> {
  const { updateDeckFiles } = await import("../db");
  const byFile = new Map<string, Card[]>();
  for (const card of cards) {
    const list = byFile.get(card.filePath) ?? [];
    list.push(card);
    byFile.set(card.filePath, list);
  }
  await updateDeckFiles(
    [...byFile].map(([path, cards]) => ({
      repo: cards[0].repo,
      path,
      sha: `sha-${path}`,
      cards,
    })),
    []
  );
  const { loadCards } = await import("../sync");
  await loadCards();
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
    await cache([card(1, "Alpha"), card(2, "Alpha"), card(3, "Beta")]);

    await renderDeckList(container, () => {}, () => {}, () => {});

    expect(deckNames(container)).toEqual(["Alpha", "Beta"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says which decks do not parse, opens on them, and links to the line", async () => {
    localStorage.setItem("repos", JSON.stringify([{ owner: "someone", repo: "cards", branch: "main" }]));
    const { renderDeckList } = await freshDeckList();
    await cache([card(1, "Alpha")]);
    const { updateDeckFiles } = await import("../db");
    await updateDeckFiles([
      { repo: "someone/cards", path: "geo/Baltics.md", sha: "x", cards: [], problem: { message: "Found answer tag without a question.", line: 12 } },
    ]);
    await (await import("../sync")).loadCards();

    await renderDeckList(container, () => {}, () => {}, () => {});

    const panel = container.querySelector<HTMLDetailsElement>("#deck-problems")!;
    expect(panel.open).toBe(true);
    expect(panel.querySelector("summary")!.textContent).toBe("A deck doesn't parse");
    expect(panel.textContent).toContain("Found answer tag without a question.");
    expect(panel.textContent).toContain("None of its cards can be shown until it is fixed.");
    expect(panel.querySelector("a")!.getAttribute("href")).toBe(
      "https://github.com/someone/cards/blob/main/geo/Baltics.md#L12"
    );
    // The rest of Today is still there.
    expect(deckNames(container)).toEqual(["Alpha"]);
  });

  it("folds away cards written twice, and shows nothing when all is well", async () => {
    const { renderDeckList } = await freshDeckList();
    await cache([card(1, "Alpha")]);
    await renderDeckList(container, () => {}, () => {}, () => {});
    expect(container.querySelector("#deck-problems")).toBeNull();

    const { updateDeckFiles } = await import("../db");
    await updateDeckFiles([
      { repo: "someone/cards", path: "Beta.md", sha: "y", cards: [card(2, "Beta")], duplicates: [{ line: 7, firstLine: 1 }] },
    ]);
    await (await import("../sync")).loadCards();
    await renderDeckList(container, () => {}, () => {}, () => {});
    const panel = container.querySelector<HTMLDetailsElement>("#deck-problems")!;
    expect(panel.open).toBe(false);
    expect(panel.querySelector("summary")!.textContent).toBe("A card is in your decks twice");
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
    await cache([card(1, "Alpha")]);

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
    await cache([card(1, "Alpha")]);

    await renderDeckList(container, () => {}, () => {}, () => {});
    // The row says what the deck offers: its size, then what is due or new.
    const counts = () => container.querySelector(".deck-row")!.textContent!;
    expect(counts()).toContain("1 new");

    // What a completed state sync leaves behind: scheduling pulled from another
    // device, which turns an unseen card into a due review.
    const { importState } = await import("../db");
    await importState({
      "someone/cards/h:hash-1": {
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
      expect(counts()).toContain("1 due");
      expect(counts()).not.toContain("new");
    });
  });

  it("stops listening once torn down, so a late sync can't repaint a view the user left", async () => {
    const { renderDeckList, setSyncStatus } = await freshDeckList();
    await cache([card(1, "Alpha")]);

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
    [...container.querySelectorAll(".deck-row")].map((el) => el.textContent!);

  it("keeps same-named files in different directories apart", async () => {
    const { renderDeckList } = await freshDeckList();
    await cache([
      card(1, "Networking", "aws/Networking.md"),
      card(2, "Networking", "aws/Networking.md"),
      card(3, "Networking", "misc/Networking.md"),
    ]);

    await renderDeckList(container, () => {}, () => {}, () => {});

    // Two decks, both displaying the same name.
    expect(deckNames(container)).toEqual(["Networking", "Networking"]);
    expect(counts(container)[0]).toContain("2 cards");
    expect(counts(container)[1]).toContain("1 card");
  });

  it("groups decks under their directory, repo root first", async () => {
    const { renderDeckList } = await freshDeckList();
    await cache([
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
    await cache([
      card(1, "Networking", "aws/Networking.md"),
      card(2, "Networking", "misc/Networking.md"),
    ]);

    const drilled: Card[][] = [];
    await renderDeckList(container, (cards) => drilled.push(cards), () => {}, () => {});

    // The whole row is the button now, rather than a Drill button inside it.
    const buttons = [...container.querySelectorAll("button.deck-row")];
    (buttons[0] as HTMLButtonElement).click();

    expect(drilled).toHaveLength(1);
    expect(drilled[0].map((c) => c.filePath)).toEqual(["aws/Networking.md"]);
  });

  it("shows each deck's real supply but promises only what the budget allows", async () => {
    const { renderDeckList } = await freshDeckList();
    localStorage.setItem("new_cards_per_day", "2");
    await cache([
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
    // The summary above Start has to promise what pressing it actually gives.
    // Clamping each deck to the global budget and adding them up said "4 new".
    expect(container.querySelector("#due-summary")!.textContent).toContain(
      "2 new"
    );
  });

  it("hands the drill only as many new cards as the budget allows", async () => {
    const { renderDeckList } = await freshDeckList();
    localStorage.setItem("new_cards_per_day", "2");
    await cache([
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

  it("says it is caught up, rather than offering an empty review, when nothing is due", async () => {
    const { renderDeckList } = await freshDeckList();
    localStorage.setItem("new_cards_per_day", "1");
    await cache([card(1, "A", "a.md"), card(2, "A", "a.md")]);
    // Today's one new card, started on another deck: the budget is spent.
    const { importReviews } = await import("../db");
    await importReviews([
      {
        key: "someone/cards/h:0123456789abcdef",
        log: "someone/cards",
        tz: -new Date().getTimezoneOffset(),
        cardHash: "other",
        reviewedAt: new Date().toISOString(),
        grade: 3,
        stability: 2,
        difficulty: 5,
        intervalRaw: 2,
        intervalDays: 2,
        dueDate: "2999-01-01",
      },
    ]);

    await renderDeckList(container, () => {}, () => {}, () => {});

    expect(container.querySelector("#drill-all")).toBeNull();
    expect(container.textContent).toContain("All caught up");
    // The deck still says what it holds, without promising it today.
    expect(counts(container)[0]).toContain("2 new left");
  });

  it("starts the review on Space, and stops listening once torn down", async () => {
    const { renderDeckList } = await freshDeckList();
    await cache([card(1, "A", "a.md")]);

    const drilled: Card[][] = [];
    const dispose = await renderDeckList(container, (c) => drilled.push(c), () => {}, () => {});
    document.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    expect(drilled).toHaveLength(1);

    dispose();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    expect(drilled).toHaveLength(1);
  });

  /**
   * Quick capture lives here because this is the screen you are on when you are
   * not drilling, and it is the one that already knows every deck by name.
   */
  describe("writing a new card", () => {
    const sheet = () => document.querySelector(".capture-text");
    const decks = () =>
      [...document.querySelectorAll(".capture-deck option")].map((o) =>
        (o.textContent ?? "").trim()
      );

    async function until(done: () => boolean, label: string): Promise<void> {
      for (let i = 0; i < 200; i++) {
        if (done()) return;
        await new Promise((r) => setTimeout(r, 0));
      }
      throw new Error(`Timed out waiting for ${label}`);
    }

    it("opens a sheet listing every deck, plus somewhere new", async () => {
      const { renderDeckList } = await freshDeckList();
      localStorage.setItem("github_owner", "someone");
      localStorage.setItem("github_repo", "cards");
      await cache([card(1, "Alpha", "Alpha.md"), card(2, "Beta", "sub/Beta.md")]);

      await renderDeckList(container, () => {}, () => {}, () => {});
      (container.querySelector("#new-card-btn") as HTMLButtonElement).click();
      await until(() => sheet() !== null, "the capture sheet");

      // The folder is part of the name here: two decks can be called the same
      // thing, and the picker is where that has to be told apart.
      expect(decks()).toEqual(["Alpha", "sub/Beta", "New deck…"]);
    });

    it("sends an unconfigured app to Settings instead", async () => {
      const { renderDeckList } = await freshDeckList();
      await cache([card(1, "Alpha", "Alpha.md")]);
      let settingsOpened = false;

      await renderDeckList(
        container,
        () => {},
        () => {
          settingsOpened = true;
        },
        () => {}
      );
      (container.querySelector("#new-card-btn") as HTMLButtonElement).click();
      await until(() => settingsOpened, "settings to be opened");

      expect(sheet()).toBeNull();
    });

    /**
     * A repository that syncs cleanly and holds no decks is the one case where
     * there is no header to hang the button on — and the one that most needs
     * somewhere to write a first card.
     */
    it("offers itself on the empty screen too, once a repo is configured", async () => {
      const { renderDeckList } = await freshDeckList();
      localStorage.setItem("github_owner", "someone");
      localStorage.setItem("github_repo", "cards");
      await cache([]);

      await renderDeckList(container, () => {}, () => {}, () => {});

      expect(container.querySelector("#new-card-btn")).not.toBeNull();
    });

    it("does not, when there is no repo to write to", async () => {
      const { renderDeckList } = await freshDeckList();
      await cache([]);

      await renderDeckList(container, () => {}, () => {}, () => {});

      expect(container.querySelector("#new-card-btn")).toBeNull();
    });
  });
});
