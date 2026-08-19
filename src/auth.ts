import { AUTH_API, GITHUB_APP, signInAvailable } from "./github-app";
import { readCredential, writeCredential, deleteCredential } from "./db";

/**
 * How the app proves who it is to GitHub.
 *
 * Two shapes, because both have to keep working. `app` is a user-to-server
 * token from the Hashcards GitHub App: short-lived, renewable, and reaching
 * only the repositories the user picked when installing. `pat` is a personal
 * access token the user pasted in — the original mechanism, kept for existing
 * installs and for forks that have no GitHub App of their own.
 */
export type Credential =
  | { kind: "pat"; token: string }
  | {
      kind: "app";
      token: string;
      /** Epoch ms, or null when the App does not expire user tokens. */
      expiresAt: number | null;
      refreshToken: string | null;
      refreshExpiresAt: number | null;
      /** Login recorded at sign-in, so Settings can name the account offline. */
      login: string | null;
    };

/** Nothing short of the user signing in again will fix this. */
export class AuthError extends Error {}

const SIGN_IN_AGAIN = "Your GitHub sign-in has expired. Sign in again in Settings.";
const LEGACY_PAT_KEY = "github_pat";
const STATE_KEY = "github_oauth_state";

/** Refresh this far ahead of expiry, so a sync starting now still finishes. */
const REFRESH_MARGIN_MS = 5 * 60_000;

// `undefined` means "not read yet"; `null` means "read, and there is none".
let cached: Credential | null | undefined;

export async function loadCredential(): Promise<Credential | null> {
  if (cached === undefined) {
    cached = (await readCredential<Credential>()) ?? (await adoptLegacyPat());
  }
  return cached;
}

export async function saveCredential(credential: Credential): Promise<void> {
  await writeCredential(credential);
  cached = credential;
}

export async function signOut(): Promise<void> {
  await deleteCredential();
  localStorage.removeItem(LEGACY_PAT_KEY);
  cached = null;
}

/**
 * Tokens used to live in localStorage under `github_pat`. Carry one over the
 * first time we look, and only drop the old copy once the new one is provably
 * written — the same ordering the card cache migration uses, for the same
 * reason: a half-finished migration must not be the thing that loses it.
 */
async function adoptLegacyPat(): Promise<Credential | null> {
  const token = localStorage.getItem(LEGACY_PAT_KEY);
  if (!token) return null;
  const credential: Credential = { kind: "pat", token };
  await writeCredential(credential);
  localStorage.removeItem(LEGACY_PAT_KEY);
  return credential;
}

/**
 * A bearer token good to send right now, renewing it first if it is close
 * enough to expiry that a request might outlive it.
 */
export async function getAccessToken(): Promise<string> {
  const credential = await loadCredential();
  if (!credential) {
    throw new AuthError("Not connected to GitHub. Open Settings to sign in.");
  }
  if (credential.kind === "pat") return credential.token;
  if (
    credential.expiresAt !== null &&
    credential.expiresAt - Date.now() < REFRESH_MARGIN_MS
  ) {
    const renewed = await refreshCredential();
    if (!renewed) throw new AuthError(SIGN_IN_AGAIN);
    return renewed;
  }
  return credential.token;
}

let refreshing: Promise<string | null> | null = null;

/**
 * Trade the refresh token for a fresh access token, returning null when there
 * is nothing to refresh — a PAT, or an App configured not to expire its tokens.
 *
 * GitHub rotates the refresh token on every use, so two of these racing would
 * spend the same single-use token twice and sign the user out. Concurrent
 * callers share one attempt.
 */
export function refreshCredential(): Promise<string | null> {
  if (!refreshing) {
    refreshing = runRefresh().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function runRefresh(): Promise<string | null> {
  const credential = await loadCredential();
  if (!credential || credential.kind !== "app" || !credential.refreshToken) {
    return null;
  }
  if (
    credential.refreshExpiresAt !== null &&
    credential.refreshExpiresAt <= Date.now()
  ) {
    await signOut();
    throw new AuthError(SIGN_IN_AGAIN);
  }

  let tokens: TokenResponse;
  try {
    tokens = await postJson("/refresh", {
      refresh_token: credential.refreshToken,
    });
  } catch (e) {
    // A refresh that failed because the network is down must not sign the user
    // out — the credential is probably still good and the next sync will try
    // again. Only GitHub actually rejecting the token does that.
    if (e instanceof AuthError) await signOut();
    throw e;
  }

  await saveCredential(toCredential(tokens, credential.login));
  return tokens.access_token;
}

/** Remember the account name, so Settings can show it without a network call. */
export async function recordLogin(login: string): Promise<void> {
  const credential = await loadCredential();
  if (credential?.kind === "app" && credential.login !== login) {
    await saveCredential({ ...credential, login });
  }
}

// --- The OAuth round trip ---

/**
 * Hand the browser to GitHub. Control comes back to `completeSignIn` after the
 * user approves, by way of a redirect to this origin carrying a one-time code.
 */
export function beginSignIn(): void {
  if (!signInAvailable()) {
    throw new Error("This build has no GitHub App configured.");
  }
  const state = randomState();
  sessionStorage.setItem(STATE_KEY, state);

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", GITHUB_APP.clientId);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("state", state);
  location.assign(url.toString());
}

/**
 * Finish a sign-in if this page load is the return leg of one. Returns whether
 * anything happened, so startup can route a fresh sign-in to the repo picker
 * and leave every other load alone.
 *
 * Throws `AuthError` if GitHub refused or the response cannot be trusted.
 */
export async function completeSignIn(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const error = params.get("error");
  if (!code && !error) return false;

  const expected = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  // Whatever happens below, the code is spent. Take it out of the URL before
  // anything can throw, so a reload cannot try to redeem it a second time.
  history.replaceState(null, "", location.pathname + location.hash);

  if (error) {
    throw new AuthError(params.get("error_description") || error);
  }
  // A code arriving without the state this tab generated did not come from a
  // sign-in this tab started.
  if (!expected || params.get("state") !== expected) {
    throw new AuthError("Sign-in could not be verified. Please try again.");
  }

  const tokens = await postJson("/token", {
    code,
    redirect_uri: redirectUri(),
  });
  await saveCredential(toCredential(tokens, null));
  return true;
}

function redirectUri(): string {
  return `${location.origin}/`;
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type TokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
};

function toCredential(
  tokens: TokenResponse,
  login: string | null
): Credential {
  const now = Date.now();
  return {
    kind: "app",
    token: tokens.access_token,
    // An App that does not expire user tokens sends neither field, and the
    // credential is then simply long-lived — same shape, no refresh.
    expiresAt: tokens.expires_in ? now + tokens.expires_in * 1000 : null,
    refreshToken: tokens.refresh_token ?? null,
    refreshExpiresAt: tokens.refresh_token_expires_in
      ? now + tokens.refresh_token_expires_in * 1000
      : null,
    login,
  };
}

/**
 * Call the token exchange. Distinguishes "GitHub said no" (`AuthError`, the
 * user must sign in again) from "we could not ask" (a plain error, worth
 * retrying) — the difference decides whether a failure signs the user out.
 */
async function postJson(
  path: string,
  body: Record<string, unknown>
): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(`${AUTH_API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach the sign-in service.");
  }

  const data = (await res.json().catch(() => null)) as
    | (TokenResponse & { error?: string; error_description?: string })
    | null;

  // GitHub answers a rejected code with 200 and an `error` in the body, so the
  // status alone does not say whether this is worth retrying.
  if (data?.error) throw new AuthError(data.error_description || data.error);
  if (!res.ok || !data?.access_token) {
    throw new Error(`Sign-in service error (${res.status}).`);
  }
  return data;
}
