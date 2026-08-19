import { Context, crossSite, exchange, fail, readJson } from "./_exchange";

/** Redeem the one-time code from a completed authorize redirect. */
export async function onRequestPost({ request, env }: Context): Promise<Response> {
  if (crossSite(request)) return fail(403, "Cross-site request refused.");

  const body = await readJson(request);
  const code = typeof body?.code === "string" ? body.code : "";
  if (!code) return fail(400, "Missing authorization code.");

  const params: Record<string, string> = { code };
  // Only forwarded when the client sent one. GitHub requires it to match the
  // value used in the authorize step, and rejects the exchange if it does not.
  if (typeof body?.redirect_uri === "string") {
    params.redirect_uri = body.redirect_uri;
  }
  return exchange(env, params);
}
