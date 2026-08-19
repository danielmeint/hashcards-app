// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The credential no longer travels in `GitHubConfig` — every request picks one
 * up inside `apiFetch`. These cover what that made possible: renewing a token
 * mid-request without the caller knowing, and classifying a token by what
 * GitHub says about it rather than by how it is spelled.
 */

const HOUR = 3_600_000;

async function fresh() {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  const auth = await import("./auth");
  const github = await import("./github");
  return { ...auth, ...github };
}

function appCredential(overrides: Record<string, unknown> = {}) {
  return {
    kind: "app" as const,
    token: "old",
    // Comfortably valid, so nothing refreshes ahead of time and the 401 path is
    // the only thing under test.
    expiresAt: Date.now() + 4 * HOUR,
    refreshToken: "r1",
    refreshExpiresAt: Date.now() + 180 * 24 * HOUR,
    login: null,
    ...overrides,
  };
}

describe("authenticated requests", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renews a rejected token and retries, instead of surfacing the failure", async () => {
    const { saveCredential, inspectConnection } = await fresh();
    await saveCredential(appCredential());

    const sent: (string | null)[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/api/auth/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "new", expires_in: 28800 }),
          { status: 200 }
        );
      }
      sent.push(new Headers(init?.headers).get("Authorization"));
      return sent.length === 1
        ? new Response(null, { status: 401 })
        : new Response(JSON.stringify({ login: "someone" }), { status: 200 });
    }) as unknown as typeof fetch;

    expect((await inspectConnection()).username).toBe("someone");
    // The retry has to carry the *new* token; resending the old one would 401
    // again and look like a permissions problem.
    expect(sent).toEqual(["Bearer old", "Bearer new"]);
  });

  it("gives up after one retry rather than renewing its way around a 401", async () => {
    const { saveCredential, inspectConnection } = await fresh();
    await saveCredential(appCredential());

    let refreshes = 0;
    let calls = 0;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      if (String(url).includes("/api/auth/refresh")) {
        refreshes++;
        // A fresh refresh token every time, so nothing but the retry limit
        // itself stops this from going round again.
        return new Response(
          JSON.stringify({
            access_token: `new-${refreshes}`,
            expires_in: 28800,
            refresh_token: `r${refreshes + 1}`,
            refresh_token_expires_in: 15811200,
          }),
          { status: 200 }
        );
      }
      calls++;
      // Succeeds on the third attempt — which a correct client never makes.
      return calls > 2
        ? new Response(JSON.stringify({ login: "someone" }), { status: 200 })
        : new Response(null, { status: 401 });
    }) as unknown as typeof fetch;

    // Two 401s in a row means the credential is not the problem. Renewing
    // repeatedly would spend a fresh token per attempt and hide a genuine
    // permissions failure behind an unbounded loop.
    await expect(inspectConnection()).rejects.toThrow(/rejected the credential/i);
    expect(refreshes).toBe(1);
    expect(calls).toBe(2);
  });

  it("does not try to renew a PAT", async () => {
    const { saveCredential, inspectConnection } = await fresh();
    await saveCredential({ kind: "pat", token: "ghp_x" });

    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      return new Response(null, { status: 401 });
    }) as unknown as typeof fetch;

    await expect(inspectConnection()).rejects.toThrow(/rejected the credential/i);
    expect(urls).toEqual(["https://api.github.com/user"]);
  });
});

describe("connection inspection", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  /** `/user`, answered with or without the scopes header. */
  function mockUser(headers: Record<string, string>) {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ login: "someone" }), {
          status: 200,
          headers,
        })
    ) as unknown as typeof fetch;
  }

  it("classifies a token by what GitHub sends back, not by its prefix", async () => {
    const { saveCredential, inspectConnection } = await fresh();
    // A classic token that does not look like one. Prefix-matching called this
    // fine-grained and told the user their credential was better scoped than
    // it was; the scopes header is the token's actual behaviour.
    await saveCredential({ kind: "pat", token: "github_pat_looks_modern" });
    mockUser({ "x-oauth-scopes": "repo, gist" });

    const connection = await inspectConnection();
    expect(connection.credential).toBe("classic");
    expect(connection.scopes).toBe("repo, gist");
  });

  it("treats an absent scopes header as fine-grained", async () => {
    const { saveCredential, inspectConnection } = await fresh();
    await saveCredential({ kind: "pat", token: "ghp_looks_classic" });
    mockUser({});

    expect((await inspectConnection()).credential).toBe("fine-grained");
  });

  it("remembers the account name, so Settings can name it offline", async () => {
    const { saveCredential, inspectConnection, loadCredential } = await fresh();
    await saveCredential(appCredential({ login: null }));
    mockUser({});

    expect((await inspectConnection()).credential).toBe("app");
    expect(await loadCredential()).toMatchObject({ login: "someone" });
  });
});

describe("the repository picker's list", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("gathers every installation's repos, with the branch each one actually uses", async () => {
    const { saveCredential, listAccessibleRepos } = await fresh();
    await saveCredential(appCredential());

    globalThis.fetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/user/installations?")) {
        return new Response(
          JSON.stringify({ installations: [{ id: 1 }, { id: 2 }] }),
          { status: 200 }
        );
      }
      const repos = u.includes("/installations/1/")
        ? [
            {
              name: "cards",
              owner: { login: "me" },
              default_branch: "master",
              private: true,
            },
          ]
        : [
            {
              name: "shared",
              owner: { login: "acme" },
              default_branch: "main",
              private: false,
            },
          ];
      return new Response(JSON.stringify({ repositories: repos }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const repos = await listAccessibleRepos();

    expect(repos.map((r) => `${r.owner}/${r.repo}`)).toEqual([
      "acme/shared",
      "me/cards",
    ]);
    // Defaulting the branch to "main" for a repo on "master" produces a 404
    // that reads exactly like a permissions problem.
    expect(repos.find((r) => r.repo === "cards")!.defaultBranch).toBe("master");
  });
});
