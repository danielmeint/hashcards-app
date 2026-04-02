# TODO

## UX Polish
- [ ] Touch gestures — swipe to reveal, swipe left/right to grade
- [ ] Progress persistence across sessions — resume mid-drill if app is closed
- [x] Better loading states during sync
- [x] Haptic feedback on grade buttons (mobile, configurable)

## Correctness / Robustness
- [ ] Handle GitHub API rate limiting gracefully (show remaining quota, back off)
- [x] Validate PAT permissions on save (descriptive error messages for 401/403/404)
- [ ] Conflict handling when `hashcards-state.json` is updated by another device mid-session
- [ ] Handle large repos — tree API limits, slow serial fetching of many files

## Features
- [ ] Search/filter cards across decks
- [x] Stats view — review history, heatmap, retention estimates
- [ ] Audio support (the CLI supports `![](audio.mp3)`)
- [ ] Multiple repos
- [x] "New cards per day" limit — configurable in settings, default 20
- [ ] Custom desired retention (currently hardcoded to 0.9)

## Infrastructure
- [x] Custom domain (hashcards.dev)
- [ ] E2E tests with Playwright — drill through a session, verify IndexedDB state
- [ ] Bundle analysis — `marked` is most of the 68KB bundle; could lazy-load it

## FSRS Algorithm
- [x] Interval fuzz (randomize intervals slightly to avoid review clustering, configurable)
- [ ] Parameter optimization (integrate with FSRS optimizer based on review history)
