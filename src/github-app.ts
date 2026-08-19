/**
 * Public identifiers for the GitHub App this build signs in through.
 *
 * Both values are public — the client ID appears in every authorize URL and the
 * slug in every install link — so they live in the repo rather than in build
 * secrets. The client *secret* never leaves the Pages Function in `functions/`.
 *
 * Leave `clientId` empty and the sign-in button disappears, leaving the
 * personal-access-token path as the only way in. That is what a fork with no
 * GitHub App of its own gets, and it is what the test suite runs as.
 *
 * See README "Sign-in setup" for how to create the App and fill these in.
 */
export const GITHUB_APP = {
  clientId: "",
  slug: "hashcards",
};

export function signInAvailable(): boolean {
  return GITHUB_APP.clientId !== "";
}

/**
 * Where the user grants the App access to repositories. Sign-in only proves who
 * they are; this is what decides which repos the token can reach.
 */
export function installUrl(): string {
  return `https://github.com/apps/${GITHUB_APP.slug}/installations/new`;
}

/**
 * The code-for-token exchange, served from our own origin by a Pages Function.
 * A browser cannot call GitHub's token endpoint directly — it is not
 * CORS-enabled, and it needs the client secret — so this hop is not optional.
 */
export const AUTH_API = "/api/auth";
