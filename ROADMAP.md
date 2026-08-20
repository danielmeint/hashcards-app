# Hashcards Roadmap

A single prioritized backlog for the app. Supersedes the old `TODO.md` and
`IMPROVEMENTS.md`.

Read it in two halves. **Sections 1–7 are the catalogue**: every known item,
grouped by kind and ordered by leverage rather than by effort — **Defects** are
things that are wrong today, **Feel** is why the app reads as slow,
**Robustness** is what breaks as the collection grows, **Big bets** are the
changes that alter what the app *is*, **Foundations** are what decides the cost
of everything after them. **The plan at the end is the order**, in phases, and
it is the part to read first if the question is "what now". Line references are
to the state of the tree as of this writing and will drift — treat them as
pointers, not addresses.

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

Two details worth settling before starting: `CacheStorage` is the other home for
the blobs and is the better fit if the service worker should serve them, and the
audio cards in the smaller backlog want the identical pipeline — so whatever
this becomes should be keyed by repo path and content type, not by "image".

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

**Fixed.** The association is the `origins` store in `src/db.ts` (hash →
`owner/repo`), written after each card sync and from whatever a repo's own
state file already knew about; `scopeToRepo` in `src/sync.ts` applies the rule.
Covered by the "two collections" and "scheduling that predates the origins
store" tests. Two things worth knowing:

The branch is deliberately not part of a repo's identity. Two branches are two
views of one collection, and it would be a surprise for scheduling to stay
behind on `main` when a card moves. The state file is per-branch because it is
a file; ownership is not.

Both halves of "cards it holds **plus** orphans last seen in it" are load
bearing, and not for the reasons the report gives. The orphan half is what the
report describes. The *holds* half covers a card this device wrote itself:
quick capture puts it straight into the deck store, and the push after a drill
is `syncStateOnly`, which never lists the tree — so nothing has recorded an
origin for it, and scoping on origin alone would drop its scheduling until some
later full sync happened to run.

Found on the way in: the tree ETag was a single global key, so it was only by
luck that switching repos refetched — GitHub's tag for one repo's tree simply
never matches another's. It is keyed by repository now, which 4.6 needs anyway.

Original report below.

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

The rule that makes both halves work: export the hashes this repo currently
holds, **plus** the orphans that were last seen in it. That needs a hash → repo
association in IndexedDB, which is also what tells 4.6 which state file a
performance belongs in. Without the second half, every card that leaves the repo
for an afternoon comes back new.

### 1.7 Editing a card discards its scheduling

**Answered for edits made in the app; still open for edits made anywhere else.**
4.2's editor knows the old hash and the new one at the same moment, so it can
offer to carry the scheduling across — see `migrateCardHistory` in `src/db.ts`
and `carryHistory` in `src/card-edit.ts`. That covers the case this was written
about. It does nothing for a card edited on GitHub, in an editor, or by the CLI,
where nothing connects the two hashes afterwards; the reasoning below is still
the design work for that. Original report follows.

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

### 1.8 A card edit can race a background sync

**Fixed.** Everything that touches the repo or the deck store now goes through
`exclusive()` in `src/sync.ts`. Two waits, deliberately different: a second sync
*joins* the one in progress, because it would do the same work, while a card
edit *queues*, because handing it back the result of someone else's sync would
be a write that never happened. Covered by `src/card-edit.test.ts`, whose fake
repo can hold a request open and answer with the state it saw when it was asked.
Original report below.

**P2, and mine.** `syncAll`, `syncStateOnly` and `adoptRepo` all go through
`start()` in `src/sync.ts`, which single-flights them — two writers interleaving
on the state file is how a merge gets lost. `commitCardEdit` does not join that
lock. It writes to GitHub and updates the deck store on its own.

The interleaving that bites: a sync lists the tree, an edit commits, and then
the sync writes the *pre-edit* file into the deck store and records the tree
ETag for the tree it listed. The edit is now invisible locally. It self-heals —
that ETag is stale, so the next sync gets a 200 and refetches — but "self-heals
on the next sync" is not the same as "correct", and auto-sync fires on
`visibilitychange`, which is exactly when a phone comes back from the editor.

**Fix:** put card edits through the same single-flight as everything else, so an
edit either waits for the sync in progress or the sync waits for it.

*Not* a rollback problem, incidentally: the commit goes to GitHub first and the
local stores are updated only after it lands, so a rejected write leaves nothing
local to undo. That ordering is deliberate.

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

**Fixed.** `writeStateFile` now tells a lost race from a real failure
(`ConflictError` in `src/github.ts`) and `fullSync` answers one by reading the
new remote state, merging again, and pushing that — twice at most, since a
conflict that keeps recurring is not a race with one other device. Both shapes
GitHub uses are handled: a 409 when the SHA we sent is stale, and a 422 naming
`sha` when the file was created after we read a 404 for it. A 422 about anything
else is not retried. Covered by `src/sync.test.ts`, whose fake repo now enforces
the SHA on writes the way GitHub does. Original report below.

`fullSync` merges last-write-wins per card (`src/sync.ts:81-97`), which is a
sound model, but the write path is not defended: `writeStateFile` sends the SHA
read at the *start* of the sync, so a push racing another device fails, and per
1.5 that failure is currently invisible.

**Fix:** on a 409, re-read remote state, re-merge, and retry. LWW per card makes
this safe to do automatically — the merge is already idempotent.

*As shipped:* the retry re-reads **local** state too, not just remote. A merge
writes back into IndexedDB, so a second attempt has to build on what the first
one left there rather than on the state the sync started with. Shipping 1.5 is
what made this worth doing now — the failure did not become more likely, it
became visible, as a red "Try again" for something the app can settle itself.

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

*Inline edit: done, from the leech list.* `src/card-edit.ts` reads the file,
splices the edit into the card's own lines, commits it, and reconciles the deck
store with the blob SHA it gets back — so the next sync recognises the file
rather than fetching back bytes the app just sent. The sheet is
`src/views/card-editor.ts`.

Two things it does that the deep link never could. Clearing the box deletes the
card, and taking the last card out of a file deletes the file. And it offers to
keep the card's scheduling: an edit is the one moment both the old hash and the
new one are known, which is the whole of 1.7's problem, solved for the case that
matters most. Reviews move with the card and the performance is copied, so a
rewritten leech is still tracked as one rather than quietly leaving the list
because its hash changed.

*Drill-time edit and quick capture: done.* The drill's Edit is the same sheet
rather than a link out, and `session.replaceCard` puts what the edit produced
back in the slot the old card held — see `src/views/drill/session.ts` and the
"a card rewritten during the drill" tests. Quick capture is
`src/views/capture.ts`, appending to a deck rather than splicing into one, with
`createCard` in `src/card-edit.ts` behind it.

The deep link from the drill is gone. Nothing was lost with it: the sheet falls
back to `cardSourceUrl` when it cannot read the file, which is the only case the
link was ever the better answer.

### 4.3 Hunt leeches

**Fixed.** Detection is `src/leeches.ts`, rendered as a section at the top of
the stats view, covered by `src/leeches.test.ts`. Each row's Edit button opens
4.2's editor, so the list is a place cards get rewritten rather than a list of
things to feel bad about. Original report below.

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

## 5. Foundations

Not features, and not defects. These are the things that decide what the next
feature costs.

### 5.1 The view layer is string templates and selector casts

**Fixed.** Every view is a `lit-html` template of its own state. What that
turned into, measured the same way as the report below: **52 → 5** selector
casts in view code, **21 → 0** `escapeHtml` calls (`src/escape.ts` is deleted;
interpolations are escaped by the library, and the one place that genuinely
renders HTML — a card body that markdown already produced — says so with
`unsafeHTML`), and no view assigns `innerHTML`. Bundle: 36.90 → 40.19 kB
gzipped, of which lit-html is ~3.1 kB.

The five casts that remain are all reaching for something a template cannot
own: gestures finding the card currently under the finger, the drill toggling
`revealed` on a cached node it deliberately did not rebuild, and the mount
point the connection panel renders into.

Three things fell out along the way rather than being aimed at. Preferences
save when they change instead of when you leave the screen. Picking a
repository no longer assigns to three input elements by hand to keep the manual
fields in step. And the stats heatmap and forecast are in the template, under a
comment that used to explain there were too many cells for a template string.

One trap worth writing down: `main.ts` cleared the container before each view,
and lit-html keeps its render state on the container it was handed — so
rendering into one that something else emptied updates nodes that are no longer
in the document, silently, with nothing thrown. Each view gets a fresh element
now (`freshHost` in `main.ts`). Original report below.

Every view builds a template string, assigns it to `innerHTML`, and then goes
looking for its own elements again. As of this writing that is roughly 1,700
lines across six views, **52** `querySelector(...) as T` or `!` assertions, and
**21** `escapeHtml` call sites — each one a place a future edit can forget, with
nothing to catch it. `drill/view.ts` already hand-rolls "build the chrome once
and mutate it" (2.2) because rebuilding on every card was visibly slow. That is
precisely the job a template library does, and does better.

**Recommendation: `lit-html`, one view at a time — not a rewrite.**

Why `lit-html` specifically:

- **It is scoped to the three things that actually hurt.** Escaping is automatic
  (interpolations are values, not text), events bind in the template rather than
  by selector afterwards, and re-rendering updates only the parts that changed —
  which is `drill/view.ts`'s hand-written `paint()`, for free and more precisely.
- **~4 KB gzipped**, against a 36 KB gzipped bundle today. Lazy-loading KaTeX
  would pay for it several times over.
- **No build change and no new file type.** Tagged template literals compile as
  they are; Vite needs nothing.
- **It migrates per view.** `render(template, container)` is a drop-in for one
  `innerHTML` assignment, so every step is shippable on its own.

Why not something heavier. React or Preact would add a virtual DOM to solve what
template parts already solve, and their real gift — a component model and an
ecosystem — answers problems this app does not have: there is no routing, no
shared reactive state beyond a handful of module-level values, and no forms of
consequence. The most intricate UI code here is `drill/gestures.ts`, direct
touch handling that a VDOM makes harder to reason about, not easier. Svelte
would mean a compiler and `.svelte` files: the right answer if this became a
product with a team, and a large tax on a 4,000-line app with one author.

**Why not the complete rewrite.** The tests assert on rendered DOM — what is on
screen, not how it got there — so a view converted to `lit-html` is verified by
the tests that already exist. A big-bang rewrite gives up that safety net to
arrive at the same place.

Which means the order follows the tests, not the line counts:

| View | Lines | Tests |
|---|---|---|
| `views/card-editor.ts` | 195 | 9 |
| `views/settings.ts` | 187 | **none** |
| `views/drill/view.ts` | 298 | 29 (+9 session) |
| `views/auth-panel.ts` | 304 | 5 |
| `views/deck-list.ts` | 340 | 10 |
| `views/stats.ts` | 386 | **none** |

The two biggest string blobs are the two with no safety net, so they are not the
place to learn the pattern — they are the place to write a render smoke test
first, which is worth having regardless and is a down payment on 3.5.

**The discipline that makes it safe** — and the discipline that turned out to be
too tight. The first rule was that a conversion changes how the DOM is built and
nothing else: same elements, same text, same tests passing untouched. That is
the right instinct and the wrong rule. Converting `card-editor.ts` produced a
599-pixel difference in a 4.3-megapixel screenshot, from `${a} review${b}`
becoming two text nodes where there had been one, and chasing it back to zero
bought nothing.

What is worth keeping from it: a conversion commit stays *about* the conversion,
tests either keep passing or are changed deliberately and for a stated reason,
and a test that is pinning down how a view is built rather than what it does is
a test to fix — the checkbox one asserted on `.checked` without a `change`
event, which is a fact about the old implementation and nothing else.

What is not worth keeping: pixel equivalence as a gate. Improve a view while
converting it, if the improvement is in front of you.

And no `View` interface, lifecycle base class, or component abstraction up
front: convert two views, see what actually repeats, extract that and nothing
more.

**The honest cost.** This buys the user nothing on the day it ships. It competes
for the same evenings as 1.4 and 1.6, which fix things that are actually wrong.
What it buys is the *next* features: a preview pane in the card editor,
drill-time editing, quick capture — all of them partial updates and forms, which
is exactly where string templates stop being cheap.

### 5.2 Settings live in two places, and one module reads around them

**Fixed.** `src/settings.ts` owns every key, its default, its codec and the two
it is migrating away from; nothing else in the app touches `localStorage`. The
existing accessors — `getConfig`, `getNewCardsPerDay`, `getTheme`,
`getLastPushedAt` — stayed where they were and delegate, so no caller changed.
`render.ts` now asks `getConfig()` like everything else. Covered by
`src/settings.test.ts` and `src/render.test.ts`, the latter being the first
tests that module has had. Original report below.

Configuration is nine raw `localStorage` keys (`github_owner`, `github_repo`,
`github_branch`, `new_cards_per_day`, `interval_fuzz`, `haptic_feedback`,
`theme`, `last_synced_at`, `last_pushed_at`) with their accessors spread across
`github.ts`, `theme.ts`, `budget.ts` and `sync-state.ts`, while everything else
lives in IndexedDB. Nothing validates a key, nothing migrates one, and the names
are string literals at each use.

The concrete bug this shape produces is already in the tree: `render.ts:7-9`
reads `github_owner`, `github_repo` and `github_branch` straight out of
`localStorage` rather than calling `getConfig()`, so image URLs are built from a
second, independent reading of the configuration.

**Fix:** one typed module owning the keys, their defaults, and their migrations,
with the existing accessors kept as its surface so callers do not all change at
once. `adoptLegacySyncTimestamp` shows the shape a migration wants. Stop short
of a settings *object* threaded through every view — see 5.3.

### 5.3 Declined: a services container

The suggestion that prompted 5.1 and 5.2 also proposed replacing the
module-level singletons (`cachedCards`, the cached credential, sync's
`inFlight`) with instantiable services in an `AppServices` container, so tests
could build isolated harnesses instead of calling `vi.resetModules()`.

Recorded here as considered and declined. The whole suite is 208 tests in about
two seconds, and the isolation boilerplate is four lines in a helper per test
file. Rewriting every module's shape to remove four lines is a poor trade, and
the singletons are load-bearing in a way a container would not improve: one
in-flight sync, one credential, one card cache is the *correctness* requirement,
not an accident of style. If test setup ever becomes the friction, extract a
shared `freshApp()` helper first and see what is left to complain about.

---

## 6. Smaller backlog

Carried forward, still open, none of it urgent.

- **Custom desired retention** — `TARGET_RECALL` is hardcoded at 0.9
  (`src/fsrs.ts:12`); expose it as a 0.7–0.97 setting.
- **FSRS parameter optimization** — fit `W` to actual review history rather than
  shipping defaults. Wants a meaningful review corpus first.
- **Search / filter across decks** — a search bar on the deck list.
- **Audio cards** — the CLI supports `![](audio.mp3)`; detect audio extensions
  and render an `<audio>` element. Shares the private-repo blob-fetching work
  from 1.4.
- ~~**Bundle size**~~ — done in Phase 3. Initial JS 40.46 → 28.86 kB gzipped,
  and a collection with no maths and no code now fetches neither KaTeX nor the
  highlighter at all.
- ~~**The cloze placeholder is a magic string**~~ — done in Phase 3, and it was
  hiding a second bug: `String.replace` reads `$&` in the *replacement* as the
  matched text, so a cloze answer containing one was spliced into itself.
- ~~**DOM query boilerplate**~~ — done with 5.1, which removed the casting
  rather than making it terser.
- **Demo mode used to spend the real new-card budget** — fixed when the drill was
  split; kept here as a reminder that `dryRun` has to cover localStorage writes,
  not just IndexedDB ones.
- **`manifest.json` has a fixed light `background_color`** — the PWA splash is
  white regardless of theme. A manifest cannot vary by colour scheme, so this
  needs either a compromise value or a generated per-theme manifest.

---

## 7. Done

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

## The plan

Phases, not a queue. Each one is a set of things that belong together — they
touch the same code, or one is only cheap because another already happened — and
each ends somewhere the app is shippable and better. Sizes are honest guesses in
evenings, not estimates.

**Shipped so far:** the whole of section 2 (Feel), **1.1** durable grades,
**1.2**/**1.3** the deck-list counts and names, **1.5** visible sync failures,
**3.1** the conflict retry, **3.4** token detection, **4.1** sign-in with GitHub,
the whole of **4.2** — deep link, in-app editor, drill-time editing and quick
capture — and **4.3** the leech list.

---

### Phase 1 — Loose ends · ~2 evenings — **done**

**1.8** (a card edit joining sync's single-flight) and **5.2** (one typed home
for the nine `localStorage` keys, which retires the second reading of the config
in `render.ts`).

*Why together:* both are small corrections to things already shipped, and both
sit underneath Phase 2. Migrating a view that reads `localStorage` directly
means touching it twice, so 5.2 goes first or the saving is spent twice.

*Done when:* an edit and a background sync cannot interleave, and one module
owns every setting key.

---

### Phase 2 — The view layer · ~6 evenings — **done**

**5.1**, `lit-html`, one view per commit, in this order:

1. `card-editor.ts` — smallest, newest, 9 tests, and the most state transitions
   of any view. The pattern gets settled where it is most exercised and least
   entangled.
2. `settings.ts` + `auth-panel.ts` — a render smoke test for `settings.ts`
   first, since it has none.
3. `deck-list.ts` — the first with a subscription and a teardown, which is where
   the question "what replaces `disposeView`" gets answered.
4. `stats.ts` — the largest template in the app, and a smoke test before it for
   the same reason as `settings.ts`.
5. `drill/view.ts` — last, and the payoff: `paint()`'s hand-written
   build-once-and-mutate becomes what the library does anyway.

*Why in this phase and not later:* everything in Phase 3 and Phase 4 is forms
and partial updates. Doing them on string templates and then converting is
paying twice.

*Done when:* no view assigns `innerHTML`, `escapeHtml` has no callers left in
`src/views`, and the suite is unchanged except for the two new smoke tests.

---

### Phase 3 — The render path · ~3 evenings — **done**

*As shipped.* Three things rather than two. The cloze deletion is a `marked`
tokenizer, so the answer is parsed in the same pass as the prose around it —
which also retired the regex that used to unwrap the `<p>` a second parse put
there. Markdown left the initial bundle: only a drill needs it, `renderDrill`
was already async, so the await happens once at the door and everything past it
stays synchronous. And KaTeX and highlight.js are fetched only by a collection
that has maths or code in it, warmed during idle time so the first card does
not wait.

The judgement call worth recording is `hasMath`. Matching KaTeX's own rules
means `$5 to $9` is maths, and auto-render will duly set "5 to " in Computer
Modern — so being faithful to it costs 300 KB in order to mangle a sentence
about money. The heuristic is stricter than the library it feeds: a command, a
superscript, a subscript, braces, or a lone short symbol. The costs are
asymmetric, and this is the cheap side to be wrong on.

Numbers: initial JS 40.46 → 28.86 kB gzipped, `marked` split into a 12.42 kB
chunk the drill pulls in, and ~400 KB of CDN script and stylesheet no longer
fetched at all by a collection that has no use for it.

A `marked` extension that substitutes cloze deletions on the AST instead of
`String.replace`-ing a magic placeholder out of its output, plus lazy-loading
`marked`, KaTeX and the syntax highlighter behind dynamic imports.

*Why together:* both are `render.ts`, and both are easier once views are
templates rather than strings — an async `import()` mid-render is a state
transition, which is Phase 2's whole subject. The bundle-size half is the only
user-visible startup win left on the board, and it more than pays back the 4 KB
`lit-html` costs.

*Done when:* a cold start ships neither KaTeX nor the highlighter, and the
placeholder constant is gone.

---

### Phase 4 — Authoring · ~8 evenings — **done**

*As shipped.* Three things rather than two, and the third was a defect found on
the way in.

**The parse moved to the other side of the write.** `runEdit` committed and
*then* parsed, so text the parser refuses — a `Q:` with no `A:`, a `C:` with no
deletion — reached the repo, the local store did not follow, and the SHA the
sheet was holding went stale, so trying again conflicted rather than recovering.
One file broken on every device that synced it. The parse happens first now, and
a `CardSyntaxError` is shown in the sheet with the text still in the box.

**Drill-time editing.** The hard part was never the UI. The session holds hashes
in six places — the queue, `requeued`, `completed`, `gradedNew`, the scheduling
cache, and the undo stack — and rewriting the card in front of you invalidates
every one of them at once. `replaceCard` moves all six and drops the card's undo
entries, along with the reviews that pair with them: reversing a grade means
writing an earlier scheduling back, and after an edit there is no longer one
card that scheduling belongs to. The grade itself stays in the log — it
happened. Deleting the card mid-drill also shrinks the progress denominator,
without which the bar could never fill again.

The one judgement call worth recording is what "keep its scheduling" means to a
session in progress. Unchecking it makes the card new to the *store*, so the
session treats it as new too — new intervals on the grade buttons, and eligible
for the day's new-card budget. What does *not* reset is a charge already made:
the budget is per slot per sitting, so a card graded before the edit is not
charged twice for being rewritten.

**Quick capture** appends rather than splices, which needs no range and no SHA
arithmetic, and can write a deck that does not exist yet. The box is the file
format, not a question field and an answer field — `C:` cards have no two halves
to put in two fields, and a form that could only express `Q:`/`A:` would be a
worse authoring tool than the text file it writes to.

Numbers: the initial bundle went *down*, 28.90 → 28.11 kB gzipped, because both
sheets and `card-edit.ts` with them now load on the click that opens them. Two
features, and a cold start 0.79 kB lighter than before them.

*Why here:* this is where the app stops being a reader of a repo and becomes the
place cards are made, and it is the reason Phase 2 was worth doing first.

*Done when:* a card can be written, fixed, and deleted without ever opening
GitHub.

---

### Phase 5 — More than one repo · ~8 evenings

**1.6** then **4.6**. 1.6 is the data half: a hash → repo association, and an
export scoped to the cards a repo holds plus the orphans last seen in it. 4.6 is
the visible half: a list of repos instead of one, and read-only subscriptions to
other people's decks.

*Why in this order and why after Phase 2:* 1.6 is a correctness fix that 4.6
cannot be built on top of without, and 4.6 is mostly deck-list and settings
work — the two views Phase 2 will have just rewritten.

*Done when:* two card repos can be configured without either one's state file
mentioning the other's cards.

---

### Phase 6 — Media · ~4 evenings, and it jumps the queue

**1.4**, plus the audio cards from the backlog on the same pipeline: fetch
blobs through the authenticated API during `syncCards`, store them keyed by repo
path and content type, serve them as object URLs.

*Why it floats:* it is latent until the first card wants a diagram and P0 the
day one does. If that day arrives during Phase 2, this phase goes first.

---

### Not in a phase

**Triggered by scale, not by schedule.** **3.2** rate limiting and **3.3** large
repos both wait for a repo big enough to need them; **3.5**'s browser-level E2E
waits for a bug the jsdom tests miss. Doing any of them now is guessing.

**Waiting on a corpus.** FSRS parameter fitting needs a meaningful review
history before it can be honest, and the desired-retention setting is more
useful once there is something to tune it against.

**Waiting on a decision.** **1.7**'s remaining half — scheduling that survives a
card edited *outside* the app — needs the stable-card-id design, which is a
change to the file format and therefore a conversation with the CLI. **4.4**,
generating cards from source material, is the largest bet on the board and the
only one that adds a dependency on someone else's API.

**Any evening.** **4.5** push notifications is small, self-contained, and the
single change most likely to turn this into a daily habit. It fits in any gap.
