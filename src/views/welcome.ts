import { html, nothing, render, TemplateResult } from "lit-html";
import { beginSignIn, loadCredential } from "../auth";
import { signInAvailable } from "../github-app";
import { icon } from "./icons";

/**
 * The first screen for anyone without a collection: signed out, or signed in
 * with no repository chosen yet. It used to be Settings with a banner on top,
 * which asked a newcomer to arrive already owning a repository of cards in a
 * format they had never seen. Now there are three ways in, each one tap away:
 *
 * 1. **Try the demo**: the whole app on the starter decks, no account.
 * 2. **Start your own collection**: GitHub's "use this template" makes a copy
 *    of the same starter decks in their account, then sign in and grant it.
 * 3. **Already have cards?** Sign in and pick the repository.
 *
 * The token path stays where it was, in Settings, one link down.
 */

export const TEMPLATE_URL =
  "https://github.com/new?template_owner=danielmeint&template_name=hashcards-starter";
export const SPEC_URL =
  "https://github.com/danielmeint/hashcards-app/blob/main/CARD_FORMAT_SPEC.md";
const AGENTS_URL =
  "https://github.com/danielmeint/hashcards-app/blob/main/cli/templates/AGENTS.md";
const HC_URL = "https://github.com/danielmeint/hashcards-app#for-agents-and-scripts";

/** The hint GitHub's repository picker needs, said where the user will need it. */
export const GRANT_HINT = "When GitHub asks which repositories, include your new one.";

export async function renderWelcome(
  container: HTMLElement,
  /** Settings: the repository picker once signed in, and the token form. */
  onSettings: () => void
): Promise<void> {
  const credential = await loadCredential();
  const signedIn = credential !== null;

  // Without a GitHub App (a fork, a self-hosted copy) the token is the only
  // way in, and Settings is where it is entered.
  const signIn = () => (signInAvailable() ? beginSignIn() : onSettings());

  function tryDemo(): void {
    // `main.ts` reloads on the change: the demo swaps out storage, which can
    // only happen before anything has read it.
    location.hash = "demo";
  }

  /** Step two, or what replaces it once the sign-in has happened. */
  function connectStep(): TemplateResult {
    if (signedIn) {
      return html`<button type="button" class="btn btn-primary btn-block" id="pick-repo-btn" @click=${onSettings}>
          Choose your repository
        </button>
        <p class="welcome-hint">Signed in. Not in the list? The next screen links to where you grant it.</p>`;
    }
    return html`<button type="button" class="btn btn-primary btn-block btn-signin" id="signin-btn" @click=${signIn}>
        Sign in with GitHub
      </button>
      <p class="welcome-hint" id="grant-hint">${GRANT_HINT}</p>`;
  }

  const view = html`<div class="page welcome-view">
    <header class="app-bar">
      <div class="brand">hashcards</div>
      <nav class="app-nav">
        <button id="settings-btn" class="icon-btn" aria-label="Settings" title="Settings" @click=${onSettings}>
          ${icon("settings")}<span class="icon-btn-label">Settings</span>
        </button>
      </nav>
    </header>

    <section class="welcome-hero">
      <h1>Flashcards you write in Markdown, reviewed anywhere.</h1>
      <p>
        Your cards live in your own GitHub repository. Hashcards schedules them
        with FSRS, works offline, and syncs your reviews back to the repo.
      </p>
    </section>

    <section class="panel welcome-path" id="path-demo">
      <div class="welcome-path-head">
        <h2>Try the demo</h2>
        <span class="pill pill-tint">No account</span>
      </div>
      <p class="welcome-copy">The whole app on a few sample decks, with some review history. Nothing is saved.</p>
      <button type="button" class="btn btn-block" id="demo-btn" @click=${tryDemo}>
        Try the demo
      </button>
    </section>

    <section class="panel welcome-path" id="path-template">
      <h2>Start your own collection</h2>
      <ol class="welcome-steps">
        <li>
          <span class="welcome-step-title">Copy the starter decks to your GitHub</span>
          <a class="btn btn-block" id="template-link" href=${TEMPLATE_URL} target="_blank" rel="noopener">
            Use the template${icon("external", 16)}
          </a>
        </li>
        <li>
          <span class="welcome-step-title">${signedIn ? "Pick it here" : "Sign in and pick it"}</span>
          ${connectStep()}
        </li>
      </ol>
    </section>

    <section class="panel welcome-path" id="path-existing">
      <h2>Already have cards?</h2>
      <p class="welcome-copy">
        ${signedIn ? "Choose the repository they are in." : "Sign in with GitHub and pick the repository they are in."}
      </p>
      <div class="welcome-actions">
        <button type="button" class="btn" id="existing-btn" @click=${signedIn ? onSettings : signIn}>
          ${signedIn ? "Choose repository" : "Sign in"}
        </button>
        ${signedIn
          ? nothing
          : html`<button type="button" class="link-btn" id="pat-link" @click=${onSettings}>
              Use a personal access token
            </button>`}
      </div>
    </section>

    <footer class="welcome-footer">
      <p>
        Cards are plain Markdown: see the
        <a href=${SPEC_URL} target="_blank" rel="noopener" id="spec-link">card format</a>.
      </p>
      <p>
        Using an AI agent? See
        <a href=${AGENTS_URL} target="_blank" rel="noopener">AGENTS.md</a> and
        <a href=${HC_URL} target="_blank" rel="noopener"><code>hc</code></a>.
      </p>
    </footer>
  </div>`;

  render(view, container);
}
