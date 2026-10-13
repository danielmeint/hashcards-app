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
  owner: "someone",
  repo: "cards",
  branch: "main",
};

/** A stand-in repo, and a record of what was actually asked of it. */
class FakeRepo {
  files = new Map<string, { sha: string; content: string }>();
  etag = 'W/"tree-1"';
  fetchedPaths: string[] = [];
  /** Paths of every file fetched through the blobs API, i.e. media. */
  fetchedBlobs: string[] = [];
  /** Every ordinary file committed, in order — the review log's writes. */
  fileWrites: { path: string; content: string }[] = [];
  /** Every request whose URL mentions the review log, writes or reads. */
  logRequests = 0;
  treeRequests: { conditional: boolean }[] = [];
  /** The repo's `hashcards-state.json`, base64 as the contents API returns it. */
  state: { content: string; sha: string } | null = null;
  /** Every state file this repo accepted a commit of. */
  stateWrites: unknown[] = [];
  /** Every state file it was asked to commit, including the refused ones. */
  writeAttempts: unknown[] = [];
  /** Runs after each read of the state file, to stand in for another device. */
  onStateRead: (() => void) | null = null;
  /**
   * Answer the tree with only the first file and `truncated: true`, as GitHub
   * does past 100,000 entries or 7 MB of listing.
   */
  truncated = false;

  set(path: string, content: string, sha: string): void {
    this.files.set(path, { sha, content });
  }

  /** Change what the tree returns, as pushing a commit would. */
  retag(etag: string): void {
    this.etag = etag;
  }

  /** Give the repo an existing state file, as another device would have. */
  setState(data: unknown): void {
    this.state = { content: btoa(JSON.stringify(data)), sha: "state-0" };
  }

  handler = (url: string, init?: RequestInit): Response => {
    const headers = new Headers(init?.headers as HeadersInit);

    if (url.includes("/git/trees/")) {
      const sent = headers.get("If-None-Match");
      this.treeRequests.push({ conditional: sent !== null });
      if (sent === this.etag) {
        return new Response(null, { status: 304 });
      }
      const all = [...this.files].map(([path, f]) => ({
        path,
        sha: f.sha,
        type: "blob",
      }));
      const tree = this.truncated ? all.slice(0, 1) : all;
      return new Response(JSON.stringify({ tree, truncated: this.truncated }), {
        status: 200,
        headers: { etag: this.etag },
      });
    }

    if (url.includes("/contents/hashcards-state.json")) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as {
          content: string;
          sha?: string;
        };
        this.writeAttempts.push(JSON.parse(atob(body.content)));
        // GitHub refuses a write built on a SHA that is no longer current —
        // accepting it would silently drop whatever moved the file. It has two
        // ways of saying so, and they are not the same status code.
        if (this.state && !body.sha) {
          return new Response(
            JSON.stringify({ message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }),
            { status: 422 }
          );
        }
        if ((body.sha ?? null) !== (this.state?.sha ?? null)) {
          return new Response(
            JSON.stringify({
              message: "hashcards-state.json does not match the file's SHA",
            }),
            { status: 409 }
          );
        }
        this.stateWrites.push(JSON.parse(atob(body.content)));
        this.state = { content: body.content, sha: `state-${this.stateWrites.length}` };
        return new Response(JSON.stringify({}), { status: 200 });
      }
      const res = this.state
        ? new Response(JSON.stringify(this.state), { status: 200 })
        : new Response(null, { status: 404 });
      this.onStateRead?.();
      return res;
    }

    if (url.includes("/contents/hashcards-reviews/")) this.logRequests++;
    const put = url.match(/\/contents\/([^?]+)$/);
    if (put && init?.method === "PUT") {
      const path = decodeURIComponent(put[1]);
      const body = JSON.parse(String(init.body)) as { content: string; sha?: string };
      if ((body.sha ?? null) !== (this.files.get(path)?.sha ?? null)) {
        return new Response(JSON.stringify({ message: "sha mismatch" }), { status: 409 });
      }
      const content = new TextDecoder().decode(
        Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0))
      );
      const sha = `sha-w${this.fileWrites.length + 1}`;
      this.fileWrites.push({ path, content });
      this.files.set(path, { sha, content });
      return new Response(JSON.stringify({ content: { sha } }), { status: 200 });
    }

    const blob = url.match(/\/git\/blobs\/(.+)$/);
    if (blob) {
      const entry = [...this.files].find(([, f]) => f.sha === blob[1]);
      if (!entry) return new Response(null, { status: 404 });
      this.fetchedBlobs.push(entry[0]);
      return new Response(entry[1].content, { status: 200 });
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
  // The config carries no credential any more; `apiFetch` reads one from the
  // credential store, so a sync needs one there before it can send anything.
  const { saveCredential } = await import("./auth");
  await saveCredential({ kind: "pat", token: "token" });
  return import("./sync");
}

/** Two collections behind one `fetch`, routed by the owner/repo in the URL. */
function installMany(repos: Record<string, FakeRepo>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const named = url.match(/\/repos\/([^/]+\/[^/]+)\//);
    const repo = named && repos[named[1]];
    if (!repo) throw new Error(`No fake repo for ${url}`);
    return repo.handler(url, init);
  }) as unknown as typeof fetch;
}

function install(repo: FakeRepo): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    repo.handler(String(input), init)
  ) as unknown as typeof fetch;
}

const card = (q: string) => `Q: ${q}\nA: because\n`;

/**
 * The hash the parser will give a card, so a test can seed scheduling for a
 * card the repo genuinely holds. A made-up hash is no longer interchangeable:
 * a repo's state file carries its own cards, and an invented one belongs to
 * nothing.
 */
async function hashOf(text: string): Promise<string> {
  const { parseFile } = await import("./parser");
  const [parsed] = await parseFile(text, "a.md", "a");
  return parsed.hash;
}

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

  it("keeps every card when GitHub truncates the tree", async () => {
    repo.set("a.md", card("one"), "sha-a");
    repo.set("b.md", card("two"), "sha-b");
    const { syncCards } = await freshSync();
    await syncCards(CONFIG);

    // A partial listing is not a list of deletions: `b.md` is still in the
    // repo, the tree just stopped before reaching it.
    repo.truncated = true;
    repo.retag('W/"tree-2"');

    await expect(syncCards(CONFIG)).rejects.toThrow(/too large/);
    const { loadCards } = await import("./sync");
    expect(await loadCards()).toHaveLength(2);
  });

  it("fetches the media a card references, and only that", async () => {
    repo.set("aws/s3.md", card("![](diagram.png)"), "sha-deck");
    repo.set("aws/diagram.png", "PNG-BYTES", "sha-img");
    repo.set("aws/unused.png", "OTHER", "sha-unused");
    const { syncCards } = await freshSync();

    await syncCards(CONFIG);

    expect(repo.fetchedBlobs).toEqual(["aws/diagram.png"]);
    const { getMedia } = await import("./db");
    const stored = await getMedia("someone/cards", "aws/diagram.png");
    expect(stored?.type).toBe("image/png");
    expect(new TextDecoder().decode(stored?.bytes)).toBe("PNG-BYTES");
  });

  it("fetches a file again only when its SHA moves", async () => {
    repo.set("a.md", card("![](a.png)"), "sha-a");
    repo.set("a.png", "v1", "sha-img-1");
    const { syncCards } = await freshSync();
    await syncCards(CONFIG);

    // Something else changed: the image is still the same blob.
    repo.set("b.md", card("two"), "sha-b");
    repo.retag('W/"tree-2"');
    await syncCards(CONFIG);
    expect(repo.fetchedBlobs).toEqual(["a.png"]);

    repo.set("a.png", "v2", "sha-img-2");
    repo.retag('W/"tree-3"');
    await syncCards(CONFIG);
    expect(repo.fetchedBlobs).toEqual(["a.png", "a.png"]);
  });

  it("drops media no card references any more", async () => {
    repo.set("a.md", card("![](a.png)"), "sha-a");
    repo.set("a.png", "bytes", "sha-img");
    const { syncCards } = await freshSync();
    await syncCards(CONFIG);

    repo.set("a.md", card("no picture now"), "sha-a2");
    repo.retag('W/"tree-2"');
    await syncCards(CONFIG);

    const { getMedia } = await import("./db");
    expect(await getMedia("someone/cards", "a.png")).toBeUndefined();
  });

  it("does not record the tree tag when a media fetch fails", async () => {
    repo.set("a.md", card("![](a.png)"), "sha-a");
    repo.set("a.png", "bytes", "sha-img");
    const { syncCards } = await freshSync();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/git/blobs/")) throw new Error("network down");
      return repo.handler(url, init);
    }) as unknown as typeof fetch;

    await expect(syncCards(CONFIG)).rejects.toThrow("network down");

    install(repo);
    await syncCards(CONFIG);
    expect(repo.fetchedBlobs).toEqual(["a.png"]);
  });

  it("fetches media a device's cards already had before media was stored", async () => {
    repo.set("a.md", card("![](a.png)"), "sha-a");
    repo.set("a.png", "bytes", "sha-img");
    const { syncCards } = await freshSync();
    await syncCards(CONFIG);

    // As a device on the previous schema left it: the deck file and the tree
    // tag stored, and no media store at all.
    const { getMeta } = await import("./db");
    const etag = await getMeta<string>("tree_etag:someone/cards");
    const deckFiles = await new Promise<unknown[]>((resolve) => {
      const open = indexedDB.open("hashcards");
      open.onsuccess = () => {
        const req = open.result.transaction("deckFiles").objectStore("deckFiles").getAll();
        req.onsuccess = () => {
          open.result.close();
          resolve(req.result);
        };
      };
    });
    globalThis.indexedDB = new IDBFactory();
    await new Promise<void>((resolve) => {
      const open = indexedDB.open("hashcards", 6);
      open.onupgradeneeded = () => {
        const db = open.result;
        for (const name of ["performances", "origins", "deckFiles", "meta"]) {
          const keyPath =
            name === "performances" ? "hash" : name === "deckFiles" ? ["repo", "path"] : undefined;
          db.createObjectStore(name, keyPath ? { keyPath } : undefined);
        }
        for (const name of ["reviews"]) db.createObjectStore(name, { autoIncrement: true });
        for (const name of ["session", "decks", "credentials"]) db.createObjectStore(name);
        const tx = open.transaction!;
        tx.objectStore("meta").put(etag, "tree_etag:someone/cards");
        for (const file of deckFiles) tx.objectStore("deckFiles").put(file);
      };
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
    });
    vi.resetModules();
    const { saveCredential } = await import("./auth");
    await saveCredential({ kind: "pat", token: "token" });
    const upgraded = await import("./sync");
    repo.fetchedBlobs = [];
    repo.fetchedPaths = [];

    await upgraded.syncCards(CONFIG);

    expect(repo.fetchedBlobs).toEqual(["a.png"]);
    // The listing was full, but the deck file still matched by SHA.
    expect(repo.fetchedPaths).toEqual([]);
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
    // What an install from before this change looks like on first open. The
    // configured repo has to be there too: deck files are keyed by collection
    // now, and cards from that era came from the one repo there could be.
    localStorage.setItem("github_owner", "someone");
    localStorage.setItem("github_repo", "cards");
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

/**
 * Choosing a repository in a list is not consent to commit to it. Before this,
 * picking one in Settings ran a full sync — so a mis-tap in the picker wrote
 * the entire local review history into whatever repo was under the finger,
 * which is how this app's own source repo acquired an 87-card state file.
 */
describe("state sync", () => {
  let repo: FakeRepo;

  const performance = (dueDate: string) => ({
    type: "reviewed" as const,
    lastReviewedAt: "2026-01-01T00:00:00.000Z",
    stability: 3,
    difficulty: 5,
    intervalRaw: 3,
    intervalDays: 3,
    dueDate,
    reviewCount: 2,
  });

  beforeEach(() => {
    localStorage.clear();
    repo = new FakeRepo();
    install(repo);
  });

  it("pushes review state to a repo the cards came from", async () => {
    repo.set("a.md", card("one"), "sha-a");
    const { syncAll } = await freshSync();
    const { importState } = await import("./db");
    const mine = await hashOf(card("one"));
    await importState({ [mine]: performance("2026-02-01") });

    expect(await syncAll(CONFIG)).toBe(true);

    expect(repo.stateWrites).toHaveLength(1);
    expect(repo.stateWrites[0]).toMatchObject({
      cards: { [mine]: { dueDate: "2026-02-01" } },
    });
  });

  it("writes no state file into a repo that holds no cards", async () => {
    // A repository with no card files — the app's own source repo, say.
    const { syncAll } = await freshSync();
    const { importState } = await import("./db");
    await importState({ "hash-1": performance("2026-02-01") });

    expect(await syncAll(CONFIG)).toBe(true);

    // Committing here would say something untrue about that repository, and
    // it is a commit the user never asked for.
    expect(repo.stateWrites).toEqual([]);
  });

  it("does not claim state is safe after a sync that pushed nothing", async () => {
    repo.set("a.md", card("one"), "sha-a");
    const { adoptRepo } = await freshSync();
    const { importState } = await import("./db");
    const { getLastPushedAt, getLastSyncedAt } = await import("./sync-state");
    await importState({ "hash-1": performance("2026-02-01") });

    expect(await adoptRepo(CONFIG)).toBe(true);

    // A pull is a sync, and the deck list may say so. But those reviews are
    // still only on this device, and the warning that says so keys off this.
    expect(getLastSyncedAt()).not.toBeNull();
    expect(getLastPushedAt()).toBeNull();
  });

  it("reports a missing credential as needing sign-in, not as a retryable failure", async () => {
    repo.set("a.md", card("one"), "sha-a");
    const { syncAll } = await freshSync();
    const { signOut } = await import("./auth");
    const { getSyncStatus } = await import("./sync-state");
    await signOut();

    expect(await syncAll(CONFIG)).toBe(false);

    const status = getSyncStatus();
    expect(status.phase).toBe("error");
    expect(status.phase === "error" && status.needsSignIn).toBe(true);
  });

  it("re-merges and pushes again when another device commits first", async () => {
    repo.set("a.md", card("one"), "sha-a");
    repo.setState({ version: 1, cards: { shared: performance("2026-02-01") } });
    const { syncAll } = await freshSync();
    const { importState, getAllPerformances } = await import("./db");
    const mine = await hashOf(card("one"));
    await importState({ [mine]: performance("2026-02-01") });

    // The phone commits in the window between our read and our write, which is
    // exactly what the SHA we are about to send is there to catch.
    repo.onStateRead = () => {
      repo.onStateRead = null;
      repo.state = {
        content: btoa(
          JSON.stringify({
            version: 1,
            cards: {
              shared: performance("2026-02-01"),
              "on-the-phone": performance("2026-04-01"),
            },
          })
        ),
        sha: "state-from-the-phone",
      };
    };

    expect(await syncAll(CONFIG)).toBe(true);

    // The refused push, then one built on what the phone actually left behind.
    expect(repo.writeAttempts).toHaveLength(2);
    expect(repo.stateWrites).toHaveLength(1);
    expect(
      Object.keys((repo.stateWrites[0] as { cards: object }).cards).sort()
    ).toEqual([mine, "on-the-phone", "shared"].sort());
    // And the phone's card is scheduled here too, not merely preserved there.
    expect([...(await getAllPerformances()).keys()]).toContain("on-the-phone");
  });

  it("re-merges when the state file appears between the read and the write", async () => {
    // No state file at all, so nothing to send a SHA for — and then the phone
    // creates one. GitHub reports that as a 422 about a missing `sha`, not a
    // 409, but it is the same lost race.
    repo.set("a.md", card("one"), "sha-a");
    const { syncAll } = await freshSync();
    const { importState } = await import("./db");
    const mine = await hashOf(card("one"));
    await importState({ [mine]: performance("2026-02-01") });

    repo.onStateRead = () => {
      repo.onStateRead = null;
      repo.state = {
        content: btoa(
          JSON.stringify({
            version: 1,
            cards: { "on-the-phone": performance("2026-04-01") },
          })
        ),
        sha: "created-by-the-phone",
      };
    };

    expect(await syncAll(CONFIG)).toBe(true);

    expect(repo.stateWrites).toHaveLength(1);
    expect(
      Object.keys((repo.stateWrites[0] as { cards: object }).cards).sort()
    ).toEqual([mine, "on-the-phone"].sort());
  });

  it("does not retry a 422 that has nothing to do with a lost race", async () => {
    repo.set("a.md", card("one"), "sha-a");
    const { syncAll } = await freshSync();
    const { importState } = await import("./db");
    await importState({ "hash-1": performance("2026-02-01") });

    // 422 is GitHub's general validation status. Re-merging cannot make a
    // branch exist, so retrying one is two more requests and the same answer.
    let attempts = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT" && url.includes("hashcards-state.json")) {
        attempts++;
        return new Response(
          JSON.stringify({ message: "Branch cards-v2 not found" }),
          { status: 422 }
        );
      }
      return repo.handler(url, init);
    }) as unknown as typeof fetch;

    expect(await syncAll(CONFIG)).toBe(false);

    expect(attempts).toBe(1);
    const { getSyncStatus } = await import("./sync-state");
    const status = getSyncStatus();
    expect(status.phase === "error" && status.message).toContain("Branch");
  });

  it("stops re-merging a conflict that never clears", async () => {
    repo.set("a.md", card("one"), "sha-a");
    repo.setState({ version: 1, cards: {} });
    const { syncAll } = await freshSync();
    const { importState } = await import("./db");
    const { getSyncStatus } = await import("./sync-state");
    await importState({ [await hashOf(card("one"))]: performance("2026-02-01") });

    // Something is moving the file every single time. Retrying is no longer
    // racing one other device, and it will still be true on the next attempt.
    let n = 0;
    repo.onStateRead = () => {
      repo.state = { content: btoa("{}"), sha: `moved-again-${++n}` };
    };

    expect(await syncAll(CONFIG)).toBe(false);

    expect(repo.writeAttempts).toHaveLength(3);
    expect(repo.stateWrites).toEqual([]);
    // Reported as a failure the user can retry, not swallowed as a success.
    const status = getSyncStatus();
    expect(status.phase).toBe("error");
    expect(status.phase === "error" && status.needsSignIn).toBe(false);
  });

  it("adopts a repo by pulling its scheduling, not by committing to it", async () => {
    repo.set("a.md", card("one"), "sha-a");
    repo.setState({
      version: 1,
      cards: { "from-another-device": performance("2026-03-01") },
    });
    const { adoptRepo } = await freshSync();
    const { importState, getAllPerformances } = await import("./db");
    await importState({ "hash-local": performance("2026-02-01") });

    expect(await adoptRepo(CONFIG)).toBe(true);

    // Cards arrive and remote scheduling is merged in...
    expect(repo.fetchedPaths).toEqual(["a.md"]);
    expect([...(await getAllPerformances()).keys()].sort()).toEqual([
      "from-another-device",
      "hash-local",
    ]);
    // ...but nothing is written back until the user has drilled cards that
    // came out of this repo.
    expect(repo.stateWrites).toEqual([]);
  });
});

/**
 * `exportState` returns every performance on the device, and `fullSync` used to
 * write all of them into whichever repo was configured. Point the app at a
 * second collection and both files end up holding every hash from both — not
 * data loss, since hashes are content-derived and last-write-wins stays correct
 * per card, but each file accumulates scheduling for cards it does not have and
 * leaks that those cards exist somewhere else.
 */
describe("two collections", () => {
  const performance = (dueDate: string) => ({
    type: "reviewed" as const,
    lastReviewedAt: "2026-01-01T00:00:00.000Z",
    stability: 3,
    difficulty: 5,
    intervalRaw: 3,
    intervalDays: 3,
    dueDate,
    reviewCount: 2,
  });

  const OTHER: GitHubConfig = { owner: "someone", repo: "other", branch: "main" };

  let mine: FakeRepo;
  let theirs: FakeRepo;

  beforeEach(() => {
    localStorage.clear();
    mine = new FakeRepo();
    theirs = new FakeRepo();
    mine.set("a.md", card("one"), "sha-a");
    theirs.set("b.md", card("two"), "sha-b");
    installMany({ "someone/cards": mine, "someone/other": theirs });
  });

  const cardsIn = (writes: unknown[]) =>
    Object.keys((writes[writes.length - 1] as { cards: object }).cards).sort();

  it("keeps each repo's state file to its own cards", async () => {
    const { syncAll } = await freshSync();
    const { importState } = await import("./db");
    const { parseFile } = await import("./parser");
    const [one] = await parseFile(card("one"), "a.md", "a");
    const [two] = await parseFile(card("two"), "b.md", "b");

    await importState({ [one.hash]: performance("2026-02-01") });
    await syncAll(CONFIG);

    // Point the app at a second collection and review something in it.
    await importState({ [two.hash]: performance("2026-03-01") });
    await syncAll(OTHER);

    expect(cardsIn(mine.stateWrites)).toEqual([one.hash]);
    expect(cardsIn(theirs.stateWrites)).toEqual([two.hash]);
  });

  it("does not write the first repo's file again just because the second synced", async () => {
    const { syncAll } = await freshSync();
    const { importState } = await import("./db");
    const { parseFile } = await import("./parser");
    const [one] = await parseFile(card("one"), "a.md", "a");

    await importState({ [one.hash]: performance("2026-02-01") });
    await syncAll(CONFIG);
    const before = mine.stateWrites.length;

    await syncAll(OTHER);

    expect(mine.stateWrites).toHaveLength(before);
  });

  /**
   * The half that is not optional. A card temporarily out of the repo — a file
   * being reorganised, a rename half-done, an edit made on another device and
   * not yet pulled — must stay in the file. Drop it and its history is gone,
   * and it comes back as a card nobody has ever seen.
   */
  it("keeps scheduling for a card that has left the repo for now", async () => {
    const { syncAll } = await freshSync();
    const { importState } = await import("./db");
    const { parseFile } = await import("./parser");
    const [one] = await parseFile(card("one"), "a.md", "a");

    await importState({ [one.hash]: performance("2026-02-01") });
    await syncAll(CONFIG);
    expect(cardsIn(mine.stateWrites)).toEqual([one.hash]);

    // The file goes away, and another takes its place — reviewed, so the next
    // sync genuinely has something new to write and the assertion is about
    // what it wrote rather than about it declining to write at all.
    mine.files.delete("a.md");
    mine.set("c.md", card("three"), "sha-c");
    mine.retag('W/"tree-2"');
    const [three] = await parseFile(card("three"), "c.md", "c");
    await importState({ [three.hash]: performance("2026-04-01") });
    await syncAll(CONFIG);

    expect(mine.stateWrites).toHaveLength(2);
    expect(cardsIn(mine.stateWrites)).toEqual([one.hash, three.hash].sort());
  });

  /**
   * A card written here rather than fetched. Quick capture puts it straight in
   * the deck store, and the push that follows a drill is `syncStateOnly` —
   * which never lists the tree, so nothing has recorded where the card came
   * from. Scoping on the recorded origin alone would drop its scheduling out of
   * the file until some later full sync happened to run.
   */
  it("pushes scheduling for a card this device wrote, before any card sync", async () => {
    const { syncAll, syncStateOnly } = await freshSync();
    const { importState, updateDeckFiles } = await import("./db");
    const { parseFile } = await import("./parser");
    const [one] = await parseFile(card("one"), "a.md", "a");

    await importState({ [one.hash]: performance("2026-02-01") });
    await syncAll(CONFIG);

    // Written locally and committed, exactly as `createCard` leaves things.
    const [written] = await parseFile(card("written here"), "z.md", "z");
    mine.set("z.md", card("written here"), "sha-z");
    await updateDeckFiles(
      [
        {
          repo: "someone/cards",
          path: "z.md",
          sha: "sha-z",
          cards: [{ ...written, repo: "someone/cards" }],
        },
      ],
      []
    );
    const { loadCards } = await import("./sync");
    await loadCards();
    await importState({ [written.hash]: performance("2026-05-01") });

    await syncStateOnly(CONFIG);

    expect(cardsIn(mine.stateWrites)).toEqual([one.hash, written.hash].sort());
  });

  it("does not carry an orphan into a collection it was never in", async () => {
    const { syncAll } = await freshSync();
    const { importState } = await import("./db");
    const { parseFile } = await import("./parser");
    const [one] = await parseFile(card("one"), "a.md", "a");
    const [two] = await parseFile(card("two"), "b.md", "b");

    await importState({ [one.hash]: performance("2026-02-01") });
    await syncAll(CONFIG);

    mine.files.delete("a.md");
    mine.retag('W/"tree-2"');
    await importState({ [two.hash]: performance("2026-03-01") });
    await syncAll(OTHER);

    expect(cardsIn(theirs.stateWrites)).toEqual([two.hash]);
  });
});

/**
 * Everything already on a device predates the question "which collection is
 * this card in", so there is no answer for it in the data — but there is one
 * outside it: until now the app could hold only one repository at a time, so
 * whatever is configured is where it all came from. Without this seeding, the
 * first sync after the upgrade writes a state file with every temporarily
 * absent card missing, and each of them comes back as a card nobody has seen.
 */
describe("scheduling that predates the origins store", () => {
  let repo: FakeRepo;

  const performance = (dueDate: string) => ({
    type: "reviewed" as const,
    lastReviewedAt: "2026-01-01T00:00:00.000Z",
    stability: 3,
    difficulty: 5,
    intervalRaw: 3,
    intervalDays: 3,
    dueDate,
    reviewCount: 2,
  });

  /**
   * A database as the previous version left it: the old stores, real
   * scheduling in them, and no `origins`. Opening it through `db.ts` is what
   * runs the upgrade, so this has to be closed before the app touches it.
   */
  async function databaseFromBefore(hashes: string[]): Promise<void> {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    const { openDB } = await import("idb");
    const old = await openDB("hashcards", 4, {
      upgrade(db) {
        db.createObjectStore("performances", { keyPath: "hash" });
        db.createObjectStore("reviews", { autoIncrement: true });
        db.createObjectStore("session");
        db.createObjectStore("decks", { keyPath: "path" });
        db.createObjectStore("meta");
        db.createObjectStore("credentials");
      },
    });
    const tx = old.transaction("performances", "readwrite");
    for (const hash of hashes) {
      tx.store.put({ hash, ...performance("2026-02-01") });
    }
    await tx.done;
    old.close();
  }

  beforeEach(() => {
    localStorage.clear();
    repo = new FakeRepo();
    repo.set("a.md", card("one"), "sha-a");
    install(repo);
  });

  it("claims an orphan for the repo that was configured when it arrived", async () => {
    // The upgrade reads the configured repo out of localStorage, so it has to
    // be there before the database is opened.
    localStorage.setItem("github_owner", "someone");
    localStorage.setItem("github_repo", "cards");
    await databaseFromBefore(["from-before"]);

    const { saveCredential } = await import("./auth");
    await saveCredential({ kind: "pat", token: "token" });
    const { syncAll } = await import("./sync");
    await syncAll(CONFIG);

    const written = repo.stateWrites[0] as { cards: Record<string, unknown> };
    expect(Object.keys(written.cards)).toContain("from-before");
  });

  it("guesses nothing when there is no repo configured to guess from", async () => {
    await databaseFromBefore(["from-before"]);

    const { getAllOrigins } = await import("./db");

    expect([...(await getAllOrigins()).keys()]).toEqual([]);
  });

  /**
   * The seeding runs on every open, not only on the upgrade — there is no
   * "did I already do this" flag other than the store itself. So the guard is
   * what stops the second launch, with a different repo configured, from
   * re-claiming every card in the database for whatever is selected now.
   */
  it("leaves real answers alone on the launches after the first", async () => {
    localStorage.setItem("github_owner", "someone");
    localStorage.setItem("github_repo", "cards");
    await databaseFromBefore(["from-before"]);

    const first = await import("./db");
    await first.recordOrigins(["from-before"], "someone/elsewhere");

    // A second launch: same database, fresh modules, a different repo picked.
    vi.resetModules();
    localStorage.setItem("github_repo", "cards-two");
    const second = await import("./db");

    expect((await second.getAllOrigins()).get("from-before")).toBe(
      "someone/elsewhere"
    );
  });
});

/**
 * A subscription is someone else's repository. Its cards are read and drilled
 * here; nothing is ever committed back to it, and the scheduling for its cards
 * lives in your own collection's state file — which is the only place it can.
 */
describe("a collection the app only reads", () => {
  const performance = (dueDate: string) => ({
    type: "reviewed" as const,
    lastReviewedAt: "2026-01-01T00:00:00.000Z",
    stability: 3,
    difficulty: 5,
    intervalRaw: 3,
    intervalDays: 3,
    dueDate,
    reviewCount: 2,
  });

  let mine: FakeRepo;
  let theirs: FakeRepo;

  beforeEach(() => {
    localStorage.clear();
    mine = new FakeRepo();
    theirs = new FakeRepo();
    mine.set("a.md", card("one"), "sha-a");
    theirs.set("b.md", card("two"), "sha-b");
    installMany({ "me/cards": mine, "someone/shared": theirs });
    localStorage.setItem(
      "repos",
      JSON.stringify([
        { owner: "me", repo: "cards", branch: "main" },
        { owner: "someone", repo: "shared", branch: "main", readOnly: true },
      ])
    );
  });

  it("fetches its cards", async () => {
    const { syncEverything, loadCachedCards } = await freshSync();

    await syncEverything();

    const repos = (await loadCachedCards()).map((c) => c.repo).sort();
    expect(repos).toEqual(["me/cards", "someone/shared"]);
  });

  it("never commits to it, however much scheduling its cards have", async () => {
    const { syncEverything } = await freshSync();
    const { importState } = await import("./db");
    const { parseFile } = await import("./parser");
    const [one] = await parseFile(card("one"), "a.md", "a");
    const [two] = await parseFile(card("two"), "b.md", "b");

    await importState({
      [one.hash]: performance("2026-02-01"),
      [two.hash]: performance("2026-03-01"),
    });
    await syncEverything();

    expect(theirs.writeAttempts).toEqual([]);
    expect(mine.stateWrites).toHaveLength(1);
  });

  /**
   * And the scheduling for a subscribed card does not silently fall into your
   * own file either — it belongs to their collection, which has nowhere to put
   * it, so it stays on this device. Two devices of yours will each build it up
   * separately; that is the honest cost of not owning the repo.
   */
  it("keeps a subscribed card's scheduling out of your own state file", async () => {
    const { syncEverything } = await freshSync();
    const { importState } = await import("./db");
    const { parseFile } = await import("./parser");
    const [one] = await parseFile(card("one"), "a.md", "a");
    const [two] = await parseFile(card("two"), "b.md", "b");

    await importState({
      [one.hash]: performance("2026-02-01"),
      [two.hash]: performance("2026-03-01"),
    });
    await syncEverything();

    const written = mine.stateWrites[0] as { cards: Record<string, unknown> };
    expect(Object.keys(written.cards)).toEqual([one.hash]);
  });
});

/**
 * The deck store used to be keyed by path alone, which could only ever describe
 * one repository. Carrying it into the keyed store is a one-shot migration: it
 * runs once, marks itself done, and empties what it read — so getting it wrong
 * is not something a later sync quietly repairs.
 */
describe("a deck store from before collections", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("github_owner", "someone");
    localStorage.setItem("github_repo", "cards");
  });

  /** A database at the previous version, with the old single-repo deck store. */
  async function deckStoreFromBefore(): Promise<void> {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    const { openDB } = await import("idb");
    const old = await openDB("hashcards", 5, {
      upgrade(db) {
        db.createObjectStore("performances", { keyPath: "hash" });
        db.createObjectStore("reviews", { autoIncrement: true });
        db.createObjectStore("session");
        db.createObjectStore("decks", { keyPath: "path" });
        db.createObjectStore("meta");
        db.createObjectStore("credentials");
        db.createObjectStore("origins");
      },
    });
    await old.put("decks", {
      path: "a.md",
      sha: "sha-a",
      // As they were stored then: no card knew which collection it came from.
      cards: [
        {
          deckName: "a",
          filePath: "a.md",
          range: [1, 2],
          content: { type: "basic", question: "one", answer: "because" },
          hash: "hash-old",
          familyHash: null,
        },
      ],
    });
    old.close();
  }

  it("attributes the files it carries across to the repo that was configured", async () => {
    await deckStoreFromBefore();
    const { getAllDeckFiles } = await import("./db");

    const [file] = await getAllDeckFiles();
    expect(file.repo).toBe("someone/cards");
    expect(file.path).toBe("a.md");
  });

  /**
   * And the cards inside, not just the file around them. Missing this left every
   * migrated card with no collection at all — invisible to the state-file
   * scoping, and uneditable, since an edit needs to know which repo to commit to.
   */
  it("attributes the cards inside those files too", async () => {
    await deckStoreFromBefore();
    const { loadCards } = await import("./sync");

    const cards = await loadCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].repo).toBe("someone/cards");
  });

  it("does not run a second time and resurrect a collection since removed", async () => {
    await deckStoreFromBefore();
    const db = await import("./db");
    await db.forgetRepo("someone/cards");
    expect(await db.getAllDeckFiles()).toEqual([]);

    // A later launch: same database, fresh modules.
    vi.resetModules();
    const again = await import("./db");

    expect(await again.getAllDeckFiles()).toEqual([]);
  });
});

/**
 * The state file says where each card is; fitting FSRS to a person needs where
 * each card has been. That history used to stay in the IndexedDB of whichever
 * device recorded it.
 */
describe("review history", () => {
  let repo: FakeRepo;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("device_id", "phone1");
    repo = new FakeRepo();
    install(repo);
  });

  /** Record reviews as a drill would have left them in the local log. */
  async function seedReviews(reviews: { hash: string; at: string; grade?: number }[]) {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("hashcards");
      open.onsuccess = () => {
        const tx = open.result.transaction("reviews", "readwrite");
        for (const r of reviews) {
          tx.objectStore("reviews").add({
            cardHash: r.hash,
            reviewedAt: r.at,
            grade: r.grade ?? 3,
            stability: 2.3,
            difficulty: 5,
            intervalRaw: 2.3,
            intervalDays: 2,
            dueDate: "2026-01-01",
          });
        }
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }

  it("writes this device's reviews into one file per month, oldest first", async () => {
    repo.set("a.md", card("one"), "sha-a");
    const hash = await hashOf(card("one"));
    const { syncAll } = await freshSync();
    await syncAll({ ...CONFIG });
    await seedReviews([
      { hash, at: "2026-10-02T09:00:00.000Z" },
      { hash, at: "2026-09-20T09:00:00.000Z", grade: 1 },
      { hash, at: "2026-10-01T09:00:00.000Z" },
    ]);

    await syncAll({ ...CONFIG });

    const writes = Object.fromEntries(repo.fileWrites.map((w) => [w.path, w.content]));
    expect(Object.keys(writes).sort()).toEqual([
      "hashcards-reviews/2026-09.phone1.jsonl",
      "hashcards-reviews/2026-10.phone1.jsonl",
    ]);
    const october = writes["hashcards-reviews/2026-10.phone1.jsonl"]
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(october.map((r) => r.at)).toEqual([
      "2026-10-01T09:00:00.000Z",
      "2026-10-02T09:00:00.000Z",
    ]);
    expect(october[0]).toMatchObject({ card: hash, grade: 3 });
  });

  it("asks nothing of GitHub when no review is new", async () => {
    repo.set("a.md", card("one"), "sha-a");
    const hash = await hashOf(card("one"));
    const { syncAll } = await freshSync();
    await syncAll({ ...CONFIG });
    await seedReviews([{ hash, at: "2026-10-02T09:00:00.000Z" }]);
    await syncAll({ ...CONFIG });
    repo.logRequests = 0;

    await syncAll({ ...CONFIG });

    expect(repo.logRequests).toBe(0);
  });

  it("rewrites only the month that gained a review", async () => {
    repo.set("a.md", card("one"), "sha-a");
    const hash = await hashOf(card("one"));
    const { syncAll } = await freshSync();
    await syncAll({ ...CONFIG });
    await seedReviews([
      { hash, at: "2026-09-20T09:00:00.000Z" },
      { hash, at: "2026-10-02T09:00:00.000Z" },
    ]);
    await syncAll({ ...CONFIG });
    repo.fileWrites = [];

    await seedReviews([{ hash, at: "2026-10-05T09:00:00.000Z" }]);
    await syncAll({ ...CONFIG });

    expect(repo.fileWrites.map((w) => w.path)).toEqual([
      "hashcards-reviews/2026-10.phone1.jsonl",
    ]);
    expect(repo.fileWrites[0].content.trim().split("\n")).toHaveLength(2);
  });

  it("files a month by the local day, not the UTC one", async () => {
    // 23:30 UTC on 31 October is already November in Berlin.
    process.env.TZ = "Europe/Berlin";
    repo.set("a.md", card("one"), "sha-a");
    const hash = await hashOf(card("one"));
    const { syncAll } = await freshSync();
    await syncAll({ ...CONFIG });
    await seedReviews([{ hash, at: "2026-10-31T23:30:00.000Z" }]);

    await syncAll({ ...CONFIG });

    expect(repo.fileWrites.map((w) => w.path)).toEqual([
      "hashcards-reviews/2026-11.phone1.jsonl",
    ]);
  });

  it("keeps reviews of a subscribed collection's cards on this device", async () => {
    const mine = new FakeRepo();
    const theirs = new FakeRepo();
    mine.set("a.md", card("one"), "sha-a");
    theirs.set("b.md", card("two"), "sha-b");
    installMany({ "me/cards": mine, "someone/shared": theirs });
    localStorage.setItem(
      "repos",
      JSON.stringify([
        { owner: "me", repo: "cards", branch: "main" },
        { owner: "someone", repo: "shared", branch: "main", readOnly: true },
      ])
    );
    const { syncEverything } = await freshSync();
    await syncEverything();
    await seedReviews([
      { hash: await hashOf(card("one")), at: "2026-10-02T09:00:00.000Z" },
      { hash: await hashOf(card("two")), at: "2026-10-02T09:05:00.000Z" },
    ]);

    await syncEverything();

    expect(theirs.fileWrites).toEqual([]);
    expect(theirs.logRequests).toBe(0);
    // And theirs does not leak into yours.
    expect(mine.fileWrites).toHaveLength(1);
    expect(mine.fileWrites[0].content.trim().split("\n")).toHaveLength(1);
  });
});
