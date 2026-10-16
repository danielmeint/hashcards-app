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
| A card is the SHA-256 of its text, whitespace included. | A card is still **its text** (§2.7): hashed after normalising whitespace. Edits in the app keep history; other edits are carried over on request with **`link` events** (`hc relink`). No IDs in the files. |
| `hashcards-state.json` is the synced truth; the review log is a side record. | The **review log is the truth**. Current state is FSRS replayed over it. Snapshots are caches. |
| Review data commits land on `main` next to the cards. | Review data lives on an orphan **`hashcards-data`** branch. `main` history is content only. |
| Settings live in each device's localStorage. | Collection settings live in **`hashcards.toml`** in the repo. Only device prefs (theme, haptics) stay local. |
| Agents write files by hand against a prose spec. | A **`hc` CLI**, `AGENTS.md` and a JSON Schema are the agent interface. |
| Every card that appears in a file is scheduled. | Cards can be **drafts**: agents propose, you accept on your phone in an **Inbox**. |
| Deck-first UI with per-deck Drill buttons. | **Today**-first UI from the mockups (`docs/design/`). Decks are filters. |
| Anki holds the CKA decks (`anki-decks`, `ankictl`). | **Anki is imported, history included, and retired.** |

### Drop

- Format compatibility with the original hashcards CLI: its exact hash bytes,
  its line-joining quirks. (Identity by content stays: §2.7.)
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

Tags: capitals
Q: What is the capital of Estonia?
A: Tallinn

---

Reverse: yes
Q: **Germany**
A: ![Germany on the map](map-deu.png)

---

Status: draft
C: In Kubernetes, a [Deployment] manages a [ReplicaSet].
```

- **Metadata lines come first in a card block, before `Q:` / `C:`.** A line
  matching `^(Tags|Reverse|Status):` at the top of a block is metadata.
  After `Q:` / `A:` / `C:` starts, nothing is metadata, so answers can say
  anything.
- **No `ID:`.** A card is its text (§2.7). An `ID:` line written by the
  first 1.0 builds is still read (and ignored, with a lint warning) so old
  files keep parsing; `hc migrate` removes them and carries their history.
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
| Any card | `h:<first 16 hex of its content hash>` (§2.7) |
| A card from a subscribed collection, as recorded in *your* log | `<owner>/<repo>/h:<…>` |

A basic card and its reverse are two hashes (question and answer swapped), so
two keys; each cloze deletion is its own hash. Siblings (a card and its
reverse, the deletions of one cloze) share a **family hash** and are buried
together.

**Deleting a card never deletes its history.** The events stay on the data
branch. Writing the same text again picks the history back up.

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
- **`link`** (`{"v":2,"kind":"link","card":"h:new…","from":"h:old…","at":…}`)
  says the card now called `card` used to be `from`: replay reads every event
  of `from` as one of `card` (§2.7).
- `src` is optional provenance (`"anki"`, `"v1"`, `"edit"`, `"relink"`).
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

### 2.7 Identity: a card is its text

Decided 2026-10-16, replacing the `ID:` lines of M1. Stable IDs fixed one
problem (an edit loses history) and brought a class of new ones: duplicate
IDs from copied blocks, a "never reuse an ID" rule for agents, `ID:` noise in
every file, a stamping step in every tool, and a name ("hashcards") that no
longer described the tool. Edit detection (inferring which new card an old
one became) was considered and dropped as too clever: history is never lost,
so carrying it over can be a deliberate act instead.

**The hash.** `normalise(s)` collapses every run of whitespace (spaces, tabs,
newlines) to one space and trims the ends. Then:

- basic: `sha256("basic\0" + normalise(Q) + "\0" + normalise(A))`; its
  reverse swaps Q and A.
- cloze deletion: `sha256("cloze\0" + normalise(before) + "\0" +
  normalise(deleted) + "\0" + normalise(after))`, over the text with every
  bracket removed. Adding or removing *another* deletion leaves it unchanged.
- family: the forward basic hash for a basic card and its reverse;
  `sha256("cloze\0" + normalise(text without brackets))` for a cloze block.

`Tags:`, `Status:`, `Reverse:`, `Extra:`, the deck, the file and the card's
position are outside the hash: changing them keeps history.

**What carries history, and what does not:**

| Change | History |
|---|---|
| Reorder, move to another file or deck, change tags, status or `Extra:` | kept |
| Reflow, re-indent, trailing spaces | kept (normalised) |
| Add or remove another cloze deletion | kept for the others |
| Undo an edit (the old text comes back) | comes back by itself |
| Edit in the app | kept: the app writes a `link` event |
| Edit anywhere else (GitHub, an editor, an agent) | starts fresh, unless you run `hc relink` |
| Reword a cloze sentence | every deletion starts fresh, unless relinked |
| The same text twice in a collection | one card, one schedule; `hc lint` warns |
| A subscribed deck's author fixes a typo | starts fresh (accepted for 1.0) |

**Carrying it over by hand.** `hc relink` compares the cards at a revision
(default `HEAD`) with the working tree, pairs cards that disappeared with
cards that appeared in the same file by position (what the app does for an
in-app edit), shows the pairs, and with `--apply` commits one `link` event per
pair to the data branch. `hc relink <old-key> <new-key>` links one pair
explicitly. Orphaned history stays on the data branch, so this can be done any
time later. A "lost history" list in the app is a possible follow-up, not 1.0.

**`link` in replay.** Before replaying, events are resolved through the links:
an event of `from` counts as one of `card`, transitively. A link that would
close a cycle (`a→b`, later `b→a`: an undone relink) replaces the older one.
Links make an incremental replay invalid, so a group that receives one is
replayed from scratch.

---

## 3. Milestones

Each milestone ends with tests green (`npm test`, `npm run typecheck`,
`npm run e2e`) and the tracker updated. Branches come off `v1`, which merges to
`main` when 1.0 ships.

### M1. Format v2 and identity — *foundation*

*The `ID:` half of this milestone was reversed by §2.7 and M10.*

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

### M10. Hash identity — *revisits M1, before the 1.0 tag*

- Hash per §2.7 (`src/hash.ts`); keys are `h:` only; `ID:` read as legacy.
- `link` events (`src/core/events.ts`), link resolution before every replay
  and history read (app and `hc`).
- In-app edits write `link` instead of a baseline. Inbox Keep, `hc add` and
  `hc lint --fix` stop stamping IDs; `stampIds` goes.
- `hc relink` (diff mode and explicit pair); `hc lint` warns on legacy `ID:`
  and on duplicate text.
- `hc migrate`: v1 repos map hashes to the new keys; repos with `ID:` lines
  get one `link` per card and their `ID:` lines removed. The app treats a
  legacy `ID:` as an implicit link meanwhile, so nothing looks new between
  deploy and migration.
- Spec, schema, `AGENTS.md`, `starter/` and the `hashcards-starter` template
  without IDs; `my-hashcards` migrated (with Daniel's go-ahead).
- *Exit:* migrating a copy of `my-hashcards` keeps every card's s/d/reps.

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
| M7 Features | Inbox, settings wiring, leeches merged into `v1`; FSRS fit and notifications open | `v1-inbox` | **Inbox** done: Today row, keep/discard/edit/skip/undo (swipe, K/D/E/S/U), decisions queued in IndexedDB and laid over the cards, committed as one Git Data commit per collection on the content branch ("Inbox: keep 2, discard 1") on leaving, after 15s idle, or on the next sync; a change whose draft changed upstream is dropped and reported. **Settings**: pushed to `hashcards.toml` on leaving; Collection / This device sections. **Leeches** count every device's grades (`reviewHistory`). **Reverse cards**: parser keys `<id>:r`, drill buries forward/reverse as siblings, stats count them separately (tested). **Stats from full history** done (`v1-visible-problems`): heatmap, streak and grade mix read every device's grades (`reviewHistory`, links resolved, local day per review); card counts leave out deleted cards' leftover states. FSRS fit and notifications not started. |
| M8 UI 1.0 | done, merged into `v1` | `v1-ui` | Today, Review, Caught up, Stats, Settings, sheets restyled; responsive tour in e2e. Inbox waits on M7 |
| Visible deck problems | done, shipped 2026-10-16 | `v1-visible-problems` | A deck that stops parsing keeps its last good cards and Today says which file and line, linked to GitHub (`src/deck-problems.ts`, `DeckFile.problem`); the same card in two places is shown once, with a folded warning. Responsive tour includes a broken deck. |
| Sync edge cases | done, on `v1-sync-edge-cases` | `v1-sync-edge-cases` | A device that finds reviews it did not write under its name (cloned browser, lost local log) takes a new name instead of overwriting them (`checkOwnFiles` in `src/data-branch.ts`); identical lines count once in the CLI as in the app; reviews, links and "today" use the server-corrected clock (`src/clock.ts`), with a notice past 5 minutes of skew. e2e: `e2e/sync-edge-cases.spec.ts`. |
| M10 Hash identity | done 2026-10-16: deployed, `my-hashcards` migrated (main 91a990a, hashcards-data 6485b70), `hashcards-starter` updated (80bb913) | `main` | Decision and edge cases in §2.7. Keys `h:` + 16 hex of the normalised hash (`src/hash.ts` `basicIdentity`/`clozeIdentity`); `Card.hash` stays the v1 hash, `Card.legacyKey` is what an `ID:` line gave. `link` events (`src/core/events.ts`), resolved before every replay and history read (`linkMap`/`resolveLinks` in `src/core/replay.ts`; a link in fresh events forces a full replay). Readers treat a card's former keys (legacy ID key, v1-hash `h:` key: `formerKeys` in `src/card-key.ts`) as epoch-dated links, so unmigrated and archived history keeps working. In-app edits write `link` (src `edit`) instead of a baseline. IndexedDB re-keys cached cards once (`hash_identity`), no refetch. `hc relink` (diff mode, by name), `hc migrate` ID mode (strip + links in `reviews/<month>.hc.jsonl`, recovers deleted cards from git history), `hc lint` warns on duplicates and legacy IDs, no `--fix`, `hc add` has no `--id`, `hc show file:line`. Anki import strips its IDs and re-keys reviews. Rehearsal on a clone of `my-hashcards`: 184 ID lines, 246 links (194 current, 52 from history, 35 orphans left), 100/100 cards with history unchanged; `hc due` today/+7/+30 and `hc stats` identical before and after. |
| M9 Ship | 1.0 app shipped to production 2026-10-16 (`v1` → `main`); onboarding on `v1-onboarding` | `main`, `v1-onboarding` | **Onboarding:** `starter/` is the sample collection (5 decks, 39 cards, 3 drafts, lint-clean under `cli/starter.test.ts`) and the root of the `danielmeint/hashcards-starter` template repo, still to be created from it. `#demo` runs the whole app on it with seeded history (`src/demo*.ts`); `demo-mode.ts` swaps localStorage, IndexedDB and GitHub for in-memory/per-session ones. Welcome screen with demo / template / existing-repo paths. README rewritten with `npm run screenshots`; `ROADMAP.md` → `docs/history/`. The lint workflow builds `hc` from this repo until it is on npm. Still open: CLI npm name and publish, `v1.0.0` tag. |
