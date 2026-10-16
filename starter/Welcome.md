---
name = "Welcome to hashcards"
tags = ["hashcards"]
---

ID: welcome-reveal
Q: You're looking at a card. How do you see the answer?
A: Press **Space**, or tap the card.
Extra: Press **Space** once more and the card is graded **Good**, so a whole review can be run with one key.

---

ID: welcome-grades
Q: Once the answer shows, what do the keys **1** to **4** mean?
A:

| Key | Grade | When |
|---|---|---|
| 1 | Forgot | You didn't remember it |
| 2 | Hard | You got there, with effort |
| 3 | Good | You remembered it |
| 4 | Easy | You knew it instantly |

Extra: **Forgot** brings the card back later in the same review. The others push it into the future, Easy the furthest.

---

ID: welcome-swipe
Tags: phone
Q: On a phone, what do swipes do?
A: Swipe a revealed card **right** for Good, **left** for Forgot.
Extra: Tapping a revealed card also grades it Good. A swipe before the answer is showing only reveals it.

---

ID: welcome-fsrs
C: Hashcards decides when you see a card next with the [FSRS] scheduling algorithm.
Extra: Free Spaced Repetition Scheduler. Each grade updates how well you know the card, and the next review is timed for just before you would forget it.

---

ID: welcome-undo
Q: You pressed the wrong grade. How do you take it back?
A: Press **U**, or the undo arrow at the top of the review.

---

ID: welcome-edit
Q: You spot a typo in a card halfway through a review. What do you do?
A: Press **E**, or the pencil on the card, and fix it right there.
Extra: The change is saved to your repository as a commit. The card keeps its review history, because history follows its `ID:` line, not its wording.

---

ID: welcome-where
Q: Where do your cards live?
A: In **Markdown files in your own GitHub repository**, one file per deck.
Extra: Review history goes on a separate `hashcards-data` branch and settings in `hashcards.toml`. Nothing is kept on a hashcards server.

---

ID: welcome-inbox
Q: What is the **Inbox** for?
A: **Draft** cards wait there for you to keep or discard them.
Extra: A card marked `Status: draft` is not scheduled until you keep it. AI agents and scripts write drafts, so nothing reaches your reviews without your say-so. Open it from **Inbox** on Today.

---

ID: welcome-add
Q: What are three ways to add cards?
A:

- The **+** button on Today
- Editing the `.md` files on GitHub
- Asking an AI agent: `AGENTS.md` in your repository tells it how

---

ID: welcome-draft
Status: draft
Q: This card is a draft. What happens when you keep it?
A: Its `Status: draft` line goes and it joins your reviews as a new card.
Extra: Discard it instead and the card is deleted from its file.
