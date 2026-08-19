import { Context, crossSite, exchange, fail, readJson } from "./_exchange";

/**
 * Trade a refresh token for a new access token. GitHub rotates the refresh
 * token on every use, so the response carries a replacement for the one spent
 * here and the client must store it.
 */
export async function onRequestPost({ request, env }: Context): Promise<Response> {
  if (crossSite(request)) return fail(403, "Cross-site request refused.");

  const body = await readJson(request);
  const refreshToken =
    typeof body?.refresh_token === "string" ? body.refresh_token : "";
  if (!refreshToken) return fail(400, "Missing refresh token.");

  return exchange(env, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}
