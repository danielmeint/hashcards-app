// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { utcOffsetMinutes } from "./core/schedule";
import { IDBFactory } from "fake-indexeddb";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { GitHubConfig, RepoConfig } from "./github";
import { Card, Grade, Review } from "./types";

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

/** Base64 of the UTF-8 bytes, as GitHub encodes contents. Plain `btoa` takes Latin-1 only. */
function base64(text: string): string {
  return btoa(Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join(""));
}

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

  // --- The Git Data API, for the `hashcards-data` branch ---------------------

  /** Branch → commit. `main` is not in here: its tree is `files` above. */
  refs = new Map<string, string>();
  commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  /** Tree SHA → path → blob SHA. */
  trees = new Map<string, Map<string, string>>();
  blobs = new Map<string, string>();
  /** Every ref update and creation, refused ones included. */
  refWrites: { branch: string; sha: string; ok: boolean }[] = [];
  /** Runs before each ref update is judged, to stand in for another device. */
  onRefWrite: (() => void) | null = null;
  /** Every request the data branch was asked, by method and path. */
  dataRequests: string[] = [];
  private n = 0;

  private nextSha(kind: string): string {
    return `${kind}-${++this.n}`;
  }

  /** The files on a branch, by path, as text. */
  branchFiles(branch = "hashcards-data"): Map<string, string> {
    const head = this.refs.get(branch);
    if (!head) return new Map();
    const tree = this.trees.get(this.commits.get(head)!.tree)!;
    return new Map([...tree].map(([path, sha]) => [path, this.blobs.get(sha)!]));
  }

  /** Commits on a branch, newest first. */
  history(branch = "hashcards-data"): string[] {
    const out: string[] = [];
    let at = this.refs.get(branch);
    while (at) {
      out.push(at);
      at = this.commits.get(at)!.parents[0];
    }
    return out;
  }

  /** Commit files to a branch the way another device (or `hc`) would. */
  commitFiles(files: Record<string, string | null>, branch = "hashcards-data"): string {
    const head = this.refs.get(branch);
    const tree = new Map(head ? this.trees.get(this.commits.get(head)!.tree)! : []);
    for (const [path, text] of Object.entries(files)) {
      if (text === null) tree.delete(path);
      else {
        const sha = this.nextSha("blob");
        this.blobs.set(sha, text);
        tree.set(path, sha);
      }
    }
    const treeSha = this.nextSha("tree");
    this.trees.set(treeSha, tree);
    const commit = this.nextSha("commit");
    this.commits.set(commit, { tree: treeSha, parents: head ? [head] : [], message: "elsewhere" });
    this.refs.set(branch, commit);
    return commit;
  }

  private descends(commit: string, ancestor: string): boolean {
    let at: string | undefined = commit;
    while (at) {
      if (at === ancestor) return true;
      at = this.commits.get(at)?.parents[0];
    }
    return false;
  }

  private dataApi(url: string, init?: RequestInit): Response | null {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    const path = new URL(url).pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    const ref = path.match(/^\/git\/ref\/heads\/(.+)$/);
    if (ref && method === "GET") {
      this.dataRequests.push(`GET ref`);
      const sha = this.refs.get(decodeURIComponent(ref[1]));
      return sha ? json({ object: { sha } }) : json({ message: "Not Found" }, 404);
    }
    const tree = path.match(/^\/git\/trees\/([^/]+)$/);
    if (tree && method === "GET") {
      const id = tree[1];
      const treeSha = this.commits.get(id)?.tree ?? (this.trees.has(id) ? id : null);
      if (!treeSha) return null; // `main`, answered by the listing below
      this.dataRequests.push(`GET tree`);
      const entries = [...this.trees.get(treeSha)!].map(([p, sha]) => ({ path: p, sha, type: "blob" }));
      return json({ sha: treeSha, tree: entries, truncated: false });
    }
    if (path === "/git/trees" && method === "POST") {
      this.dataRequests.push(`POST tree`);
      const base = body.base_tree ? this.trees.get(body.base_tree) : new Map<string, string>();
      if (!base) return json({ message: "base_tree not found" }, 422);
      const next = new Map(base);
      for (const entry of body.tree as { path: string; content?: string; sha?: string | null }[]) {
        if (entry.content !== undefined) {
          const sha = this.nextSha("blob");
          this.blobs.set(sha, entry.content);
          next.set(entry.path, sha);
        } else if (entry.sha === null) {
          next.delete(entry.path);
        } else next.set(entry.path, entry.sha!);
      }
      const sha = this.nextSha("tree");
      this.trees.set(sha, next);
      return json({ sha, tree: [...next].map(([p, s]) => ({ path: p, sha: s, type: "blob" })) }, 201);
    }
    if (path === "/git/commits" && method === "POST") {
      this.dataRequests.push(`POST commit`);
      const sha = this.nextSha("commit");
      this.commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
      return json({ sha }, 201);
    }
    const update = path.match(/^\/git\/refs\/heads\/(.+)$/);
    if (update && method === "PATCH") {
      this.dataRequests.push(`PATCH ref`);
      this.onRefWrite?.();
      const branch = decodeURIComponent(update[1]);
      const head = this.refs.get(branch);
      if (!head) return json({ message: "Reference does not exist" }, 422);
      // GitHub's check on a non-forced update: the new commit must descend
      // from where the branch is now.
      const ok = body.force || this.descends(body.sha, head);
      this.refWrites.push({ branch, sha: body.sha, ok });
      if (!ok) return json({ message: "Update is not a fast forward" }, 422);
      this.refs.set(branch, body.sha);
      return json({ object: { sha: body.sha } });
    }
    if (path === "/git/refs" && method === "POST") {
      this.dataRequests.push(`POST ref`);
      this.onRefWrite?.();
      const branch = String(body.ref).replace(/^refs\/heads\//, "");
      const exists = this.refs.has(branch);
      this.refWrites.push({ branch, sha: body.sha, ok: !exists });
      if (exists) return json({ message: "Reference already exists" }, 422);
      this.refs.set(branch, body.sha);
      return json({ object: { sha: body.sha } }, 201);
    }
    const blob = path.match(/^\/git\/blobs\/(.+)$/);
    if (blob && this.blobs.has(blob[1])) {
      this.dataRequests.push(`GET blob`);
      return new Response(this.blobs.get(blob[1])!, { status: 200 });
    }
    return null;
  }

  handler = (url: string, init?: RequestInit): Response => {
    const headers = new Headers(init?.headers as HeadersInit);
    const data = this.dataApi(url, init);
    if (data) return data;

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
        JSON.stringify({ content: base64(file.content), sha: file.sha }),
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

// --- Review data: the data branch, replay, compatibility -----------------------

/**
 * One device: its own IndexedDB and localStorage, sharing a fake GitHub with
 * every other. `use` makes it the one the app's modules see, the way switching
 * phones would — which is how these tests get two devices to talk to each
 * other through nothing but the repository.
 */
class Device {
  static active: Device | null = null;
  readonly idb = new IDBFactory();
  storage: Record<string, string>;

  constructor(name: string, repos: RepoConfig[] = [{ ...CONFIG }]) {
    this.storage = { device_id: name, repos: JSON.stringify(repos) };
  }

  async use() {
    const active = Device.active;
    if (active && active !== this) {
      active.storage = Object.fromEntries(
        Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).map(
          (k) => [k, localStorage.getItem(k)!]
        )
      );
    }
    localStorage.clear();
    for (const [k, v] of Object.entries(this.storage)) localStorage.setItem(k, v);
    globalThis.indexedDB = this.idb;
    vi.resetModules();
    Device.active = this;
    const { saveCredential } = await import("./auth");
    await saveCredential({ kind: "pat", token: "token" });
    return {
      sync: await import("./sync"),
      db: await import("./db"),
      session: await import("./views/drill/session"),
      github: await import("./github"),
      state: await import("./sync-state"),
    };
  }
}

type App = Awaited<ReturnType<Device["use"]>>;

const question = (c: Card) => (c.content.type === "basic" ? c.content.question : c.content.text);

/** Grade the cards with these questions, in this order, in one drill. */
async function drill(app: App, grades: [string, Grade][]) {
  const cards = await app.sync.loadCachedCards();
  const wanted = grades.map(([q]) => cards.find((c) => question(c) === q)!);
  const session = await app.session.createSession(wanted, { resume: {
    queue: wanted.map(app.db.stateKey),
    completed: [],
    gradedNew: [],
    totalCards: wanted.length,
    startedAt: new Date(0).toISOString(),
  } });
  for (const [q, grade] of grades) {
    expect(question(session.current!)).toBe(q);
    session.reveal();
    session.grade(grade);
  }
  await session.summary();
  return session;
}

/** Cards with IDs, as a v2 collection has them. */
const DECK = "ID: alpha\nQ: Alpha?\nA: a\n\n---\n\nID: beta\nQ: Beta?\nA: b\n";

const reviewFiles = (repo: FakeRepo) =>
  [...repo.branchFiles()].filter(([path]) => path.startsWith("reviews/"));

const lines = (text: string) => text.trim().split("\n").map((l) => JSON.parse(l));

/** Every card's state, as plain data, for comparing two devices. */
async function states(app: App) {
  return Object.fromEntries(
    [...(await app.db.getAllPerformances())].map(([k, s]) => [
      k,
      { due: s.dueDate, s: s.stability, d: s.difficulty, reps: s.reviewCount },
    ])
  );
}

describe("the data branch", () => {
  let repo: FakeRepo;

  beforeEach(() => {
    localStorage.clear();
    Device.active = null;
    repo = new FakeRepo();
    repo.set("a.md", DECK, "sha-a");
    install(repo);
  });

  it("creates the orphan branch on the first push, with the review as a v2 event", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);
    await drill(app, [["Alpha?", Grade.Good]]);

    expect(await app.sync.syncAll(CONFIG)).toBe(true);

    const [commit] = repo.history();
    expect(repo.commits.get(commit)!.parents).toEqual([]);
    const files = reviewFiles(repo);
    expect(files).toHaveLength(1);
    expect(files[0][0]).toMatch(/^reviews\/\d{4}-\d{2}\.phone1\.jsonl$/);
    const [event] = lines(files[0][1]);
    expect(event).toMatchObject({ v: 2, card: "alpha", grade: 3 });
    expect(event.tz).toBe(utcOffsetMinutes(event.at));
    expect(event.ms).toBeGreaterThanOrEqual(0);
    // The snapshot rides along in the same commit.
    expect(JSON.parse(repo.branchFiles().get("snapshot.json")!).cards.alpha.reps).toBe(1);
    // And nothing of it on `main`.
    expect(repo.fileWrites).toEqual([]);
    expect(repo.stateWrites).toEqual([]);
  });

  it("commits nothing, and reads no tree, when nothing is new", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);
    await drill(app, [["Alpha?", Grade.Good]]);
    await app.sync.syncAll(CONFIG);
    const commits = repo.history().length;
    repo.dataRequests = [];

    await app.sync.syncAll(CONFIG);

    expect(repo.history()).toHaveLength(commits);
    expect(repo.dataRequests).toEqual(["GET ref"]);
  });

  it("writes every changed file in one commit", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);
    await drill(app, [["Alpha?", Grade.Good], ["Beta?", Grade.Easy]]);
    // A second month, as a baseline carried by an edit would make.
    await app.db.addBaselines([
      {
        log: "someone/cards",
        event: { v: 2, kind: "baseline", card: "alpha", at: "2025-03-01T10:00:00.000Z", tz: 60, s: 5, d: 5, reps: 2 },
      },
    ]);

    await app.sync.syncAll(CONFIG);

    expect(repo.history()).toHaveLength(1);
    expect(reviewFiles(repo).map(([p]) => p)).toContain("reviews/2025-03.phone1.jsonl");
    expect(reviewFiles(repo)).toHaveLength(2);
  });

  it("brings two devices to the same state", async () => {
    const phone = new Device("phone1");
    const laptop = new Device("laptop1");

    let app = await phone.use();
    await app.sync.syncAll(CONFIG);
    await drill(app, [["Alpha?", Grade.Good]]);
    await app.sync.syncAll(CONFIG);

    app = await laptop.use();
    await app.sync.syncAll(CONFIG);
    await drill(app, [["Beta?", Grade.Hard], ["Alpha?", Grade.Easy]]);
    await app.sync.syncAll(CONFIG);
    const onLaptop = await states(app);

    app = await phone.use();
    await app.sync.syncAll(CONFIG);
    const onPhone = await states(app);

    expect(Object.keys(onPhone).sort()).toEqual(["someone/cards/alpha", "someone/cards/beta"]);
    expect(onPhone).toEqual(onLaptop);
    expect(onPhone["someone/cards/alpha"].reps).toBe(2);
    // Two devices, two files, never the same one.
    expect(reviewFiles(repo).map(([p]) => p.split(".")[1]).sort()).toEqual(["laptop1", "phone1"]);
  });

  it("builds on the new tip when another device commits first", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);
    await drill(app, [["Alpha?", Grade.Good]]);
    await app.sync.syncAll(CONFIG);
    await drill(app, [["Beta?", Grade.Good]]);

    // The laptop pushes in the window between our read of the tip and our
    // move of it, which is what the fast-forward check is there to catch.
    const at = new Date().toISOString();
    repo.onRefWrite = () => {
      repo.onRefWrite = null;
      repo.commitFiles({
        "reviews/2026-01.laptop1.jsonl": JSON.stringify({ v: 2, card: "alpha", at, tz: 60, grade: 1 }) + "\n",
      });
    };

    expect(await app.sync.syncAll(CONFIG)).toBe(true);

    expect(repo.refWrites.map((w) => w.ok)).toEqual([true, false, true]);
    expect(reviewFiles(repo).map(([p]) => p).sort()).toEqual([
      "reviews/2026-01.laptop1.jsonl",
      expect.stringMatching(/phone1/),
    ]);
    // And the laptop's lapse is part of the state here, not merely preserved there.
    expect((await app.db.getAllPerformances()).get("someone/cards/alpha")!.reviewCount).toBe(2);
  });

  it("settles two devices creating the branch at once", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);
    await drill(app, [["Alpha?", Grade.Good]]);
    repo.onRefWrite = () => {
      repo.onRefWrite = null;
      repo.commitFiles({ "reviews/2026-01.laptop1.jsonl": "" });
    };

    expect(await app.sync.syncAll(CONFIG)).toBe(true);

    expect(repo.refWrites.map((w) => w.ok)).toEqual([false, true]);
    expect(repo.branchFiles().has("reviews/2026-01.laptop1.jsonl")).toBe(true);
    expect(reviewFiles(repo)).toHaveLength(2);
  });

  it("stops retrying a race that never clears, and says so", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);
    await drill(app, [["Alpha?", Grade.Good]]);
    await app.sync.syncAll(CONFIG);
    await drill(app, [["Beta?", Grade.Good]]);
    let n = 0;
    repo.onRefWrite = () => {
      repo.commitFiles({ [`reviews/2026-01.busy.jsonl`]: `${++n}\n` });
    };

    expect(await app.sync.syncAll(CONFIG)).toBe(false);

    expect(repo.refWrites.filter((w) => !w.ok)).toHaveLength(3);
    const status = app.state.getSyncStatus();
    expect(status.phase === "error" && status.needsSignIn).toBe(false);
  });

  it("keeps reviews graded offline, and pushes them when back", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);
    const online = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await drill(app, [["Alpha?", Grade.Good]]);
    expect(await app.sync.syncAll(CONFIG)).toBe(false);
    expect((await app.db.getAllPerformances()).get("someone/cards/alpha")!.reviewCount).toBe(1);

    globalThis.fetch = online;
    expect(await app.sync.syncAll(CONFIG)).toBe(true);
    expect(lines(reviewFiles(repo)[0][1])).toMatchObject([{ card: "alpha", grade: 3 }]);
  });

  it("never pushes a grade undone before the push", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);
    const session = await drill(app, [["Alpha?", Grade.Good]]);
    await session.undo();

    await app.sync.syncAll(CONFIG);

    expect(repo.refs.size).toBe(0);
    expect(await app.db.getAllPerformances()).toEqual(new Map());
  });

  it("rewrites the month file for a grade undone after the push", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);
    const session = await drill(app, [["Alpha?", Grade.Good], ["Beta?", Grade.Good]]);
    await app.sync.syncAll(CONFIG);
    expect(lines(reviewFiles(repo)[0][1])).toHaveLength(2);

    await session.undo();
    await app.sync.syncAll(CONFIG);
    expect(lines(reviewFiles(repo)[0][1]).map((e) => e.card)).toEqual(["alpha"]);

    // The month's last grade going takes the file with it.
    await session.undo();
    await app.sync.syncAll(CONFIG);
    expect(reviewFiles(repo)).toEqual([]);
    expect(repo.history()).toHaveLength(3);
  });

  it("forgets another device's grade that it undid after pushing", async () => {
    const laptop = await new Device("laptop1").use();
    await laptop.sync.syncAll(CONFIG);
    await drill(laptop, [["Alpha?", Grade.Good]]);
    await laptop.sync.syncAll(CONFIG);

    const phone = new Device("phone1");
    let app = await phone.use();
    await app.sync.syncAll(CONFIG);
    expect((await app.db.getAllPerformances()).has("someone/cards/alpha")).toBe(true);

    // What the laptop's next push does after that undo: its file goes.
    repo.commitFiles({ [reviewFiles(repo)[0][0]]: null });
    app = await phone.use();
    await app.sync.syncAll(CONFIG);

    expect((await app.db.getAllPerformances()).has("someone/cards/alpha")).toBe(false);
  });

  it("does not push to a repo it has only adopted", async () => {
    const app = await new Device("phone1").use();
    await app.sync.adoptRepo(CONFIG);
    const inStepAt = app.state.getLastPushedAt();
    await drill(app, [["Alpha?", Grade.Good]]);

    expect(await app.sync.adoptRepo(CONFIG)).toBe(true);

    expect(repo.refs.size).toBe(0);
    // A pull is a sync; but that review is still only on this device, and the
    // warning that says so keys off this not moving.
    expect(app.state.getLastPushedAt()).toBe(inStepAt);
  });

  it("creates no data branch in a repo that holds no cards", async () => {
    repo.files.clear();
    const app = await new Device("phone1").use();
    await app.db.updateDeckFiles(
      [{ repo: "someone/other", path: "x.md", sha: "x", cards: [] }],
      []
    );

    expect(await app.sync.syncAll(CONFIG)).toBe(true);

    expect(repo.refWrites).toEqual([]);
  });
});

describe("drafts and suspended cards", () => {
  it("are never due and never introduced as new", async () => {
    const file =
      "ID: live\nQ: Live?\nA: a\n\n---\n\nID: idea\nStatus: draft\nQ: Idea?\nA: b\n\n---\n\n" +
      "ID: parked\nStatus: suspended\nQ: Parked?\nA: c\n\n---\n\nID: parked-new\nStatus: suspended\nQ: Parked new?\nA: d\n";
    const repo = new FakeRepo();
    repo.set("a.md", file, "sha-a");
    install(repo);
    localStorage.clear();
    Device.active = null;
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);
    const cards = await app.sync.loadCachedCards();
    // Suspended after it had been learned, and overdue since.
    await app.db.importState({
      "someone/cards/parked": {
        type: "reviewed",
        lastReviewedAt: "2026-01-01T00:00:00.000Z",
        stability: 2,
        difficulty: 5,
        intervalRaw: 2,
        intervalDays: 2,
        dueDate: "2026-01-03",
        reviewCount: 1,
      },
    });
    const { selectDueCards, countDue } = await import("./new-card-budget");
    const performances = await app.db.getAllPerformances();

    expect(selectDueCards(cards, performances, "2026-10-15").map(question)).toEqual(["Live?"]);
    expect(countDue(cards, performances, "2026-10-15")).toMatchObject({ reviewDue: 0, newCount: 1 });
  });
});

describe("a collection the app only reads", () => {
  let mine: FakeRepo;
  let theirs: FakeRepo;
  const repos: RepoConfig[] = [
    { owner: "me", repo: "cards", branch: "main" },
    { owner: "someone", repo: "shared", branch: "main", readOnly: true },
  ];

  beforeEach(() => {
    localStorage.clear();
    Device.active = null;
    mine = new FakeRepo();
    theirs = new FakeRepo();
    mine.set("a.md", DECK, "sha-a");
    theirs.set("b.md", "ID: gamma\nQ: Gamma?\nA: g\n", "sha-b");
    installMany({ "me/cards": mine, "someone/shared": theirs });
  });

  it("fetches its cards", async () => {
    const app = await new Device("phone1", repos).use();

    await app.sync.syncEverything();

    const fromRepos = (await app.sync.loadCachedCards()).map((c) => c.repo).sort();
    expect(fromRepos).toEqual(["me/cards", "me/cards", "someone/shared"]);
  });

  it("logs your reviews of its cards in your own data branch, under its name", async () => {
    const app = await new Device("phone1", repos).use();
    await app.sync.syncEverything();
    await drill(app, [["Gamma?", Grade.Good], ["Alpha?", Grade.Good]]);

    await app.sync.syncEverything();

    const events = lines(reviewFiles(mine)[0][1]);
    expect(events.map((e) => e.card).sort()).toEqual(["alpha", "someone/shared/gamma"]);
    // Their repository is read for cards and nothing else: not written, and
    // not even asked about a data branch.
    expect(theirs.dataRequests).toEqual([]);
    expect(theirs.fileWrites).toEqual([]);
    expect(theirs.writeAttempts).toEqual([]);
  });

  it("carries that scheduling to your other devices", async () => {
    let app = await new Device("phone1", repos).use();
    await app.sync.syncEverything();
    await drill(app, [["Gamma?", Grade.Easy]]);
    await app.sync.syncEverything();
    const there = await states(app);

    app = await new Device("laptop1", repos).use();
    await app.sync.syncEverything();

    expect(await states(app)).toEqual(there);
    expect(Object.keys(there)).toEqual(["someone/shared/gamma"]);
  });
});

/**
 * A collection from before 1.0: no data branch, its scheduling in
 * `hashcards-state.json` on `main`, its history in v1 files beside it, and
 * cards without IDs. Until `hc migrate` has been run on it, it keeps working
 * exactly as it did, in both directions.
 */
describe("a collection that has not been migrated", () => {
  let repo: FakeRepo;
  let hash: string;
  const V1 = card("one");

  const entry = (at: string, reps: number) => ({
    lastReviewedAt: at,
    stability: 3,
    difficulty: 5,
    intervalRaw: 3,
    intervalDays: 3,
    dueDate: "2026-02-01",
    reviewCount: reps,
  });

  beforeEach(async () => {
    localStorage.clear();
    Device.active = null;
    repo = new FakeRepo();
    repo.set("a.md", V1, "sha-a");
    hash = await hashOf(V1);
    repo.setState({ version: 1, cards: { [hash]: entry("2026-01-01T09:00:00.000Z", 4) } });
    // Another device reviewed it since the state file was last written.
    repo.set(
      "hashcards-reviews/2026-01.tablet.jsonl",
      JSON.stringify({ card: hash, at: "2026-01-05T09:00:00.000Z", grade: 1, s: 1, d: 7 }) + "\n",
      "sha-log"
    );
    install(repo);
  });

  it("reads the state file and the v1 logs into the schedule", async () => {
    const app = await new Device("phone1").use();

    expect(await app.sync.syncAll(CONFIG)).toBe(true);

    const state = (await app.db.getAllPerformances()).get(`someone/cards/h:${hash.slice(0, 16)}`)!;
    // The state file's four reviews, then the tablet's lapse on top.
    expect(state.reviewCount).toBe(5);
    expect(state.lastReviewedAt).toBe("2026-01-05T09:00:00.000Z");
  });

  it("keeps writing v1 files, and no v2 data, after a review here", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);
    await drill(app, [["one", Grade.Good]]);

    expect(await app.sync.syncAll(CONFIG)).toBe(true);

    const written = repo.stateWrites[repo.stateWrites.length - 1] as { cards: Record<string, { reviewCount: number }> };
    expect(written.cards[hash].reviewCount).toBe(6);
    const log = repo.fileWrites.find((w) => w.path.startsWith("hashcards-reviews/"))!;
    expect(log.path).toMatch(/\.phone1\.jsonl$/);
    expect(lines(log.content)[0]).toMatchObject({ card: hash, grade: 3 });
    expect(repo.refs.size).toBe(0);
    expect(repo.refWrites).toEqual([]);
    expect(repo.fileWrites.map((w) => w.path)).not.toContain("hashcards.toml");
  });

  it("writes nothing when it has learned nothing new", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);

    await app.sync.syncAll(CONFIG);

    // Replay recomputes due dates (current retention, deterministic fuzz), but
    // a card this device has nothing newer about keeps its entry verbatim.
    expect(repo.stateWrites).toHaveLength(1);
    expect((repo.stateWrites[0] as { cards: Record<string, unknown> }).cards[hash]).toMatchObject({
      lastReviewedAt: "2026-01-05T09:00:00.000Z",
    });
  });

  it("says what to run, without stopping anything", async () => {
    const app = await new Device("phone1").use();

    await app.sync.syncAll(CONFIG);

    const status = app.state.getSyncStatus();
    expect(status.phase).toBe("idle");
    expect(status.phase === "idle" && status.notice).toContain("hc migrate");
  });

  it("re-reads and retries when another device writes the state file first", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);
    await drill(app, [["one", Grade.Good]]);
    const other = await hashOf(card("elsewhere"));
    repo.onStateRead = () => {
      repo.onStateRead = null;
      repo.state = {
        content: btoa(JSON.stringify({ version: 1, cards: { ...JSON.parse(atob(repo.state!.content)).cards, [other]: entry("2026-03-01T00:00:00.000Z", 1) } })),
        sha: "state-from-the-tablet",
      };
    };

    expect(await app.sync.syncAll(CONFIG)).toBe(true);

    const last = repo.stateWrites[repo.stateWrites.length - 1] as { cards: object };
    expect(Object.keys(last.cards).sort()).toEqual([hash, other].sort());
  });

  it("does not retry a 422 that has nothing to do with a lost race", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);
    await drill(app, [["one", Grade.Good]]);
    let attempts = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT" && url.includes("hashcards-state.json")) {
        attempts++;
        return new Response(JSON.stringify({ message: "Branch cards-v2 not found" }), { status: 422 });
      }
      return repo.handler(url, init);
    }) as unknown as typeof fetch;

    expect(await app.sync.syncAll(CONFIG)).toBe(false);
    expect(attempts).toBe(1);
  });

  it("switches to the data branch once one appears", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);
    // `hc migrate`, run elsewhere: the history moves to the data branch, keyed.
    const key = `h:${hash.slice(0, 16)}`;
    repo.commitFiles({
      "reviews/2025-12.migrated.jsonl":
        JSON.stringify({ v: 2, kind: "baseline", card: key, at: "2026-01-01T09:00:00.000Z", s: 3, d: 5, reps: 4 }) + "\n",
      "reviews/2026-01.tablet.jsonl":
        JSON.stringify({ v: 2, card: key, at: "2026-01-05T09:00:00.000Z", tz: 60, grade: 1, src: "v1" }) + "\n",
    });
    await drill(app, [["one", Grade.Good]]);

    await app.sync.syncAll(CONFIG);

    expect((await app.db.getAllPerformances()).get(`someone/cards/${key}`)!.reviewCount).toBe(6);
    expect(lines(repo.branchFiles().get(reviewFiles(repo).find(([p]) => p.includes("phone1"))![0])!)).toMatchObject([
      { card: key, grade: 3 },
    ]);
    expect(app.state.getSyncStatus()).toEqual({ phase: "idle" });
  });
});

/**
 * The other end of `hc migrate` (PLAN-1.0 M4): the app reading a collection
 * before and after it was migrated. The repo is a copy of my-hashcards
 * (`cli/fixtures/v1-repo`), migrated with the same pure planner `hc` uses; the
 * CLI's own tests cover the git side.
 */
describe("a collection migrated by hc migrate", () => {
  // A path, not a URL: jsdom brings its own `URL`, which `fs` does not take.
  const fixture = (path: string) =>
    readFileSync(join(import.meta.dirname, "../cli/fixtures/v1-repo", path), "utf8");
  const DECKS = [
    "geography/europe/Europe_Central.md",
    "geography/europe/Europe_Nordic_Baltic.md",
    "geography/europe/Europe_Southern.md",
    "geography/europe/Europe_Western.md",
    "geography/germany/Germany_States.md",
    "geography/norway/Norway_Counties.md",
  ];
  const LOGS = ["hashcards-reviews/2026-10.3e2bd77f.jsonl", "hashcards-reviews/2026-10.5a1b5635.jsonl"];
  let repo: FakeRepo;

  beforeEach(() => {
    localStorage.clear();
    Device.active = null;
    repo = new FakeRepo();
    repo.set("CARD_GUIDE.md", fixture("CARD_GUIDE.md"), "sha-guide");
    for (const path of DECKS) repo.set(path, fixture(path), `sha-${path}`);
    for (const path of LOGS) repo.set(path, fixture(path), `sha-${path}`);
    repo.set("hashcards-state.json", fixture("hashcards-state.json"), "sha-state");
    repo.setState(JSON.parse(fixture("hashcards-state.json")));
    install(repo);
  });

  /** What `hc migrate --apply` and a push would do to the repo, as it is now. */
  async function migrate() {
    const { planMigration } = await import("./migrate");
    let n = 0;
    const logs = [...repo.files].filter(([path]) => path.startsWith("hashcards-reviews/"));
    const plan = await planMigration({
      decks: DECKS.map((path) => ({ path, text: repo.files.get(path)!.content })),
      state: atob(repo.state!.content),
      logs: logs.map(([path, f]) => ({ path, text: f.content })),
      generate: () => `m${String(++n).padStart(3, "0")}`,
    });
    for (const deck of plan.stamped) repo.set(deck.path, deck.text, `sha-${deck.path}-migrated`);
    for (const [path] of logs) repo.files.delete(path);
    repo.files.delete("hashcards-state.json");
    repo.state = null;
    repo.commitFiles(Object.fromEntries(plan.files));
    repo.retag('W/"migrated"');
    return plan;
  }

  /** The app's state of every card a deck has, by its v1 hash, so keys can change under it. */
  async function byHash(app: App) {
    const performances = await app.db.getAllPerformances();
    const out = new Map<string, { due: string; s: number; d: number; reps: number }>();
    for (const card of await app.sync.loadCachedCards()) {
      const state = performances.get(app.db.stateKey(card));
      if (state) out.set(card.hash, { due: state.dueDate, s: state.stability, d: state.difficulty, reps: state.reviewCount });
    }
    return out;
  }

  it("keeps every card's memory state, and moves due dates only by fuzz", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);
    const before = await byHash(app);
    expect(app.state.getSyncStatus()).toMatchObject({ notice: expect.stringContaining("hc migrate") });

    const plan = await migrate();
    expect(await app.sync.syncAll(CONFIG)).toBe(true);
    const after = await byHash(app);

    expect(app.state.getSyncStatus()).toEqual({ phase: "idle" });
    expect(before.size).toBe(51);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    const moved = new Map(plan.dueShift.moved.map((m) => [m.key, m]));
    const cards = await app.sync.loadCachedCards();
    for (const [hash, was] of before) {
      const now = after.get(hash)!;
      expect({ ...now, due: undefined }).toEqual({ ...was, due: undefined });
      // Exactly the cards the plan said fuzz would move, to the dates it said.
      const key = cards.find((c) => c.hash === hash)!.key;
      expect([was.due, now.due]).toEqual(moved.has(key) ? [moved.get(key)!.before, moved.get(key)!.after] : [was.due, was.due]);
    }
    // Nothing of v1 written, before or after, and no reviews of its own to push.
    expect(repo.stateWrites).toEqual([]);
    expect(repo.fileWrites).toEqual([]);
    expect(reviewFiles(repo).every(([path]) => path.endsWith(".v1.jsonl"))).toBe(true);
  });

  it("counts a review this device made before the migration once", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);
    await drill(app, [["Where is **Iceland**? Picture it on the map, then check.", Grade.Good]]);
    await app.sync.syncAll(CONFIG);
    expect(repo.fileWrites.map((w) => w.path)).toEqual(["hashcards-reviews/" + repo.fileWrites[0].path.split("/")[1]]);

    await migrate();
    await app.sync.syncAll(CONFIG);

    const iceland = (await app.sync.loadCachedCards()).find((c) => question(c) === "Where is **Iceland**? Picture it on the map, then check.")!;
    expect(iceland.id).not.toBeNull();
    const performances = await app.db.getAllPerformances();
    expect(performances.get(app.db.stateKey(iceland))!.reviewCount).toBe(1);
    // Its old key no longer names a card, and must not linger as a second schedule.
    expect(performances.has(`someone/cards/h:${iceland.hash.slice(0, 16)}`)).toBe(false);
    // Nor is the review sent to the data branch a second time.
    expect(reviewFiles(repo).every(([path]) => path.endsWith(".v1.jsonl"))).toBe(true);
  });

  it("agrees with a replay of the migrated events, and a fresh device agrees too", async () => {
    const plan = await migrate();
    const fresh = await new Device("tablet").use();
    await fresh.sync.syncAll(CONFIG);

    const { replay } = await import("./core/replay");
    const expected = replay(plan.events, { retention: 0.9, fuzz: true });
    const performances = await fresh.db.getAllPerformances();
    const cards = await fresh.sync.loadCachedCards();
    expect(cards).toHaveLength(240);
    expect(cards.every((c) => c.id !== null)).toBe(true);
    let scheduled = 0;
    for (const card of cards) {
      const want = expected.get(card.key);
      const got = performances.get(fresh.db.stateKey(card));
      if (!want) {
        expect(got).toBeUndefined();
        continue;
      }
      scheduled++;
      expect(got).toMatchObject({ dueDate: want.dueDate, stability: want.stability, reviewCount: want.reviewCount });
    }
    expect(scheduled).toBe(51);
  });
});

describe("hashcards.toml", () => {
  let repo: FakeRepo;
  const TOML = `# The collection's settings
[review]
new_per_day = 5
desired_retention = 0.8   # stretch it
fuzz = false

[decks]
exclude = ["archive/**"]
`;

  beforeEach(() => {
    localStorage.clear();
    Device.active = null;
    repo = new FakeRepo();
    repo.set("a.md", DECK, "sha-a");
    repo.set("archive/old.md", "Q: Old?\nA: o\n", "sha-old");
    repo.set("hashcards.toml", TOML, "sha-toml");
    install(repo);
  });

  it("is where the review settings and the decks come from", async () => {
    const app = await new Device("phone1").use();

    await app.sync.syncAll(CONFIG);

    expect(app.github.getDesiredRetention()).toBe(0.8);
    expect(app.github.getIntervalFuzz()).toBe(false);
    const { getNewCardsPerDay } = await import("./new-card-budget");
    expect(getNewCardsPerDay()).toBe(5);
    expect((await app.sync.loadCachedCards()).map((c) => c.filePath)).toEqual(["a.md", "a.md"]);
  });

  it("gets a changed setting written back as one commit, keeping the rest of the file", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);

    app.github.setDesiredRetention(0.85);
    await app.sync.syncAll(CONFIG);

    const writes = repo.fileWrites.filter((w) => w.path === "hashcards.toml");
    expect(writes).toHaveLength(1);
    expect(writes[0].content).toBe(TOML.replace("desired_retention = 0.8   # stretch it", "desired_retention = 0.85 # stretch it"));
    // Written once, then read back like any other change.
    await app.sync.syncAll(CONFIG);
    expect(repo.fileWrites.filter((w) => w.path === "hashcards.toml")).toHaveLength(1);
    expect(app.github.getDesiredRetention()).toBe(0.85);
  });

  it("moves every due date when retention changes", async () => {
    const app = await new Device("phone1").use();
    await app.sync.syncAll(CONFIG);
    await drill(app, [["Alpha?", Grade.Good]]);
    const before = (await app.db.getAllPerformances()).get("someone/cards/alpha")!.intervalDays;

    repo.set("hashcards.toml", TOML.replace("0.8", "0.95"), "sha-toml-2");
    repo.retag('W/"tree-2"');
    await app.sync.syncAll(CONFIG);

    expect((await app.db.getAllPerformances()).get("someone/cards/alpha")!.intervalDays).toBeLessThan(before);
  });
});

/**
 * An install from before card keys: performances and reviews keyed by content
 * hash, cards cached without IDs or keys. Opening the database carries all of
 * it across once.
 */
describe("a database from before keys", () => {
  async function databaseAtV7(hash: string, oldCard: unknown, month: string, line: string) {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    const { openDB } = await import("idb");
    const old = await openDB("hashcards", 7, {
      upgrade(db) {
        db.createObjectStore("performances", { keyPath: "hash" });
        db.createObjectStore("reviews", { autoIncrement: true });
        db.createObjectStore("session");
        db.createObjectStore("meta");
        db.createObjectStore("credentials");
        db.createObjectStore("origins");
        db.createObjectStore("deckFiles", { keyPath: ["repo", "path"] });
        db.createObjectStore("media", { keyPath: ["repo", "path"] });
      },
    });
    await old.put("deckFiles", { repo: "someone/cards", path: "a.md", sha: "sha-a", cards: [oldCard] });
    await old.put("performances", {
      hash,
      lastReviewedAt: "2026-09-02T09:00:00.000Z",
      stability: 3,
      difficulty: 5,
      intervalRaw: 3,
      intervalDays: 3,
      dueDate: "2026-09-05",
      reviewCount: 2,
    });
    await old.add("reviews", {
      cardHash: hash,
      reviewedAt: "2026-09-02T09:00:00.000Z",
      grade: 3,
      stability: 3,
      difficulty: 5,
      intervalRaw: 3,
      intervalDays: 3,
      dueDate: "2026-09-05",
    });
    await old.put("meta", line + "\n", `review_log:someone/cards:${month}`);
    await old.put("meta", 'W/"t"', "tree_etag:someone/cards");
    await old.put("session", { queue: [hash], completed: [], gradedNew: [], totalCards: 1, startedAt: "x" }, "current");
    old.close();
  }

  it("moves hashes onto keys, once", async () => {
    localStorage.clear();
    localStorage.setItem("repos", JSON.stringify([CONFIG]));
    const hash = await hashOf(card("one"));
    const key = `someone/cards/h:${hash.slice(0, 16)}`;
    const oldCard = {
      deckName: "a",
      repo: "someone/cards",
      filePath: "a.md",
      range: [1, 2],
      content: { type: "basic", question: "one", answer: "because" },
      hash,
      familyHash: null,
    };
    const { logLine, v1MonthOf } = await import("./v1-log");
    const review = { cardHash: hash, reviewedAt: "2026-09-02T09:00:00.000Z", grade: 3, stability: 3, difficulty: 5 } as Review;
    await databaseAtV7(hash, oldCard, v1MonthOf(review), logLine(review));

    const db = await import("./db");

    expect([...(await db.getAllPerformances()).keys()]).toEqual([key]);
    const [migrated] = await db.getAllReviews();
    expect(migrated).toMatchObject({ key, log: "someone/cards", v1Pushed: true });
    expect(typeof migrated.tz).toBe("number");
    expect(await db.getLocalBaselines()).toMatchObject([
      { log: "someone/cards", event: { kind: "baseline", card: `h:${hash.slice(0, 16)}`, reps: 2, src: "v1" } },
    ]);
    expect((await db.loadSession())!.queue).toEqual([key]);
    // Cached without keys: given them now, and fetched again on the next sync.
    const [file] = await db.getAllDeckFiles();
    expect(file.sha).toBe("");
    expect(file.cards[0]).toMatchObject({ key: `h:${hash.slice(0, 16)}`, id: null, tags: [], status: "active" });
    expect(await db.getMeta("tree_etag:someone/cards")).toBeUndefined();
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

