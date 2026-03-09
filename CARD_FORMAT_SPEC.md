# Hashcards Card Format Specification

Version 1.0

## Overview

Hashcards decks are plain Markdown files (`.md`) containing flashcards. Each file is a **deck**. The deck name defaults to the filename without extension (e.g., `Geography.md` → "Geography") but can be overridden with TOML frontmatter.

Cards are **content-addressed**: each card is identified by the SHA-256 hash of its content. Editing a card's text resets its review history.

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

All `.md` files in the repository are parsed as decks. Non-`.md` files are ignored by the parser but may be referenced as media.

## Frontmatter (Optional)

A deck file may begin with TOML frontmatter enclosed by `---` fences:

```
---
name = "Custom Deck Name"
---
```

- `name` (string): Overrides the deck name derived from the filename.
- The opening `---` must be the very first line of the file.
- The closing `---` must appear on its own line.
- Only the `name` field is recognized.

If no frontmatter is present, or `name` is not set, the deck name is the filename without extension.

**Use case:** Multiple files can share the same deck name, useful for organizing large subjects across files (e.g., `Ch1.md`, `Ch2.md`, ... all with `name = "Textbook"`).

## Card Types

### Basic Cards (Q/A)

A basic card has a question and an answer, introduced by `Q:` and `A:` tags at the start of a line:

```
Q: What is the capital of France?
A: Paris
```

Both sides can span multiple lines. Everything after the tag prefix until the next card boundary (another tag, a separator, or end of file) belongs to that side:

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
- `Q:` must always be followed by a matching `A:` before any other card begins.
- `A:` without a preceding `Q:` is an error.
- A `Q:` appearing while reading a question (before `A:`) is an error.
- Leading/trailing whitespace on question and answer text is trimmed.

### Cloze Cards

A cloze card is a single body of text with one or more **cloze deletions** marked by square brackets `[...]`. It is introduced by the `C:` tag:

```
C: An [agonist] is a ligand that binds to a receptor and [activates it].
```

Each bracketed region produces a **separate card** in the database. The card above generates 2 cards:
1. One that hides "agonist" and shows the rest.
2. One that hides "activates it" and shows the rest.

Cloze cards can span multiple lines:

```
C:
Better is the sight of the eyes than the wandering of the
desire: this is also vanity and vexation of spirit.

— [Ecclesiastes] [6]:[9]
```

**Rules:**
- A `C:` card must contain at least one `[...]` deletion. A cloze card with no deletions is an error.
- Leading/trailing whitespace on the cloze text is trimmed.
- Brackets inside image syntax `![](...)` are **not** treated as cloze deletions.
- Escaped brackets `\[` and `\]` are treated as literal bracket characters, not cloze markers. The backslash is consumed (not included in output).

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

## Card Separators

Cards are separated implicitly by encountering a new tag (`Q:`, `A:`, `C:`) or end of file. Optionally, a `---` horizontal rule can be used as an explicit separator for visual clarity:

```
C: A semigroup with an identity element is called a [monoid].

---

C: A magma where the operation is [associative] is called a [semigroup].
```

**Rules:**
- `---` during a question (between `Q:` and `A:`) is an error.
- `---` during an answer or cloze text finalizes that card and returns to the initial state.
- Multiple blank lines between cards are fine; they are treated as plain text.

## Content Features

### Markdown

Card text is rendered as GitHub-flavored Markdown. All standard Markdown features are supported:

- **Bold**, *italics*, ~~strikethrough~~
- Bullet and numbered lists
- Code spans `` `inline` `` and fenced code blocks (with syntax highlighting)
- Tables
- Links (rendered but not interactive during review)

### LaTeX Math

Inline math uses `$...$` and display math uses `$$...$$`:

```
Q: What is the combinatorial meaning of $\binom{n}{k}$?
A: From a set of size $n$, we can choose $\binom{n}{k}$ subsets of size $k$.
```

```
C: The amount of substance $n$ is defined as:

$$
n = \frac{N}{N_A}
$$

where $N$ is [the number of entities] and $N_A$ is [Avogadro's constant].
```

**Custom macros:** A `macros.tex` file at the collection root defines KaTeX macros. Format:

```
\commandname definition
```

Example:
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

**Path resolution:**
- **Relative paths** (e.g., `art/diagram.png`) resolve relative to the deck file's directory.
- **Collection-root paths** prefixed with `@/` (e.g., `@/images/photo.webp`) resolve relative to the repository root, regardless of where the deck file lives.

### Audio

Same syntax as images. The file extension determines rendering (audio player vs. image):

```
Q: How do you pronounce "پرنده" in Persian?
A: ![](audio/parande.mp3)
```

## Content Addressing (Hashing)

Every card is identified by a SHA-256 hash of its content. This hash is the card's primary key in the performance database.

### Basic Card Hash

```
SHA-256("Basic" + question + answer)
```

Where `+` is byte concatenation (no separator) and strings are UTF-8 encoded.

### Cloze Card Hash

Each cloze deletion produces a card with:

```
SHA-256("Cloze" + cleanText + start_u64le + end_u64le)
```

- `cleanText`: The full cloze text with all bracket markers removed (but content preserved).
- `start_u64le`: The **byte offset** (not character offset) of the deletion start in `cleanText`, as a little-endian unsigned 64-bit integer.
- `end_u64le`: The byte offset of the deletion end (inclusive), as a little-endian unsigned 64-bit integer.

### Cloze Family Hash

All cloze deletions from the same `C:` block share a family hash:

```
SHA-256("Cloze" + cleanText)
```

This is used for **sibling burial**: within a single review session, only one card from each family is shown to prevent one card's context from spoiling another's answer.

### Byte Position Semantics

Cloze positions are measured in **bytes** of the UTF-8 encoded clean text, not character indices. This is critical for correctness with multibyte characters.

Given `C: Foo [bar] baz [quux].`:
- Clean text: `"Foo bar baz quux."`
- Card 1: `start=4, end=6` (the word "bar", bytes 4–6 inclusive)
- Card 2: `start=12, end=15` (the word "quux", bytes 12–15 inclusive)

### Bracket Processing for Clean Text

1. Scan the raw cloze text byte-by-byte.
2. `[` — If not inside an image (`![`) and not escaped (`\[`): skip the bracket (cloze open).
3. `]` — If not inside an image and not escaped: skip the bracket (cloze close).
4. `![` — Enter image mode; brackets inside images are preserved literally.
5. `\[` or `\]` — Escape mode; the backslash is consumed and the bracket is output literally.
6. All other bytes are passed through unchanged.

## Deduplication

If two cards in the same file produce the same hash (identical content), only the first occurrence is kept.

## Parsing State Machine

The parser is a line-by-line state machine with these states:

| State | On `Q:` | On `A:` | On `C:` | On `---` | On text | On EOF |
|---|---|---|---|---|---|---|
| **Start** | → ReadingQuestion | Error | → ReadingCloze | Stay | Stay | End |
| **ReadingQuestion** | Error | → ReadingAnswer | Error | Error | Append to question | Error |
| **ReadingAnswer** | Emit card, → ReadingQuestion | Error | Emit card, → ReadingCloze | Emit card, → Start | Append to answer | Emit card, End |
| **ReadingCloze** | Emit card, → ReadingQuestion | Error | Emit card, → ReadingCloze | Emit card, → Start | Append to text | Emit card, End |

- "Emit card" means the completed card (basic or cloze group) is added to the output.
- "Error" means the parser throws with a message indicating the file path and line number.

## Error Conditions

| Condition | Error |
|---|---|
| `A:` without preceding `Q:` | "Found answer tag without a question" |
| `Q:` while reading a question | "New question without answer" |
| `C:` while reading a question | "Found cloze tag while reading a question" |
| `---` while reading a question | "Found flashcard separator while reading a question" |
| EOF while reading a question | "File ended while reading a question without an answer" |
| `A:` while reading a cloze | "Found answer tag while reading a cloze card" |
| `C:` with no `[...]` deletions | "Cloze card must contain at least one cloze deletion" |
| Unclosed frontmatter `---` | "Frontmatter opening '---' found but no closing '---'" |

## Complete Example

```markdown
---
name = "Chemistry"
---

Q: What is Avogadro's number?
A: $6.022 \times 10^{23}$

---

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

---

C: The pH scale ranges from [0] to [14], with [7] being neutral.

---

Q: Identify this molecular structure:

![](images/benzene.png)

A: Benzene ($\text{C}_6\text{H}_6$)
```

This file produces:
- 3 basic cards (the Q/A pairs)
- 2 cloze cards from the water formula card (sharing a family hash)
- 3 cloze cards from the pH scale card (sharing a different family hash)
- **Total: 8 cards**
