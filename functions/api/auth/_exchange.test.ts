import { describe, it, expect, vi } from "vitest";
import { onRequestPost as token } from "./token";
import { onRequestPost as refresh } from "./refresh";

/**
 * The one piece of this app that holds a secret. What matters is that the
 * secret goes exactly one way — into GitHub's token endpoint — and that a
 * refusal is not mistakable for a token.
 *
 * The file name is underscore-prefixed so Cloudflare Pages leaves it out of the
 * deployed routes along with `_exchange.ts` itself.
 */

const ENV = {
  GITHUB_CLIENT_ID: "Iv1.abc",
  GITHUB_CLIENT_SECRET: "s3cr3t",
};

const ORIGIN = "https://hashcards.dev";

function post(body: unknown, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  return new Request(`${ORIGIN}/api/auth/token`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** Stands in for GitHub, recording what it was sent. */
function mockGitHub(body: unknown, status = 200) {
  const spy = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(body), { status })
  );
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe("the code exchange", () => {
  it("adds the client credentials and returns only the token fields", async () => {
    const github = mockGitHub({
      access_token: "ghu_x",
      expires_in: 28800,
      refresh_token: "ghr_x",
      // Anything unrecognised stays on this side of the boundary.
      internal_note: "not for the browser",
    });

    const res = await token({ request: post({ code: "c", redirect_uri: `${ORIGIN}/` }), env: ENV });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      access_token: "ghu_x",
      expires_in: 28800,
      refresh_token: "ghr_x",
    });

    const sent = JSON.parse(String(github.mock.calls[0][1].body));
    expect(sent).toMatchObject({
      code: "c",
      redirect_uri: `${ORIGIN}/`,
      client_id: ENV.GITHUB_CLIENT_ID,
      client_secret: ENV.GITHUB_CLIENT_SECRET,
    });
    // The secret is the whole reason this hop exists; it must not come back out.
    expect(JSON.stringify(body)).not.toContain(ENV.GITHUB_CLIENT_SECRET);
  });

  it("turns GitHub's 200-with-an-error into a failure status", async () => {
    mockGitHub({ error: "bad_verification_code", error_description: "Expired." });

    const res = await token({ request: post({ code: "stale" }), env: ENV });

    // GitHub reports a rejected code with 200. A client checking `res.ok` would
    // read that as success and store an undefined token.
    expect(res.ok).toBe(false);
    expect(await res.json()).toMatchObject({ error: "bad_verification_code" });
  });

  it("refuses a request another site's page sent", async () => {
    const github = mockGitHub({ access_token: "ghu_x" });

    const res = await token({
      request: post({ code: "c" }, "https://evil.example"),
      env: ENV,
    });

    expect(res.status).toBe(403);
    expect(github).not.toHaveBeenCalled();
  });

  it("rejects a request with no code before spending a round trip", async () => {
    const github = mockGitHub({ access_token: "ghu_x" });

    const res = await token({ request: post({}), env: ENV });

    expect(res.status).toBe(400);
    expect(github).not.toHaveBeenCalled();
  });

  it("says so when the deployment has no App configured", async () => {
    const github = mockGitHub({ access_token: "ghu_x" });

    const res = await token({
      request: post({ code: "c" }),
      env: { GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" },
    });

    expect(res.status).toBe(500);
    expect(github).not.toHaveBeenCalled();
  });
});

describe("the refresh exchange", () => {
  it("asks GitHub for a refresh grant", async () => {
    const github = mockGitHub({ access_token: "ghu_y", refresh_token: "ghr_y" });

    const res = await refresh({
      request: post({ refresh_token: "ghr_x" }),
      env: ENV,
    });

    expect(await res.json()).toEqual({
      access_token: "ghu_y",
      refresh_token: "ghr_y",
    });
    expect(JSON.parse(String(github.mock.calls[0][1].body))).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "ghr_x",
      client_secret: ENV.GITHUB_CLIENT_SECRET,
    });
  });

  it("rejects a request with no refresh token", async () => {
    const github = mockGitHub({ access_token: "ghu_y" });

    const res = await refresh({ request: post({}), env: ENV });

    expect(res.status).toBe(400);
    expect(github).not.toHaveBeenCalled();
  });
});
