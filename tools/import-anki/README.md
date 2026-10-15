# import-anki

Prototype of `hc import anki` (PLAN-1.0.md, M6). It turns an
ankictl deck repo (`~/projects/personal/ankictl`) plus a **copy** of the Anki collection
into hashcards v2 deck files, v2 review events and a reference snapshot of
Anki's scheduling state.

It reads only. It writes only into `--out`.

## Usage

```bash
# 1. Copy the collection. Never point the tool at the live file. It refuses
#    any path inside an `Anki2` directory.
mkdir -p /tmp/anki-copy
cp ~/Library/Application\ Support/Anki2/User\ 1/collection.anki2* /tmp/anki-copy/

# 2. Import.
node tools/import-anki/import-anki.ts \
  --decks ~/projects/personal/anki-decks \
  --collection /tmp/anki-copy/collection.anki2 \
  --out tools/import-anki/out \
  --acronym CKA
```

| Option | Default | |
|---|---|---|
| `--decks` | (required) | ankictl repo: `ankictl.yaml` plus `decks/**/*.yaml` |
| `--collection` | (required) | a copy of `collection.anki2` (and `-wal`/`-shm`, if present) |
| `--out` | (required) | must be missing, empty, or an earlier output of this tool (it carries `.import-anki-output`, and is cleared and rewritten) |
| `--tz` | `Europe/Berlin` | IANA zone the reviews happened in |
| `--max-ms` | `60000` | cap on one review's `ms` |
| `--acronym` | none | repeatable; writes the word in this case in deck names (`Cka` → `CKA`) |
| `--json` | off | print the summary as JSON |

`tools/import-anki/out/` is git-ignored. The output is deterministic, so two
runs over the same inputs are byte-identical.

### Output

```
out/
├── cka/workloads-and-scheduling.md   deck files     → main branch of the card repo
├── reviews/2026-09.anki.jsonl        review events  → hashcards-data branch
├── reference.json                    Anki's state per card key, for M6's parity check
└── import-report.json                summary, ID changes, cloze maps, warnings
```

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

## Folding into `hc import anki` (M5)

- `convert.ts`, `revlog.ts`, `decks.ts`, `collection.ts` and `importer.ts`
  move into `src/core/import/anki/` (or `cli/`) unchanged. They are
  platform-neutral apart from `node:sqlite` and `node:fs` in `collection.ts`
  and `decks.ts`, which are CLI-only anyway.
- The card types, the ID regex and the event type are replaced by M1's
  parser and M2's `src/core/events.ts` (serialiser, `src` field). The local
  `ID_PATTERN`, `TAG_PATTERN`, `ReviewEvent` and `renderDeck` exist only because those
  milestones have not landed yet.
- The CLI wrapper becomes `hc import anki --decks … --collection … --out …`.
  Writing into a repo stays out of scope: the output is reviewed and
  committed by hand. `reviews/` goes to the `hashcards-data` branch and the
  deck files to `main`.
- The parity check (M6 exit criterion) replays the imported events with M2's
  replay and compares each key's due date with `reference.json`.

## Tests

```bash
npx vitest run tools/import-anki
```

There are three test files:

- `convert.test.ts`: cloze conversion, checked against the app's own parser;
  IDs and slugs; tags, checked against the parser's normalisation; deck paths and names; and the Markdown dialect, checked
  against marked.
- `revlog.test.ts`: the type and ease mapping, the time cap, `tz` across both
  2026 DST switches, local months, and Anki due dates.
- `importer.test.ts`: the whole pipeline over a synthetic collection built
  with `node:sqlite`. The collection is in WAL mode with a `unicase` schema,
  and has one revlog row for every skip reason. The generated deck file is parsed with `src/parser.ts`.
