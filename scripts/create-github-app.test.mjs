import { describe, it, expect } from "vitest";
import { buildManifest, installUrl } from "./create-github-app.mjs";

/**
 * The manifest is the whole reason this script exists: it replaces ten form
 * fields where a wrong one produces an app that authenticates fine and fails
 * much later, somewhere that points nowhere near the cause. These pin the
 * fields with that property.
 */

const manifest = () =>
  buildManifest({ name: "Hashcards", url: "https://hashcards.dev", port: 8765 });

describe("the GitHub App manifest", () => {
  it("asks for write access to contents", () => {
    // Read is enough for cards and not enough for `hashcards-state.json`, so a
    // read-only app drills perfectly and silently never syncs a review back.
    expect(manifest().default_permissions.contents).toBe("write");
  });

  it("offers the OAuth step during installation", () => {
    // Without this, installing grants repository access but issues no user
    // token, and the app comes back from a successful install still signed out.
    expect(manifest().request_oauth_on_install).toBe(true);
  });

  it("accepts the redirect back from both production and wrangler dev", () => {
    // GitHub rejects an authorize request whose redirect_uri is not registered,
    // and the app sends its own origin — so a missing entry breaks sign-in
    // entirely on whichever of the two was left out.
    expect(manifest().callback_urls).toEqual([
      "https://hashcards.dev/",
      "http://localhost:8788/",
    ]);
  });

  it("does not double the slash when the url already has one", () => {
    const urls = buildManifest({
      name: "x",
      url: "https://example.com/",
      port: 1,
    }).callback_urls;
    expect(urls[0]).toBe("https://example.com/");
  });

  it("declares no webhook", () => {
    // Nothing here listens for one, and an app with an inactive webhook URL is
    // a delivery queue quietly filling up against a dead endpoint.
    expect(manifest()).not.toHaveProperty("hook_attributes");
    expect(manifest().default_events).toEqual([]);
  });

  it("sends the code back to the local server that issued the manifest", () => {
    expect(manifest().redirect_url).toBe("http://localhost:8765/created");
  });

  it("is installable beyond the owner's own account", () => {
    expect(manifest().public).toBe(true);
  });

  it("points installs at the app's slug", () => {
    expect(installUrl("hashcards-app")).toBe(
      "https://github.com/apps/hashcards-app/installations/new"
    );
  });
});
