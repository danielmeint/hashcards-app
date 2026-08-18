# Hashcards Roadmap

A single prioritized backlog for the app. Supersedes the old `TODO.md` and
`IMPROVEMENTS.md`.

Sections are ordered by leverage, not by effort: **Defects** are things that are
wrong today, **Feel** is why the app reads as slow, **Robustness** is what breaks
as the collection grows, **Big bets** are the changes that alter what the app
*is*. Line references are to the state of the tree as of this writing and will
drift — treat them as pointers, not addresses.

---

## 1. Defects

Ranked by consequence. The first one loses data.

### 1.1 Closing the app mid-session discards every review in it

**Fixed.** Grades now persist individually; see `src/db.ts` (`persistReview` /
`revertReview`) and the write queue in `src/views/drill.ts`, covered by
`src/views/drill.test.ts`. Original report below.

**P0.** `saveSessionResults` is called only from `doEnd()` (`src/views/drill.ts:329`)
and the Done button on the finished screen (`src/views/drill.ts:420`). Everything
before that lives purely in `state.reviews` and `state.cache`, in memory.

Grade forty cards on a train, iOS reclaims the tab, and all forty are gone —
scheduling state is the entire value of the app, and the most common mobile
session ending is not a tap on "End".

**Fix:** persist after each grade. Write the single updated `Performance` and
append the `Review` inside `doGrade`, rather than batching the whole session at
the end. The IndexedDB write is a few hundred microseconds and is not on any
path the user waits for.

**Fallout, all positive:** this makes session resume nearly free — if per-grade
state is already durable, "resume mid-drill" is just persisting the remaining
queue alongside it (see 2.6). It also means a crash costs one card, not a session.

*As shipped:* writes are serialized through a small queue so an undo can never
overtake the grade it reverses, and the undo entry carries the previous
scheduling state rather than re-reading it — the old code read the *post-grade*
value back from IndexedDB, which would have restored the wrong state once writes
became eager. A failed write now raises a banner in the drill instead of being
swallowed. `renderFinished` was rewired to reuse `doEnd`, removing a second copy
of the save-and-sync logic.

### 1.2 The deck list inflates the "new" count

**P1.** The new-card budget is a single global pool (`remainingBudget()`), but
`countDue` clamps *each deck independently* to that global remainder:

```ts
// src/new-card-budget.ts:88
newCount: Math.min(newCount, budget),
```

`deck-list.ts:60-62` then sums those per-deck minima into `totalNew`. Three decks
with 20 new cards each and a budget of 20 render as "60 new", and the
`Drill All (… 60 new)` button hands you 20 — `selectDueCards` clamps correctly
against the whole set, so the button's behavior is right and only its label lies.

**Fix:** compute per-deck raw new counts, then clamp once at the aggregate level.
Per-deck numbers should show the deck's genuine new-card supply (with the global
remaining budget displayed separately, as it already is in `.new-budget-status`),
or be apportioned explicitly — but they must not each independently claim the
whole budget.

### 1.3 Deck names collide across directories

**P1.** Deck name is derived from the basename only:

```ts
// src/sync.ts:33-37
const deckName = path.split("/").pop()!.replace(/\.md$/, "");
```

`aws/Networking.md` and `misc/Networking.md` silently merge into one deck in the
UI. The card repo already uses `aws/` and `misc/`, so this is one filename away
from being live.

**Fix:** derive the deck identity from the full path. Display the basename, but
key on the path, and use the directory structure as a grouping level in the deck
list (see 4.3). TOML frontmatter `name = "..."` continues to override the display
name.

### 1.4 Images are broken in private repos

**P2 today, P0 the day you add a diagram.** `render.ts:6-11` rewrites relative
image sources to `raw.githubusercontent.com`. That host requires authentication
for private repos, and an `<img>` tag cannot carry an `Authorization` header.
`my-hashcards` is private; no card currently uses an image, so this is latent.

**Fix:** fetch image blobs through the authenticated API alongside the card
content, store them in IndexedDB, and serve them as object URLs. This also makes
images work offline, which the current approach never can.

### 1.5 Sync failures are silent

**P1.** Both post-session sync attempts swallow errors into `console.warn`
(`src/views/drill.ts:336` and `:427`). An expired or revoked PAT produces an app
that keeps accepting reviews indefinitely with nothing reaching GitHub and no
indication anything is wrong. The user discovers it when they open the app on
another device and find weeks of work missing.

**Fix:** surface sync state persistently — a header indicator with the last
successful sync time, and an unmissable banner once a push has failed. Queue the
failed push and retry on next launch. Failure to persist is the one error in this
app that must never be quiet.

---

## 2. Feel

Nothing here is a bug. All of it is why the app reads as slower than it is.

### 2.1 Startup blocks on the network

`init()` awaits a full card sync *and* a full state sync before rendering
anything at all:

```ts
// src/main.ts:77-86
if (navigator.onLine) {
  try {
    await syncCards(config);
    await fullSync(config);
  } catch (e) { … }
}
navigate("decks");
```

Every cold open is a blank white screen for the duration of a tree call, N
content calls, and a state read. On mobile over a slow connection that is
seconds, every time, with no feedback.

**Fix:** invert it. Paint the deck list from cache immediately, kick off sync in
the background, and patch counts in when it resolves. This single change is the
difference between an app that "loads" and one that "opens" — it is the highest
feel-per-line-changed item in this document.

### 2.2 Every interaction destroys and rebuilds the DOM

Reveal, grade, requeue, and undo all funnel into `render()`, which replaces the
entire subtree (`src/views/drill.ts:105`) and then re-runs KaTeX and highlight.js
from scratch (`:161`). That is the source of the flicker, and it scales with how
rich the card is — a card with math and a code block pays the most.

**Fix, in order of payoff:**

- **Reveal should be a class toggle**, not a re-render. The answer is already in
  the DOM for basic cards (hidden via `visibility: hidden`); unhiding it needs no
  new HTML and no re-typesetting.
- **Advancing should swap a node**, not rebuild a tree.
- **Pre-render card N+1** while card N is on screen. Typesetting happens during
  the seconds the user spends thinking, and the next card appears instantly.
  With this in place the perceived jank goes to zero.

### 2.3 Sync re-fetches everything, every time

`syncCards` lists the tree and then fetches every `.md` file individually, five
at a time, on every startup — whether or not anything changed. `listMdFiles`
returns each file's blob SHA (`src/github.ts:94-110`) and `sync.ts:26` throws
them away.

**Fix, two independent wins:**

- **Conditional request on the tree.** Store the tree ETag and send
  `If-None-Match`. A 304 costs one request and does not count against the rate
  limit, so the overwhelmingly common "nothing changed" case becomes a single
  cheap call.
- **SHA-diffed fetches.** When the tree *has* changed, fetch blobs only for paths
  whose SHA moved. Keep parsed cards for the rest.

### 2.4 Cards live in localStorage

`sync.ts:46` stringifies the whole card set into localStorage on every sync, and
`loadCachedCards` synchronously `JSON.parse`s it on the startup path. That is a
5 MB ceiling and a main-thread parse that grows with the collection — on the one
code path where blocking hurts most.

**Fix:** move cards into IndexedDB next to performances and reviews. Same store,
same transaction semantics, no ceiling, no synchronous parse.

### 2.5 No dark mode

There is not one `prefers-color-scheme` rule in 1090 lines of `src/style.css`.
Spaced repetition is a last-thing-before-bed activity; a full-brightness white
card in a dark room is the most viscerally unpleasant thing about the app on a
phone.

The groundwork is already done — `:root` defines a complete token set
(`--color-bg`, `--color-text-*`, `--color-border-*`, …). This is a matter of
redefining those tokens under a media query, plus an explicit override so a
manual setting can win in both directions.

### 2.6 Session resume

Once 1.1 lands, persist the remaining queue and revealed state too, and offer
"Resume session?" on reopen. Closing the app mid-drill is normal mobile behavior,
not an error, and should cost nothing.

### 2.7 Mobile input is button-only

Space and 1–4 are excellent on desktop. On a phone you are tapping into a row of
small targets at the bottom of the screen.

- **Tap anywhere on the card to reveal.** The single biggest target on screen is
  currently inert.
- **Swipe to grade** — left/right for the common grades, with the button row
  retained for the rest.
- Both should respect the existing haptic setting.

---

## 3. Robustness

### 3.1 Multi-device conflict handling

`fullSync` merges last-write-wins per card (`src/sync.ts:81-97`), which is a
sound model, but the write path is not defended: `writeStateFile` sends the SHA
read at the *start* of the sync, so a push racing another device fails, and per
1.5 that failure is currently invisible.

**Fix:** on a 409, re-read remote state, re-merge, and retry. LWW per card makes
this safe to do automatically — the merge is already idempotent.

### 3.2 Rate limiting

Nothing reads `X-RateLimit-Remaining` or handles a 429. With 2.3 in place the
request volume drops enough that this becomes unlikely rather than merely rare,
but the app should still back off deliberately and say so rather than failing
opaquely.

### 3.3 Large repos

The tree API truncates on large repos and the current serial-ish content fetch
scales linearly with file count. 2.3's SHA diffing addresses the steady state;
the cold-start case wants either the GraphQL API to batch blob fetches, or a
single tarball/zipball request unpacked client-side.

### 3.4 Token type detection is prefix-based

`inspectToken` (`src/github.ts:65-75`) hits `/user` for the username but still
classifies the token by string prefix (`github_pat_` / `ghp_`). Largely moot if
4.1 lands, since OAuth removes user-supplied tokens entirely.

### 3.5 E2E tests

There is good unit coverage of the parser and FSRS, and none of the drill loop —
which is where 1.1 lives. A Playwright run that drills a session and asserts on
IndexedDB state would have caught it. Worth adding *with* the 1.1 fix, so the
regression can't come back.

---

## 4. Big bets

These change what the app is, rather than how well it does what it already does.

### 4.1 Replace the PAT with a GitHub App

Onboarding today is: go to GitHub settings, create a fine-grained token, scope it
correctly, copy it, paste it into a web page. That is a wall, and it is the
reason this is a tool for one person rather than a tool anyone uses. The settings
view already spends a welcome banner, a help link, and a token-type badge trying
to soften it — that effort is evidence of the problem, not a solution to it.

A GitHub App with OAuth — device flow, or a small Cloudflare Worker for the code
exchange, given the domain is already there — turns the whole thing into "Sign in
with GitHub → pick a repo."

It also fixes a real security posture problem: a long-lived, write-scoped
credential currently sits in localStorage (`src/github.ts:9`) where any XSS can
lift it. Short-lived installation tokens scoped to a single repo are strictly
better.

### 4.2 Write, don't just read

The app holds a write-scoped token and every `Card` already carries `filePath`
and `range: [start, end]`. That is everything needed for an **"Edit this card"**
button that deep-links to `github.com/{owner}/{repo}/blob/{branch}/{path}#L12-L18`.
You are drilling, you notice a stale or badly-worded answer, you fix it in ten
seconds instead of resolving to do it later and not doing it.

*Prerequisite:* cloze cards are currently constructed with `range: [0, 0]`
(`src/parser.ts`, in `parseClozeCards`) — the parser knows the line range for
basic cards but does not thread it through for cloze. That needs fixing first,
and it is small.

The larger versions, in order of ambition:

- **Inline edit and commit** from within the app.
- **Quick capture** — an "add card" flow that appends to a deck file. Ideas for
  cards arrive while reading, not while drilling.

Together these close the loop and make the app the place cards are *made*, not
just consumed.

### 4.3 Hunt leeches

Full review history sits in IndexedDB and is currently surfaced only as
aggregates in the stats view. The most actionable signal in that data is *which
specific cards keep failing* — and a card that fails repeatedly is almost always
a badly written card, not a hard fact. Two-sided cards, cards with ambiguous
answers, cards that test three things at once.

Surface them: "these 8 cards keep failing — want to rewrite them?", wired
directly into the edit flow from 4.2. This is the highest-leverage feature in any
SRS tool and essentially nobody implements it well.

### 4.4 Generate cards from source material

The collection is clearly built from technical reading — DDIA, Terraform, AWS.
The friction in spaced repetition was never the reviewing; it is the authoring.

Point the app at a chapter or a file, get proposed cards in the existing
`Q:` / `A:` / `C:` format, approve or edit each one, commit to the repo. The
format is plain Markdown with a documented spec (`CARD_FORMAT_SPEC.md`), which
makes it a good generation target.

### 4.5 Notifications

A daily push at a fixed local time with today's due count, from the PWA. Small,
and it is the thing that actually converts the app into a habit.

### 4.6 Multiple repos

Config is four flat localStorage keys (`src/github.ts:8-15`). Making it a list
unlocks shared decks: subscribe to someone else's card repo read-only while
keeping your own review state locally. That is the version of this app with a
network effect — public decks as ordinary GitHub repos, forkable and
pull-requestable, which no other SRS tool can do naturally.

---

## 5. Smaller backlog

Carried forward, still open, none of it urgent.

- **Custom desired retention** — `TARGET_RECALL` is hardcoded at 0.9
  (`src/fsrs.ts:12`); expose it as a 0.7–0.97 setting.
- **FSRS parameter optimization** — fit `W` to actual review history rather than
  shipping defaults. Wants a meaningful review corpus first.
- **Search / filter across decks** — a search bar on the deck list.
- **Audio cards** — the CLI supports `![](audio.mp3)`; detect audio extensions
  and render an `<audio>` element. Shares the private-repo blob-fetching work
  from 1.4.
- **Bundle size** — `marked` dominates the ~68 KB bundle; lazy-load it via
  dynamic import, since it is not needed until the first card renders.
- **DOM query boilerplate** — a small typed helper would remove a lot of repeated
  `querySelector` casting, mostly in the settings view.
- **The "Session Complete" screen is unreachable** — `doGrade` and `doRequeue`
  both call `doEnd()` directly when the queue empties, which navigates away
  before `render()` can show `renderFinished`. The end-of-session summary has
  therefore never been visible. Either route the last card through `render()` or
  delete the screen.
- **Requeue keybinding is inconsistent** — Space means "reveal" everywhere except
  on a requeued card, where it means "Again" (`src/views/drill.ts:351-354`).
  Worth a second look.

---

## 6. Done

Kept for history.

- Stats view — review history, heatmap, retention estimates
- New-cards-per-day limit, configurable, default 20
- Interval fuzz, configurable
- Haptic feedback on grade buttons, configurable
- Interval previews on grade buttons
- Requeue reinforcement separated from FSRS scheduling
- Same-day re-review fix (`time = 1` for successful same-day grades)
- PAT permission validation with descriptive 401/403/404 errors
- First-run welcome banner and token-type detection
- Sync progress reporting
- Custom domain (hashcards.dev)
- Demo mode via `#demo`, using the real parser, no persistence
- New-card budget extracted into its own module
- Shared `scanClozeBytes` helper extracted in the parser
- Batched performance loading via a single `getAllPerformances()`
- Keyboard listener cleanup via `AbortController`

---

## Suggested order

**Done:** **1.1**, with drill-loop tests (a partial answer to 3.5 — these run in
jsdom against a fake IndexedDB rather than a real browser).

**Next,** nearly free now that grades are durable: **2.6** (session resume).

**Then the daily-feel batch,** all small and all independent: **2.1**
(non-blocking startup), **2.5** (dark mode), **2.2** (stop rebuilding the DOM).
These three are what change the experience of using the app every day.

**Then correctness cleanup:** **1.2**, **1.3**, **1.5**, **3.1**.

**Then pick a bet.** **4.1** is the one that changes who can use this at all, and
it makes 3.4 and the localStorage-credential problem disappear. **4.2 → 4.3** is
the one that most improves the collection itself, and 4.2 is unusually cheap for
what it delivers.
