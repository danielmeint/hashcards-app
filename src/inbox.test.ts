// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { InboxOp } from "./inbox-queue";
import type { Card } from "./types";

/**
 * A content branch behind the Git Data API: commits, trees and blobs, with ref
 * updates refused unless they fast-forward — which is how GitHub tells a
 * writer it lost a race.
 */
class GitRepo {
  blobs = new Map<string, string>();
  commits = new Map<string, { tree: Map<string, string>; parent: string | null; message: string }>();
  trees = new Map<string, Map<string, string>>();
  head: string;
  /** Messages of every commit the ref moved to, oldest first. */
  log: string[] = [];
  /** Runs once, just before the next ref update is answered. */
  beforeRefUpdate: (() => void) | null = null;
  private n = 0;

  constructor(readonly name: string, files: Record<string, string>) {
    this.head = this.commit(new Map(Object.entries(files).map(([p, t]) => [p, this.blob(t)])), null, "seed");
  }

  blob(text: string): string {
    const sha = `${this.name}-blob-${++this.n}`;
    this.blobs.set(sha, text);
    return sha;
  }

  commit(tree: Map<string, string>, parent: string | null, message: string): string {
    const treeSha = `${this.name}-tree-${++this.n}`;
    this.trees.set(treeSha, tree);
    const sha = `${this.name}-commit-${++this.n}`;
    this.commits.set(sha, { tree, parent, message });
    return sha;
  }

  /** Someone else pushing to main. */
  push(path: string, text: string): void {
    const tree = new Map(this.commits.get(this.head)!.tree);
    tree.set(path, this.blob(text));
    this.head = this.commit(tree, this.head, "upstream");
  }

  files(): Record<string, string> {
    const tree = this.commits.get(this.head)!.tree;
    return Object.fromEntries([...tree].map(([p, sha]) => [p, this.blobs.get(sha)!]));
  }

  private treeOfCommit(sha: string): string {
    const tree = this.commits.get(sha)!.tree;
    return [...this.trees].find(([, t]) => t === tree)![0];
  }

  handle(path: string, init?: RequestInit): Response {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path === "/git/ref/heads/main") return json({ object: { sha: this.head } });
    let m = path.match(/^\/git\/trees\/(.+)$/);
    if (m && !init?.method) {
      const treeSha = this.treeOfCommit(m[1]);
      const tree = this.trees.get(treeSha)!;
      return json({ sha: treeSha, tree: [...tree].map(([p, sha]) => ({ path: p, sha, type: "blob" })) });
    }
    m = path.match(/^\/git\/blobs\/(.+)$/);
    if (m) return new Response(this.blobs.get(m[1])!, { status: 200 });
    if (path === "/git/trees" && init?.method === "POST") {
      const tree = new Map(this.trees.get(body.base_tree));
      for (const e of body.tree) {
        if (e.content !== undefined) tree.set(e.path, this.blob(e.content));
        else if (e.sha === null) tree.delete(e.path);
      }
      const sha = `${this.name}-tree-${++this.n}`;
      this.trees.set(sha, tree);
      // Like GitHub: only the top level of the tree comes back.
      const top = [...tree].filter(([p]) => !p.includes("/"));
      return json({ sha, tree: top.map(([p, s]) => ({ path: p, sha: s, type: "blob" })) }, 201);
    }
    if (path === "/git/commits" && init?.method === "POST") {
      const sha = `${this.name}-commit-${++this.n}`;
      this.commits.set(sha, { tree: this.trees.get(body.tree)!, parent: body.parents[0], message: body.message });
      return json({ sha }, 201);
    }
    if (path === "/git/refs/heads/main" && init?.method === "PATCH") {
      this.beforeRefUpdate?.();
      this.beforeRefUpdate = null;
      if (this.commits.get(body.sha)!.parent !== this.head) {
        return json({ message: "Update is not a fast forward" }, 422);
      }
      this.head = body.sha;
      this.log.push(this.commits.get(body.sha)!.message);
      return json({ object: { sha: body.sha } });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  }
}

const K8S = `Q: What is a Pod?
A: The smallest deployable unit.

---

Status: draft
Q: What does a Deployment manage?
A: A ReplicaSet.

---

Status: draft
C: A [Service] gives Pods a stable address.
`;

const GEO = `---
name = "Capitals"
---

ID: est-capital
Status: draft
Q: Capital of Estonia?
A: Tallinn
`;

let repos: Map<string, GitRepo>;

async function setup(files: Record<string, Record<string, string>>) {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem(
    "repos",
    JSON.stringify(
      Object.keys(files).map((key) => {
        const [owner, repo] = key.split("/");
        return { owner, repo, branch: "main" };
      })
    )
  );
  vi.resetModules();
  repos = new Map(Object.entries(files).map(([key, f]) => [key, new GitRepo(key.replace("/", "-"), f)]));
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)$/)!;
    return repos.get(m[1])!.handle(m[2], init);
  }) as unknown as typeof fetch;

  const { saveCredential } = await import("./auth");
  await saveCredential({ kind: "pat", token: "token" });
  const { parseFile } = await import("./parser");
  const { updateDeckFiles } = await import("./db");
  for (const [key, repoFiles] of Object.entries(files)) {
    for (const [path, text] of Object.entries(repoFiles)) {
      const cards = (await parseFile(text, path, path.replace(/\.md$/, ""))).map((c) => ({ ...c, repo: key }));
      await updateDeckFiles([{ repo: key, path, sha: "old", cards }], []);
    }
  }
  const sync = await import("./sync");
  await sync.loadCards();
  return {
    sync,
    queue: await import("./inbox-queue"),
    commit: await import("./inbox-commit"),
    edits: await import("./draft-edits"),
    db: await import("./db"),
  };
}

type Modules = Awaited<ReturnType<typeof setup>>;

/** Queue one decision about the draft whose text includes `text`. */
async function decide(
  m: Modules,
  text: string,
  action: InboxOp["action"],
  extra: Partial<InboxOp> = {}
): Promise<InboxOp> {
  const drafts = m.edits.findDrafts(await m.sync.loadCachedCards(), () => true);
  const block = drafts.find((d) =>
    d.cards.some((c) => (c.content.type === "basic" ? c.content.question : c.content.text).includes(text))
  )!;
  const op: InboxOp = {
    id: m.queue.opId(),
    repo: block.repo,
    path: block.path,
    action,
    block: block.cards.map((c) => c.hash),
    ...(action === "keep" && !block.cards[0].id ? { stampId: "stamp" + Math.random().toString(36).slice(2, 5) } : {}),
    at: new Date().toISOString(),
    ...extra,
  };
  await m.queue.enqueue([op]);
  await m.sync.loadCards();
  return op;
}

const drafts = (cards: Card[]) => cards.filter((c) => c.status === "draft");

describe("the queue, laid over the cards", () => {
  it("makes a kept draft a new card under the key its stamped ID will give it", async () => {
    const m = await setup({ "me/cards": { "k8s.md": K8S } });
    const op = await decide(m, "Deployment", "keep");
    const cards = await m.sync.loadCachedCards();
    const kept = cards.find((c) => c.content.type === "basic" && c.content.question.includes("Deployment"))!;
    expect(kept.status).toBe("active");
    expect(kept.key).toBe(op.stampId);
    expect(drafts(cards)).toHaveLength(1);
  });

  it("makes a discarded draft vanish, and an undo bring it back", async () => {
    const m = await setup({ "me/cards": { "k8s.md": K8S } });
    const op = await decide(m, "Service", "discard");
    expect(drafts(await m.sync.loadCachedCards())).toHaveLength(1);
    await m.queue.dropOps([op.id]);
    expect(drafts(await m.sync.loadCards())).toHaveLength(2);
  });

  it("gives every deletion of a kept cloze its numbered key", async () => {
    const m = await setup({ "me/cards": { "c.md": "Status: draft\nC: [a] and [b]\n" } });
    await decide(m, "and", "keep", { stampId: "clz00000" });
    expect((await m.sync.loadCachedCards()).map((c) => c.key)).toEqual(["clz00000:1", "clz00000:2"]);
  });

  it("keys a kept reverse card :r", async () => {
    const m = await setup({ "me/cards": { "r.md": "Status: draft\nReverse: yes\nQ: Estonia\nA: Tallinn\n" } });
    await decide(m, "Estonia", "keep", { stampId: "rev00000" });
    expect((await m.sync.loadCachedCards()).map((c) => c.key)).toEqual(["rev00000", "rev00000:r"]);
  });
});

describe("commitMessage", () => {
  it("counts by action in a fixed order", async () => {
    const { commitMessage } = await import("./inbox-queue");
    const ops = ["discard", "keep", "keep", "edit", "keep", "discard"].map((action) => ({ action })) as InboxOp[];
    expect(commitMessage(ops)).toBe("Inbox: keep 3, discard 2, edit 1");
    expect(commitMessage([{ action: "keep" }])).toBe("Inbox: keep 1");
  });
});

describe("committing the queue", () => {
  it("commits every file's changes in one commit, and nothing else", async () => {
    const m = await setup({ "me/cards": { "k8s.md": K8S, "geo/capitals.md": GEO } });
    const keep = await decide(m, "Deployment", "keep", { stampId: "dep10000" });
    await decide(m, "Service", "discard");
    await decide(m, "Estonia", "keep");

    const result = await m.commit.flushInbox();
    expect(result).toEqual({ committed: 3, conflicts: 0 });
    const repo = repos.get("me/cards")!;
    expect(repo.log).toEqual(["Inbox: keep 2, discard 1"]);
    expect(repo.files()["k8s.md"]).toBe(`Q: What is a Pod?
A: The smallest deployable unit.

---

ID: ${keep.stampId}
Q: What does a Deployment manage?
A: A ReplicaSet.
`);
    expect(repo.files()["geo/capitals.md"]).toBe(GEO.replace("Status: draft\n", ""));
    expect(await m.queue.pendingOps()).toEqual([]);

    // Recorded under the SHA git gives the new text, nested path or not, so
    // the next sync has nothing to fetch.
    const { gitBlobSha } = await import("./hash");
    const stored = await m.db.getAllDeckFiles();
    const capitals = stored.find((f) => f.path === "geo/capitals.md")!;
    expect(capitals.sha).toBe(await gitBlobSha(repo.files()["geo/capitals.md"]));
    expect(capitals.cards[0].status).toBe("active");
    expect(drafts(await m.sync.loadCachedCards())).toEqual([]);
  });

  it("makes one commit per collection", async () => {
    const m = await setup({ "me/cards": { "k8s.md": K8S }, "me/geo": { "capitals.md": GEO } });
    await decide(m, "Deployment", "discard");
    await decide(m, "Estonia", "keep");
    await m.commit.flushInbox();
    expect(repos.get("me/cards")!.log).toEqual(["Inbox: discard 1"]);
    expect(repos.get("me/geo")!.log).toEqual(["Inbox: keep 1"]);
  });

  it("drops a change whose draft was edited upstream, and commits the rest", async () => {
    const m = await setup({ "me/cards": { "k8s.md": K8S } });
    await decide(m, "Deployment", "keep");
    await decide(m, "Service", "discard");
    const upstream = K8S.replace("A: A ReplicaSet.", "A: A ReplicaSet, which runs Pods.");
    repos.get("me/cards")!.push("k8s.md", upstream);

    const result = await m.commit.flushInbox();
    expect(result).toEqual({ committed: 1, conflicts: 1 });
    expect(repos.get("me/cards")!.files()["k8s.md"]).toBe(
      upstream.replace("\n\n---\n\nStatus: draft\nC: A [Service] gives Pods a stable address.", "")
    );
    // Nothing of it is left queued: the draft is GitHub's version now.
    expect(await m.queue.pendingOps()).toEqual([]);
  });

  it("rebuilds on the new tip when another commit lands first", async () => {
    const m = await setup({ "me/cards": { "k8s.md": K8S, "other.md": "Q: x\nA: y\n" } });
    await decide(m, "Deployment", "discard");
    const repo = repos.get("me/cards")!;
    repo.beforeRefUpdate = () => repo.push("other.md", "Q: x\nA: y, changed\n");

    await m.commit.flushInbox();
    // One refused update, then ours on top of theirs.
    expect(repo.log).toEqual(["Inbox: discard 1"]);
    expect(repo.commits.get(repo.head)!.parent).not.toBeNull();
    // The upstream change survived, under ours.
    expect(repo.files()["other.md"]).toBe("Q: x\nA: y, changed\n");
    expect(repo.files()["k8s.md"]).not.toContain("Deployment");
  });

  it("keeps a decision made while the commit was in flight", async () => {
    const m = await setup({ "me/cards": { "k8s.md": K8S } });
    await decide(m, "Deployment", "discard");
    const repo = repos.get("me/cards")!;
    let late: InboxOp | null = null;
    repo.beforeRefUpdate = () => {
      late = {
        id: "late",
        repo: "me/cards",
        path: "k8s.md",
        action: "discard",
        block: ["whatever"],
        at: "",
      };
    };
    const flushing = m.commit.flushInbox();
    // Queued between the read of the queue and the end of the commit.
    await vi.waitFor(() => expect(late).not.toBeNull());
    await m.queue.enqueue([late!]);
    await flushing;
    expect((await m.queue.pendingOps()).map((op) => op.id)).toEqual(["late"]);
  });

  it("deletes a deck whose last card was discarded", async () => {
    const m = await setup({ "me/cards": { "solo.md": "Status: draft\nQ: a\nA: b\n" } });
    await decide(m, "a", "discard");
    await m.commit.flushInbox();
    expect(repos.get("me/cards")!.files()).toEqual({});
    expect((await m.db.getAllDeckFiles()).map((f) => f.path)).toEqual([]);
  });

  it("commits an edit and a keep of the edited block together", async () => {
    const m = await setup({ "me/cards": { "k8s.md": K8S } });
    const text = "Status: draft\nQ: What does a Deployment own?\nA: ReplicaSets.";
    const { parseFile } = await import("./parser");
    const edited = (await parseFile(K8S.replace(/Status: draft\nQ: What does a Deployment manage\?\nA: A ReplicaSet\./, text), "k8s.md", "k8s"))
      .filter((c) => c.content.type === "basic" && c.content.question.includes("own"));
    await decide(m, "Deployment", "edit", { text, cards: edited });
    expect(drafts(await m.sync.loadCachedCards()).some((c) => c.content.type === "basic" && c.content.question.includes("own"))).toBe(true);
    await decide(m, "own", "keep", { stampId: "own00000" });
    await m.commit.flushInbox();
    expect(repos.get("me/cards")!.log).toEqual(["Inbox: keep 1, edit 1"]);
    expect(repos.get("me/cards")!.files()["k8s.md"]).toContain("ID: own00000\nQ: What does a Deployment own?\nA: ReplicaSets.\n");
  });
});

describe("the batcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("commits once after a pause, however many decisions came before it", async () => {
    const { createBatcher } = await import("./inbox-queue");
    const flush = vi.fn(async () => {});
    const batcher = createBatcher(1000, flush);
    batcher.touch();
    vi.advanceTimersByTime(600);
    batcher.touch();
    vi.advanceTimersByTime(600);
    batcher.touch();
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("commits straight away on leaving, and not again after", async () => {
    const { createBatcher } = await import("./inbox-queue");
    const flush = vi.fn(async () => {});
    const batcher = createBatcher(1000, flush);
    batcher.touch();
    await batcher.now();
    vi.advanceTimersByTime(5000);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
