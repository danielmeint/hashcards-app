// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Card, Grade, Review } from "../types";

/**
 * Reviews used to be held in memory for the whole session and written only when
 * the user pressed End, so a drill interrupted by a crash or a reclaimed tab
 * lost every answer in it. The invariant these tests protect is that a graded
 * card is durable immediately, whether or not the session is ever finished.
 */

/**
 * `db.ts` memoizes its connection, so a clean database also needs a clean
 * module registry — otherwise the cached handle outlives the reset.
 */
async function freshDrill() {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  const [{ renderDrill }, db] = await Promise.all([
    import("./drill"),
    import("../db"),
  ]);
  return { renderDrill, ...db };
}

function basicCard(n: number): Card {
  return {
    deckName: "Test",
    filePath: "test.md",
    range: [n, n + 1],
    content: { type: "basic", question: `Q${n}`, answer: `A${n}` },
    hash: `hash-${n}`,
    familyHash: null,
  };
}

function click(container: HTMLElement, selector: string): void {
  const el = container.querySelector(selector) as HTMLButtonElement | null;
  if (!el) throw new Error(`No element matching ${selector}`);
  el.click();
}

/**
 * Drain the drill's serialized write queue. Only sound for asserting that
 * nothing was written — for anything else use `waitFor`, which does not assume
 * how many event-loop turns an IndexedDB write takes.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Poll until `predicate` holds, so tests never guess at write timing. */
async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string
): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Reveal the current card and grade it. */
function grade(container: HTMLElement, g: Grade): void {
  click(container, "#reveal-btn");
  click(container, `.grade-btn[data-grade="${g}"]`);
}

function clozeCard(n: number): Card {
  // Byte offsets, end inclusive: "Paris" in "The capital is Paris".
  return {
    deckName: "Test",
    filePath: "test.md",
    range: [n, n + 1],
    content: { type: "cloze", text: "The capital is Paris", start: 15, end: 19 },
    hash: `cloze-${n}`,
    familyHash: null,
  };
}

describe("drill persistence", () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("persists a grade without the session being ended", async () => {
    const { renderDrill, getAllPerformances, getAllReviews } =
      await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2), basicCard(3)], () => {});

    grade(container, Grade.Good);

    // No End, no Done — this is the interrupted-session case.
    const reviews: Review[] = await waitFor(
      getAllReviews,
      (r) => r.length === 1,
      "the grade to be persisted"
    );
    const perfs = await getAllPerformances();

    expect(reviews[0].grade).toBe(Grade.Good);
    expect(perfs.size).toBe(1);
    expect(perfs.get(reviews[0].cardHash)!.reviewCount).toBe(1);
  });

  it("keeps every graded card when the session is abandoned midway", async () => {
    const { renderDrill, getAllPerformances, getAllReviews } =
      await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2), basicCard(3)], () => {});

    // Easy does not re-queue, so each grade retires one card.
    grade(container, Grade.Easy);
    await waitFor(getAllReviews, (r) => r.length === 1, "first grade");
    grade(container, Grade.Easy);
    await waitFor(getAllReviews, (r) => r.length === 2, "second grade");

    expect((await getAllPerformances()).size).toBe(2);
  });

  it("undo removes the persisted review and restores the prior state", async () => {
    const { renderDrill, getAllPerformances, getAllReviews } =
      await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

    grade(container, Grade.Easy);
    await waitFor(getAllReviews, (r) => r.length === 1, "the grade");

    click(container, "#undo-btn");

    // The card was new before the grade, so its record should be gone
    // entirely rather than left behind with stale scheduling state.
    await waitFor(getAllReviews, (r) => r.length === 0, "the undo");
    expect((await getAllPerformances()).size).toBe(0);
  });

  it("undo after a second grade leaves the first review intact", async () => {
    const { renderDrill, getAllPerformances, getAllReviews } =
      await freshDrill();
    // Three cards, so grading twice leaves the drill on a card rather than on
    // the end-of-session summary, where there is no undo button.
    await renderDrill(
      container,
      [basicCard(1), basicCard(2), basicCard(3)],
      () => {}
    );

    grade(container, Grade.Easy);
    await waitFor(getAllReviews, (r) => r.length === 1, "first grade");
    grade(container, Grade.Easy);
    await waitFor(getAllReviews, (r) => r.length === 2, "second grade");

    click(container, "#undo-btn");

    // The queue is shuffled, so assert the surviving review and performance
    // describe the same card rather than naming one.
    const reviews = await waitFor(
      getAllReviews,
      (r) => r.length === 1,
      "the undo"
    );
    const perfs = await getAllPerformances();
    expect(perfs.size).toBe(1);
    expect([...perfs.keys()]).toEqual([reviews[0].cardHash]);
  });

  it("a re-queued card is graded once, not twice", async () => {
    const { renderDrill, getAllReviews } = await freshDrill();
    await renderDrill(container, [basicCard(1)], () => {});

    // Forgot re-queues the card for reinforcement without further FSRS.
    grade(container, Grade.Forgot);
    await waitFor(getAllReviews, (r) => r.length === 1, "the grade");

    click(container, "#reveal-btn");
    click(container, '.requeue-btn[data-action="done"]');
    await settle();

    expect(await getAllReviews()).toHaveLength(1);
  });

  it("records drill position and clears it when the session ends", async () => {
    const { renderDrill, getAllReviews, loadSession } = await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2), basicCard(3)], () => {});

    grade(container, Grade.Easy);
    await waitFor(getAllReviews, (r) => r.length === 1, "the grade");

    const session = await waitFor(
      loadSession,
      (s) => s !== null && s.queue.length === 2,
      "the drill position"
    );
    expect(session!.completed).toHaveLength(1);
    expect(session!.totalCards).toBe(3);

    click(container, "#end-btn");
    await waitFor(loadSession, (s) => s === null, "the session to be cleared");
  });

  it("resumes an interrupted drill without re-asking graded cards", async () => {
    const { renderDrill, getAllReviews, loadSession } = await freshDrill();
    const cards = [basicCard(1), basicCard(2), basicCard(3)];
    await renderDrill(container, cards, () => {});

    grade(container, Grade.Easy);
    const session = await waitFor(
      loadSession,
      (s) => s !== null && s.queue.length === 2,
      "the drill position"
    );

    // Simulate a reopen: fresh container, same database, restored position.
    document.body.innerHTML = "";
    const resumed = document.createElement("div");
    document.body.appendChild(resumed);
    await renderDrill(resumed, cards, () => {}, { resume: session! });

    grade(resumed, Grade.Easy);
    await waitFor(getAllReviews, (r) => r.length === 2, "fourth grade");
    grade(resumed, Grade.Easy);

    const reviews = await waitFor(
      getAllReviews,
      (r) => r.length === 3,
      "the drill to finish"
    );

    // Every card graded exactly once across the two sittings.
    expect(new Set(reviews.map((r) => r.cardHash)).size).toBe(3);
  });

  it("drops cards that have left the repo when resuming", async () => {
    const { renderDrill, getAllReviews, loadSession } = await freshDrill();
    const cards = [basicCard(1), basicCard(2), basicCard(3)];
    await renderDrill(container, cards, () => {});

    grade(container, Grade.Easy);
    const session = await waitFor(
      loadSession,
      (s) => s !== null && s.queue.length === 2,
      "the drill position"
    );

    // One of the queued cards no longer exists in the synced card set.
    const survivors = cards.filter((c) => c.hash !== session!.queue[0]);

    document.body.innerHTML = "";
    const resumed = document.createElement("div");
    document.body.appendChild(resumed);
    await renderDrill(resumed, survivors, () => {}, { resume: session! });

    grade(resumed, Grade.Easy);
    const reviews = await waitFor(
      getAllReviews,
      (r) => r.length === 2,
      "the remaining card"
    );
    expect(reviews.map((r) => r.cardHash)).not.toContain(session!.queue[0]);
  });

  it("writes nothing in dry-run (demo) mode", async () => {
    const { renderDrill, getAllPerformances, getAllReviews } =
      await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {}, {
      dryRun: true,
    });

    grade(container, Grade.Good);
    await settle();

    expect(await getAllReviews()).toHaveLength(0);
    expect((await getAllPerformances()).size).toBe(0);
  });
});

/**
 * Reveal, grade, requeue and undo all used to funnel into one function that
 * replaced the entire subtree and re-ran KaTeX and highlight.js from scratch.
 * These tests pin the two claims that replaced it: revealing touches nothing
 * but a class, and a card is typeset exactly once.
 */
describe("drill rendering", () => {
  let container: HTMLElement;
  let typeset: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // A drill from an earlier test may still have a prepare-next callback
    // pending. Let those land against nothing before installing a fresh
    // counter, or they show up as typesetting passes this test did not cause.
    (window as any).renderMathInElement = undefined;
    await settle();

    localStorage.clear();
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);

    // postRender's KaTeX hook, standing in as a count of typesetting passes.
    typeset = vi.fn();
    (window as any).renderMathInElement = typeset;
  });

  it("keeps the answer in the DOM and reveals it with a class", async () => {
    const { renderDrill } = await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

    const card = container.querySelector(".card");
    const content = container.querySelector(".card-content")!;
    expect(container.querySelector(".answer")!.textContent).toContain("A");
    expect(content.classList.contains("revealed")).toBe(false);

    const passes = typeset.mock.calls.length;
    click(container, "#reveal-btn");

    // Same nodes, no second typesetting pass — only the class changed.
    expect(container.querySelector(".card")).toBe(card);
    expect(container.querySelector(".card-content")).toBe(content);
    expect(typeset.mock.calls.length).toBe(passes);
    expect(content.classList.contains("revealed")).toBe(true);
  });

  it("carries both faces of a cloze card, parsed once", async () => {
    const { renderDrill } = await freshDrill();
    await renderDrill(container, [clozeCard(1), clozeCard(2)], () => {});

    const slot = container.querySelector(".cloze-slot")!;
    expect(slot.querySelector(".cloze")).not.toBeNull();
    expect(slot.querySelector(".cloze-reveal")!.textContent).toBe("Paris");

    const passes = typeset.mock.calls.length;
    click(container, "#reveal-btn");

    expect(container.querySelector(".cloze-slot")).toBe(slot);
    expect(typeset.mock.calls.length).toBe(passes);
  });

  it("prepares the next card while the current one is on screen", async () => {
    const { renderDrill } = await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

    expect(typeset).toHaveBeenCalledTimes(1);
    await waitFor(
      async () => typeset.mock.calls.length,
      (n) => n === 2,
      "the next card to be prepared ahead of time"
    );

    // Advancing then costs nothing: the card was typeset while the user was
    // still looking at the previous one.
    grade(container, Grade.Easy);
    expect(typeset).toHaveBeenCalledTimes(2);
  });

  it("swaps the card node when advancing rather than rebuilding the chrome", async () => {
    const { renderDrill } = await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

    const controls = container.querySelector(".controls");
    const progress = container.querySelector(".progress-fill");
    const first = container.querySelector(".card");

    grade(container, Grade.Easy);

    expect(container.querySelector(".card")).not.toBe(first);
    expect(container.querySelector(".controls")).toBe(controls);
    expect(container.querySelector(".progress-fill")).toBe(progress);
  });

  it("does not re-typeset a card brought back by undo", async () => {
    const { renderDrill, getAllReviews } = await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

    const first = container.querySelector(".card");
    grade(container, Grade.Easy);
    await waitFor(getAllReviews, (r) => r.length === 1, "the grade");

    const passes = typeset.mock.calls.length;
    click(container, "#undo-btn");
    await waitFor(getAllReviews, (r) => r.length === 0, "the undo");

    expect(container.querySelector(".card")).toBe(first);
    expect(typeset.mock.calls.length).toBe(passes);
  });
});

/**
 * Space and 1–4 are good on a desktop; on a phone they leave you tapping a row
 * of small targets along the bottom edge while the biggest thing on the screen
 * — the card — does nothing. These cover the two gestures that changed that,
 * and the keyboard inconsistency found alongside them.
 */

/** jsdom has no PointerEvent, so synthesize one with the fields read. */
function pointer(
  el: Element,
  type: string,
  x: number,
  y: number,
  id = 1
): void {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, {
    pointerId: id,
    pointerType: "touch",
    clientX: x,
    clientY: y,
  });
  el.dispatchEvent(ev);
}

function drag(container: HTMLElement, dx: number, dy = 0): void {
  const target = container.querySelector(".card-container")!;
  pointer(target, "pointerdown", 200, 300);
  pointer(target, "pointermove", 200 + dx / 2, 300 + dy / 2);
  pointer(target, "pointermove", 200 + dx, 300 + dy);
  pointer(target, "pointerup", 200 + dx, 300 + dy);
}

function press(key: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function isRevealed(container: HTMLElement): boolean {
  return !!container.querySelector(".card-content.revealed");
}

describe("drill input", () => {
  let container: HTMLElement;

  beforeEach(async () => {
    await settle();
    localStorage.clear();
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("reveals when the card itself is tapped", async () => {
    const { renderDrill } = await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

    expect(isRevealed(container)).toBe(false);
    (container.querySelector(".card-container") as HTMLElement).click();
    expect(isRevealed(container)).toBe(true);
  });

  it("does not grade when a revealed card is tapped", async () => {
    const { renderDrill, getAllReviews } = await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

    click(container, "#reveal-btn");
    (container.querySelector(".card-container") as HTMLElement).click();
    await settle();

    // Grading stays deliberate: only the buttons, keys and swipes do it.
    expect(await getAllReviews()).toHaveLength(0);
  });

  it("swipes right for Good and left for Forgot", async () => {
    const { renderDrill, getAllReviews } = await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

    click(container, "#reveal-btn");
    drag(container, 120);
    let reviews = await waitFor(getAllReviews, (r) => r.length === 1, "the swipe right");
    expect(reviews[0].grade).toBe(Grade.Good);

    click(container, "#reveal-btn");
    drag(container, -120);
    reviews = await waitFor(getAllReviews, (r) => r.length === 2, "the swipe left");
    expect(reviews[1].grade).toBe(Grade.Forgot);
  });

  it("maps a swipe on a re-queued card to Again and Got it", async () => {
    const { renderDrill, getAllReviews } = await freshDrill();
    await renderDrill(container, [basicCard(1)], () => {});

    // Forgot re-queues the card, so the controls become Again / Got it.
    grade(container, Grade.Forgot);
    await waitFor(getAllReviews, (r) => r.length === 1, "the grade");

    click(container, "#reveal-btn");
    drag(container, -120); // Again: back to the end of the queue
    expect(container.querySelector(".finished")).toBeNull();

    click(container, "#reveal-btn");
    drag(container, 120); // Got it: retires the card

    await waitFor(
      async () => container.querySelector(".finished"),
      (el) => el !== null,
      "the session to finish"
    );
    // Reinforcement, not re-grading — still the one review.
    expect(await getAllReviews()).toHaveLength(1);
  });

  it("reveals rather than grades when swiped before the answer is showing", async () => {
    const { renderDrill, getAllReviews } = await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

    drag(container, 120);
    await settle();

    expect(isRevealed(container)).toBe(true);
    expect(await getAllReviews()).toHaveLength(0);
  });

  it("springs back from a short swipe and ignores a vertical drag", async () => {
    const { renderDrill, getAllReviews } = await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

    click(container, "#reveal-btn");
    drag(container, 40); // short of the commit distance
    drag(container, 0, 140); // scrolling a long card, not a swipe
    await settle();

    expect(await getAllReviews()).toHaveLength(0);
    expect(isRevealed(container)).toBe(true);
  });

  it("space reveals and never grades", async () => {
    const { renderDrill, getAllReviews } = await freshDrill();
    await renderDrill(container, [basicCard(1)], () => {});

    // Space used to mean "Again" on a re-queued card, so holding it down sent
    // the same card round the queue over and over.
    grade(container, Grade.Forgot);
    await waitFor(getAllReviews, (r) => r.length === 1, "the grade");

    press(" ");
    expect(isRevealed(container)).toBe(true);
    press(" ");
    press(" ");
    await settle();

    expect(container.querySelector(".finished")).toBeNull();
    expect(await getAllReviews()).toHaveLength(1);
  });
});

describe("drill summary", () => {
  let container: HTMLElement;

  beforeEach(async () => {
    await settle();
    localStorage.clear();
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("lands on the summary rather than navigating straight out", async () => {
    const { renderDrill } = await freshDrill();
    const onEnd = vi.fn();
    await renderDrill(container, [basicCard(1)], onEnd);

    grade(container, Grade.Easy);
    await waitFor(
      async () => container.querySelector(".finished"),
      (el) => el !== null,
      "the summary"
    );

    expect(onEnd).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Reviewed 1 card");

    click(container, "#done-btn");
    await waitFor(
      async () => onEnd.mock.calls.length,
      (n) => n === 1,
      "Done to leave the drill"
    );
  });

  it("counts both sittings of a resumed session", async () => {
    const { renderDrill, getAllReviews, loadSession } = await freshDrill();
    const cards = [basicCard(1), basicCard(2), basicCard(3)];
    await renderDrill(container, cards, () => {});

    grade(container, Grade.Easy);
    const session = await waitFor(
      loadSession,
      (s) => s !== null && s.queue.length === 2,
      "the drill position"
    );

    document.body.innerHTML = "";
    const resumed = document.createElement("div");
    document.body.appendChild(resumed);
    await renderDrill(resumed, cards, () => {}, { resume: session! });

    grade(resumed, Grade.Easy);
    await waitFor(getAllReviews, (r) => r.length === 2, "the second grade");
    grade(resumed, Grade.Easy);

    // The first sitting's review is in the store, not in memory.
    await waitFor(
      async () => resumed.querySelector(".finished")?.textContent ?? "",
      (text) => text.includes("Reviewed 3 cards"),
      "the summary to count both sittings"
    );
  });
});

/**
 * Every `Card` has carried `filePath` and `range` from the start, but the
 * parser filled `range` with `[0, 0]`, so the app could not point at a card it
 * was showing. Noticing a badly-worded answer mid-drill and fixing it there and
 * then is the difference between a card that gets rewritten and one you resolve
 * to rewrite.
 */
describe("editing the card on screen", () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.setItem("github_owner", "someone");
    localStorage.setItem("github_repo", "cards");
    localStorage.setItem("github_branch", "trunk");
  });

  const editLink = () =>
    container.querySelector("#edit-link") as HTMLAnchorElement;

  const sourced = (n: number, filePath: string, range: [number, number]): Card => ({
    ...basicCard(n),
    filePath,
    range,
  });

  it("links to the lines the card was parsed from, on the configured branch", async () => {
    const { renderDrill } = await freshDrill();
    await renderDrill(container, [sourced(1, "aws/Networking.md", [12, 18])], () => {});

    expect(editLink().href).toBe(
      "https://github.com/someone/cards/blob/trunk/aws/Networking.md#L12-L18"
    );
    expect(editLink().hidden).toBe(false);
  });

  it("links to a single line without a range", async () => {
    const { renderDrill } = await freshDrill();
    await renderDrill(container, [sourced(1, "a.md", [7, 7])], () => {});

    expect(editLink().href).toBe(
      "https://github.com/someone/cards/blob/trunk/a.md#L7"
    );
  });

  it("escapes a path with a space, without escaping its slashes", async () => {
    const { renderDrill } = await freshDrill();
    await renderDrill(container, [sourced(1, "my notes/deep dive.md", [1, 2])], () => {});

    expect(editLink().href).toContain("/blob/trunk/my%20notes/deep%20dive.md#L1-L2");
  });

  it("follows the drill rather than going stale after the first card", async () => {
    const { renderDrill } = await freshDrill();
    await renderDrill(
      container,
      [sourced(1, "one.md", [1, 2]), sourced(2, "two.md", [30, 31])],
      () => {}
    );

    const seen = [editLink().href];
    click(container, "#reveal-btn");
    click(container, '.grade-btn[data-grade="4"]');
    seen.push(editLink().href);

    // The queue is shuffled, so which card comes first is not knowable — only
    // that the link moved with it. Set once at mount, both would be the same.
    expect(seen.map((href) => href.split("/blob/trunk/")[1]).sort()).toEqual([
      "one.md#L1-L2",
      "two.md#L30-L31",
    ]);
  });

  it("is absent when no repo is configured", async () => {
    localStorage.clear();
    const { renderDrill } = await freshDrill();
    await renderDrill(container, [sourced(1, "a.md", [1, 2])], () => {});

    expect(editLink().hidden).toBe(true);
  });

  it("is absent in demo mode, whose cards are in no repo at all", async () => {
    const { renderDrill } = await freshDrill();
    await renderDrill(container, [sourced(1, "demo.md", [1, 2])], () => {}, {
      dryRun: true,
    });

    expect(editLink().hidden).toBe(true);
  });
});
