# Hashcards 1.0

The plan for turning hashcards from "a phone front-end for the hashcards CLI's
format" into a standalone spaced-repetition tool, and the one Daniel uses for
everything, Anki included.

[`docs/history/ROADMAP.md`](docs/history/ROADMAP.md) is the history of how the app got here (Phases 1–6). This file is
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
| M1 Format v2 and identity | done, merged into `v1` | `v1-format` | Parser reads metadata and frontmatter `tags`; `src/card-key.ts` (keys), `src/card-ids.ts` (`stampIds`), spec v2 + `schema/card.schema.json`. `hash` unchanged and still the app's key until M3. Cached deck files lack the new fields until their SHA moves: M3 should force a re-parse. `v1-extra`: `Extra:` section (`content.extra`, outside hash and key, rendered as `.answer.extra`) and tag normalisation, in spec and schema. |
| M2 Event log and replay | done, merged into `v1` | `v1-replay` | `src/core/{events,schedule,replay}.ts`. Live path and replay share one step; fuzz seeded by key + review count. v1 lines assume CET/CEST. Live-path equivalence and the real v1 log reproduce exactly. App wiring (keys into fuzz, tz on writes) is M3. |
| M3 Data branch and sync | done, merged into `v1` | `v1-sync` | Grades are v2 events applied with replay's own step (`applyEvent`, key-seeded fuzz, real `tz`); state is replay cached per group in IndexedDB v8 (`states`, `pulled`, `baselines`). `src/data-branch.ts` pulls changed blobs and pushes one commit per sync via the Git Data API, fast-forward only with retry. `hashcards.toml` read on sync, written on change (`collection-config.ts`, `collection-settings.ts`); Settings UI needs no new controls yet. Unmigrated repos stay v1 read-write (`compat.ts`) with an `hc migrate` hint. M4: reviews already in v1 logs are flagged `v1Pushed` and never re-pushed, so migrate owns them; don't name migrated files `<month>.<live device id>.jsonl`, since a device rebuilds its own files from its local log. |
| M4 Migration | done: `my-hashcards` migrated and pushed 2026-10-16 | `v1-migrate` | `hc migrate` (`cli/commands/migrate.ts`, pure planner `src/migrate.ts`): dry run by default, `--apply` makes one commit on `main` (IDs, `hashcards.toml` with retention/fuzz read off the state file, v1 files removed) and an orphan `hashcards-data` (`reviews/<month>.v1.jsonl`), both refs in one `update-ref` transaction, never pushes. `v1` and `anki` are reserved writer names (`src/core/month-files.ts`, spec). Reviews keep no `src` so a device's own copy of the same line dedupes; baselines are `src:"v1"`. Hashes no deck has keep `h:` keys (87 in my-hashcards: archived decks); re-adding such a deck picks its history back up, but `hc lint --fix` on it would re-key it away from that history. Check verdicts: exact, fuzz, newer, retention, `rules` (v1's 256-day cap and same-day passes, archived cards only), other (refuses `--apply`). Rehearsal on a clone: 0 other; in-deck cards keep s/d/reps exactly; 17 of 51 due dates move by fuzz (new key, new seed), none across today; `hc lint/due/stats` identical except the 14-day forecast. App fix: `collectEvents` drops this device's `v1Pushed` reviews once `main` has no v1 files (else an orphan `h:` schedule). Sync every device before migrating. |
| M5 `hc` CLI | done, merged into `v1` | `v1-cli` | `cli/` (`node cli/hc.ts`, or `npm run build:cli` → `dist-cli/hc.js`): lint/add/due/stats/leeches/show/init, `--json` everywhere, exit 0/1/2; migrate, import anki and fit are stubs for M4/M6/M7 (one module each in `cli/commands/`). Reads `hashcards-data` (local or `origin/`) with `git`, else v1 state file + log as baselines and v1 reviews. Has its own `hashcards.toml` reader (`cli/config.ts`); M3 should move one into `src/core/` and both use it. Cold-start agent check passed (5 drafts, lint clean); AGENTS.md fixed from its report. npm name is still `hashcards-app`; `npx hashcards` in the lint workflow needs the M9 rename and publish. |
| M6 Anki import | `hc import anki` merged into `v1`; not run on real data yet | `v1-migrate` | Prototype moved to `cli/anki/` (unchanged logic, extensionless imports; `tools/import-anki/` removed). `cli/commands/import-anki.ts`: dry run by default, `--apply` commits decks on `main` and `reviews/<month>.anki.jsonl` on top of `hashcards-data` in one transaction; refuses `Anki2` paths, unmigrated repos, path/ID clashes, re-import without `--force`. Rehearsal (copy of the collection as of 1 Oct, into the migrated clone): 153 notes, 168 cards, 625 of 939 revlog rows (314 of deleted cards). Parity against Anki's due dates: 121/167 = **72.5% within a day** (−3..+3: 6/16/24/78/19/18/6), short of 90%. Cause is fuzz, not the model: stability within 1% of Anki's for 164/167, and without fuzz on either side 167/167 within a day. Anki fuzzes ±15%/10%/5% randomly and does not store the draw. Closing it means comparing unfuzzed or giving imported cards Anki's due date once; neither done. 167 CKA cards are due or overdue on import (182 due in all) (Anki unused since ~1 Oct). |
| M7 Features | Inbox, settings wiring, leeches merged into `v1`; FSRS fit and notifications open | `v1-inbox` | **Inbox** done: Today row, keep/discard/edit/skip/undo (swipe, K/D/E/S/U), decisions queued in IndexedDB and laid over the cards, committed as one Git Data commit per collection on the content branch ("Inbox: keep 2, discard 1") on leaving, after 15s idle, or on the next sync; a change whose draft changed upstream is dropped and reported. **Settings**: pushed to `hashcards.toml` on leaving; Collection / This device sections. **Leeches** count every device's grades (`reviewHistory`). **Reverse cards**: parser keys `<id>:r`, drill buries forward/reverse as siblings, stats count them separately (tested). FSRS fit, notifications and the rest of "stats from full history" (retention, heatmap still read local reviews) not started. |
| M8 UI 1.0 | done, merged into `v1` | `v1-ui` | Today, Review, Caught up, Stats, Settings, sheets restyled; responsive tour in e2e. Inbox waits on M7 |
| M9 Ship | 1.0 app shipped to production 2026-10-16 (`v1` → `main`); onboarding on `v1-onboarding` | `main`, `v1-onboarding` | **Onboarding:** `starter/` is the sample collection (5 decks, 39 cards, 3 drafts, lint-clean under `cli/starter.test.ts`) and the root of the `danielmeint/hashcards-starter` template repo, still to be created from it. `#demo` runs the whole app on it with seeded history (`src/demo*.ts`); `demo-mode.ts` swaps localStorage, IndexedDB and GitHub for in-memory/per-session ones. Welcome screen with demo / template / existing-repo paths. README rewritten with `npm run screenshots`; `ROADMAP.md` → `docs/history/`. The lint workflow builds `hc` from this repo until it is on npm. Still open: CLI npm name and publish, `v1.0.0` tag. |
