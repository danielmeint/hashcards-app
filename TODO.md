# TODO

## UX Polish
- [ ] Touch gestures — swipe to reveal, swipe left/right to grade
- [ ] Progress persistence across sessions — resume mid-drill if app is closed
- [ ] Better loading states during sync
- [ ] Haptic feedback on grade buttons (mobile)

## Correctness / Robustness
- [ ] Handle GitHub API rate limiting gracefully (show remaining quota, back off)
- [ ] Validate PAT permissions on save (currently fails silently on first sync)
- [ ] Conflict handling when `hashcards-state.json` is updated by another device mid-session
- [ ] Handle large repos — tree API limits, slow serial fetching of many files

## Features
- [ ] Search/filter cards across decks
- [ ] Stats view — review history, heatmap, retention estimates
- [ ] Audio support (the CLI supports `![](audio.mp3)`)
- [ ] Multiple repos
- [ ] "New cards per day" limit — currently all new cards are due immediately
- [ ] Custom desired retention (currently hardcoded to 0.9)

## Infrastructure
- [x] Custom domain (hashcards.dev)
- [ ] E2E tests with Playwright — drill through a session, verify IndexedDB state
- [ ] Bundle analysis — `marked` is most of the 68KB bundle; could lazy-load it

## FSRS Algorithm
- [ ] Interval fuzz (randomize intervals slightly to avoid review clustering)
- [ ] Parameter optimization (integrate with FSRS optimizer based on review history)
