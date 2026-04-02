# Improvement Ideas

## Simplifications
1. **DRY new-card budget tracking** — Single `NewCardBudget` module instead of logic spread across github.ts, deck-list.ts, drill.ts
2. **Cloze byte-position parsing** — Extract shared `scanBytes` helper from two near-identical loops in parser.ts
3. **Batch-load performances** — Single `getAllPerformances()` call instead of per-card IndexedDB queries in drill.ts
4. **DOM query boilerplate** — Helper for repeated `querySelector` casts in settings view
5. **Keyboard handler cleanup** — Use `AbortController` signal instead of manual listener removal in drill.ts

## Features
6. **Stats view** — Review heatmap + retention curves using existing IndexedDB data
7. **Custom desired retention** — Expose the hardcoded 0.9 in fsrs.ts as a setting (0.7–0.97)
8. **Search/filter cards** — Search bar on deck list filtering across all decks
9. **Session resume** — Persist drill queue to localStorage, offer "Resume?" on reopen
10. **Multi-device conflict handling** — Detect stale hashcards-state.json before push, merge per-card

## Robustness
11. **GitHub API rate limiting** — Read X-RateLimit-Remaining headers, backoff on 429s
12. **Large repo handling** — Pagination + parallel file fetches
13. **Token format fragility** — Validate token via API response instead of prefix matching

## Polish
14. **Touch gestures** — Swipe to reveal/grade on mobile
15. **Audio card support** — Detect audio extensions, render `<audio>` elements
16. **Bundle optimization** — Lazy-load `marked` via dynamic import
