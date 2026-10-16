# Writing flashcards in this repo

This is a [hashcards](https://hashcards.dev) collection: spaced-repetition
cards as Markdown. Every `.md` file is a deck (except README/AGENTS-style docs
and whatever `hashcards.toml` excludes). Review history lives on the
`hashcards-data` branch: never edit or delete it.

## Use `hc`, then lint

`hc` is the hashcards CLI. If it is not on your PATH, run it with the path
you were given (`node …/hc.js`; it is not on npm yet), and write that out in
each command: a shell variable holding it may not word-split.

```bash
hc add --json cards.json          # or: echo '[…]' | hc add --json -
hc add --deck geo/baltics.md --draft -q "Capital of Estonia?" -a "Tallinn"
hc add --deck k8s/workloads.md --draft --cloze "A Deployment manages a [ReplicaSet]."
hc lint                           # must report 0 errors
```

`--json` takes one card or an array, in this shape (`schema/card.schema.json`
in the hashcards repo; `hc add --help` lists every flag):

```json
[
  {"file": "k8s/workloads.md", "type": "cloze", "status": "draft", "tags": ["deploy"],
   "text": "`kubectl rollout [undo] deploy/web` returns to the previous revision."},
  {"file": "k8s/workloads.md", "type": "basic", "status": "draft",
   "question": "Deployment vs StatefulSet: what does a StatefulSet add?",
   "answer": "Stable pod **names** and **per-pod volumes**, created and removed **in order**."}
]
```

`hc add` validates everything, writes nothing if any card is wrong (or is
already in the collection), appends each card after a `---`, and creates the
deck file if needed (`--name "Deck name"` sets its title). Add `--dry-run` to
preview.

## The format, if you edit files by hand

```markdown
---
name = "Europe: Baltics"
tags = ["geo"]
---

Tags: capitals
Status: draft
C: The capital of Estonia is [Tallinn].
Extra: Its old town is a UNESCO World Heritage Site.

---

Status: draft
Reverse: yes
Q: **Latvia**
A: ![Latvia on the map](map-lva.png)
```

- Metadata lines (`Tags:`, `Reverse: yes`, `Status:`) go at the top of a
  block, before `Q:` or `C:`. Separate blocks with `---`.
- A card is its text: there are no IDs. Moving a card or changing its tags,
  status or `Extra:` keeps its review history; rewording it makes a new card.
- `Extra:` (optional, last) is a note shown only after the answer: context,
  a mnemonic, a docs pointer. Never put the answer's substance there.
- `C:` text: every `[bracketed]` part becomes its own card. Write `\[` `\]`
  for literal brackets.

## Rules for agents

1. **Write `Status: draft`** (`--draft`, `"status": "draft"`) for anything you
   propose. The owner accepts drafts in the app's Inbox. `hc` run by an agent
   defaults to draft anyway.
2. **Don't reword or delete existing non-draft cards** unless asked. After
   rewording some, run `hc relink`: it pairs each old card with its new text,
   so its review history can follow. Report what it proposes; `hc relink
   --apply` (which commits to the data branch) only when you may commit.
3. Fixing a draft's wording is free: drafts have no history yet.
4. Check what exists first and skip facts already covered:
   `grep -ril '<topic>' --include='*.md' --exclude=AGENTS.md --exclude=README.md .`
5. Finish with `hc lint`. It must report 0 errors.
6. Don't commit or push unless you were asked to; say which files you changed.

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
