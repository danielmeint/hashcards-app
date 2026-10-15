# `hc import anki`

The Anki importer (PLAN-1.0 M6). It turns an ankictl deck repo
(`~/projects/personal/anki-decks`) plus a **copy** of the Anki collection into
deck files and review events in a migrated (1.0) card repo. These modules are
the M6 prototype (`tools/import-anki/`), folded into `hc`;
`cli/commands/import-anki.ts` is the command around them.

## Usage

```bash
# 1. Copy the collection. Never point the importer at the live file: any path
#    inside an `Anki2` directory is refused.
mkdir -p /tmp/anki-copy
cp ~/Library/Application\ Support/Anki2/User\ 1/collection.anki2* /tmp/anki-copy/

# 2. Look at the plan and the parity check (a dry run: nothing is written).
hc import anki --decks ~/projects/personal/anki-decks \
  --collection /tmp/anki-copy/collection.anki2 --into ~/cards --acronym CKA

# 3. Commit it, locally, then push both branches together.
hc import anki … --apply
git -C ~/cards push --atomic origin main hashcards-data
```

| Option | Default | |
|---|---|---|
| `--decks` | (required) | ankictl repo: `ankictl.yaml` plus `decks/**/*.yaml` |
| `--collection` | (required) | a copy of `collection.anki2` (and `-wal`/`-shm`, if present) |
| `--into` | `--repo`, or `.` | the card repo: a clean, migrated clone |
| `--dir` | the top-level deck's name (`cka/`) | where the deck files go |
| `--tz` | `Europe/Berlin` | IANA zone the reviews happened in |
| `--max-ms` | `60000` | cap on one review's `ms` |
| `--acronym` | none | repeatable; writes the word in this case in deck names (`Cka` → `CKA`) |
| `--out` | none | also write `reference.json` and `import-report.json` (new or empty dir) |
| `--force` | off | replace the review files of an earlier import |
| `--apply` | off | commit; without it, a dry run |

With `--apply` it makes one commit on the current branch (the deck files) and
one on `hashcards-data` (the events, `reviews/YYYY-MM.anki.jsonl`, on top of
whatever devices have pushed), moving both refs in one transaction. `anki` is
a reserved writer name: no device ever rebuilds those files. It never pushes.

It refuses a dirty tree, a repo not yet migrated, deck paths or card IDs the
repo already has, and a second import without `--force`.

### Parity

The dry run replays the imported events with hashcards' FSRS (the published
default parameters, which is also what Anki used: the real collection's preset
was never optimised) and compares each card's due date with Anki's
(`reference.json`). It reports two numbers:

- **Against Anki's due dates.** M6's exit criterion: 90% within a day.
- **Without fuzz on either side**, Anki's side rebuilt from its own memory
  state in `cards.data`. Anki fuzzes every interval of 3 days or more (±15% up
  to a week, ±10% to 20 days, ±5% beyond) with a random draw it does not
  store, and hashcards fuzzes with its own seeded one, so the first number
  can miss a day's tolerance on cards whose memory state is identical. The
  second number says whether the schedulers themselves agree.

## Mapping

| Anki / ankictl | hashcards v2 |
|---|---|
| note `key` (in the `Key` field, per `ankictl.yaml` `key_field`) | `ID: <key>`. Kept as is when it matches `[a-z0-9][a-z0-9-]{1,63}`. Otherwise it is slugged with ankictl's rules, or becomes `k-<hash>` when nothing is sluggable, with `-2`, `-3` on collision. Changes are listed in the report. |
| deck `Cka::Workloads And Scheduling` | file `cka/workloads-and-scheduling.md`, `name = "CKA: Workloads and Scheduling"` (minor words lowercased, `--acronym` applied) |
| file `tags:` | frontmatter `tags = [...]`, normalised (below) |
| note `tags:` | `Tags: a, b`, normalised; the file's tags are not repeated |
| tag `CKA::Type::Syntax-Pattern` | `cka/type/syntax-pattern`: lowercase, `::` → `/`, whitespace → `-`, as the parser normalises. A tag with no valid form (`c++`) is dropped with a warning. |
| Basic `front` / `back` | `Q:` / `A:` |
| `Basic (and reversed card)` | `Reverse: yes`; Anki card ord 1 → key `<id>:r` |
| Cloze `text` | `C:` with `{{cN::x}}` / `{{cN::x::hint}}` → `[x]` |
| Cloze `Extra` (`extra`), stock Cloze `Back Extra` (`back_extra`) | the card's `Extra:` section, shown only after reveal, as in Anki |
| any other field beyond the card's sides | appended to the `Extra:` section, with a warning. Flashcards-as-Code Basic has only `Front` / `Back` / `Key`, so Basic notes normally have no Extra. |
| `<field>_html` (raw HTML) | kept as HTML (marked passes it through); MathJax `\(…\)` / `\[…\]` → `$…$` / `$$…$$` |
| all cards of a note suspended | `Status: suspended` |
| Anki card ord *k* of a cloze note | key `<id>:<n>`, where *n* is the 1-based position of c*k+1*'s first deletion in the text |
| `revlog.id` (epoch ms) | `"at"`, ISO UTC |
| `revlog.ease` 1–4 | `"grade"` 1–4 (Again, Hard, Good, Easy) |
| `revlog.time` | `"ms"`, capped at `--max-ms` |
| (not stored by Anki) | `"tz"`: `--tz`'s UTC offset **at that instant**, so DST is right per review |
| local month of the review | file `reviews/YYYY-MM.anki.jsonl` |

### Revlog types

From Anki's `RevlogReviewKind`:

| `type` | Kind | Imported? |
|---|---|---|
| 0 | learn | yes |
| 1 | review | yes |
| 2 | relearn | yes |
| 3 | filtered | yes when the row has an ease factor (rescheduling filtered deck); no when `factor = 0` (cram). This follows Anki's own FSRS. |
| 4 | manual (set due date, forget) | no |
| 5 | rescheduled (FSRS reschedule) | no |

Rows with ease 0, rows whose card no longer exists, and rows whose note is
not in the deck files are also skipped. The summary counts each reason. The
importer refuses a collection on Anki's v1 scheduler, where ease 3 in
learning meant Easy.

### `reference.json`

For each card key: the Anki card ID, deck, state (new, learning, review or
relearning), suspended and buried flags, interval, reps and lapses, and the
**due date**. With FSRS on, it also has `cards.data`: stability,
difficulty, desired retention, decay and last review time.

It also has Anki's **FSRS parameters**, since replaying a card needs the
parameters it was scheduled with:

```json
"deckConfigs": { "1": { "name": "Default", "fsrs": { "version": 6, "params": [0.212, …], "desiredRetention": 0.9 } } },
"decks": { "Cka::Storage": { "config": 1 }, "Cram": { "config": null } }
```

- `deckConfigs` is every deck options preset, decoded from the protobuf in
  `deck_config.config` (`protobuf.ts`, `deck-config.ts`). `version` is the
  newest of `fsrs_params_6`, `_5`, `_4` that has parameters, which is the one
  Anki uses. `version: null` with no `params` means the preset was never
  optimised, so Anki schedules with the built-in defaults of its FSRS version,
  which the collection does not record. Floats are written as the shortest
  decimal of the stored float32 (`0.9`, not `0.8999999761581421`).
- `decks` is each deck's preset, from `decks.kind`, plus `desiredRetention`
  where the deck overrides its preset's. Filtered decks have `config: null`;
  their cards schedule by their home deck's.

How `due` is read depends on the queue:

- **Review and interday-learning cards** store a day number, counted from
  day 0. Day 0 is the local date of `col.crt` minus the rollover hour (4 a.m.
  by default). The due date is day 0 plus the number.
- **Intraday learning cards** store epoch seconds. These get `dueAt` (ISO)
  and their local date.
- **New cards** store a queue position, which is given as `newPosition`
  (`due` is null).
- **Cards in a filtered deck** keep their real due date in `odue`, which is
  used instead.

## Markdown dialect

ankictl renders deck Markdown with markdown-it (CommonMark plus tables).
Hashcards renders it with marked (GFM, `breaks: false`). They mostly agree:

- **Trailing `\` line breaks** are hard breaks in both, so they are kept as
  they are. ankictl's decks use them on nearly every multi-line answer.
- **`~` strikethrough.** GFM strikes `~x~` and `~~x~~` through, and
  CommonMark never does. The importer asks marked; when a field would be
  struck through, every tilde outside code is escaped. The CKA decks' `~1 min`
  and `~2 billion` are not affected.
- **Literal `[` and `]` in cloze text** are escaped as `\[` / `\]`, because
  the hashcards cloze scanner treats every bracket as a deletion, even inside
  code spans. `` `rules[].host` `` becomes `` `rules\[\].host` `` and renders
  the same.
- **A line that is exactly `---`** would end the card. After a blank line it
  becomes `***`, the same horizontal rule. After text it is a setext heading,
  which is flagged.
- **A line starting `Q:`, `A:`, `C:` or `Extra:`** inside a field would start
  a new card or section. It is flagged.
- **`$…$`** that hashcards would typeset as maths is flagged. Shell
  `$(…)` inside code spans is safe, because KaTeX skips `<code>`.
- **GFM autolinks** (`www.x.io`, `https://…` in prose) become links in
  hashcards where they were text in Anki. This is harmless and not changed.

## What is lossy

- **Cloze hints** (`{{c1::x::hint}}`): hashcards has no hints, so they are
  dropped with a warning.
- **A c-number used twice** (`{{c1::a}} … {{c1::b}}`): Anki makes one card
  that hides both. Hashcards makes one card per bracket, so the second
  bracket becomes a new card with no history. Anki's c1 history goes to the
  first one. Flagged, not silently merged.
- **Nested clozes**: inner markers are flattened to text, and the inner card is
  lost. Flagged.
- **Anki tags that do not fit the tag pattern** (`c++`, `a.b`, non-ASCII)
  are dropped with a warning. The CKA decks have none.
- **Per-card suspension inside a cloze note**: `Status:` applies to the whole
  note, so a partly suspended note stays active and is flagged.
- **Anki-only tags** (for example `leech`, which Anki adds itself, or tags
  added in the GUI and never pulled) are listed but not imported. The deck
  files own tags.
- **Reviews of deleted cards**: `revlog` outlives its cards, but there is no
  card → note → key link once the card is gone. These rows are counted in the
  summary (`card deleted from collection`) and written nowhere: no event, no
  reference entry.
- **Anki's day boundary** is the rollover hour (4 a.m.). Hashcards' days are
  local calendar days. A review between midnight and 4 a.m. counts as the
  previous day in Anki and as that day in hashcards. This matters only for
  same-day rules, not for the events.
- **Review time zone** is assumed, not recorded. A review done while travelling
  outside `--tz` gets the wrong `tz`, though its `at` (UTC) is still exact.

## How it reads the collection

`node:sqlite` cannot register Anki's custom `unicase` collation. Without it,
SQLite cannot even scan `fields`, `notetypes` or `decks`. So the copy is
opened read-only and serialised into memory. In memory, the WAL flag is
cleared from the header and `COLLATE unicase` is rewritten to `nocase` in the
schema. The file itself is never written. The importer only full-scans, so
the collation swap cannot change a result.

## Tests

```bash
npx vitest run cli/anki cli/commands/import-anki.test.ts
```

The test files:

- `convert.test.ts`: cloze conversion, checked against the app's own parser;
  IDs and slugs; tags, checked against the parser's normalisation; deck paths and names; and the Markdown dialect, checked
  against marked.
- `revlog.test.ts`: the type and ease mapping, the time cap, `tz` across both
  2026 DST switches, local months, and Anki due dates.
- `protobuf.test.ts` and `deck-config.test.ts`: the wire-format reader and
  the FSRS preset and deck-kind decoders, on synthetic blobs built with
  `protobuf-writer.ts`.
- `importer.test.ts`: the whole pipeline over a synthetic collection built
  with `node:sqlite`. The collection is in WAL mode with a `unicase` schema,
  and has one revlog row for every skip reason, and protobuf deck and preset
  blobs (`test-collection.ts`). The generated deck file is parsed with
  `src/parser.ts`.
- `parity.test.ts`: both parity measures.
- `cli/commands/import-anki.test.ts`: the command on real git repos: dry run,
  both commits, `--dir`, re-import, refusals (including a path in `Anki2`).
