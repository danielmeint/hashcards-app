// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Sign-in, and the two ways it can go wrong that matter: a credential that
 * quietly stops working, and one that gets thrown away when it did not have to
 * be. A spaced repetition app that logs you out is an app whose reviews stop
 * reaching GitHub, which per the roadmap is the one failure that must never be
 * quiet — so these lean on when the credential is *kept*.
 */

async function freshAuth() {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  return import("./auth");
}

/** The session key `beginSignIn` writes and `completeSignIn` checks against. */
const STATE_KEY = "github_oauth_state";

const HOUR = 3_600_000;

function appCredential(overrides: Record<string, unknown> = {}) {
  return {
    kind: "app" as const,
    token: "old",
    expiresAt: Date.now() + 8 * HOUR,
    refreshToken: "r1",
    refreshExpiresAt: Date.now() + 180 * 24 * HOUR,
    login: "someone",
    ...overrides,
  };
}

/** Answers every `/api/auth/*` call with one token payload. */
function mockAuthApi(body: unknown, status = 200) {
  const spy = vi.fn(
    async () => new Response(JSON.stringify(body), { status })
  );
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe("credential storage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("carries a token out of localStorage and leaves no copy behind", async () => {
    localStorage.setItem("github_pat", "ghp_legacy");
    const { loadCredential } = await freshAuth();

    expect(await loadCredential()).toEqual({ kind: "pat", token: "ghp_legacy" });
    expect(localStorage.getItem("github_pat")).toBeNull();

    // And it landed in the store rather than only in memory: a fresh module
    // instance, sharing the same database, still finds it.
    vi.resetModules();
    const again = await import("./auth");
    expect(await again.loadCredential()).toEqual({
      kind: "pat",
      token: "ghp_legacy",
    });
  });

  it("forgets the token on sign-out", async () => {
    const { saveCredential, signOut, loadCredential } = await freshAuth();
    await saveCredential({ kind: "pat", token: "ghp_x" });
    await signOut();

    expect(await loadCredential()).toBeNull();
    vi.resetModules();
    const again = await import("./auth");
    expect(await again.loadCredential()).toBeNull();
  });
});

describe("token renewal", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("renews an expiring token once, however many callers ask at once", async () => {
    const { saveCredential, getAccessToken } = await freshAuth();
    // Inside the refresh margin: still valid, but not for long enough to send.
    await saveCredential(appCredential({ expiresAt: Date.now() + 60_000 }));
    const fetchSpy = mockAuthApi({
      access_token: "new",
      expires_in: 28800,
      refresh_token: "r2",
      refresh_token_expires_in: 15811200,
    });

    const tokens = await Promise.all([
      getAccessToken(),
      getAccessToken(),
      getAccessToken(),
    ]);

    expect(tokens).toEqual(["new", "new", "new"]);
    // GitHub invalidates a refresh token the moment it is spent, so a second
    // concurrent attempt would be rejected — and rejection signs the user out.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("stores the replacement refresh token, so the next renewal works too", async () => {
    const { saveCredential, getAccessToken, loadCredential } = await freshAuth();
    await saveCredential(appCredential({ expiresAt: Date.now() + 60_000 }));
    mockAuthApi({
      access_token: "new",
      expires_in: 28800,
      refresh_token: "r2",
      refresh_token_expires_in: 15811200,
    });

    await getAccessToken();

    const credential = await loadCredential();
    expect(credential).toMatchObject({ token: "new", refreshToken: "r2" });
  });

  it("keeps the credential when the renewal could not be sent at all", async () => {
    const { saveCredential, getAccessToken, loadCredential } = await freshAuth();
    await saveCredential(appCredential({ expiresAt: Date.now() + 60_000 }));
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new TypeError("Failed to fetch"))
    ) as unknown as typeof fetch;

    await expect(getAccessToken()).rejects.toThrow(/could not reach/i);
    // A tunnel, a captive portal or a flaky connection is not GitHub saying no.
    // Signing out here would cost the user their session for a dropped packet.
    expect(await loadCredential()).not.toBeNull();
  });

  it("signs out when GitHub rejects the refresh token", async () => {
    const { saveCredential, getAccessToken, loadCredential } = await freshAuth();
    await saveCredential(appCredential({ expiresAt: Date.now() + 60_000 }));
    mockAuthApi({ error: "bad_refresh_token", error_description: "Expired." }, 400);

    await expect(getAccessToken()).rejects.toThrow("Expired.");
    expect(await loadCredential()).toBeNull();
  });

  it("does not spend a refresh token that has already expired", async () => {
    const { saveCredential, getAccessToken, loadCredential } = await freshAuth();
    await saveCredential(
      appCredential({ expiresAt: Date.now() - 1, refreshExpiresAt: Date.now() - 1 })
    );
    const fetchSpy = mockAuthApi({ access_token: "new" });

    await expect(getAccessToken()).rejects.toThrow(/sign in again/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await loadCredential()).toBeNull();
  });

  it("leaves a PAT alone — there is nothing to renew", async () => {
    const { saveCredential, getAccessToken } = await freshAuth();
    await saveCredential({ kind: "pat", token: "ghp_x" });
    const fetchSpy = mockAuthApi({ access_token: "new" });

    expect(await getAccessToken()).toBe("ghp_x");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the sign-in callback", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    history.replaceState(null, "", "/");
  });

  it("ignores an ordinary page load", async () => {
    const { completeSignIn } = await freshAuth();
    const fetchSpy = mockAuthApi({ access_token: "new" });

    expect(await completeSignIn()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records when the token expires, not just the token", async () => {
    const { completeSignIn, loadCredential } = await freshAuth();
    sessionStorage.setItem(STATE_KEY, "s1");
    history.replaceState(null, "", "/?code=abc&state=s1");
    mockAuthApi({
      access_token: "ghu_new",
      expires_in: 28800,
      refresh_token: "r1",
      refresh_token_expires_in: 15811200,
    });

    expect(await completeSignIn()).toBe(true);

    const credential = await loadCredential();
    expect(credential).toMatchObject({
      kind: "app",
      token: "ghu_new",
      refreshToken: "r1",
    });
    // Without this the token is treated as permanent and is never renewed,
    // which is a sign-out eight hours later with no explanation.
    if (credential?.kind !== "app") throw new Error("expected an App credential");
    expect(credential.expiresAt).toBeGreaterThan(Date.now());
    expect(location.search).toBe("");
  });

  it("refuses a callback carrying a state this tab never issued", async () => {
    const { completeSignIn, loadCredential } = await freshAuth();
    sessionStorage.setItem(STATE_KEY, "s1");
    history.replaceState(null, "", "/?code=abc&state=forged");
    const fetchSpy = mockAuthApi({ access_token: "ghu_new" });

    await expect(completeSignIn()).rejects.toThrow(/could not be verified/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await loadCredential()).toBeNull();
  });

  it("takes the spent code out of the URL even when the exchange fails", async () => {
    const { completeSignIn } = await freshAuth();
    sessionStorage.setItem(STATE_KEY, "s1");
    history.replaceState(null, "", "/?code=abc&state=s1");
    mockAuthApi({ error: "bad_verification_code" }, 400);

    await expect(completeSignIn()).rejects.toThrow("bad_verification_code");
    // A code is single-use. Leaving it in the URL means a reload retries it and
    // fails again, and the user is stuck on an error they cannot clear.
    expect(location.search).toBe("");
  });

  it("reports what GitHub said when the user declines", async () => {
    const { completeSignIn } = await freshAuth();
    history.replaceState(
      null,
      "",
      "/?error=access_denied&error_description=The+user+said+no"
    );

    await expect(completeSignIn()).rejects.toThrow("The user said no");
  });
});
