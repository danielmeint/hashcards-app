# Hashcards Card Format Specification

Version 2

## Overview

Hashcards decks are plain Markdown files (`.md`) in a git repository. Each file
is a **deck**, and each deck holds **card blocks**: a basic card (`Q:` / `A:`)
or a cloze card (`C:`), optionally preceded by **metadata lines** that give the
card tags and a status, and optionally followed by an **`Extra:`** note shown
after the answer. **A card is its text**: there are no IDs to write or keep
unique (see [Card keys](#card-keys)).

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
Extra: A rollout creates a new ReplicaSet and scales the old one down.
```

People, scripts and agents all write these files. Agents that would rather
emit structured data can use the JSON Schema in
[`schema/card.schema.json`](schema/card.schema.json) (see
[Structured cards](#structured-cards-json-schema)).

## What changed from version 1

| Version 1 | Version 2 |
|---|---|
| A card is the SHA-256 of its exact text: reflowing a paragraph makes a new card. | A card is still its text, hashed after **normalising whitespace**. Edits made in the app keep their history; edits made elsewhere can be [linked](#edits-and-history). |
| Nothing but `Q:` / `A:` / `C:` in a block. | **Metadata lines** (`Tags:`, `Reverse:`, `Status:`) may open a block. |
| Frontmatter knows only `name`. | Frontmatter also takes **`tags`**. |
| Every card is scheduled. | Cards can be **drafts** (waiting to be accepted) or **suspended**. |
| A reverse card means writing the card twice. | **`Reverse: yes`** schedules the answer→question card too. |
| Notes about a card go in the answer or nowhere. | An optional **`Extra:`** section, shown only after reveal, outside the card's identity. |
| Tags are free text. | Tags are **normalised** (`CKA::Workloads` → `cka/workloads`) and checked. |

Every version 1 file is a valid version 2 file, with the same cards. Their keys
change once, since the hash now normalises whitespace; `hc migrate` carries
version 1 history over to the new keys.

## File Structure

```
collection/
  DeckA.md
  DeckB.md
  subfolder/
    DeckC.md
  macros.tex          # optional: KaTeX macro definitions
  images/
    diagram.png
  audio/
    clip.mp3
```

Every `.md` file is a deck, except documentation such as `README.md` and
`AGENTS.md`. A `hashcards.toml` at the root can say exactly which files are
decks with `include` and `exclude` globs (see the
[README](README.md#how-it-works)). Non-`.md` files are ignored by the parser
but may be referenced as media.

## Frontmatter (Optional)

A deck file may begin with TOML frontmatter enclosed by `---` fences:

```
---
name = "Custom Deck Name"
tags = ["geo", "europe"]
---
```

- `name` (string): overrides the deck name derived from the file name.
- `tags` (array of strings, on one line): every card in the file carries these
  tags, before any of its own. They are normalised and checked like a card's
  [`Tags:`](#tags).
- The opening `---` must be the very first line of the file, and the closing
  `---` must appear on its own line.
- Other keys are ignored.

If there is no frontmatter, or `name` is not set, the deck name is the file
name without its extension (`Geography.md` → "Geography"). Several files can
share one deck name, which is useful for splitting a large subject across files
(`Ch1.md`, `Ch2.md`, … all with `name = "Textbook"`).

## Card Blocks

A **block** is one card's worth of lines: optional metadata lines, then a `Q:`
line with its `A:`, or a `C:` line, then an optional [`Extra:`](#extra-section)
line, and every line after them up to the next card. Blocks are separated by `---` on a line of its own:

```
C: A semigroup with an identity element is called a [monoid].

---

C: A magma where the operation is [associative] is called a [semigroup].
```

A new `Q:` or `C:` also ends the card before it, without a `---`. That still
works, but such a card has no block top for metadata to go on (see below), so
**use `---` between cards**.

Blank lines between blocks, and between metadata lines and the card, are fine.

## Metadata Lines

Metadata lines come **first in a block, before `Q:` or `C:`**. A line is
metadata when it is at the top of a block and matches
`^(Tags|Reverse|Status):`. The top of a block is the start of the file
(after any frontmatter) or the line after a `---`.

**Once `Q:`, `A:` or `C:` has started, nothing is metadata.** An answer can say
`Status: Running` and mean it. The same goes for a line between two
cards that are not separated by `---`: it belongs to the card above.

Each key may appear at most once per block, in any order. Values are trimmed.

### Legacy `ID:`

Files written by early 1.0 builds open their blocks with an `ID:` line
(`ID: est-capital`, 2–64 characters of `a-z`, `0-9` and `-`). It is still
read, so those files keep parsing, but it is not part of the card: it only
tells tools which key the card's history was filed under then (`<id>`,
`<id>:r` for its reverse, `<id>:<n>` for cloze deletion *n*), and until it is
gone that history is read as the card's. `hc lint` warns about it, and
`hc migrate` removes it and writes the [links](#edits-and-history) for real.
Write no new ones.

### `Tags:`

```
Tags: capitals, baltic
```

Comma-separated. A card's tags are the file's frontmatter `tags`, then its
own. Each tag is **normalised** as it is read:

1. Surrounding whitespace is trimmed, and an empty entry is dropped.
2. It is lowercased.
3. `::` becomes `/` (Anki's hierarchy separator, so imported tags keep their levels).
4. Each run of whitespace becomes `-`.
5. Leading and trailing `/` are removed.

The result must then match

```
^[a-z0-9][a-z0-9_-]*(/[a-z0-9][a-z0-9_-]*)*$
```

that is, levels of lowercase letters, digits, `_` and `-`, each starting with a
letter or digit, separated by `/`. Anything else (`c++`, `a.b`, `a//b`, `ä`) is
an error. Finally, repeats are removed, including two spellings of one tag:

```
Tags: CKA::Type::Syntax Pattern, cka/type/syntax-pattern, Lists
```

gives the tags `cka/type/syntax-pattern` and `lists`. Write tags in their
normalised form; the normalising is there so other spellings still mean the
same tag, not as a style to rely on.

### `Reverse:`

```
Reverse: yes
```

`yes` or `no` (the default). On a basic card, `yes` also produces the reverse
card, with question and answer swapped, scheduled independently. A cloze card
cannot be reversed; `Reverse: yes` on one is an error.

### `Status:`

```
Status: draft
```

| Value | Meaning |
|---|---|
| *(absent)* | **Active**: scheduled normally. |
| `draft` | Proposed, not scheduled. Shown in the app's Inbox to accept or discard. Agents should normally write drafts. |
| `suspended` | Kept, with its history, but not scheduled. |

Any other value is an error. There is no `Status: active`; active is written
by leaving the line out.

## Card Types

### Basic Cards (Q/A)

A basic card has a question and an answer, introduced by `Q:` and `A:` at the
start of a line:

```
Q: What is the capital of France?
A: Paris
```

Both sides can span multiple lines. Everything after the tag until the next
card boundary (another tag, a separator, or end of file) belongs to that side:

```
Q: List the platinum group metals.
A:

- ruthenium
- rhodium
- palladium
- osmium
- iridium
- platinum
```

**Rules:**
- `Q:` must be followed by a matching `A:` before any other card begins.
- `A:` without a preceding `Q:` is an error.
- A `Q:` while reading a question (before `A:`) is an error.
- Leading and trailing whitespace on the question and answer is trimmed.

### Cloze Cards

A cloze card is one body of text with one or more **cloze deletions** marked by
square brackets `[...]`, introduced by `C:`:

```
C: An [agonist] is a ligand that binds to a receptor and [activates it].
```

Each deletion is a **separate card**, with its own [key](#card-keys). The
block above makes two: one hiding "agonist", one hiding "activates it".

Cloze cards can span multiple lines:

```
C:
Better is the sight of the eyes than the wandering of the
desire: this is also vanity and vexation of spirit.

— [Ecclesiastes] [6]:[9]
```

**Rules:**
- A `C:` card must contain at least one `[...]` deletion.
- Leading and trailing whitespace on the cloze text is trimmed.
- Brackets inside image syntax `![](...)` are **not** deletions.
- Escaped brackets `\[` and `\]` are literal brackets, not deletions. The
  backslash is consumed.

### Cloze Tables

Cloze deletions work inside Markdown tables:

```
C: Truth table for OR:

| $A$ | $B$ | $A \lor B$ |
| --- | --- | ---------- |
| F   | F   | [F]        |
| F   | T   | [T]        |
| T   | F   | [T]        |
| T   | T   | [T]        |
```

### Extra section

Either card type may end with an **`Extra:`** section: a note shown only once
the answer is revealed, such as context, a mnemonic or a pointer to the docs.
It is never part of the question, and a cloze card's note is hidden with its
deletions, so it cannot give them away.

```
Q: What is the capital of Estonia?
A: Tallinn
Extra: Called *Reval* until 1918.

---

C: Change a Deployment's image: `kubectl` [set image] `deploy/web` [nginx=nginx:1.27]
Extra:
The container name comes before `=`.

See `kubectl set image --help`.
```

`Extra:` works like `A:`: it starts at the beginning of a line, its text may
start on the same line or the next, and it runs over any number of lines to the
next card boundary. It is Markdown, trimmed like the other sides.

**Rules:**
- `Extra:` comes after the `A:` of a basic card or after the `C:` text of a
  cloze card. Before either, including among the metadata lines, it is an
  error.
- At most one `Extra:` per card.
- An `Extra:` with nothing after it is an error.
- A reverse card (`Reverse: yes`) carries the same extra, and so does every
  deletion of a cloze block.
- **Extra is not part of the card's identity.** It never enters the
  [key](#card-keys): adding, rewording or removing it keeps the card's
  history.

## Content Features

### Markdown

Card text is rendered as GitHub-flavored Markdown: **bold**, *italics*,
~~strikethrough~~, lists, code spans and fenced code blocks (with syntax
highlighting), tables, and links (rendered but not interactive during review).

### LaTeX Math

Inline math uses `$...$` and display math uses `$$...$$`:

```
Q: What is the combinatorial meaning of $\binom{n}{k}$?
A: From a set of size $n$, we can choose $\binom{n}{k}$ subsets of size $k$.
```

**Custom macros:** a `macros.tex` file at the collection root defines KaTeX
macros, one per line:

```
\R \mathbb{R}
\euler e^{i \pi} + 1
```

Macros may use positional arguments (`#1`, `#2`, etc.).

### Images

Standard Markdown image syntax:

```
Q: Identify this painting:

![](art/thesiren.jpg)

A: _The Siren_, by John William Waterhouse.
```

- **Relative paths** (`art/diagram.png`) resolve relative to the deck file's
  directory.
- **Collection-root paths** prefixed with `@/` (`@/images/photo.webp`) resolve
  relative to the repository root.

### Audio

Same syntax as images; the file extension decides between an audio player and
an image:

```
Q: How do you pronounce "پرنده" in Persian?
A: ![](audio/parande.mp3)
```

## Card Keys

A **key** names one schedulable card: it is what the review log refers to.
A card is its text, so its key is a hash of its text:

| Card | Key |
|---|---|
| Any card | `h:<first 16 hex digits of its identity hash>` |
| A card from a subscribed collection, as recorded in *your* log | `<owner>/<repo>/h:<…>` |

`Q: What is the capital of Estonia?` / `A: Tallinn` is `h:0adbdf261f9947fc`,
written on one line or on three, with any indentation.

### Identity hashes

Text is first **normalised**: every run of whitespace (spaces, tabs, newlines)
becomes one space, and the ends are trimmed. The parts below are joined with a
NUL byte (`\0`); strings are UTF-8.

| Card | Hashed |
|---|---|
| Basic | `SHA-256("basic" \0 question \0 answer)` |
| Its reverse | the same with the sides swapped: it is the card it would be if written out by hand |
| Cloze deletion | `SHA-256("cloze" \0 before \0 deleted \0 after)` |

For a cloze deletion, `before`, `deleted` and `after` split the block's text at
that deletion, with **every** deletion bracket removed (see
[Bracket processing](#bracket-processing-for-clean-text)): `C: Foo [bar] baz
[quux].` gives `"Foo "`, `"bar"`, `" baz quux."` for its first card. So
bracketing another word of the sentence, or un-bracketing one, leaves the other
deletions the cards they were.

**What is not part of a card:** metadata lines, the `Extra:` section, the deck,
the file, and where in the file the card is. Moving a card, retagging it,
suspending it or rewriting its note keeps its history.

**Siblings** are buried together in a review: a basic card and its reverse
share the forward card's hash as their family, and the deletions of one cloze
block share `SHA-256("cloze" \0 text without brackets)`.

### Edits and history

Rewording a card makes it a new card, with a new key. Its history stays under
the old key: **nothing is ever deleted from the log**, so writing the old text
back brings the history back with it, and re-adding a deleted card picks its
history up again.

To carry history over an edit, the log gets a **link**: an event saying the
card now keyed `card` used to be `from`. Every event of `from` then counts as
one of `card`, transitively; when two links would form a cycle (a relink
undone), the later one wins. The Estonia card above, after its answer was
changed to `**Tallinn**` in the app:

```json
{"v":2,"kind":"link","card":"h:520e371e59f5a9c3","from":"h:0adbdf261f9947fc","at":"2026-10-16T09:12:03.120Z","tz":120,"src":"edit"}
```

- **Edits made in the app** write a link for every card whose text changed,
  pairing old and new by position in the block. Nothing to do.
- **Edits made anywhere else** (GitHub, an editor, an agent) start the card
  fresh, unless someone links it: `hc relink` compares the decks with an
  earlier revision, proposes the pairs, and with `--apply` commits the links.
  `hc relink <old-key> <file:line>` links one pair by hand. It can be done any
  time later: the old history is still there.

The same text twice in one collection is one card with one schedule. The
parser keeps the first of two in one file; `hc lint` warns about both cases.

### Where reviews of a key are kept

Reviews live on the repo's orphan `hashcards-data` branch, one file per
writer per month: `reviews/YYYY-MM.<writer>.jsonl`. A device's writer name is
eight hex digits. Three names are reserved for tools that write history on the
collection's behalf, so that no device ever treats their files as its own:

| Writer | Written by | Holds |
|---|---|---|
| `v1` | `hc migrate` | the v1 state file as `baseline` events, and the v1 review logs, re-keyed |
| `anki` | `hc import anki` | an Anki collection's review log, `src: "anki"` |
| `hc` | `hc migrate`, `hc relink` | `link` events |

A writer rewrites its own files whole and nobody else's. Two rules keep that
safe when devices do not know each other's latest state:

- **The same line is one event.** A line found in two files, or twice in one,
  is applied and counted once. Two different reviews cannot serialise to the
  same line: it would take the same card, grade, duration and millisecond.
- **A device that finds a line under its name that it did not write takes a
  new name.** That happens to a browser restored from a backup or copied with
  its profile, and to one that lost its local log but kept its name. The old
  files are then read like any other device's and never written again, so no
  review is overwritten. Reviews the device had already pushed are written
  again under the new name, and the first rule counts them once.

Reviews are dated by the server's clock, not the device's. The app measures
the difference on every sync and corrects by it, offline too, because review
order and the gaps between reviews are what the schedule is computed from.

### Version 1 hashes

Version 1 keyed cards by a different hash, which logs written by version 1
still use. It is computed for every card (no normalising, no separators) so
that `hc migrate` and an unmigrated collection can map those logs to keys:

```
SHA-256("Basic" + question + answer)
SHA-256("Cloze" + cleanText + start_u64le + end_u64le)
```

`start_u64le` and `end_u64le` are the byte offsets of the deletion's first and
last byte in `cleanText`, inclusive, as little-endian unsigned 64-bit
integers.

### Bracket Processing for Clean Text

1. Scan the raw cloze text byte by byte.
2. `[`: if not inside an image (`![`) and not escaped (`\[`), skip it (open).
3. `]`: if not inside an image and not escaped, skip it (close).
4. `![`: enter image mode; brackets inside images are kept literally.
5. `\[` or `\]`: the backslash is consumed and the bracket kept literally.
6. All other bytes pass through unchanged.

## Parsing State Machine

The parser is a line-by-line state machine. Metadata lines are only recognised
in **Start**; in every other state they are text.

| State | On metadata | On `Q:` | On `A:` | On `C:` | On `Extra:` | On `---` | On text | On EOF |
|---|---|---|---|---|---|---|---|---|
| **Start** | Record it | → ReadingQuestion | Error | → ReadingCloze | Error | Stay (error after metadata) | Stay (error after metadata, unless blank) | End (error after metadata) |
| **ReadingQuestion** | *(text)* | Error | → ReadingAnswer | Error | Error | Error | Append to question | Error |
| **ReadingAnswer** | *(text)* | Emit card, → ReadingQuestion | Error | Emit card, → ReadingCloze | Start extra (error if started) | Emit card, → Start | Append to extra if started, else answer | Emit card, End |
| **ReadingCloze** | *(text)* | Emit card, → ReadingQuestion | Error | Emit card, → ReadingCloze | Start extra (error if started) | Emit card, → Start | Append to extra if started, else text | Emit card, End |

- "Emit card" adds the completed block (basic, plus its reverse; or every
  deletion of a cloze) to the output, with the metadata recorded in Start.
- A card's line range runs from its first metadata line (or its `Q:` / `C:`
  line) to its last non-blank line.
- "Error" throws with the file path and the line number, 1-based and counting
  the frontmatter.

## Error Conditions

| Condition | Error |
|---|---|
| `A:` without preceding `Q:` | "Found answer tag without a question" |
| `Q:` while reading a question | "New question without answer" |
| `C:` while reading a question | "Found cloze tag while reading a question" |
| `---` while reading a question | "Found flashcard separator while reading a question" |
| EOF while reading a question | "File ended while reading a question without an answer" |
| `A:` while reading an answer | "Found answer tag while reading an answer" |
| `A:` while reading a cloze | "Found answer tag while reading a cloze card" |
| `C:` with no `[...]` deletions | "Cloze card must contain at least one cloze deletion" |
| `Extra:` before any card, or among metadata | "Found Extra: without a card before it" |
| `Extra:` while reading a question | "Found Extra: before the card's A: line" |
| A second `Extra:` in one card | "A card can only have one Extra: section" |
| `Extra:` with nothing after it | "Found Extra: with nothing after it" |
| A tag that does not normalise to the tag pattern | "Invalid tag" |
| Unclosed frontmatter `---` | "Frontmatter opening '---' found but no closing '---'" |
| Frontmatter `tags` not a one-line array of strings | "Frontmatter tags must be a TOML array of strings on one line" |
| A legacy `ID:` not matching its pattern | "Invalid card ID" |
| A metadata key twice in one block | "A card can only have one 'Key:' line" |
| `Reverse:` other than `yes` / `no` | "Reverse must be 'yes' or 'no'" |
| `Reverse: yes` on a cloze card | "a cloze card cannot be reversed" |
| `Status:` other than `draft` / `suspended` | "Status must be 'draft' or 'suspended'" |
| Metadata followed by `---` or end of file | "Found metadata with no card after it" |
| Non-blank text between metadata and `Q:` / `C:` | "Found text between a card's metadata and its Q: or C: line" |

## Structured Cards (JSON Schema)

[`schema/card.schema.json`](schema/card.schema.json) (JSON Schema draft
2020-12) describes one card as JSON, for agents and scripts that emit data
rather than Markdown:

```json
{
  "file": "geography/europe/Europe_Nordic_Baltic.md",
  "type": "basic",
  "tags": ["capitals"],
  "question": "What is the capital of Estonia?",
  "answer": "Tallinn",
  "status": "draft"
}
```

| Field | Required | Written as |
|---|---|---|
| `file` | yes | The deck file the block is appended to, relative to the collection root. |
| `type` | yes | `basic` (with `question` and `answer`) or `cloze` (with `text`). |
| `question`, `answer` | basic | `Q: …` and `A: …` |
| `text` | cloze | `C: …`, deletions in `[brackets]` |
| `extra` | no | `Extra: …`, after the card |
| `tags` | no | `Tags: a, b`, already [normalised](#tags) |
| `reverse` | no, basic only | `Reverse: yes` when `true` |
| `status` | no | `Status: draft` / `Status: suspended`; `active` writes no line |

A block is written as its metadata lines, then the card, then its `Extra:`,
separated from the cards before it by `---`. The schema also rejects text the
parser would split: a line after the first that starts with `Q:`, `A:`, `C:` or
`Extra:`, or that is a `---` separator. The parser remains the authority; a card that
validates against the schema and fails to parse is a bug in the schema.

## Complete Example

```markdown
---
name = "Chemistry"
tags = ["science"]
---

Q: What is Avogadro's number?
A: $6.022 \times 10^{23}$

---

Tags: lists
Q: List the noble gases.
A:

- Helium
- Neon
- Argon
- Krypton
- Xenon
- Radon
- Oganesson

---

C: Water has the chemical formula [H₂O] and a molar mass of approximately [18.015 g/mol].
Extra: 2 × 1.008 (H) + 15.999 (O).

---

Status: suspended
C: The pH scale ranges from [0] to [14], with [7] being neutral.

---

Reverse: yes
Q: Identify this molecular structure:

![](images/benzene.png)

A: Benzene ($\text{C}_6\text{H}_6$)

---

Status: draft
Q: What is the SI unit of amount of substance?
A: The mole
```

This file produces, each card keyed `h:…`:

| Cards | Kind | Tags | Status |
|---|---|---|---|
| 1 | basic | science | active |
| 1 | basic | science, lists | active |
| 2 | cloze, with an extra | science | active |
| 3 | cloze | science | suspended |
| 2 | basic and its reverse | science | active |
| 1 | basic | science | draft |

**10 cards** in all, of which 6 are scheduled.
