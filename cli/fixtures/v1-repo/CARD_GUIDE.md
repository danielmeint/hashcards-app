# Card Writing Guide

A good card is a micro-test you can read, answer, and grade in under 10 seconds.

## Principles

1. **One fact per card.** If you can't grade it pass/fail unambiguously, split it up.

2. **Understand before you memorize.** Spaced repetition retains knowledge — it doesn't teach it. If you don't understand the concept, the card will become a leech.

3. **Keep it brief.** Short phrases over full sentences. Bold the key term. Skip filler.

4. **Prefer cloze for factual recall.** Cloze cards are faster to write and test information in context:
   ```
   C: The Linux kernel uses [CFS] as its default CPU scheduler.
   ```

5. **Each cloze deletion should stand alone.** Every `[...]` generates a separate review card. Make sure each one is a meaningful test by itself — don't blank out so many words that the remaining text is unreadable:
   ```
   Good — each deletion is independently useful:
   C: NTP achieves accuracy of [1-50 ms] over the internet and [< 1 ms] on a LAN.

   Bad — too many blanks, cards become guessing games:
   C: [NTP] achieves accuracy of [1-50 ms] over the [internet] and [< 1 ms] on a [LAN].
   ```

6. **Use basic cards for explanations and comparisons.** When the answer is a paragraph, table, or list — not a single term — use Q/A:
   ```
   Q: What is the difference between NTP and PTP?
   A:
   | Feature | NTP | PTP (IEEE 1588) |
   |---------|-----|-----------------|
   | Accuracy | 1-50 ms | < 1 ms |
   | Hardware assist | No | Yes |
   ```

7. **Be careful with edits.** Cards are content-addressed — changing any text in a card (even fixing a typo) resets its review history. If a card is well-established, think twice before rewording it.

8. **Escape brackets that aren't cloze deletions.** If your card text contains literal square brackets (e.g., array syntax, optional parameters), escape them with `\[` and `\]` so they aren't treated as cloze deletions.

## Quick checklist

- [ ] Can I answer this in under 10 seconds?
- [ ] Does it test exactly one thing?
- [ ] Would I know how to grade myself pass/fail?
- [ ] If cloze: does each deletion work as a standalone test?
- [ ] If editing an established card: is the change worth resetting history?
