# Hashcards Card Format Specification

Version 2

## Overview

Hashcards decks are plain Markdown files (`.md`) in a git repository. Each file
is a **deck**, and each deck holds **card blocks**: a basic card (`Q:` / `A:`)
or a cloze card (`C:`), optionally preceded by **metadata lines** that give the
card a stable ID, tags and a status, and optionally followed by an **`Extra:`**
note shown after the answer.

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
Extra: A rollout creates a new ReplicaSet and scales the old one down.
```

People, scripts and agents all write these files. Agents that would rather
emit structured data can use the JSON Schema in
[`schema/card.schema.json`](schema/card.schema.json) (see
[Structured cards](#structured-cards-json-schema)).

## What changed from version 1

| Version 1 | Version 2 |
|---|---|
| A card *is* the SHA-256 of its text. Fixing a typo makes a new card and strands the old one's history. | A card has an **`ID:`** written in the file. Editing, moving or rewording it keeps its history. |
| Nothing but `Q:` / `A:` / `C:` in a block. | **Metadata lines** (`ID:`, `Tags:`, `Reverse:`, `Status:`) may open a block. |
| Frontmatter knows only `name`. | Frontmatter also takes **`tags`**. |
| Every card is scheduled. | Cards can be **drafts** (waiting to be accepted) or **suspended**. |
| A reverse card means writing the card twice. | **`Reverse: yes`** schedules the answer→question card too. |
| Cloze siblings share a "family hash". | Cloze siblings share an ID: `<id>:1`, `<id>:2`, … |
| Notes about a card go in the answer or nowhere. | An optional **`Extra:`** section, shown only after reveal, outside the card's identity. |
| Tags are free text. | Tags are **normalised** (`CKA::Workloads` → `cka/workloads`) and checked. |

Every version 1 file is a valid version 2 file. Its cards have no IDs, so they
are keyed by their content hash exactly as before, until IDs are stamped in
(see [Stamping IDs](#stamping-ids)). Adding metadata to a card never changes
its content hash.

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

All `.md` files in the repository are parsed as decks. Non-`.md` files are
ignored by the parser but may be referenced as media.

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
ID: monoid
C: A semigroup with an identity element is called a [monoid].

---

ID: semigroup
C: A magma where the operation is [associative] is called a [semigroup].
```

A new `Q:` or `C:` also ends the card before it, without a `---`. That still
works, but such a card has no block top for metadata to go on (see below), so
**use `---` between cards**. Stamping IDs inserts one where it is missing.

Blank lines between blocks, and between metadata lines and the card, are fine.

## Metadata Lines

Metadata lines come **first in a block, before `Q:` or `C:`**. A line is
metadata when it is at the top of a block and matches
`^(ID|Tags|Reverse|Status):`. The top of a block is the start of the file
(after any frontmatter) or the line after a `---`.

**Once `Q:`, `A:` or `C:` has started, nothing is metadata.** An answer can say
`Status: Running` or `ID: 42` and mean it. The same goes for a line between two
cards that are not separated by `---`: it belongs to the card above.

Each key may appear at most once per block, in any order. Values are trimmed.

### `ID:`

```
ID: est-capital
```

The card's stable identity. It must match

```
[a-z0-9][a-z0-9-]{1,63}
```

that is, 2–64 characters of lowercase letters, digits and `-`, not starting
with `-`. IDs can never contain `:` or `/`, which is what lets [keys](#card-keys)
be split unambiguously.

- **Unique within the collection.** The parser rejects the same ID twice in one
  file. Uniqueness across files is checked by tooling that reads the whole
  collection (`hc lint`).
- **Optional.** A card without an ID is valid and is keyed by its content hash.
  Tools treat a missing ID as a warning, not an error, and can stamp one in.
- **Pick a slug** when a card has an obvious name (`cka-wl-set-image`).
  Otherwise let a tool generate one: 8 characters of lowercase Crockford base32
  (`0-9` and `a-z` without `i`, `l`, `o`, `u`), such as `k8q2xv7m`.
- **Never reuse an ID** for a different card. Review history follows the ID,
  and is never deleted with the card: re-adding a deleted ID picks its history
  back up.

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

Each deletion is a **separate card**. The block above makes two: one hiding
"agonist", one hiding "activates it". They are numbered 1, 2, … in order of
appearance, which is how their [keys](#card-keys) tell them apart.

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
ID: est-capital
Q: What is the capital of Estonia?
A: Tallinn
Extra: Called *Reval* until 1918.

---

ID: cka-wl-set-image
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
  [content hash](#content-hashes) or the [key](#card-keys): adding, rewording
  or removing it keeps the card's history.

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

A **key** names one schedulable card. It is what the review log refers to, so
it must survive edits. One ID can name several cards, so the key says which:

| Card | Key |
|---|---|
| Basic | `<id>` |
| Its reverse | `<id>:r` |
| Cloze deletion *n* (1-based, in order of appearance) | `<id>:<n>` |
| A card with no ID | `h:<first 16 hex digits of its content hash>` |
| A card from a subscribed collection, as recorded in *your* log | `<owner>/<repo>/<key>` |

Examples: `est-capital`, `k8q2xv7m:r`, `k3n9wq2p:2`, `h:3f9a0c41d2b7e865`,
`someone/cards/est-capital`.

Since IDs contain neither `:` nor `/` and are at least two characters long, a
key always parses one way, and `h:` can never be an ID. All deletions of one
cloze block are `<id>:*`, which is how siblings are recognised.

Adding a deletion to a cloze block, or reordering its deletions, renumbers the
ones after it. Prefer appending deletions, or splitting a block that keeps
growing.

## Stamping IDs

Stamping adds an `ID:` line with a generated ID to the top of every block that
has none. It changes **nothing else**: frontmatter, blank lines, line endings
(LF or CRLF) and the trailing newline stay byte for byte as they were, and
existing IDs are kept. Generated IDs never collide with IDs already in the
file. A card that follows the previous one without a `---` gets one inserted
above its `ID:` line, since otherwise the ID would be part of the previous
card's answer.

Stamping is idempotent, and changes no card's content hash. Before:

```
Q: What is the capital of Estonia?
A: Tallinn

---

Tags: capitals
C: The capital of [Norway] is [Oslo].
```

After:

```
ID: m3x9p2qa
Q: What is the capital of Estonia?
A: Tallinn

---

ID: 7hc0wd5n
Tags: capitals
C: The capital of [Norway] is [Oslo].
```

## Content Hashes

Every card also has a SHA-256 content hash, as in version 1. It is no longer a
card's identity once the card has an ID, but it still keys cards without one
(`h:` keys) and maps version 1 review history onto IDs. **Metadata lines and
the `Extra:` section never enter the hash.**

`+` below is byte concatenation with no separator; strings are UTF-8.

### Basic Card Hash

```
SHA-256("Basic" + question + answer)
```

A reverse card is hashed as the basic card it is, with the sides swapped:
`SHA-256("Basic" + answer + question)`.

### Cloze Card Hash

```
SHA-256("Cloze" + cleanText + start_u64le + end_u64le)
```

- `cleanText`: the cloze text with every deletion bracket removed (contents
  kept).
- `start_u64le`, `end_u64le`: the **byte offsets** (not character offsets) of
  the deletion's first and last byte in `cleanText`, inclusive, as
  little-endian unsigned 64-bit integers.

Given `C: Foo [bar] baz [quux].`, the clean text is `"Foo bar baz quux."`;
card 1 is `start=4, end=6`, card 2 is `start=12, end=15`.

All deletions of one block also share `SHA-256("Cloze" + cleanText)`, the v1
family hash. It is still computed; with IDs, `<id>:*` does the same job.

### Bracket Processing for Clean Text

1. Scan the raw cloze text byte by byte.
2. `[`: if not inside an image (`![`) and not escaped (`\[`), skip it (open).
3. `]`: if not inside an image and not escaped, skip it (close).
4. `![`: enter image mode; brackets inside images are kept literally.
5. `\[` or `\]`: the backslash is consumed and the bracket kept literally.
6. All other bytes pass through unchanged.

## Deduplication

If two cards in the same file have the same content hash, only the first is
kept. That includes a reverse card identical to a card written out by hand.

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
| `ID:` not matching the pattern | "Invalid card ID" |
| The same `ID:` twice in one file | "Duplicate card ID" |
| A metadata key twice in one block | "A card can only have one 'Key:' line" |
| `Reverse:` other than `yes` / `no` | "Reverse must be 'yes' or 'no'" |
| `Reverse: yes` on a cloze card | "a cloze card cannot be reversed" |
| `Status:` other than `draft` / `suspended` | "Status must be 'draft' or 'suspended'" |
| Metadata followed by `---` or end of file | "Found metadata with no card after it" |
| Non-blank text between metadata and `Q:` / `C:` | "Found text between a card's metadata and its Q: or C: line" |

A missing `ID:` is not an error.

## Structured Cards (JSON Schema)

[`schema/card.schema.json`](schema/card.schema.json) (JSON Schema draft
2020-12) describes one card as JSON, for agents and scripts that emit data
rather than Markdown:

```json
{
  "file": "geography/europe/Europe_Nordic_Baltic.md",
  "type": "basic",
  "id": "est-capital",
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
| `id` | no | `ID: …`; stamped if absent |
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

ID: avogadro
Q: What is Avogadro's number?
A: $6.022 \times 10^{23}$

---

ID: noble-gases
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

ID: water
C: Water has the chemical formula [H₂O] and a molar mass of approximately [18.015 g/mol].
Extra: 2 × 1.008 (H) + 15.999 (O).

---

ID: ph-scale
Status: suspended
C: The pH scale ranges from [0] to [14], with [7] being neutral.

---

ID: benzene
Reverse: yes
Q: Identify this molecular structure:

![](images/benzene.png)

A: Benzene ($\text{C}_6\text{H}_6$)

---

Status: draft
Q: What is the SI unit of amount of substance?
A: The mole
```

This file produces:

| Key | Card | Tags | Status |
|---|---|---|---|
| `avogadro` | basic | science | active |
| `noble-gases` | basic | science, lists | active |
| `water:1`, `water:2` | cloze, with an extra | science | active |
| `ph-scale:1` … `ph-scale:3` | cloze | science | suspended |
| `benzene`, `benzene:r` | basic and its reverse | science | active |
| `h:…` | basic, no ID yet | science | draft |

**10 cards** in all, of which 6 are scheduled.
