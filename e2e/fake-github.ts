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

  constructor(readonly config: FakeRepoConfig) {}

  set(path: string, content: string | Buffer): void {
    this.files.set(path, { sha: `sha-${++this.shas}`, content });
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
      "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
      "access-control-expose-headers": "etag, x-oauth-scopes",
    };
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });

    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });

    if (url.pathname === "/user") return json({ login: owner });

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
