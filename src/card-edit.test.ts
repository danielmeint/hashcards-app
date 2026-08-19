// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { GitHubConfig } from "./github";
import { Grade } from "./types";

const CONFIG: GitHubConfig = { owner: "someone", repo: "cards", branch: "main" };

/** A repo that serves and accepts single files, SHA-checked the way GitHub is. */
class FakeRepo {
  files = new Map<string, { text: string; sha: string }>();
  commits: { path: string; message: string; text: string | null }[] = [];
  private n = 0;

  set(path: string, text: string): void {
    this.files.set(path, { text, sha: `sha-${++this.n}` });
  }

  handler = (url: string, init?: RequestInit): Response => {
    if (url.includes("/git/trees/")) {
      return new Response(JSON.stringify({ tree: [] }), { status: 200 });
    }
    const match = url.match(/\/contents\/([^?]+)/);
    if (!match) throw new Error(`Unexpected request: ${url}`);
    const path = decodeURIComponent(match[1]);
    const existing = this.files.get(path);

    if (init?.method === "PUT" || init?.method === "DELETE") {
      const body = JSON.parse(String(init.body)) as {
        content?: string;
        sha?: string;
        message: string;
      };
      if ((body.sha ?? null) !== (existing?.sha ?? null)) {
        return new Response(JSON.stringify({ message: "does not match" }), {
          status: 409,
        });
      }
      if (init.method === "DELETE") {
        this.files.delete(path);
        this.commits.push({ path, message: body.message, text: null });
        return new Response(JSON.stringify({}), { status: 200 });
      }
      const text = new TextDecoder().decode(
        Uint8Array.from(atob(body.content!), (c) => c.charCodeAt(0))
      );
      this.set(path, text);
      this.commits.push({ path, message: body.message, text });
      return new Response(
        JSON.stringify({ content: { sha: this.files.get(path)!.sha } }),
        { status: 200 }
      );
    }

    if (!existing) return new Response(null, { status: 404 });
    const content = btoa(
      String.fromCharCode(...new TextEncoder().encode(existing.text))
    );
    return new Response(JSON.stringify({ content, sha: existing.sha }), {
      status: 200,
    });
  };
}

let repo: FakeRepo;

/** A fresh module graph, a fresh database, and the repo's cards already loaded. */
async function freshEdit(path: string, text: string) {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  repo = new FakeRepo();
  repo.set(path, text);
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    repo.handler(String(input), init)
  ) as unknown as typeof fetch;

  const { saveCredential } = await import("./auth");
  await saveCredential({ kind: "pat", token: "token" });

  const { parseFile } = await import("./parser");
  const { updateDeckFiles } = await import("./db");
  const cards = await parseFile(text, path, "deck");
  await updateDeckFiles([{ path, sha: repo.files.get(path)!.sha, cards }], []);

  const sync = await import("./sync");
  await sync.loadCards();
  return { ...(await import("./card-edit")), db: await import("./db"), sync };
}

const FILE = `Q: What does S3 stand for?
A: Simple Storage Service

Q: What is the default S3 durability?
A: Eleven nines

C: The capital of [France] is [Paris]
`;

const performance = {
  type: "reviewed" as const,
  lastReviewedAt: "2026-01-01T00:00:00.000Z",
  stability: 3,
  difficulty: 5,
  intervalRaw: 3,
  intervalDays: 3,
  dueDate: "2026-02-01",
  reviewCount: 7,
};

describe("splicing a card back into its file", () => {
  const file = "one\ntwo\nthree\nfour\n";

  it("takes the lines a range names, 1-based and inclusive", async () => {
    const { sliceLines } = await import("./card-edit");
    expect(sliceLines(file, [2, 3])).toBe("two\nthree");
  });

  it("puts a replacement of a different length in their place", async () => {
    const { spliceLines } = await import("./card-edit");
    expect(spliceLines(file, [2, 3], "TWO\nAND\nTHREE")).toBe(
      "one\nTWO\nAND\nTHREE\nfour\n"
    );
  });

  it("removes the lines outright when the replacement is empty", async () => {
    const { spliceLines } = await import("./card-edit");
    expect(spliceLines(file, [2, 3], "   ")).toBe("one\nfour\n");
  });

  it("does not let a trailing newline in the box grow the file", async () => {
    const { spliceLines } = await import("./card-edit");
    expect(spliceLines(file, [2, 2], "TWO\n\n")).toBe("one\nTWO\nthree\nfour\n");
  });
});

describe("committing a card edit", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("rewrites only the card's own lines", async () => {
    const { readCardSource, commitCardEdit, sync } = await freshEdit("a.md", FILE);
    const card = (await sync.loadCachedCards())[1];
    const source = await readCardSource(CONFIG, card);

    expect(source.text).toBe(
      "Q: What is the default S3 durability?\nA: Eleven nines"
    );

    await commitCardEdit(CONFIG, card, source, "Q: How durable is S3?\nA: 99.999999999%", {
      keepScheduling: true,
    });

    expect(repo.files.get("a.md")!.text).toBe(
      `Q: What does S3 stand for?
A: Simple Storage Service

Q: How durable is S3?
A: 99.999999999%

C: The capital of [France] is [Paris]
`
    );
  });

  it("carries the card's scheduling and its history onto the new hash", async () => {
    const { readCardSource, commitCardEdit, db, sync } = await freshEdit("a.md", FILE);
    const card = (await sync.loadCachedCards())[1];
    await db.importState({ [card.hash]: performance });
    await db.persistReview(
      card.hash,
      performance,
      {
        cardHash: card.hash,
        reviewedAt: "2026-01-01T00:00:00.000Z",
        grade: Grade.Forgot,
        stability: 3,
        difficulty: 5,
        intervalRaw: 3,
        intervalDays: 3,
        dueDate: "2026-02-01",
      },
      {
        queue: [],
        requeued: [],
        completed: [card.hash],
        gradedNew: [],
        totalCards: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
      }
    );
    const source = await readCardSource(CONFIG, card);

    const result = await commitCardEdit(
      CONFIG,
      card,
      source,
      "Q: How durable is S3?\nA: 99.999999999%",
      { keepScheduling: true }
    );

    expect(result.migrated).toBe(1);
    const fresh = result.cards[0];
    expect(fresh.hash).not.toBe(card.hash);
    // Seven reviews of work, still attached to the card it belongs to...
    expect((await db.getAllPerformances()).get(fresh.hash)?.reviewCount).toBe(7);
    // ...including the failures, so a rewritten leech is still tracked as one
    // rather than quietly leaving the list because its hash changed.
    const reviews = await db.getAllReviews();
    expect(reviews.map((r) => r.cardHash)).toEqual([fresh.hash]);
  });

  it("starts the card over when the user asks it to", async () => {
    const { readCardSource, commitCardEdit, db, sync } = await freshEdit("a.md", FILE);
    const card = (await sync.loadCachedCards())[1];
    await db.importState({ [card.hash]: performance });
    const source = await readCardSource(CONFIG, card);

    const result = await commitCardEdit(
      CONFIG,
      card,
      source,
      "Q: How durable is S3?\nA: 99.999999999%",
      { keepScheduling: false }
    );

    expect(result.migrated).toBe(0);
    expect((await db.getAllPerformances()).has(result.cards[0].hash)).toBe(false);
  });

  it("handles a card being split into two, which is the usual leech fix", async () => {
    const { readCardSource, commitCardEdit, db, sync } = await freshEdit("a.md", FILE);
    const card = (await sync.loadCachedCards())[1];
    await db.importState({ [card.hash]: performance });
    const source = await readCardSource(CONFIG, card);

    // "A card that fails repeatedly is usually two questions in one" — so the
    // replacement is routinely longer than what it replaced, and the cards
    // after it move down the file.
    const result = await commitCardEdit(
      CONFIG,
      card,
      source,
      "Q: How many nines of durability does S3 offer?\nA: Eleven\n\nQ: How many nines of availability?\nA: Four",
      { keepScheduling: true }
    );

    expect(result.cards).toHaveLength(2);
    // The history goes to the first of them; there is only one card's worth of
    // it, and no way to tell which half inherited the work.
    expect(result.migrated).toBe(1);
    const performances = await db.getAllPerformances();
    expect(performances.has(result.cards[0].hash)).toBe(true);
    expect(performances.has(result.cards[1].hash)).toBe(false);
    // The cloze card below it is still there, three lines further down.
    const all = await sync.loadCachedCards();
    expect(all.filter((c) => c.content.type === "cloze")).toHaveLength(2);
  });

  it("deletes a card when the box is cleared", async () => {
    const { readCardSource, commitCardEdit, sync } = await freshEdit("a.md", FILE);
    const card = (await sync.loadCachedCards())[1];
    const source = await readCardSource(CONFIG, card);

    const result = await commitCardEdit(CONFIG, card, source, "", {
      keepScheduling: true,
    });

    expect(result.cards).toEqual([]);
    expect(repo.files.get("a.md")!.text).not.toContain("durability");
    expect(repo.commits[0].message).toBe("Remove a card from a.md");
    // The other cards in the file are untouched.
    expect((await sync.loadCachedCards()).map((c) => c.filePath)).toHaveLength(3);
  });

  it("deletes the file when its last card goes", async () => {
    const only = "Q: Only card\nA: Yes\n";
    const { readCardSource, commitCardEdit, sync } = await freshEdit("solo.md", only);
    const card = (await sync.loadCachedCards())[0];
    const source = await readCardSource(CONFIG, card);

    const result = await commitCardEdit(CONFIG, card, source, "", {
      keepScheduling: true,
    });

    expect(result.removedFile).toBe(true);
    expect(repo.files.has("solo.md")).toBe(false);
    // An empty deck in the list would be worse than no deck.
    expect(await sync.loadCachedCards()).toEqual([]);
  });

  it("survives the text cards are actually written in", async () => {
    const { readCardSource, commitCardEdit, sync } = await freshEdit("a.md", FILE);
    const card = (await sync.loadCachedCards())[1];
    const source = await readCardSource(CONFIG, card);

    // `btoa` takes one byte per character and throws on everything here.
    const text = "Q: What is 2 × 2 — really?\nA: Ça fait quatre 🇫🇷";
    const result = await commitCardEdit(CONFIG, card, source, text, {
      keepScheduling: true,
    });

    expect(repo.files.get("a.md")!.text).toContain("Ça fait quatre 🇫🇷");
    expect(result.cards[0].content).toMatchObject({
      answer: "Ça fait quatre 🇫🇷",
    });
  });

  it("records the file it just wrote, so the next sync does not refetch it", async () => {
    const { readCardSource, commitCardEdit, db } = await freshEdit("a.md", FILE);
    const { loadCachedCards } = await import("./sync");
    const card = (await loadCachedCards())[1];
    const source = await readCardSource(CONFIG, card);

    await commitCardEdit(CONFIG, card, source, "Q: Durable?\nA: Very", {
      keepScheduling: true,
    });

    const [stored] = await db.getAllDeckFiles();
    expect(stored.sha).toBe(repo.files.get("a.md")!.sha);
    expect(
      stored.cards.map((c) => (c.content.type === "basic" ? c.content.question : ""))
    ).toContain("Durable?");
  });

  it("refuses to overwrite a file that moved since it was opened", async () => {
    const { readCardSource, commitCardEdit, sync } = await freshEdit("a.md", FILE);
    const { ConflictError } = await import("./github");
    const card = (await sync.loadCachedCards())[1];
    const source = await readCardSource(CONFIG, card);

    // Someone edits the file on GitHub while the sheet is open. Splicing by
    // line number into bytes we have not seen is how an edit eats someone
    // else's, so this one fails and says so.
    repo.set("a.md", "Q: Something else entirely\nA: Indeed\n");

    await expect(
      commitCardEdit(CONFIG, card, source, "Q: Durable?\nA: Very", {
        keepScheduling: true,
      })
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
