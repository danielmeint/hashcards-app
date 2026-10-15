# Hashcards 1.0

The plan for turning hashcards from "a phone front-end for the hashcards CLI's
format" into a standalone spaced-repetition tool, and the one Daniel uses for
everything, Anki included.

`ROADMAP.md` is the history of how the app got here (Phases 1–6). This file is
what comes next. Where they disagree, this one wins.

Status lives in the [Tracker](#tracker) at the end. Update it as work lands.

---

## 1. What 1.0 is

One sentence: **cards are plain Markdown in a git repo that people, scripts and
agents all write to, and the app is the best place to review and curate them.**

### Keep

- **The git repo as the only backend.** History, backup, multi-device, review
  by PR and agent access come free. The only server code stays the GitHub
  sign-in exchange (`functions/api/auth/*`).
- **Markdown cards**, `Q:` / `A:` / `C:`. The most agent-friendly format there is.
- **FSRS**, offline-first IndexedDB, installable PWA, swipe and keyboard review.
- **The per-device, per-month review log.** It becomes the source of truth.

### Change

| Today | 1.0 |
|---|---|
| A card is the SHA-256 of its text. A typo fix resets its history. | A card has a stable **ID** written in the file. Edits, moves and rewording keep history. |
| `hashcards-state.json` is the synced truth; the review log is a side record. | The **review log is the truth**. Current state is FSRS replayed over it. Snapshots are caches. |
| Review data commits land on `main` next to the cards. | Review data lives on an orphan **`hashcards-data`** branch. `main` history is content only. |
| Settings live in each device's localStorage. | Collection settings live in **`hashcards.toml`** in the repo. Only device prefs (theme, haptics) stay local. |
| Agents write files by hand against a prose spec. | A **`hc` CLI**, `AGENTS.md` and a JSON Schema are the agent interface. |
| Every card that appears in a file is scheduled. | Cards can be **drafts**: agents propose, you accept on your phone in an **Inbox**. |
| Deck-first UI with per-deck Drill buttons. | **Today**-first UI from the mockups (`docs/design/`). Decks are filters. |
| Anki holds the CKA decks (`anki-decks`, `ankictl`). | **Anki is imported, history included, and retired.** |

### Drop

- Format compatibility with the original hashcards CLI: hash identity, its
  line-joining quirks, cloze family hashes.
- `hashcards-state.json` as the thing that syncs (read once, for migration).
- Per-deck navigation as the primary flow.

### Not in 1.0

Non-GitHub hosts, image occlusion, custom note templates, shared/collaborative
decks beyond today's read-only subscriptions, native apps, a server.

---

## 2. Card format v2

Fully specified in `CARD_FORMAT_SPEC.md` (rewritten in milestone M1). The
decisions:

### 2.1 Cards and metadata

```markdown
---
name = "Europe: Nordic & Baltic"
tags = ["geo", "europe"]
---

ID: est-capital
Tags: capitals
Q: What is the capital of Estonia?
A: Tallinn

---

ID: k8q2xv7m
Reverse: yes
Q: **Germany**
A: ![Germany on the map](map-deu.png)

---

ID: k3n9wq2p
Status: draft
C: In Kubernetes, a [Deployment] manages a [ReplicaSet].
```

- **Metadata lines come first in a card block, before `Q:` / `C:`.** A line
  matching `^(ID|Tags|Reverse|Status):` at the top of a block is metadata.
  After `Q:` / `A:` / `C:` starts, nothing is metadata, so answers can say
  anything.
- **`ID:`** matches `[a-z0-9][a-z0-9-]{1,63}`. It must be unique within the
  collection. People and agents may pick slugs (`cka-wl-set-image`, as
  ankictl's keys); otherwise `hc lint --fix` or the app stamps a random
  8-character base32 one. **A missing ID is not an error, only a warning.**
  Agents can write cards without one.
- **`Tags:`** is comma-separated and adds to the file's frontmatter `tags`.
- **`Reverse: yes`** (basic cards only) also schedules answer→question.
- **`Status:`** is `draft` (not scheduled, shown in the Inbox) or `suspended`
  (kept, not scheduled). Absent means active.
- **`Extra:`** is an optional last section of any card, after `A:` or the
  `C:` text, like `A:` starts the answer. It is a note shown only after reveal
  (context, a mnemonic, a docs pointer), never part of the question, and it
  does not affect the card's identity.
- **Tags** are lowercase, with `/` for hierarchy (`cka/type/syntax-pattern`),
  and are normalised on read.
- The frontmatter stays TOML between `---` lines and gains `tags`. A deck name
  still defaults to the file name.
- Cloze syntax, `---` separators, Markdown, LaTeX, code and images are
  unchanged.

### 2.2 Card keys (what the review log refers to)

| Card | Key |
|---|---|
| Basic | `<id>` |
| Its reverse | `<id>:r` |
| Cloze deletion *n* (1-based, in order of appearance) | `<id>:<n>` |
| A card with no ID (unmigrated file, read-only subscription) | `h:<first 16 hex of the v1 content hash>` |
| A card from a subscribed collection, as recorded in *your* log | `<owner>/<repo>/<key>` |

IDs cannot contain `/` or `:`, so keys parse unambiguously. Cloze siblings are
`<id>:*`. Burying siblings needs no family hash any more.

**Deleting a card never deletes its history.** The events stay on the data
branch. Re-adding the same ID picks the history back up. (This is ankictl's
"deletion is never automatic" for free.)

### 2.3 Collection layout

```
main
├── hashcards.toml        collection settings (§2.5)
├── AGENTS.md             how to write cards here (generated by `hc init`)
├── <any dir>/*.md        decks; include/exclude globs in hashcards.toml
└── <media next to decks>

hashcards-data            orphan branch, written by the app and `hc`
├── reviews/YYYY-MM.<device>.jsonl   append-only events (§2.4)
├── fsrs.json             fitted FSRS parameters (M7), optional
└── snapshot.json         derived state cache, safe to delete
```

### 2.4 Review events

One JSON object per line, short keys (these files only grow):

```json
{"v":2,"card":"est-capital","at":"2026-10-15T07:12:03.120Z","tz":120,"grade":3,"ms":4200}
{"v":2,"kind":"baseline","card":"k3n9wq2p:1","at":"2026-10-13T19:14:37.619Z","s":8.2956,"d":1,"reps":1}
{"v":2,"card":"cka-wl-set-image","at":"2026-09-02T18:01:44.000Z","tz":120,"grade":1,"ms":9100,"src":"anki"}
```

- `kind` defaults to `"review"`. **`baseline`** seeds a card's stability and
  difficulty when its real history is not available (the v1 state file). Replay
  starts from the latest baseline and applies later reviews.
- `tz` is the local UTC offset in minutes at review time. Days are local days,
  so replay must not depend on the replaying device's timezone.
- `src` is optional provenance (`"anki"`, `"v1"`).
- A device only ever writes its own files. Undo before a push simply never
  appears; an undo after a push rewrites that device's current month file
  (as today). No undo events.

### 2.5 `hashcards.toml`

```toml
[review]
new_per_day = 20
desired_retention = 0.9     # 0.80–0.95
fuzz = true

[decks]
include = ["**/*.md"]
exclude = ["README.md", "AGENTS.md", "archive/**"]
```

Device preferences (theme, haptics) stay in localStorage. Fitted FSRS weights
are machine-written, so they live on the data branch (`fsrs.json`), not here.

### 2.6 Replay semantics

State is a pure function: `replay(events, params, retention) → Map<key, CardState>`.

- Same inputs give the same output on every device. **Fuzz must be
  deterministic**, seeded from `hash(cardKey + reviewIndex)`, not `Math.random`.
- Stability and difficulty come from the events. **The due date is the last
  review plus the interval at the *current* retention.** Changing retention
  therefore moves every due date at once, which is the honest reading of the
  setting.
- The existing same-day rules carry over unchanged: a pass is never due the
  same day, a lapse may be (`src/fsrs.ts`).
- Locally, the app caches the replay result in IndexedDB and replays
  incrementally from what it has not seen yet.

---

## 3. Milestones

Each milestone ends with tests green (`npm test`, `npm run typecheck`,
`npm run e2e`) and the tracker updated. Branches come off `v1`, which merges to
`main` when 1.0 ships.

### M1. Format v2 and identity — *foundation*

- Parser: metadata lines, `ID` / `Tags` / `Reverse` / `Status`, frontmatter
  `tags`, card keys per §2.2. v1 files (no IDs) still parse, with `h:` keys.
- `ParsedCard` gains `id`, `key`, `tags`, `status`; `hash` stays only to derive
  `h:` keys and for migration.
- Rewrite `CARD_FORMAT_SPEC.md` as the v2 spec, with a JSON Schema for one card
  (`schema/card.schema.json`) for agents that emit structured cards.
- A pure `stampIds(fileText) → fileText` that adds missing IDs without touching
  anything else in the file (byte-for-byte elsewhere).
- *Exit:* every existing fixture parses; v2 fixtures cover every metadata
  combination; stamping round-trips.

### M2. Event log and replay — *foundation*

- `src/core/events.ts`: event types, parse/serialise lines, v1 log lines
  (`{"card":<hash>,…}`) read as `src:"v1"` events.
- `src/core/replay.ts`: pure replay per §2.6, deterministic fuzz, baselines.
- Equivalence test: replaying a recorded session gives the same state as the
  live `updatePerformance` path (fuzz off).
- *Exit:* replay is the only way state is computed in tests. No app wiring yet.

### M3. Data branch and sync rewrite

- `src/github.ts`: read and write the `hashcards-data` branch through the Git
  Data API (blobs, trees, commits, refs). One commit per sync for all changed
  files, and create the orphan branch on first use.
- `src/sync.ts`: push own event files, pull others, replay, then cache. Remove
  `hashcards-state.json` writes. Read it once for migration (M4).
- `hashcards.toml` read and written by the app. Settings screen edits it.
- Subscribed collections: their cards are read from their `main`; your events
  for them live in your data branch under `<owner>/<repo>/<key>`.
- *Exit:* two-device e2e test (two pages, one fake GitHub) converges with no
  conflicts. Offline reviews survive and push later.

### M4. Migration of `my-hashcards`

- `hc migrate` (M5's CLI) on a clone: stamp IDs into every deck, write
  `baseline` events from `hashcards-state.json`, rewrite v1 review logs to v2
  keys, move logs to the data branch, write `hashcards.toml` from current
  settings. Remove the state file and old log dir from `main`.
- The app detects an unmigrated repo and says what to run. No silent in-app
  migration of the user's files.
- *Exit:* before and after the migration, every card's due date and stability
  match (within fuzz). Run against a copy first, then the real repo, with
  Daniel's go-ahead.

### M5. `hc` CLI and the agent interface

- `src/core/` holds everything platform-neutral (parser, IDs, events, replay,
  FSRS, settings). The app and the CLI both import it. No DOM or IndexedDB in
  core.
- `cli/`: Node ≥ 22, published as the npm package `hashcards` with bin `hc`.
  Works on a local clone and reads the data branch with plain `git`.
  - `hc lint [--fix]`: validate, report duplicate IDs, stamp missing IDs.
  - `hc add`: create a card from flags or `--json` (validated against the
    schema). Defaults to `Status: draft` when `--draft` is set or the caller is
    an agent.
  - `hc due`, `hc stats`, `hc leeches`, `hc show <key>`: `--json` everywhere.
  - `hc migrate`, `hc import anki` (M6), `hc fit` (M7), `hc init` (writes
    `hashcards.toml`, `AGENTS.md`, a lint workflow).
- `AGENTS.md` template: the format in one screen, "prefer drafts", ID rules,
  the card-writing guide from `my-hashcards/CARD_GUIDE.md`.
- GitHub Action template for card repos: `hc lint` on PRs.
- *Exit:* an agent with only `AGENTS.md` and `hc` can add valid draft cards to
  a fresh repo (checked with the `skill-eval` method).

### M6. Anki import and cutover

- `hc import anki`: read the ankictl deck repo (`anki-decks/decks/**/*.yaml`)
  and a **copy** of the Anki collection (`collection.anki2`, SQLite, via
  `node:sqlite`). Map each note `key` to a card ID, Basic to `Q:`/`A:`, Cloze
  `{{c1::…}}` to `C:` brackets, a cloze note's Extra field to `Extra:`, tags to
  `Tags:` (lowercase, `/` hierarchy), the deck path to a file path. Reviews of
  cards deleted from Anki are dropped.
  Turn `revlog` rows into v2 review events with `src:"anki"`. Skip cram and
  manual entries, convert `ease` 1–4 to grades, and `time` to `ms`.
- Output into a directory, never straight into a repo. Daniel reviews and
  commits.
- Cutover: import into `my-hashcards`, compare due dates against Anki for a
  week, then archive `anki-decks` and `ankictl`, and retire the `anki` agent
  skill in `nix-config`.
- *Exit:* every Anki note present, every revlog review present, and due dates
  within a day of Anki's for ≥ 90% of cards (FSRS parameters differ, so not
  100%).

### M7. Features

- **Inbox:** drafts across the collection. Swipe right to accept (removes
  `Status: draft`, stamps an ID), swipe left to discard (removes the block),
  tap to edit. Changes are batched into one commit.
- **Reverse cards** in review and stats.
- **FSRS fit:** `hc fit` fits parameters from the full log and writes
  `fsrs.json` on the data branch. The app uses it when present. Investigate
  `fsrs-rs` bindings (WASM or napi) or the Python optimizer in a GitHub Action.
- **Notifications:** a card-repo GitHub Action on a morning cron runs
  `hc due --json` and posts to ntfy. No server, no app change.
- **Stats from full history:** retention, streaks and leeches stop being "on
  this device".

### M8. UI 1.0 — *runs alongside M1–M7*

- Mockups: `docs/design/mockups/*.dc.html` (also on the canvas linked in
  `docs/design/README.md`). Today, Review (question, answer, swipe, dark),
  Caught up, Stats, Settings.
- Rewrite `src/style.css` from scratch:
  - Mobile-first. `light-dark()` palette tokens, one set rather than three.
  - The UI font is the body default; only card content uses the content font.
  - Fluid widths (`min()`, `clamp()`); no fixed 900px card.
  - `@media (hover: hover)` around every hover rule.
  - Charts that cannot overflow.
- Screens: Today (replaces the deck list), Review, Caught up, Stats, Settings,
  then Inbox and Card editor in the same style.
- A permanent responsive tour in e2e: 320, 390, 820 and 1440 px, light and
  dark, asserting `scrollWidth <= innerWidth` on every screen.
- *Exit:* the tour passes and the screens match the mockups.

### M9. Ship

- Docs: README rewritten for the standalone tool, `CARD_FORMAT_SPEC.md` v2,
  `AGENTS.md`, CLI `--help`.
- `ROADMAP.md` archived into `docs/history/`.
- Migrate `my-hashcards` and import Anki (M4, M6) on the real data.
- Tag `v1.0.0`, deploy, publish the CLI to npm.

---

## 4. Order and parallelism

```
M1 format ──┬── M4 migration ──┐
M2 replay ──┼── M3 data branch ┼── M9 ship
            └── M5 CLI ── M6 Anki import ─┘
M8 UI ───────────────── (alongside) ──────┘
M7 features after M3 + M5
```

Running in parallel from the start: **M1, M2, M8, and the M6 importer as a
standalone prototype** (`tools/import-anki/`, against the §2 spec). It folds
into `hc` once M5 exists.

## 5. Risks

- **Replay drift.** If replay and the live path disagree, due dates jump after
  migration. Mitigated by M2's equivalence test and M4's before/after check.
- **Timezones.** Events carry `tz`, and replay uses it, never the device's.
- **GitHub API budget.** The data branch takes one commit per sync through the
  Git Data API, which costs fewer calls than today's per-file contents API.
- **iOS storage eviction.** Call `navigator.storage.persist()`. The repo is the
  backup, so eviction costs a re-sync, never data.
- **Anki parity.** Anki's own FSRS parameters differ, so due dates will move a
  little on import. That is accepted; M7's fit closes the gap.

## 6. Working agreements

- Branch per workstream off `v1` (`v1-format`, `v1-replay`, `v1-ui`,
  `v1-anki-import`, …). Merge into `v1` after review. No pushes to `main`
  until 1.0.
- `npm test`, `npm run typecheck` and the e2e suite stay green on every merge.
- Never write to `my-hashcards`, `anki-decks` or the Anki collection from a
  tool without Daniel's go-ahead. Work on copies.
- E2E port: set `E2E_PORT` per worktree so parallel runs don't share a dev
  server.
- Worktrees share the main checkout's `node_modules` through a symlink. Never
  run `npm install` or `npm ci` from a worktree; add dependencies on `v1`.
- **Hashcards is not an Anki clone.** The Anki import is a one-off migration.
  Map Anki's concepts onto hashcards-native ones (as with `Extra:`), and don't
  grow the format to mirror Anki's features.

---

## Tracker

| Milestone | Status | Branch | Notes |
|---|---|---|---|
| M1 Format v2 and identity | done, merged into `v1` | `v1-format` | Parser reads metadata and frontmatter `tags`; `src/card-key.ts` (keys), `src/card-ids.ts` (`stampIds`), spec v2 + `schema/card.schema.json`. `hash` unchanged and still the app's key until M3. Cached deck files lack the new fields until their SHA moves: M3 should force a re-parse. |
| M2 Event log and replay | done, merged into `v1` | `v1-replay` | `src/core/{events,schedule,replay}.ts`. Live path and replay share one step; fuzz seeded by key + review count. v1 lines assume CET/CEST. Live-path equivalence and the real v1 log reproduce exactly. App wiring (keys into fuzz, tz on writes) is M3. |
| M3 Data branch and sync | in progress | `v1-sync` | |
| M4 Migration | not started | | needs M3, M5 |
| M5 `hc` CLI | in progress | `v1-cli` | |
| M6 Anki import | prototype merged into `v1` | `v1-anki-import` | `tools/import-anki/`: real run maps 153/153 notes, 168/168 cards, 625 reviews (314 of deleted cards skipped). Folds into `hc` with M5; parity check needs M2 |
| M7 Features | not started | | |
| M8 UI 1.0 | done, in review | `v1-ui` | Today, Review, Caught up, Stats, Settings, sheets restyled; responsive tour in e2e. Inbox waits on M7 |
| M9 Ship | not started | | |
