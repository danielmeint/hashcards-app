# My flashcards

This repository is your [hashcards](https://hashcards.dev) collection:
spaced-repetition flashcards, written as Markdown, that you review in the app.
It starts with a few sample decks so there is something to try straight away.

## Open it in the app

1. Go to **[hashcards.dev](https://hashcards.dev)** and press **Sign in with
   GitHub**.
2. When GitHub asks which repositories hashcards may use, **include this
   repository**. Hashcards can only see the repositories you pick.
3. Pick this repository from the list. Your cards appear on **Today**.

To install the app, use your browser's *Add to Home Screen* (phone) or
*Install* (desktop). It works offline and syncs when you are back online.

If you didn't grant this repository at sign-in, add it later under
**Settings → Repository → Add or remove repositories on GitHub**.

## What is in here

| Path | What it is |
|---|---|
| `Welcome.md` | A short deck about the app itself. Review it first. |
| `Geography.md`, `Maths.md`, `Programming.md`, `languages/Spanish.md` | Sample decks: questions and answers, fill-in-the-blank cards, notes shown after the answer, cards that work both ways, code and formulas. |
| `hashcards.toml` | Collection settings: new cards per day, desired retention, which files are decks. The app's Settings screen edits it too. |
| `AGENTS.md` | Instructions for AI agents that write cards here. |
| `.github/workflows/hashcards-lint.yml` | Checks every deck when you push or open a pull request. |

Your review history is kept on a separate branch, `hashcards-data`, which the
app creates the first time you review. Leave that branch alone: it is how your
devices agree on what is due.

The sample decks are only there to show you around. **Delete any of them
whenever you like**, along with the cards in them.

## Adding cards

**In the app.** Press **+** on Today to write a card, or press **E** during a
review to fix the one in front of you. Each change is saved here as a commit.

**On GitHub.** Edit any `.md` file, or add a new one: each file is a deck.

```markdown
ID: capital-peru
Q: What is the capital of Peru?
A: Lima

---

ID: water-formula
C: The chemical formula of water is [H₂O].
Extra: Two hydrogen atoms, one oxygen.
```

Separate cards with `---`. Give each card an `ID:` that never changes: it is
what keeps a card's history when you reword it. The full format is in the
[card format spec](https://github.com/danielmeint/hashcards-app/blob/main/CARD_FORMAT_SPEC.md).

**With an AI agent.** Point Claude Code, Codex or another coding agent at a
clone of this repository and ask for cards. [`AGENTS.md`](AGENTS.md) tells it
the format and the rules: it writes drafts (`Status: draft`), which wait in
the app's **Inbox** until you keep or discard them. Agents can check their work
with `hc`, the hashcards command line; see
[For agents and scripts](https://github.com/danielmeint/hashcards-app#for-agents-and-scripts).
