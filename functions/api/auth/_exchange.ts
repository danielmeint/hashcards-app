/**
 * The server half of sign-in.
 *
 * A browser cannot talk to GitHub's token endpoint directly: it is not
 * CORS-enabled, and it requires the client secret, which by definition cannot
 * ship in a static bundle. This Pages Function is the smallest thing that
 * closes that gap — it adds the client credentials to a request the browser
 * already assembled, and hands back the fields the browser is allowed to see.
 *
 * It holds no state, sets no cookies, and never sees a user's data. The secret
 * lives in Pages environment variables and never appears in a response.
 */

export type Env = {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
};

export type Context = {
  request: Request;
  env: Env;
};

const TOKEN_URL = "https://github.com/login/oauth/access_token";

/** Everything GitHub may return that the browser has any business reading. */
const PASS_THROUGH = [
  "access_token",
  "expires_in",
  "refresh_token",
  "refresh_token_expires_in",
  "token_type",
  "error",
  "error_description",
];

export function fail(status: number, error: string): Response {
  return json(status, { error, error_description: error });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // A token response has no business in any cache, ours or an intermediary's.
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Refuse a request that a *different* site's page sent. Browsers attach
 * `Origin` to every cross-origin POST, so a mismatch is proof; an absent header
 * is not proof of anything and is allowed through, because failing closed on it
 * would break sign-in for anyone whose browser does not send it.
 */
export function crossSite(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return origin !== null && origin !== new URL(request.url).origin;
}

export async function readJson(
  request: Request
): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Add the client credentials to `params` and post them to GitHub, returning
 * only the recognised fields of the answer.
 */
export async function exchange(
  env: Env,
  params: Record<string, string>
): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return fail(500, "Sign-in is not configured on this deployment.");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      ...params,
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
    }),
  });

  const data = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!data) return fail(502, "GitHub returned an unreadable response.");

  const body: Record<string, unknown> = {};
  for (const key of PASS_THROUGH) {
    if (key in data) body[key] = data[key];
  }
  // GitHub answers a rejected code with 200 and an `error` in the body. Say so
  // in the status too, so a caller that only checks `res.ok` cannot mistake a
  // refusal for a token.
  return json(body.error ? 400 : 200, body);
}
