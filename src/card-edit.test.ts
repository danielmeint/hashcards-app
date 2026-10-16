// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { GitHubConfig } from "./github";

const CONFIG: GitHubConfig = { owner: "someone", repo: "cards", branch: "main" };

/** A repo that serves and accepts single files, SHA-checked the way GitHub is. */
class FakeRepo {
  files = new Map<string, { text: string; sha: string }>();
  commits: { path: string; message: string; text: string | null }[] = [];
  private n = 0;

  set(path: string, text: string): void {
    this.files.set(path, { text, sha: `sha-${++this.n}` });
  }

  /** Blob SHAs the tree reports, when they should differ from the files. */
  treeShas: Map<string, string> | null = null;
  /** Held requests, so a test can pin down an interleaving exactly. */
  hold: { match: string; release: Promise<void> } | null = null;

  handler = async (url: string, init?: RequestInit): Promise<Response> => {
    // No review data branch: nothing has been reviewed in this repo yet.
    if (url.includes("/git/ref/")) return new Response(null, { status: 404 });
    if (url.includes("/git/trees/")) {
      const tree = [...this.files].map(([path, f]) => ({
        path,
        sha: this.treeShas?.get(path) ?? f.sha,
        type: "blob",
      }));
      return new Response(JSON.stringify({ tree }), { status: 200 });
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
    // Snapshotted before the wait, not after: a slow response carries the state
    // the server had when it was asked, which is the whole point of the race.
    const content = btoa(
      String.fromCharCode(...new TextEncoder().encode(existing.text))
    );
    const body = JSON.stringify({ content, sha: existing.sha });
    if (this.hold && url.includes(this.hold.match)) await this.hold.release;
    return new Response(body, { status: 200 });
  };
}

let repo: FakeRepo;

/** A fresh module graph, a fresh database, and the repo's cards already loaded. */
async function freshEdit(path: string, text: string) {
  globalThis.indexedDB = new IDBFactory();
  localStorage.setItem(
    "repos",
    JSON.stringify([{ owner: "someone", repo: "cards", branch: "main" }])
  );

  vi.resetModules();
  repo = new FakeRepo();
  repo.set(path, text);
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    repo.handler(String(input), init)
  ) as unknown as typeof fetch;

  const { saveCredential } = await import("./auth");
  await saveCredential({ kind: "pat", token: "token" });

  const { parseFile } = await import("./parser");
  const { updateDeckFiles } = await import("./db");
  const parsed = await parseFile(text, path, "deck");
  const cards = parsed.map((c) => ({ ...c, repo: "someone/cards" }));
  await updateDeckFiles(
    [{ repo: "someone/cards", path, sha: repo.files.get(path)!.sha, cards }],
    []
  );

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

/**
 * Give `card` seven reviews of history the way the app has any: as events in
 * its collection's log, replayed into the cache.
 */
async function giveHistory(card: { repo: string; key: string }) {
  const db = await import("./db");
  await db.addBaselines([
    {
      log: card.repo,
      event: { v: 2, kind: "baseline", card: card.key, at: "2026-01-01T00:00:00.000Z", tz: 60, s: 3, d: 5, reps: 7 },
    },
  ]);
  await db.markReplayStale(card.repo);
  const { refreshStates } = await import("./review-state");
  await refreshStates();
}

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
    const source = await readCardSource(card);

    expect(source.text).toBe(
      "Q: What is the default S3 durability?\nA: Eleven nines"
    );

    await commitCardEdit(card, source, "Q: How durable is S3?\nA: 99.999999999%", {
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

  it("carries the card's history onto the key its new text gives it, by a link", async () => {
    const { readCardSource, commitCardEdit, db, sync } = await freshEdit("a.md", FILE);
    const card = (await sync.loadCachedCards())[1];
    await giveHistory(card);
    const source = await readCardSource(card);

    const result = await commitCardEdit(
      card,
      source,
      "Q: How durable is S3?\nA: 99.999999999%",
      { keepScheduling: true }
    );

    expect(result.migrated).toBe(1);
    const fresh = result.cards[0];
    // A card is its text, so the edit moved its key.
    expect(db.stateKey(fresh)).not.toBe(db.stateKey(card));
    // Seven reviews of work, still attached to the card it belongs to — by a
    // link from the old key, which every device replays the same.
    const states = await db.getAllPerformances();
    expect(states.get(db.stateKey(fresh))?.reviewCount).toBe(7);
    expect(states.has(db.stateKey(card))).toBe(false);
    const events = (await db.getLocalBaselines()).map((b) => b.event);
    expect(events.at(-1)).toMatchObject({ kind: "link", card: fresh.key, from: card.key, src: "edit" });
  });

  it("needs nothing to carry when only the metadata changed", async () => {
    const text = "Q: What is the default S3 durability?\nA: Eleven nines\n";
    const { readCardSource, commitCardEdit, db, sync } = await freshEdit("b.md", text);
    const [card] = await sync.loadCachedCards();
    await giveHistory(card);
    const source = await readCardSource(card);

    const result = await commitCardEdit(card, source, "Tags: aws\nQ: What is the default  S3 durability?\nA: Eleven nines", {
      keepScheduling: true,
    });

    expect(db.stateKey(result.cards[0])).toBe(db.stateKey(card));
    expect(result.migrated).toBe(1);
    expect((await db.getLocalBaselines()).map((b) => b.event.kind)).toEqual(["baseline"]);
  });

  it("starts the card over when the user asks it to", async () => {
    const { readCardSource, commitCardEdit, db, sync } = await freshEdit("a.md", FILE);
    const card = (await sync.loadCachedCards())[1];
    await giveHistory(card);
    const source = await readCardSource(card);

    const result = await commitCardEdit(
      card,
      source,
      "Q: How durable is S3?\nA: 99.999999999%",
      { keepScheduling: false }
    );

    expect(result.migrated).toBe(0);
    expect((await db.getAllPerformances()).has(db.stateKey(result.cards[0]))).toBe(false);
  });

  it("handles a card being split into two, which is the usual leech fix", async () => {
    const { readCardSource, commitCardEdit, db, sync } = await freshEdit("a.md", FILE);
    const card = (await sync.loadCachedCards())[1];
    await giveHistory(card);
    const source = await readCardSource(card);

    // "A card that fails repeatedly is usually two questions in one" — so the
    // replacement is routinely longer than what it replaced, and the cards
    // after it move down the file.
    const result = await commitCardEdit(
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
    expect(performances.has(db.stateKey(result.cards[0]))).toBe(true);
    expect(performances.has(db.stateKey(result.cards[1]))).toBe(false);
    // The cloze card below it is still there, three lines further down.
    const all = await sync.loadCachedCards();
    expect(all.filter((c) => c.content.type === "cloze")).toHaveLength(2);
  });

  it("deletes a card when the box is cleared", async () => {
    const { readCardSource, commitCardEdit, sync } = await freshEdit("a.md", FILE);
    const card = (await sync.loadCachedCards())[1];
    const source = await readCardSource(card);

    const result = await commitCardEdit(card, source, "", {
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
    const source = await readCardSource(card);

    const result = await commitCardEdit(card, source, "", {
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
    const source = await readCardSource(card);

    // `btoa` takes one byte per character and throws on everything here.
    const text = "Q: What is 2 × 2 — really?\nA: Ça fait quatre 🇫🇷";
    const result = await commitCardEdit(card, source, text, {
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
    const source = await readCardSource(card);

    await commitCardEdit(card, source, "Q: Durable?\nA: Very", {
      keepScheduling: true,
    });

    const [stored] = await db.getAllDeckFiles();
    expect(stored.sha).toBe(repo.files.get("a.md")!.sha);
    expect(
      stored.cards.map((c) => (c.content.type === "basic" ? c.content.question : ""))
    ).toContain("Durable?");
  });

  it("does not commit into the window a sync is holding open", async () => {
    const { readCardSource, commitCardEdit, db, sync } = await freshEdit("a.md", FILE);
    const card = (await sync.loadCachedCards())[1];
    const source = await readCardSource(card);

    // A sync is pulling a change another device made to this same file, and its
    // content fetch is slow. Everything it is about to write into the deck
    // store was read before the edit below existed.
    repo.treeShas = new Map([["a.md", "sha-from-another-device"]]);
    let release!: () => void;
    repo.hold = {
      match: "/contents/a.md",
      release: new Promise<void>((r) => (release = r)),
    };

    const syncing = sync.syncAll(CONFIG);
    await new Promise((r) => setTimeout(r, 0));

    const editing = commitCardEdit(
      card,
      source,
      "Q: How durable is S3?\nA: 99.999999999%",
      { keepScheduling: true }
    );
    await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([syncing, editing]);

    // Interleaved, the sync writes the pre-edit parse of the file over the
    // edit, and records a tree ETag saying that is current. The next sync
    // repairs it — one sync too late, and auto-sync fires on the visibility
    // change that follows closing the editor.
    const [stored] = await db.getAllDeckFiles();
    const questions = stored.cards.map((c) =>
      c.content.type === "basic" ? c.content.question : ""
    );
    expect(questions).toContain("How durable is S3?");
    expect(questions).not.toContain("What is the default S3 durability?");
    expect(stored.sha).toBe(repo.files.get("a.md")!.sha);
  });

  it("serialises two edits rather than letting the second read stale cards", async () => {
    const { readCardSource, commitCardEdit, sync } = await freshEdit("a.md", FILE);
    const cards = await sync.loadCachedCards();
    const source = await readCardSource(cards[1]);

    // Both were opened against the same read of the file, so the second commit
    // has to be built on what the first one left behind — which is only true if
    // it waits for it.
    const first = commitCardEdit(cards[1], source, "Q: One?\nA: Yes", {
      keepScheduling: true,
    });
    const second = commitCardEdit(cards[1], source, "Q: Two?\nA: Also", {
      keepScheduling: true,
    });

    await first;
    // The second is built on a SHA the first has already moved, and says so
    // rather than overwriting it.
    await expect(second).rejects.toBeInstanceOf(
      (await import("./github")).ConflictError
    );
    expect(repo.files.get("a.md")!.text).toContain("Q: One?");
  });

  it("keeps the queue moving after a commit fails", async () => {
    const { readCardSource, commitCardEdit, sync } = await freshEdit("a.md", FILE);
    const card = (await sync.loadCachedCards())[1];
    const source = await readCardSource(card);
    repo.set("a.md", FILE); // moves the SHA out from under the edit

    await expect(
      commitCardEdit(card, source, "Q: Durable?\nA: Very", {
        keepScheduling: true,
      })
    ).rejects.toThrow();

    // A rejection that stayed in the chain would leave every later sync waiting
    // on a promise that will never settle — and the thing a user does after a
    // failed save is try again.
    const hung = Symbol("hung");
    const outcome = await Promise.race([
      sync.syncAll(CONFIG),
      new Promise((r) => setTimeout(() => r(hung), 500)),
    ]);
    expect(outcome).toBe(true);
  });

  it("refuses to overwrite a file that moved since it was opened", async () => {
    const { readCardSource, commitCardEdit, sync } = await freshEdit("a.md", FILE);
    const { ConflictError } = await import("./github");
    const card = (await sync.loadCachedCards())[1];
    const source = await readCardSource(card);

    // Someone edits the file on GitHub while the sheet is open. Splicing by
    // line number into bytes we have not seen is how an edit eats someone
    // else's, so this one fails and says so.
    repo.set("a.md", "Q: Something else entirely\nA: Indeed\n");

    await expect(
      commitCardEdit(card, source, "Q: Durable?\nA: Very", {
        keepScheduling: true,
      })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  /**
   * The parse used to happen after the write. A file the parser refuses is a
   * file the app cannot load on any device, and committing it first meant the
   * repo held it, the local store did not, and the SHA the sheet was holding
   * was stale — so trying again conflicted rather than recovering.
   */
  it("refuses text the parser cannot read, without committing it", async () => {
    const { readCardSource, commitCardEdit, CardSyntaxError, sync } =
      await freshEdit("a.md", FILE);
    const card = (await sync.loadCachedCards())[1];
    const source = await readCardSource(card);

    await expect(
      commitCardEdit(card, source, "Q: A question with no answer", {
        keepScheduling: true,
      })
    ).rejects.toBeInstanceOf(CardSyntaxError);

    expect(repo.commits).toHaveLength(0);
    expect(repo.files.get("a.md")!.text).toBe(FILE);
  });

  it("leaves the sheet able to try again after a refusal", async () => {
    const { readCardSource, commitCardEdit, sync } = await freshEdit("a.md", FILE);
    const card = (await sync.loadCachedCards())[1];
    const source = await readCardSource(card);

    await expect(
      commitCardEdit(card, source, "A: An answer with no question", {
        keepScheduling: true,
      })
    ).rejects.toBeTruthy();

    // The same source, the same SHA — nothing moved, so the fix goes through.
    await commitCardEdit(card, source, "Q: Durable?\nA: Very", {
      keepScheduling: true,
    });

    expect(repo.files.get("a.md")!.text).toContain("Q: Durable?");
  });

  it("names the card that replaced the one being edited", async () => {
    const { readCardSource, commitCardEdit, sync } = await freshEdit("a.md", FILE);
    const card = (await sync.loadCachedCards())[1];
    const source = await readCardSource(card);

    const result = await commitCardEdit(
      card,
      source,
      "Q: How durable is S3?\nA: 99.999999999%",
      { keepScheduling: true }
    );

    expect(result.card).not.toBeNull();
    expect(result.card!.hash).not.toBe(card.hash);
    expect(result.card!.content).toMatchObject({ question: "How durable is S3?" });
    expect(result.keptScheduling).toBe(true);
  });

  it("names the right sibling when a cloze block is rewritten", async () => {
    const { readCardSource, commitCardEdit, sync } = await freshEdit("a.md", FILE);
    // The block yields two cards; the second is the one being edited.
    const cards = (await sync.loadCachedCards()).filter(
      (c) => c.content.type === "cloze"
    );
    const second = cards[1];
    const source = await readCardSource(second);

    const result = await commitCardEdit(
      second,
      source,
      "C: The capital of [France] is [Paris], obviously",
      { keepScheduling: true }
    );

    expect(result.cards).toHaveLength(2);
    expect(result.card).toBe(result.cards[1]);
  });

  it("has no replacement to name when the edit deleted the card", async () => {
    const { readCardSource, commitCardEdit, sync } = await freshEdit("a.md", FILE);
    const card = (await sync.loadCachedCards())[1];
    const source = await readCardSource(card);

    const result = await commitCardEdit(card, source, "", {
      keepScheduling: true,
    });

    expect(result.card).toBeNull();
  });
});

/**
 * A v2 card's range covers its metadata lines, so the editor shows them, and
 * they can be edited like any other line.
 */
describe("editing a card with metadata", () => {
  const V2 = `---
name = "Nordic"
---

Tags: capitals
Q: What is the capital of Estonia?
A: Tallinn

---

C: The capital of [Norway] is [Oslo].
`;

  beforeEach(() => {
    localStorage.clear();
  });

  it("puts the card's metadata in the box", async () => {
    const { readCardSource, sync } = await freshEdit("v2.md", V2);
    const card = (await sync.loadCachedCards())[0];
    expect((await readCardSource(card)).text).toBe(
      "Tags: capitals\nQ: What is the capital of Estonia?\nA: Tallinn"
    );
  });

  it("keeps the metadata through an edit of the text", async () => {
    const { readCardSource, commitCardEdit, sync } = await freshEdit("v2.md", V2);
    const card = (await sync.loadCachedCards())[0];
    const source = await readCardSource(card);

    const result = await commitCardEdit(
      card,
      source,
      source.text.replace("Tallinn", "Tallinn (Reval)"),
      { keepScheduling: true }
    );

    expect(repo.files.get("v2.md")!.text).toBe(V2.replace("Tallinn", "Tallinn (Reval)"));
    expect(result.card).toMatchObject({ tags: ["capitals"] });
  });

  it("lets the other metadata lines be edited, keeping the key", async () => {
    const { readCardSource, commitCardEdit, sync } = await freshEdit("v2.md", V2);
    const card = (await sync.loadCachedCards())[0];
    const source = await readCardSource(card);

    const result = await commitCardEdit(
      card,
      source,
      source.text.replace("Tags: capitals", "Tags: capitals, baltic\nStatus: suspended"),
      { keepScheduling: true }
    );

    expect(result.card).toMatchObject({
      key: card.key,
      tags: ["capitals", "baltic"],
      status: "suspended",
    });
  });

  it("links each deletion of an edited cloze block to its new self, in order", async () => {
    const { readCardSource, commitCardEdit, db, sync } = await freshEdit("v2.md", V2);
    const before = (await sync.loadCachedCards()).filter((c) => c.content.type === "cloze");
    for (const card of before) await giveHistory(card);
    const source = await readCardSource(before[1]);

    const result = await commitCardEdit(
      before[1],
      source,
      "C: The capital of [Norway] is [Oslo], on the Oslofjord.",
      { keepScheduling: true }
    );

    expect(result.card).toBe(result.cards[1]);
    const links = (await db.getLocalBaselines()).map((b) => b.event).filter((e) => e.kind === "link");
    expect(links.map((l) => l.kind === "link" && [l.from, l.card])).toEqual([
      [before[0].key, result.cards[0].key],
      [before[1].key, result.cards[1].key],
    ]);
  });

  it("links a reversed block's two directions each to its own new self", async () => {
    const text = "Reverse: yes\nQ: la sobremesa\nA: talk after a meal\n";
    const { readCardSource, commitCardEdit, db, sync } = await freshEdit("es.md", text);
    const before = await sync.loadCachedCards();
    expect(before).toHaveLength(2);
    for (const card of before) await giveHistory(card);
    // Opened from the reverse, as the leech list does.
    const source = await readCardSource(before[1]);

    const result = await commitCardEdit(
      before[1],
      source,
      "Reverse: yes\nQ: la sobremesa\nA: the talk at the table after a meal\n",
      { keepScheduling: true }
    );

    expect(result.card).toBe(result.cards[1]);
    const links = (await db.getLocalBaselines()).map((b) => b.event).filter((e) => e.kind === "link");
    expect(links.map((l) => l.kind === "link" && [l.from, l.card])).toEqual([
      [before[0].key, result.cards[0].key],
      [before[1].key, result.cards[1].key],
    ]);
  });

  it("takes the metadata with it when the card is deleted", async () => {
    const { readCardSource, commitCardEdit, sync } = await freshEdit("v2.md", V2);
    const card = (await sync.loadCachedCards())[0];
    const source = await readCardSource(card);

    await commitCardEdit(card, source, "", { keepScheduling: true });

    const text = repo.files.get("v2.md")!.text;
    expect(text).not.toContain("Estonia");
    expect(text).not.toContain("Tags:");
    // What is left still parses: no stray metadata above the next card.
    const left = await sync.loadCachedCards();
    expect(left.map((c) => c.content.type)).toEqual(["cloze", "cloze"]);
  });
});

describe("editing a card with an Extra section", () => {
  const EXTRA = `Q: What is the capital of Estonia?
A: Tallinn
Extra: Called *Reval* until 1918.

---

C: The capital of [Norway] is [Oslo].
Extra: On the Oslofjord.
`;

  beforeEach(() => {
    localStorage.clear();
  });

  it("puts the Extra section in the box, as part of the card", async () => {
    const { readCardSource, sync } = await freshEdit("extra.md", EXTRA);
    const [basic, cloze] = await sync.loadCachedCards();
    expect((await readCardSource(basic)).text).toBe(
      "Q: What is the capital of Estonia?\nA: Tallinn\nExtra: Called *Reval* until 1918."
    );
    expect((await readCardSource(cloze)).text).toContain("\nExtra: On the Oslofjord.");
  });

  it("keeps the Extra section through an edit of the answer", async () => {
    const { readCardSource, commitCardEdit, sync } = await freshEdit("extra.md", EXTRA);
    const card = (await sync.loadCachedCards())[0];
    const source = await readCardSource(card);

    const result = await commitCardEdit(
      card,
      source,
      source.text.replace("A: Tallinn", "A: **Tallinn**"),
      { keepScheduling: true }
    );

    expect(repo.files.get("extra.md")!.text).toBe(EXTRA.replace("A: Tallinn", "A: **Tallinn**"));
    expect(result.card?.content).toMatchObject({ extra: "Called *Reval* until 1918." });
  });

  it("changes neither hash nor key when only the Extra section is edited", async () => {
    const { readCardSource, commitCardEdit, sync } = await freshEdit("extra.md", EXTRA);
    const card = (await sync.loadCachedCards())[2];
    const source = await readCardSource(card);

    const result = await commitCardEdit(
      card,
      source,
      source.text.replace("On the Oslofjord.", "On the Oslofjord, at its head."),
      { keepScheduling: true }
    );

    expect(result.card).toMatchObject({ key: card.key, hash: card.hash });
    expect(result.card?.content.extra).toBe("On the Oslofjord, at its head.");
    // Nothing to carry: the history is already under the right key.
    expect(result.migrated).toBe(0);
  });
});

/**
 * Quick capture: a card written rather than fixed. No range to splice into and
 * no history to carry, but the same refusal to commit a file the parser cannot
 * read — a half-typed card pushed to the repo breaks every device that syncs.
 */
describe("writing a new card", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("appends to the end of the deck, leaving what is there alone", async () => {
    const { createCard } = await freshEdit("a.md", FILE);

    const result = await createCard(CONFIG, "a.md", "Q: What is S3 Glacier?\nA: Cold storage");

    expect(repo.files.get("a.md")!.text).toBe(
      FILE + "\nQ: What is S3 Glacier?\nA: Cold storage\n"
    );
    expect(result.created).toBe(false);
  });

  it("returns just the card it wrote, not the whole file", async () => {
    const { createCard } = await freshEdit("a.md", FILE);

    const result = await createCard(CONFIG, "a.md", "Q: What is S3 Glacier?\nA: Cold storage");

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].content).toMatchObject({ question: "What is S3 Glacier?" });
  });

  it("writes a deck that does not exist yet, with no SHA to base it on", async () => {
    const { createCard } = await freshEdit("a.md", FILE);

    const result = await createCard(CONFIG, "new/Deck.md", "C: A [monoid] has an identity");

    expect(result.created).toBe(true);
    expect(repo.files.get("new/Deck.md")!.text).toBe(
      "C: A [monoid] has an identity\n"
    );
    expect(result.cards[0].deckName).toBe("Deck");
  });

  it("refuses a card the parser cannot read, without committing it", async () => {
    const { createCard, CardSyntaxError } = await freshEdit("a.md", FILE);

    await expect(
      createCard(CONFIG, "a.md", "C: A cloze with no deletion in it")
    ).rejects.toBeInstanceOf(CardSyntaxError);

    expect(repo.commits).toHaveLength(0);
  });

  it("refuses an empty box rather than committing a blank line", async () => {
    const { createCard, CardSyntaxError } = await freshEdit("a.md", FILE);

    await expect(createCard(CONFIG, "a.md", "   \n  ")).rejects.toBeInstanceOf(
      CardSyntaxError
    );
    expect(repo.commits).toHaveLength(0);
  });

  it("puts the new card in the deck store, so the list counts it", async () => {
    const { createCard, sync } = await freshEdit("a.md", FILE);

    await createCard(CONFIG, "a.md", "Q: What is S3 Glacier?\nA: Cold storage");

    const questions = (await sync.loadCachedCards())
      .filter((c) => c.content.type === "basic")
      .map((c) => (c.content as { question: string }).question);
    expect(questions).toContain("What is S3 Glacier?");
  });
});
