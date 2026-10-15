# Hashcards PWA

**[hashcards.dev](https://hashcards.dev)**

A mobile-friendly Progressive Web App for spaced repetition flashcards. Cards live as `.md` files in a GitHub repo (same format as the [hashcards](https://github.com/eudoxia0/hashcards) CLI), and the app reads them via the GitHub API.

## Features

- **FSRS scheduling** — modern spaced repetition algorithm with per-card stability and difficulty tracking
- **GitHub sync** — sign in with GitHub and pick a repo; reads `.md` card files and syncs review state to a `hashcards-state.json` file
- **Offline support** — works fully offline via IndexedDB + service worker; syncs when back online
- **Card formats** — basic Q/A cards and cloze deletions with multiple blanks
- **Rich content** — LaTeX math (KaTeX), syntax-highlighted code blocks, images, tables
- **Cloze sibling burial** — only one deletion per cloze card shown per session
- **Leech hunting** — the stats view ranks the cards that keep failing, and edits them in place
- **Edit cards in the app** — rewrite or delete a card and commit it to GitHub, keeping its scheduling
- **Undo** — revert the last grade during a session
- **Keyboard shortcuts** — Space to reveal, 1-4 to grade, U to undo

## Card Format

Cards are plain Markdown files. Basic cards use `Q:` / `A:` prefixes, cloze cards use `C:` with `[brackets]` around deletions:

```markdown
Q: What is the derivative of $x^n$?
A: $nx^{n-1}$

---

C: Euler's identity states that [$e^{i\pi} + 1 = 0$].
```

Use `---` separators between cards. TOML frontmatter with `name = "..."` overrides the deck name (otherwise derived from the filename).

See the [hashcards format spec](https://github.com/eudoxia0/hashcards#format) for full details.

## Setup

### 1. Create a card repo

Create a GitHub repository with `.md` files containing your flashcards. See [hashcards-demo](https://github.com/danielmeint/hashcards-demo) for an example.

### 2. Connect the app

Open the app and click **Sign in with GitHub**. Choose which repositories to grant access to, then pick your card repo from the list. That is the whole setup — the app receives a short-lived token scoped to those repositories, and you can revoke it at any time from your GitHub settings.

<details>
<summary>Using a personal access token instead</summary>

Sign-in needs a GitHub App, which a self-hosted copy may not have (see [Sign-in setup](#sign-in-setup)). Settings always offers the token path as well:

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with **Contents: Read and write** permission on your card repo.
2. In Settings, expand **Use a personal access token instead**, paste the token, enter the repo owner, name and branch, and click **Connect**.

</details>

## CLI

`hc` works on a local clone of a card repo: for scripts, CI and agents. It
reads review history from the `hashcards-data` branch with plain `git` (or, in
a repo not yet migrated, from `hashcards-state.json` and `hashcards-reviews/`).

```bash
npm run build:cli               # → dist-cli/hc.js (or run from source: node cli/hc.ts)

hc lint [--fix]                 # parse errors, duplicate IDs; --fix stamps missing IDs
hc add --deck net/tcp.md --draft -q "Question?" -a "Answer"
hc add --deck net/tcp.md --cloze "TCP opens with [SYN]."
hc add --json cards.json        # one card or an array, as schema/card.schema.json
hc due [--date tomorrow]        # reviews due, new cards within new_per_day
hc stats                        # totals, maturity, retention, 14-day forecast, reviews/day
hc leeches [--min-lapses 3]     # cards that keep failing
hc show <key|id>                # a card, its file:line, state and history
hc init                         # hashcards.toml, AGENTS.md, a lint workflow for PRs
hc migrate [--apply]            # v1 repo → 1.0: stamp IDs, history to hashcards-data (dry run by default)
hc import anki --decks <ankictl repo> --collection <copy> [--dir cka] [--apply]
                                # Anki notes → decks, revlog → hashcards-data (cli/anki/README.md)
```

Every command takes `--repo <dir>` (default: the current directory) and
`--json`. Exit codes: 0 ok, 1 findings (lint errors, leeches, no such card),
2 usage or error. `hc <command> --help` has the details.

Which files are decks: `hashcards.toml`'s `[decks]` include/exclude globs if
it has them, otherwise every `.md` except README/AGENTS-style documentation
(`README`, `AGENTS`, `CLAUDE`, `CHANGELOG`, `LICENSE`… and all-caps names with
a `_` or `-`, such as `CARD_GUIDE.md`), and nothing in hidden directories.

`hc init` writes an [`AGENTS.md`](cli/templates/AGENTS.md) telling coding
agents how to write cards in the repo. When an agent runs `hc add`, cards
default to `Status: draft`.

## Development

```bash
npm install
npm run dev       # start dev server
npm test          # run tests
npm run build     # production build
```

## Deployment

`npm run build` outputs static files to `dist/`, deployed to Cloudflare Pages by `.github/workflows/deploy.yml`. The `functions/` directory at the repo root is picked up by the same `wrangler pages deploy` invocation and served at `/api/auth/*`.

### Dev deployment

`npm run deploy:dev` builds whatever is checked out and publishes it to
**https://dev.hashcards-app.pages.dev** — a Pages preview, never production, so
a branch can be tried on a phone before it merges. It needs `npx wrangler login`
once. Sign-in works there because the GitHub App lists that URL as a callback and
the Pages *preview* environment has its own `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` (set with `--env preview`; preview and production
secrets are separate).

### Sign-in setup

"Sign in with GitHub" needs a GitHub App of your own. Without one the app still works — the sign-in button simply does not appear, and the token path is the only way in.

A browser cannot complete an OAuth exchange by itself: GitHub's token endpoint is not CORS-enabled and requires a client secret. `functions/api/auth/` is the smallest thing that closes that gap. It holds no state, sets no cookies, and never sees your cards.

```bash
node scripts/create-github-app.mjs --name "My Hashcards" --url https://your-domain
```

Open the URL it prints, press **Create GitHub App**, and it writes to `.github-app/` (gitignored):

| | |
|---|---|
| `github-app.public.json` | id, slug, client ID — public, these go in the repo |
| `github-app.secret` | client secret, `0600` |
| `github-app.private-key.pem` | `0600`; unused here, but the only copy |

The script goes through GitHub's [App Manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), so permissions, callback URLs and the install-time OAuth step come from one reviewed object rather than from ten form fields — see `buildManifest` for what it asks for and why. Then:

1. Put the **client ID** and **slug** from `github-app.public.json` into `src/github-app.ts`. Both are public and belong in the repo; the secret does not.
2. Push the credentials to your Pages project. Piping keeps the secret out of your shell history and out of `ps`:
   ```bash
   npx wrangler pages secret put GITHUB_CLIENT_SECRET \
     --project-name hashcards-app < .github-app/github-app.secret
   npx wrangler pages secret put GITHUB_CLIENT_ID --project-name hashcards-app
   ```
3. Install the App on your card repo — the script prints the link.
4. Confirm **user-to-server token expiration** is on, at the App's settings page. It is the default for new apps and cannot be set from a manifest. With it on you get 8-hour tokens and a refresh token, which is what `src/auth.ts` expects; with it off the token is permanent and `expiresAt` is simply null.

Delete `.github-app/` once the secret is in Cloudflare, keeping the private key if you want it.

<details>
<summary>Creating the App by hand instead</summary>

At [github.com/settings/apps/new](https://github.com/settings/apps/new): **Callback URL** `https://your-domain/` and `http://localhost:8788/`; **Request user authorization (OAuth) during installation** on; **Expire user authorization tokens** on; **Webhook → Active** off; **Repository permissions → Contents** Read and write. Then generate a client secret and follow the numbered steps above.

</details>

For local development, `vite` does not serve `/api/auth/*`. Put the two variables in a `.dev.vars` file (gitignored) and run the Functions alongside the built site:

```bash
npm run build
npx wrangler pages dev dist   # http://localhost:8788
```

## Tech Stack

- TypeScript, vanilla DOM
- Vite
- marked (Markdown rendering)
- idb (IndexedDB wrapper)
- KaTeX + highlight.js via CDN
- Cloudflare Pages, with a Pages Function for the OAuth token exchange
- FSRS algorithm (custom port)

## Roadmap

Known defects, planned work, and longer-term ideas live in [ROADMAP.md](ROADMAP.md).

## License

MIT
