# Writing flashcards in this repo

This is a [hashcards](https://hashcards.dev) collection: spaced-repetition
cards as Markdown. Every `.md` file is a deck (except README/AGENTS-style docs
and whatever `hashcards.toml` excludes). Review history lives on the
`hashcards-data` branch: never edit or delete it.

## Use `hc`, then lint

```bash
hc add --json cards.json          # or: echo '[…]' | hc add --json -
hc add --deck net/tcp.md --draft -q "Question?" -a "Answer"
hc add --deck net/tcp.md --draft --cloze "TCP opens with a [three-way] handshake."
hc lint                           # must exit 0 before you commit
```

`--json` takes one card or an array, in this shape (`schema/card.schema.json`
in the hashcards repo; `hc add --help` lists every flag):

```json
[
  {"file": "net/tcp.md", "type": "cloze", "status": "draft", "tags": ["tcp"],
   "text": "A TCP connection opens with [SYN], [SYN-ACK], [ACK]."},
  {"file": "net/tcp.md", "type": "basic", "status": "draft",
   "question": "Why does TCP need a *three*-way handshake, not two?",
   "answer": "Both sides must learn the other's initial sequence number **and** see it acknowledged."}
]
```

`hc add` validates everything, writes nothing if any card is wrong, appends
each card after a `---` with a fresh ID, and creates the deck file if needed
(`--name "Deck name"` sets its title). Add `--dry-run` to preview.

## The format, if you edit files by hand

```markdown
---
name = "Networking: TCP"
tags = ["networking"]
---

ID: tcp-handshake-steps
Tags: tcp
Status: draft
C: A TCP connection opens with [SYN], [SYN-ACK], [ACK].

---

Status: draft
Q: Which side sends the first SYN?
A: The **client** (active open).
```

- Metadata lines (`ID:`, `Tags:`, `Reverse: yes`, `Status:`) go at the top of
  a block, before `Q:` or `C:`. Separate blocks with `---`.
- `C:` text: every `[bracketed]` part becomes its own card. Write `\[` `\]`
  for literal brackets.

## Rules for agents

1. **Write `Status: draft`** (`--draft`, `"status": "draft"`) for anything you
   propose. The owner accepts drafts in the app's Inbox. `hc` run by an agent
   defaults to draft anyway.
2. **IDs**: leave them out (`hc` stamps a random one) or pick a short slug
   (`tcp-handshake-steps`: lowercase, digits, `-`). **Never change or reuse an
   existing ID**: review history follows it.
3. **Don't reword or delete existing non-draft cards** unless asked.
4. Check what exists first (`grep -ri <topic> --include=*.md .`) and skip
   facts already covered.
5. Finish with `hc lint`. It must report 0 errors.

## What makes a good card

- **One fact per card.** If it can't be graded pass/fail at a glance, split it.
- **Cloze for facts, Q/A for "why", comparisons and lists.** Answers short:
  a phrase, a few bullets or a small table. Bold the key term.
- **Each cloze deletion must stand alone.** Two or three blanks at most, each
  worth testing; don't blank so much that the sentence becomes a guess.
- **Point to the docs, don't memorise them.** For a long manifest, config or
  procedure, the card names where to look up the details and the trap to avoid.
  Memorise flags, paths, defaults and gotchas, not whole files.
- **Answerable in under 10 seconds**, and understood before it is memorised.
