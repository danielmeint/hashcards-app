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

**Fixed** alongside 1.3, which made it worse. `countDue` returns the genuine
supply and `deck-list.ts` clamps once across all decks. Original report below.

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

*As shipped:* per-deck rows report the deck's own supply and the Drill All button
reports what pressing it actually gives. Splitting decks by path (1.3) creates
more decks, each of which was claiming the whole budget again, so the two had to
land together.

### 1.3 Deck names collide across directories

**Fixed.** Decks are keyed by repo path and grouped by directory in
`src/views/deck-list.ts`, covered by the "deck identity" tests. Original report
below.

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

*As shipped:* exactly that, and it needed no data change — every `Card` already
carried `filePath`, so only the deck list's grouping was wrong. The merge was
worse than a display bug: pressing Drill on either deck drilled cards from both.

### 1.4 Images are broken in private repos

**P2 today, P0 the day you add a diagram.** `render.ts:6-11` rewrites relative
image sources to `raw.githubusercontent.com`. That host requires authentication
for private repos, and an `<img>` tag cannot carry an `Authorization` header.
`my-hashcards` is private; no card currently uses an image, so this is latent.

**Fix:** fetch image blobs through the authenticated API alongside the card
content, store them in IndexedDB, and serve them as object URLs. This also makes
images work offline, which the current approach never can.

### 1.5 Sync failures are silent

**Fixed.** The notice ladder is `src/sync-notice.ts`, the retry triggers are
`src/auto-sync.ts`, and both are rendered by the deck list. Covered by
`src/sync-notice.test.ts` and `src/auto-sync.test.ts`. Original report below.

**P1.** Both post-session sync attempts swallow errors into `console.warn`
(`src/views/drill.ts:336` and `:427`). An expired or revoked PAT produces an app
that keeps accepting reviews indefinitely with nothing reaching GitHub and no
indication anything is wrong. The user discovers it when they open the app on
another device and find weeks of work missing.

**Fix:** surface sync state persistently — a header indicator with the last
successful sync time, and an unmissable banner once a push has failed. Queue the
failed push and retry on next launch. Failure to persist is the one error in this
app that must never be quiet.

*As shipped:* what makes this reportable at all is a second timestamp. A sync
succeeding and review state reaching GitHub are different events — a pull-only
sync is a sync — so `last_pushed_at` is recorded separately, and only when
remote is genuinely in step. Reviews recorded after it are exactly the ones
still owed, which means the count comes from the review log rather than from a
flag the app has to remember to set and a crash can lose.

The line drawn is that not-yet-synced is not an emergency: grades have been
durable locally since 1.1, so the notice stays quiet for recent ones, says
something reassuring when offline, and only escalates to a banner once reviews
have been owed for a day. Two failures are told apart, because the action
differs: a refused credential offers Sign in, since Try again on it fails
identically, and everything else offers Try again.

Retries hang off `online` and `visibilitychange` rather than a timer — a
backgrounded PWA does not run timers reliably, so a retry loop built on one is
a retry loop that mostly does not happen. Before this the only triggers were
launching the app, finishing a drill, and pressing the button; a drill finished
offline skips its push outright and nothing came back to it.

### 1.6 Review state is global, but state files are per-repo

**P2, and the design work for 4.6.** `exportState` returns every performance in
IndexedDB, and `fullSync` writes all of them into whichever repo is configured.
Point the app at a second card repo and both repos' state files end up holding
every hash from both.

Not data loss — hashes are content-derived, so last-write-wins per card stays
correct — but each file accumulates scheduling for cards that are not in it, and
leaks that cards exist elsewhere. It barely mattered while switching repos meant
retyping owner and name; the picker added in 4.1 makes it two taps.

The guard added alongside that picker (no state file is written to a repo the
app holds no cards for) covers the worst case, where the target has no cards at
all. It does not cover two valid card repos.

**Fix:** scope the written state to cards the repo actually holds — carefully,
because a card temporarily absent from the repo must not lose its scheduling.
Anki keeps orphaned state for exactly that reason. Whatever shape this takes is
the same shape 4.6 needs.

### 1.7 Editing a card discards its scheduling

**P2, and a design question more than a bug.** Card identity is a SHA-256 of
content and nothing else (`src/hash.ts`) — no `filePath`, no `deckName`, which
is why moving a card between files or renaming a deck preserves its history.
But any content change is a new identity: the blob SHA moves, the file is
reparsed, and the new hash has no `Performance`, so the card re-enters the new
pool and charges the day's budget. Fixing `teh` → `the` costs a year of
scheduling.

Cloze is the sharp edge. `cleanText` feeds both the sibling hashes and the
`familyHash`, so one typo in a five-deletion block resets all five at once. And
because continuation lines are joined raw while `question` / `answer` are
trimmed, re-wrapping a paragraph resets a card while trailing whitespace does
not — arbitrary in a way nobody would predict.

**The orphan is retained, not deleted.** The only `performances.delete` is in
`revertReview` (undo), and `exportState` ships everything, so the old schedule
stays in IndexedDB and in the state file forever. That is half of 1.6's growth
problem — and it is also what makes any migration possible at all, since the
data to migrate *from* is still there. Worth knowing before pruning orphans:
the accidental behaviour is load-bearing.

**Whether reset is wrong depends on why you edited**, which is why there is no
single right default:

- Typo fixed → reset is clearly wrong.
- Leech rewritten → reset is clearly *right*. The card kept failing because it
  was badly written; the new one is a different question and should be
  relearned.

Those collide exactly at 4.3: the payoff of hunting leeches is rewriting them,
and rewriting is what destroys the failure history that identified them. So the
feature is not "migrate progress", it is "choose, with a default that depends on
the entry point".

**The matching problem exists only because the edit happens outside the app.**
The deep link from 4.2 hands you to GitHub, so the app finds out later by
diffing two card sets and has to guess. Inline editing — 4.2's larger version —
means the app knows: you opened card X, changed it, committed. Identity becomes
a fact rather than an inference. That reframes inline edit as the version where
this problem does not exist, rather than as a convenience.

**Fix, if it is wanted before then:** no fuzzy similarity — a wrong match
silently attaches a year of scheduling to the wrong card, which is worse than
resetting and far harder to notice. Instead an exact partial match: within one
file, a departed card and an arrived card pair up when *one half is
byte-identical* (same question, edited answer, or the reverse) and the pairing
is one-to-one. Deterministic, never guesses, and covers most real edits; both
halves changed means genuinely new.

Migrate rather than prompt, and report it afterwards. The asymmetry favours it:
a false positive shows a card at the wrong interval and self-corrects within a
few reviews, while a false negative loses months permanently.

**The hard part is that two devices must agree.** Scheduling is keyed by hash in
one shared file, so if a phone migrates and a laptop does not, LWW merges both
records and the laptop still sees a new card. The honest fix is to make the
migration a fact that *syncs* — `newHash → oldHash` recorded in the state file —
rather than a computation each device repeats from possibly different starting
points.

Follow that through and the destination is a **stable card id with the content
hash as a lookup key rather than the identity itself**: `cards: {id → schedule}`
plus `index: {hash → id}`, where editing adds a hash to an existing id. That
also gives 1.6 somewhere to put repo scoping, and it makes changing the hash
function survivable — which matters, because today changing it would reset every
card in the collection. (That much is at least computable: since 2.4 the `decks`
store keeps parsed cards *with* their old hashes, so a re-key migration has both
sides available.) Settle first whether the upstream CLI is ever meant to read
`hashcards-state.json`, because if so the hash is a shared contract rather than
ours to change.

---

## 2. Feel

Nothing here is a bug. All of it is why the app reads as slower than it is.

### 2.1 Startup blocks on the network

**Fixed.** The deck list paints from cache immediately and sync runs behind it;
status lives in `src/sync-state.ts` and is rendered by the deck list, covered by
`src/views/deck-list.test.ts`. Original report below.

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

*As shipped:* moving sync behind the UI meant it needed a progress channel it
never had — the blank screen *was* the indicator. `sync-state.ts` is that
channel, plus a "last synced" timestamp, so the deck list can distinguish a
first sync in flight from an unconfigured app and can surface failures instead
of leaving them in the console. Every sync now runs through one runner, so the
settings view, the manual refresh and the post-session push can no longer
interleave writes to the state file. Ending a drill stopped blocking on that
push too: the grades are already durable locally (1.1), so waiting on the
network on the way *out* of a drill was the same mistake in a different place.
Views can now outlive their own render, so `navigate()` takes a teardown and a
sync landing after the user has moved on cannot repaint a screen they have left.

### 2.2 Every interaction destroys and rebuilds the DOM

**Fixed.** The drill chrome is built once and mutated; see `paint()` and the
node cache in `src/views/drill.ts`, `renderCardBody` in `src/render.ts`, and the
rendering tests in `src/views/drill.test.ts`. Original report below.

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

*As shipped:* all three, and cloze cards got the reveal-as-a-class treatment
too — the prose either side of the deletion is identical on both faces, so it is
parsed once and the placeholder becomes a slot holding the blank and the answer
together. Built cards are retained only while they might be needed again (on
screen, being prepared, or one undo away), since typeset DOM is not cheap to
hold onto across a long session. Interval previews moved to card mount for the
same reason: cheap arithmetic done up front rather than work standing between
the tap and the grade buttons appearing.

### 2.3 Sync re-fetches everything, every time

**Fixed.** Conditional tree request plus SHA-diffed blob fetches in
`syncCards` (`src/sync.ts`) and `listMdFiles` (`src/github.ts`), covered by
`src/sync.test.ts`. Original report below.

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

*As shipped:* both, and they turned out to be the same change as 2.4 — the
per-file record that SHA-diffing needs is exactly what getting cards out of
localStorage wanted anyway. The tree tag is recorded only after every fetch has
succeeded, or the next sync would report "nothing changed" over files it never
got. A file that fails to *parse* is recorded with its SHA and no cards, since
re-fetching the same bytes cannot parse differently and fixing the file moves
the SHA.

### 2.4 Cards live in localStorage

**Fixed.** Cards live in a `decks` store (schema v3), keyed by repo path. See
`DeckFile` in `src/db.ts`. Original report below.

`sync.ts:46` stringifies the whole card set into localStorage on every sync, and
`loadCachedCards` synchronously `JSON.parse`s it on the startup path. That is a
5 MB ceiling and a main-thread parse that grows with the collection — on the one
code path where blocking hurts most.

**Fix:** move cards into IndexedDB next to performances and reviews. Same store,
same transaction semantics, no ceiling, no synchronous parse.

*As shipped:* each record is one source file — its path, the blob SHA it was
parsed from, and its parsed cards — which is what makes 2.3's SHA diffing
possible. Existing installs carry their localStorage cache over on upgrade so
the app still works offline immediately afterwards; those records have no SHA to
trust, so the next online sync refetches them once, and the old blob is removed
only once the cards are provably in the new store.

### 2.5 No dark mode

**Fixed.** Full token set in `src/style.css`, theme selection in `src/theme.ts`,
and a System/Light/Dark control in settings. Original report below.

There is not one `prefers-color-scheme` rule in 1090 lines of `src/style.css`.
Spaced repetition is a last-thing-before-bed activity; a full-brightness white
card in a dark room is the most viscerally unpleasant thing about the app on a
phone.

The groundwork is already done — `:root` defines a complete token set
(`--color-bg`, `--color-text-*`, `--color-border-*`, …). This is a matter of
redefining those tokens under a media query, plus an explicit override so a
manual setting can win in both directions.

*As shipped:* the existing token set turned out to cover about a third of the
colours in use — roughly seventy were hardcoded, including every surface, the
whole stats palette and the heatmap, whose intensity levels were inline styles
in `stats.ts` and are now classes. All of them are tokens now. Syntax
highlighting comes from a CDN rather than our tokens, so a dark highlight.js
sheet loads alongside the light one, parked on a non-matching media query so it
still downloads for offline use.

### 2.6 Session resume

**Fixed.** Drill position is persisted to a `session` store (schema v2) in the
same transaction as each grade, and the deck list offers it back with a Discard
alongside. The revealed flag and undo stack are deliberately not persisted.

### 2.7 Mobile input is button-only

**Fixed.** Tap-to-reveal and swipe-to-grade live in `attachCardGestures` in
`src/views/drill.ts`, covered by the "drill input" tests. Original report below.

Space and 1–4 are excellent on desktop. On a phone you are tapping into a row of
small targets at the bottom of the screen.

- **Tap anywhere on the card to reveal.** The single biggest target on screen is
  currently inert.
- **Swipe to grade** — left/right for the common grades, with the button row
  retained for the rest.
- Both should respect the existing haptic setting.

*As shipped:* right is Good, left is Forgot, and on a re-queued card the same
two directions are Got it and Again. The card follows the finger and tilts, an
indicator names what releasing would do, and the haptic fires once the gesture
passes the point where it would commit. The gesture claims a drag only once it
is unambiguously horizontal, with vertical winning ties, so long cards still
scroll and text still selects; and a swipe before the answer is showing reveals
rather than grades, so the gesture cannot grade a card that was never seen.
Swiping is touch and pen only — mouse drags are text selection, and desktop has
the keyboard — but tap-to-reveal works with a mouse too.

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

**Fixed** alongside 4.1. `inspectConnection` reads the credential's own kind for
App tokens, and tells a classic PAT from a fine-grained one by whether GitHub
sends an `x-oauth-scopes` header — a property of the token rather than of its
text. Covered by `src/github.test.ts`. Original report below.

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

**Fixed.** Sign-in lives in `src/auth.ts`, the connection UI in
`src/views/auth-panel.ts`, and the code exchange in `functions/api/auth/`.
Covered by `src/auth.test.ts`, `src/github.test.ts`,
`src/views/auth-panel.test.ts` and `functions/api/auth/_exchange.test.ts`.
Original report below.

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

*As shipped:* the authorize redirect plus a Cloudflare Pages Function for the
exchange, since a browser cannot call GitHub's token endpoint itself — it is not
CORS-enabled and it needs the client secret. Onboarding is now sign in, then
pick a repo from the ones you granted; the branch comes from the repository
rather than defaulting to `main`, which for a repo on `master` used to produce a
404 that read like a permissions problem.

The credential left `GitHubConfig` entirely. `apiFetch` picks one up itself, so
no token travels through the views, the sync runner, or an error message — and
that is what made renewal invisible: a 401 buys one refresh-and-retry, once,
with no caller aware of it. Two rules decide whether a failure costs the user
their session: a refresh GitHub *rejects* signs out, a refresh that could not be
*sent* does not, because a captive portal is not GitHub saying no. Refreshes are
single-flighted, since GitHub rotates the refresh token on every use and two
concurrent attempts would spend the same single-use token twice.

Picking a repository pulls from it and does not push: choosing one in a list
is not consent to commit to it. The first version did push, and a mis-tap in
the picker wrote a whole review history into the wrong repo — this repo, as it
happens. A state file is also never written to a repo the app holds no cards
for, which catches the hand-configured case too.

The token path stays, one disclosure down. Existing installs are on it, a fork
with no GitHub App of its own has nothing else, and the app is deliberately
buildable without one — `src/github-app.ts` ships with an empty client ID, which
simply hides the sign-in button. Tokens moved out of localStorage into their own
IndexedDB store, carried over on first read; the win over a PAT is not the
storage though, it is that the token expires in eight hours, reaches only the
repositories the user picked, and dies when they uninstall the app.

### 4.2 Write, don't just read

The app holds a write-scoped token and every `Card` already carries `filePath`
and `range: [start, end]`. That is everything needed for an **"Edit this card"**
button that deep-links to `github.com/{owner}/{repo}/blob/{branch}/{path}#L12-L18`.
You are drilling, you notice a stale or badly-worded answer, you fix it in ten
seconds instead of resolving to do it later and not doing it.

*Prerequisite: done, and the deep link with it.* The parser tracked `startLine`
in its state machine and dropped it on the way out, so **both** kinds of card
were built with `range: [0, 0]`, not just cloze. `RawCard` carries the range
now, ranges are absolute, 1-based and inclusive — what a `#L12-L18` link means
by a line number — and the frontmatter the parser strips is counted back in.
Every deletion in a `C:` block shares the block's range, since editing any of
them means editing the same lines. The link itself is `cardSourceUrl` in
`src/github.ts`, rendered in the drill header and repointed on every card.

Still open below: inline edit, and quick capture.

The larger versions, in order of ambition:

- **Inline edit and commit** from within the app.
- **Quick capture** — an "add card" flow that appends to a deck file. Ideas for
  cards arrive while reading, not while drilling.

Together these close the loop and make the app the place cards are *made*, not
just consumed.

### 4.3 Hunt leeches

**Fixed.** Detection is `src/leeches.ts`, rendered as a section at the top of
the stats view, covered by `src/leeches.test.ts`. Original report below.

Full review history sits in IndexedDB and is currently surfaced only as
aggregates in the stats view. The most actionable signal in that data is *which
specific cards keep failing* — and a card that fails repeatedly is almost always
a badly written card, not a hard fact. Two-sided cards, cards with ambiguous
answers, cards that test three things at once.

Surface them: "these 8 cards keep failing — want to rewrite them?", wired
directly into the edit flow from 4.2. This is the highest-leverage feature in any
SRS tool and essentially nobody implements it well.

*As shipped:* a lapse is a review graded Forgot, which is exactly what FSRS
treats as a failure — Hard requeues the card for reinforcement but scores as a
success, and counting it would flag every card anyone ever found effortful. The
threshold is 3 rather than Anki's 8, because this list suggests a rewrite rather
than suspending anything, so being early is cheap.

Ranking is by lapses, then by lapse rate, so three failures in twenty reviews
does not outrank three in four. A card answered correctly three times running
since its last lapse has stopped being one whatever the count says: it drops out
of the list and is reported as a line instead. History belonging to cards that
are no longer in the collection is ignored — editing a card gives it a new hash
(1.7) and there is nothing left to rewrite.

Every row links to the lines the card came from, which is the part that makes
this worth having: a list of failing cards with nothing to do about it is a list
of things to feel bad about. That link is 4.2's, and this feature was not
buildable before it.

*Known limit:* only performances cross devices — the review log is local — so
counts are per-device, which the screen says. Syncing lapse counts would fix it
and means touching the state file, so it waits on the schema question in 1.7.

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
- **Demo mode used to spend the real new-card budget** — fixed when the drill was
  split; kept here as a reminder that `dryRun` has to cover localStorage writes,
  not just IndexedDB ones.
- **`manifest.json` has a fixed light `background_color`** — the PWA splash is
  white regardless of theme. A manifest cannot vary by colour scheme, so this
  needs either a compromise value or a generated per-theme manifest.

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
- The "Session Complete" screen made reachable — it reports the whole session,
  including a sitting completed before a resume
- Space made consistent: it reveals, and never grades

---

## Suggested order

**Done:** the whole of section 2, plus **1.1** (durable grades) — with
drill-loop, deck-list and sync tests as a partial answer to 3.5, running in jsdom
against a fake IndexedDB and a fake GitHub rather than a real browser.

**Next, what is left of correctness:** **1.5** and **3.1**. 1.5 is part-done —
sync reports failures in the deck list — but the durable half (retry queue,
last-successful-sync warning) is open. 3.1 only bites with real multi-device
concurrency, and 4.1 may rewrite that code anyway.

**Then pick a bet.** **4.1** is the one that changes who can use this at all, and
it makes 3.4 and the localStorage-credential problem disappear. **4.2 → 4.3** is
the one that most improves the collection itself, and 4.2 is unusually cheap for
what it delivers.
