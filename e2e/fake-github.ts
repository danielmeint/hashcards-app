import { test as base, type Page, type Route } from "@playwright/test";

export type FakeRepoConfig = { owner: string; repo: string; branch: string };

/**
 * A GitHub that exists only inside the browser under test: every request to
 * `api.github.com` is answered from `files` and `state`, and anything it does
 * not recognise is recorded in `unhandled` and refused, so a test can assert
 * the app asked for nothing it should not have.
 */
export class FakeGitHub {
  files = new Map<string, { sha: string; content: string | Buffer }>();
  /** Every request that reached raw.githubusercontent.com — a private repo refuses them all. */
  rawRequests: string[] = [];
  state: { content: string; sha: string } | null = null;
  stateWrites: unknown[] = [];
  unhandled: string[] = [];
  private shas = 0;

  // The `hashcards-data` branch, through the Git Data API. `main` is `files`.
  refs = new Map<string, string>();
  commits = new Map<string, { tree: string; parents: string[]; message?: string }>();
  /**
   * Messages of the commits made to `main` through the Git Data API (the
   * Inbox's batches), oldest first. `main` is `files`; its ref is a commit
   * made up from them whenever they have changed since it was last asked for.
   */
  mainCommits: string[] = [];
  private mainHead: string | null = null;
  private mainStale = true;
  trees = new Map<string, Map<string, string>>();
  blobs = new Map<string, string>();
  /** Every ref move, refused ones included. */
  refWrites: { sha: string; ok: boolean }[] = [];

  /** The files on a data branch, by path, as text. */
  branchFiles(branch = "hashcards-data"): Map<string, string> {
    const head = this.refs.get(branch);
    if (!head) return new Map();
    const tree = this.trees.get(this.commits.get(head)!.tree)!;
    return new Map([...tree].map(([path, sha]) => [path, this.blobs.get(sha)!]));
  }

  private descends(commit: string, ancestor: string): boolean {
    for (let at: string | undefined = commit; at; at = this.commits.get(at)?.parents[0]) {
      if (at === ancestor) return true;
    }
    return false;
  }

  constructor(readonly config: FakeRepoConfig) {}

  set(path: string, content: string | Buffer): void {
    this.files.set(path, { sha: `sha-${++this.shas}`, content });
    this.mainStale = true;
  }

  /** `main`'s tip, as a commit whose tree is `files`. */
  private mainRef(): string {
    if (this.mainStale || !this.mainHead) {
      const tree = `tree-${++this.shas}`;
      this.trees.set(tree, new Map([...this.files].map(([p, f]) => [p, f.sha])));
      const sha = `commit-${++this.shas}`;
      this.commits.set(sha, { tree, parents: this.mainHead ? [this.mainHead] : [] });
      this.mainHead = sha;
      this.mainStale = false;
    }
    return this.mainHead;
  }

  /** Move `main` to a commit made through the Git Data API: `files` become its tree. */
  private moveMain(sha: string): void {
    const commit = this.commits.get(sha)!;
    const byBlob = new Map([...this.files.values()].map((f) => [f.sha, f.content]));
    this.files = new Map(
      [...this.trees.get(commit.tree)!].map(([p, blob]) => [
        p,
        { sha: blob, content: this.blobs.get(blob) ?? byBlob.get(blob)! },
      ])
    );
    this.mainHead = sha;
    this.mainStale = false;
    this.mainCommits.push(commit.message ?? "");
  }

  /** Give the app a signed-in PAT user configured for this repo. */
  async install(page: Page): Promise<void> {
    await page.addInitScript((repos) => {
      // Only on the first load: a reload is the app's own state, not ours.
      if (localStorage.getItem("repos")) return;
      localStorage.setItem("github_pat", "fake-token");
      localStorage.setItem("repos", JSON.stringify(repos));
    }, [this.config]);
    await page.route("https://api.github.com/**", (route) => this.handle(route));
    // Behaves as a private repository does: an <img> cannot authenticate.
    await page.route("https://raw.githubusercontent.com/**", (route) => {
      this.rawRequests.push(route.request().url());
      return route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" } });
    });
  }

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const { owner, repo } = this.config;
    const base = `/repos/${owner}/${repo}`;
    // The app is on another origin, and sends an Authorization header: without
    // these every answer is a CORS failure, which the app reads as offline.
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET, PUT, POST, PATCH, OPTIONS",
      "access-control-expose-headers": "etag, x-oauth-scopes",
    };
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });

    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });

    if (url.pathname === "/user") return json({ login: owner });

    // --- The data branch ---
    const path = url.pathname.slice(base.length);
    const ref = path.match(/^\/git\/ref\/heads\/(.+)$/);
    if (ref && req.method() === "GET") {
      const name = decodeURIComponent(ref[1]);
      const sha = name === this.config.branch ? this.mainRef() : this.refs.get(name);
      return sha ? json({ object: { sha } }) : json({ message: "Not Found" }, 404);
    }
    const treeRead = path.match(/^\/git\/trees\/([^/]+)$/);
    const treeSha = treeRead && (this.commits.get(treeRead[1])?.tree ?? (this.trees.has(treeRead[1]) ? treeRead[1] : null));
    if (treeSha) {
      const tree = [...this.trees.get(treeSha)!].map(([p, sha]) => ({ path: p, sha, type: "blob" }));
      return json({ sha: treeSha, tree, truncated: false });
    }
    if (path === "/git/trees" && req.method() === "POST") {
      const body = req.postDataJSON() as { base_tree?: string; tree: { path: string; content?: string; sha?: string | null }[] };
      const next = new Map(body.base_tree ? this.trees.get(body.base_tree) : []);
      for (const entry of body.tree) {
        if (entry.content !== undefined) {
          const sha = `blob-${++this.shas}`;
          this.blobs.set(sha, entry.content);
          next.set(entry.path, sha);
        } else if (entry.sha === null) next.delete(entry.path);
        else next.set(entry.path, entry.sha!);
      }
      const sha = `tree-${++this.shas}`;
      this.trees.set(sha, next);
      return json({ sha, tree: [...next].map(([p, s]) => ({ path: p, sha: s, type: "blob" })) }, 201);
    }
    if (path === "/git/commits" && req.method() === "POST") {
      const body = req.postDataJSON() as { tree: string; parents: string[]; message: string };
      const sha = `commit-${++this.shas}`;
      this.commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
      return json({ sha }, 201);
    }
    const refWrite = path.match(/^\/git\/refs\/heads\/(.+)$/);
    if (refWrite && req.method() === "PATCH") {
      const { sha } = req.postDataJSON() as { sha: string };
      const name = decodeURIComponent(refWrite[1]);
      const onMain = name === this.config.branch;
      const head = onMain ? this.mainRef() : this.refs.get(name);
      const ok = head !== undefined && this.descends(sha, head);
      this.refWrites.push({ sha, ok });
      if (!ok) return json({ message: "Update is not a fast forward" }, 422);
      if (onMain) this.moveMain(sha);
      else this.refs.set(name, sha);
      return json({ object: { sha } });
    }
    if (path === "/git/refs" && req.method() === "POST") {
      const { ref: name, sha } = req.postDataJSON() as { ref: string; sha: string };
      const branch = name.replace(/^refs\/heads\//, "");
      const ok = !this.refs.has(branch);
      this.refWrites.push({ sha, ok });
      if (!ok) return json({ message: "Reference already exists" }, 422);
      this.refs.set(branch, sha);
      return json({ object: { sha } }, 201);
    }
    const dataBlob = path.match(/^\/git\/blobs\/(.+)$/);
    if (dataBlob && this.blobs.has(dataBlob[1])) {
      return route.fulfill({ status: 200, headers: cors, contentType: "application/octet-stream", body: this.blobs.get(dataBlob[1])! });
    }

    if (url.pathname.startsWith(`${base}/git/trees/`)) {
      const tree = [...this.files].map(([path, f]) => ({ path, sha: f.sha, type: "blob" }));
      return json({ tree, truncated: false });
    }

    if (url.pathname === `${base}/contents/hashcards-state.json`) {
      if (req.method() === "PUT") {
        const body = req.postDataJSON() as { content: string; sha?: string };
        if ((body.sha ?? null) !== (this.state?.sha ?? null)) {
          return json({ message: "does not match" }, 409);
        }
        this.stateWrites.push(JSON.parse(Buffer.from(body.content, "base64").toString()));
        this.state = { content: body.content, sha: `state-${this.stateWrites.length}` };
        return json({});
      }
      return this.state ? json(this.state) : json({ message: "Not Found" }, 404);
    }

    const blob = url.pathname.match(new RegExp(`^${base}/git/blobs/(.+)$`));
    if (blob) {
      const file = [...this.files.values()].find((f) => f.sha === blob[1]);
      if (!file) return json({ message: "Not Found" }, 404);
      return route.fulfill({
        status: 200,
        headers: cors,
        contentType: "application/octet-stream",
        body: Buffer.from(file.content),
      });
    }

    const contents = url.pathname.match(new RegExp(`^${base}/contents/(.+)$`));
    if (contents && req.method() === "PUT") {
      const path = decodeURIComponent(contents[1]);
      const body = req.postDataJSON() as { content: string; sha?: string };
      if ((body.sha ?? null) !== (this.files.get(path)?.sha ?? null)) {
        return json({ message: "does not match" }, 409);
      }
      this.set(path, Buffer.from(body.content, "base64").toString());
      return json({ content: { sha: this.files.get(path)!.sha } });
    }
    // A file the app may look for before writing it — the review log.
    if (contents && !this.files.has(decodeURIComponent(contents[1]))) {
      if (decodeURIComponent(contents[1]).startsWith("hashcards-reviews/")) {
        return json({ message: "Not Found" }, 404);
      }
    }
    const file = contents && this.files.get(decodeURIComponent(contents[1]));
    if (file) {
      return json({ content: Buffer.from(file.content).toString("base64"), sha: file.sha });
    }

    this.unhandled.push(`${req.method()} ${url.pathname}`);
    return json({ message: "Not Found" }, 404);
  }
}

/** Every record in one of the app's IndexedDB stores. */
export function readStore(page: Page, store: string): Promise<unknown[]> {
  return page.evaluate(
    (store) =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open("hashcards");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result.transaction(store).objectStore(store).getAll();
          req.onsuccess = () => {
            open.result.close();
            resolve(req.result);
          };
          req.onerror = () => reject(req.error);
        };
      }),
    store
  );
}

/** `test` with a `github` fixture: a fake repo already installed on the page. */
export const test = base.extend<{ github: FakeGitHub }>({
  github: async ({ page }, use) => {
    const github = new FakeGitHub({ owner: "someone", repo: "cards", branch: "main" });
    await github.install(page);
    await use(github);
  },
});
export { expect } from "@playwright/test";
