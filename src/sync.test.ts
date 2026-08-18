// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { GitHubConfig } from "./github";

/**
 * Sync used to list the tree and then fetch every file in the repo on every
 * startup, whether or not a byte had changed. These cover the two things that
 * replaced that: a conditional tree request, and fetching only the blobs whose
 * SHA moved.
 */

const CONFIG: GitHubConfig = {
  pat: "token",
  owner: "someone",
  repo: "cards",
  branch: "main",
};

/** A stand-in repo, and a record of what was actually asked of it. */
class FakeRepo {
  files = new Map<string, { sha: string; content: string }>();
  etag = 'W/"tree-1"';
  fetchedPaths: string[] = [];
  treeRequests: { conditional: boolean }[] = [];

  set(path: string, content: string, sha: string): void {
    this.files.set(path, { sha, content });
  }

  /** Change what the tree returns, as pushing a commit would. */
  retag(etag: string): void {
    this.etag = etag;
  }

  handler = (url: string, init?: RequestInit): Response => {
    const headers = new Headers(init?.headers as HeadersInit);

    if (url.includes("/git/trees/")) {
      const sent = headers.get("If-None-Match");
      this.treeRequests.push({ conditional: sent !== null });
      if (sent === this.etag) {
        return new Response(null, { status: 304 });
      }
      const tree = [...this.files].map(([path, f]) => ({
        path,
        sha: f.sha,
        type: "blob",
      }));
      return new Response(JSON.stringify({ tree }), {
        status: 200,
        headers: { etag: this.etag },
      });
    }

    if (url.includes("/contents/hashcards-state.json")) {
      return new Response(null, { status: 404 });
    }

    const contents = url.match(/\/contents\/(.+)\?/);
    if (contents) {
      const path = decodeURIComponent(contents[1]);
      const file = this.files.get(path);
      if (!file) return new Response(null, { status: 404 });
      this.fetchedPaths.push(path);
      return new Response(
        JSON.stringify({ content: btoa(file.content), sha: file.sha }),
        { status: 200 }
      );
    }

    throw new Error(`Unexpected request: ${url}`);
  };
}

async function freshSync() {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  return import("./sync");
}

function install(repo: FakeRepo): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    repo.handler(String(input), init)
  ) as unknown as typeof fetch;
}

const card = (q: string) => `Q: ${q}\nA: because\n`;

describe("card sync", () => {
  let repo: FakeRepo;

  beforeEach(() => {
    localStorage.clear();
    repo = new FakeRepo();
    install(repo);
  });

  it("fetches every file the first time", async () => {
    repo.set("a.md", card("one"), "sha-a");
    repo.set("b.md", card("two"), "sha-b");
    const { syncCards } = await freshSync();

    const cards = await syncCards(CONFIG);

    expect(repo.fetchedPaths.sort()).toEqual(["a.md", "b.md"]);
    expect(cards).toHaveLength(2);
  });

  it("costs one conditional request when nothing has changed", async () => {
    repo.set("a.md", card("one"), "sha-a");
    const { syncCards } = await freshSync();
    await syncCards(CONFIG);
    repo.fetchedPaths = [];

    const cards = await syncCards(CONFIG);

    // A 304 on the tree, and not a single blob fetched.
    expect(repo.treeRequests[1].conditional).toBe(true);
    expect(repo.fetchedPaths).toEqual([]);
    // The cards are still there — they came from the store, not the network.
    expect(cards).toHaveLength(1);
  });

  it("fetches only the files whose SHA moved", async () => {
    repo.set("a.md", card("one"), "sha-a");
    repo.set("b.md", card("two"), "sha-b");
    const { syncCards } = await freshSync();
    await syncCards(CONFIG);
    repo.fetchedPaths = [];

    // One file edited: new blob SHA, and the tree is no longer the same tree.
    repo.set("b.md", card("two revised"), "sha-b2");
    repo.retag('W/"tree-2"');

    const cards = await syncCards(CONFIG);

    expect(repo.fetchedPaths).toEqual(["b.md"]);
    expect(cards).toHaveLength(2);
    const questions = cards.map((c) =>
      c.content.type === "basic" ? c.content.question : ""
    );
    expect(questions).toContain("two revised");
    expect(questions).toContain("one");
  });

  it("drops cards from a file that left the repo", async () => {
    repo.set("a.md", card("one"), "sha-a");
    repo.set("b.md", card("two"), "sha-b");
    const { syncCards } = await freshSync();
    await syncCards(CONFIG);

    repo.files.delete("b.md");
    repo.retag('W/"tree-2"');

    const cards = await syncCards(CONFIG);
    expect(cards).toHaveLength(1);
    expect(cards[0].filePath).toBe("a.md");
  });

  it("does not record the tree tag when a fetch fails", async () => {
    repo.set("a.md", card("one"), "sha-a");
    const { syncCards } = await freshSync();
    const failing = new Error("network down");
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/contents/")) throw failing;
      return repo.handler(url, init);
    }) as unknown as typeof fetch;

    await expect(syncCards(CONFIG)).rejects.toThrow("network down");

    // Recording the tag here would make the next sync report "nothing changed"
    // over files it never actually got.
    install(repo);
    await syncCards(CONFIG);
    expect(repo.fetchedPaths).toEqual(["a.md"]);
  });

  it("carries a localStorage card cache over to the deck store", async () => {
    // What an install from before this change looks like on first open.
    localStorage.setItem(
      "cached_cards",
      JSON.stringify([
        {
          deckName: "Legacy",
          filePath: "legacy.md",
          range: [1, 2],
          content: { type: "basic", question: "Q", answer: "A" },
          hash: "legacy-1",
          familyHash: null,
        },
      ])
    );

    const { loadCachedCards } = await freshSync();
    const cards = await loadCachedCards();

    // Offline still works immediately after upgrading...
    expect(cards).toHaveLength(1);
    expect(cards[0].deckName).toBe("Legacy");
    // ...and the 5 MB blob is not left sitting in localStorage.
    expect(localStorage.getItem("cached_cards")).toBeNull();
  });

  it("refetches migrated files once, having no SHA to trust", async () => {
    localStorage.setItem(
      "cached_cards",
      JSON.stringify([
        {
          deckName: "a",
          filePath: "a.md",
          range: [1, 2],
          content: { type: "basic", question: "stale", answer: "A" },
          hash: "old",
          familyHash: null,
        },
      ])
    );
    repo.set("a.md", card("fresh"), "sha-a");

    const { syncCards } = await freshSync();
    const cards = await syncCards(CONFIG);

    expect(repo.fetchedPaths).toEqual(["a.md"]);
    expect(
      cards.map((c) => (c.content.type === "basic" ? c.content.question : ""))
    ).toEqual(["fresh"]);
  });
});
