# Hashcards PWA

A mobile-friendly Progressive Web App for spaced repetition flashcards. Cards live as `.md` files in a GitHub repo (same format as the [hashcards](https://github.com/eudoxia0/hashcards) CLI), and the app reads them via the GitHub API.

## Features

- **FSRS scheduling** — modern spaced repetition algorithm with per-card stability and difficulty tracking
- **GitHub sync** — reads `.md` card files from any GitHub repo; syncs review state to a `hashcards-state.json` file
- **Offline support** — works fully offline via IndexedDB + service worker; syncs when back online
- **Card formats** — basic Q/A cards and cloze deletions with multiple blanks
- **Rich content** — LaTeX math (KaTeX), syntax-highlighted code blocks, images, tables
- **Cloze sibling burial** — only one deletion per cloze card shown per session
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

### 2. Generate a GitHub PAT

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with **Contents: Read and write** permission on your card repo.

### 3. Configure the app

Open the app, enter your PAT, repo owner, repo name, and branch. Click **Test Connection**, then **Sync Now**.

## Development

```bash
npm install
npm run dev       # start dev server
npm test          # run tests
npm run build     # production build
```

## Deployment

The production build (`npm run build`) outputs static files to `dist/` — deploy to any static host (Cloudflare Pages, Vercel, Netlify, GitHub Pages, etc.).

## Tech Stack

- TypeScript, vanilla DOM
- Vite
- marked (Markdown rendering)
- idb (IndexedDB wrapper)
- KaTeX + highlight.js via CDN
- FSRS algorithm (custom port)

## License

MIT
