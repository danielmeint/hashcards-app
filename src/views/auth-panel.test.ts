// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The connection panel. Onboarding used to be "create a fine-grained token,
 * scope it, paste it"; these pin the two things that replaced it — a repo
 * picker that configures the repo *correctly*, and a token form that is still
 * reachable for installs and forks that have no GitHub App.
 */

async function freshPanel(clientId: string) {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  // The committed config has no client ID, so a build with an App has to be
  // stood up here rather than assumed.
  vi.doMock("../github-app", () => ({
    GITHUB_APP: { clientId, slug: "hashcards" },
    signInAvailable: () => clientId !== "",
    installUrl: () => "https://github.com/apps/hashcards/installations/new",
    AUTH_API: "/api/auth",
  }));
  const [{ renderAuthPanel }, auth, github] = await Promise.all([
    import("./auth-panel"),
    import("../auth"),
    import("../github"),
  ]);
  return { renderAuthPanel, ...auth, ...github };
}

/** One installation holding one repo, whose default branch is not `main`. */
function mockGitHubApi() {
  globalThis.fetch = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes("/user/installations?")) {
      return new Response(JSON.stringify({ installations: [{ id: 7 }] }), {
        status: 200,
      });
    }
    if (u.includes("/repositories")) {
      return new Response(
        JSON.stringify({
          repositories: [
            {
              name: "cards",
              owner: { login: "me" },
              default_branch: "master",
              private: true,
            },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ login: "me" }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("the connection panel", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    vi.doUnmock("../github-app");
  });

  it("leads with sign-in and keeps the token form one disclosure away", async () => {
    const { renderAuthPanel } = await freshPanel("Iv1.abc");

    await renderAuthPanel(host, () => {});

    expect(host.querySelector("#signin-btn")).not.toBeNull();
    // Still reachable — an existing install may have nothing else — but no
    // longer the first thing a new user is asked to do.
    expect(host.querySelector("details.auth-fallback #pat")).not.toBeNull();
  });

  it("falls back to the token form when the build has no GitHub App", async () => {
    const { renderAuthPanel } = await freshPanel("");

    await renderAuthPanel(host, () => {});

    expect(host.querySelector("#signin-btn")).toBeNull();
    // Not hidden behind a disclosure this time: it is the only way in.
    expect(host.querySelector("details.auth-fallback")).toBeNull();
    expect(host.querySelector("#pat")).not.toBeNull();
  });

  it("stores the token and the repo together when connecting with a PAT", async () => {
    const { renderAuthPanel, loadCredential, getConfig } = await freshPanel("");
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ login: "me" }), { status: 200 })
    ) as unknown as typeof fetch;

    await renderAuthPanel(host, () => {});
    (host.querySelector("#pat") as HTMLInputElement).value = "github_pat_x";
    (host.querySelector("#owner") as HTMLInputElement).value = "me";
    (host.querySelector("#repo") as HTMLInputElement).value = "cards";
    (host.querySelector("#connect-pat-btn") as HTMLButtonElement).click();

    await vi.waitFor(async () => {
      expect(await loadCredential()).toEqual({
        kind: "pat",
        token: "github_pat_x",
      });
    });
    expect(getConfig()).toEqual({ owner: "me", repo: "cards", branch: "main" });
  });

  it("takes the branch from the repository that was picked", async () => {
    const { renderAuthPanel, saveCredential, getConfig } = await freshPanel("Iv1.abc");
    await saveCredential({
      kind: "app",
      token: "ghu_x",
      expiresAt: Date.now() + 3_600_000,
      refreshToken: "ghr_x",
      refreshExpiresAt: Date.now() + 3_600_000_0,
      login: "me",
    });
    mockGitHubApi();

    await renderAuthPanel(host, () => {});

    const select = host.querySelector("#repo-select") as HTMLSelectElement;
    select.value = "me/cards";
    select.dispatchEvent(new Event("change"));

    // Defaulting to "main" for a repo that lives on "master" produces a 404
    // that reads exactly like a permissions problem.
    await vi.waitFor(() => {
      expect(getConfig()).toEqual({
        owner: "me",
        repo: "cards",
        branch: "master",
      });
    });
  });

  it("says why the picker is empty when offline instead of hanging on it", async () => {
    const { renderAuthPanel, saveCredential } = await freshPanel("Iv1.abc");
    await saveCredential({
      kind: "app",
      token: "ghu_x",
      expiresAt: Date.now() + 3_600_000,
      refreshToken: null,
      refreshExpiresAt: null,
      login: "me",
    });
    const online = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(navigator),
      "onLine"
    );
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("no network in tests"))
    ) as unknown as typeof fetch;

    try {
      await renderAuthPanel(host, () => {});
      // Settings is where you go to find out why nothing is syncing, so it has
      // to render without the network.
      expect(host.textContent).toContain("Offline");
      expect(host.querySelector("#signout-btn")).not.toBeNull();
    } finally {
      if (online) Object.defineProperty(navigator, "onLine", online);
    }
  });
});
