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
    repo: "someone/cards",
    filePath: "test.md",
    range: [n, n + 1],
    content: { type: "basic", question: `Q${n}`, answer: `A${n}` },
    hash: `hash-${n}`,
    familyHash: null,
  };
}

/** A card whose typesetting is worth counting — see the prerender test. */
function mathCard(n: number): Card {
  return {
    ...basicCard(n),
    content: { type: "basic", question: `Q${n} $x^${n}$`, answer: `A${n}` },
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
    repo: "someone/cards",
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
    // Cards with maths in them: typesetting is only attempted for a card that
    // needs it now, so a card that needs none is no longer a countable pass.
    await renderDrill(container, [mathCard(1), mathCard(2)], () => {});

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

  /**
   * A thumb pivots at its base, so a swipe meant as horizontal arrives as an
   * arc. The old rule was a 45° cone measured from the touch origin, where the
   * steep opening of that arc keeps `dy` ahead of `dx` well past the point the
   * finger is plainly going sideways — so a swipe that reads as deliberate to
   * the person making it was refused.
   */
  it("takes a swipe that leans, not only one drawn with a ruler", async () => {
    const { renderDrill, getAllReviews } = await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

    click(container, "#reveal-btn");
    drag(container, 100, 120); // ~50° off horizontal: refused under |dx| > |dy|
    const reviews = await waitFor(
      getAllReviews,
      (r) => r.length === 1,
      "the leaning swipe"
    );

    expect(reviews[0].grade).toBe(Grade.Good);
  });

  /**
   * Which of the two deciders arbitrates a gesture. While a card overflows, the
   * browser is handed vertical panning and goes first — a gesture it reads as a
   * pan is taken and cancelled, and a cancelled pointer reports nothing more,
   * so the swipe is gone rather than delayed. While a card fits, conceding that
   * buys nothing and costs swipes.
   *
   * jsdom does no layout, so the heights are the test's to supply.
   */
  describe("who owns the gesture", () => {
    const measure = (scrollHeight: number, clientHeight: number): void => {
      const content = container.querySelector(".card-content")!;
      for (const [prop, value] of [
        ["scrollHeight", scrollHeight],
        ["clientHeight", clientHeight],
      ] as const) {
        Object.defineProperty(content, prop, {
          value,
          configurable: true,
        });
      }
    };

    const fits = () =>
      container.querySelector(".card-container")!.classList.contains("card-fits");

    it("gives the browser no say over a card that fits on screen", async () => {
      const { renderDrill } = await freshDrill();
      await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

      measure(200, 200);
      click(container, "#reveal-btn");

      expect(fits()).toBe(true);
    });

    it("hands vertical panning back the moment a card has somewhere to scroll", async () => {
      const { renderDrill } = await freshDrill();
      await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

      measure(900, 300);
      click(container, "#reveal-btn");

      expect(fits()).toBe(false);
    });
  });

  it("still leaves a gesture that is mostly downwards alone", async () => {
    const { renderDrill, getAllReviews } = await freshDrill();
    await renderDrill(container, [basicCard(1), basicCard(2)], () => {});

    click(container, "#reveal-btn");
    // Far enough sideways to commit if it were claimed at all — a flick down a
    // long card curves, and 100px of drift over 400px is an ordinary scroll,
    // not a swipe. Widening the cone must not reach this far.
    drag(container, 100, 400);
    await settle();

    expect(await getAllReviews()).toHaveLength(0);
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
/**
 * The drill's Edit button used to be a deep link to GitHub: it took you out of
 * the drill, into a web editor holding the whole file, and left you to find
 * your way back. It opens the same sheet the leech list uses instead, over the
 * card — which means the session has to survive the card in front of you
 * changing its identity under it.
 */
describe("editing the card on screen", () => {
  let container: HTMLElement;
  let files: Map<string, { text: string; sha: string }>;
  let writes: string[];

  const FILE = `Q: What does S3 stand for?
A: Simple Storage Service
`;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.setItem(
      "repos",
      JSON.stringify([{ owner: "someone", repo: "cards", branch: "trunk" }])
    );
  });

  const editButton = () =>
    container.querySelector("#edit-link") as HTMLButtonElement;
  const sheet = () => document.querySelector(".editor-text") as HTMLTextAreaElement;
  const cardText = () =>
    (container.querySelector(".card-content") as HTMLElement).textContent ?? "";

  /** A drill over a real file, with a repo behind it the sheet can read. */
  async function drillOnFile(options: { dryRun?: boolean } = {}) {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    files = new Map([["a.md", { text: FILE, sha: "sha-1" }]]);
    writes = [];

    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const path = decodeURIComponent(url.match(/\/contents\/([^?]+)/)![1]);
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as { content: string };
          writes.push(atob(body.content));
          return new Response(JSON.stringify({ content: { sha: "sha-2" } }), {
            status: 200,
          });
        }
        const file = files.get(path)!;
        return new Response(
          JSON.stringify({ content: btoa(file.text), sha: file.sha }),
          { status: 200 }
        );
      }
    ) as unknown as typeof fetch;

    const { saveCredential } = await import("../auth");
    await saveCredential({ kind: "pat", token: "token" });

    const { parseFile } = await import("../parser");
    const { updateDeckFiles } = await import("../db");
    const cards = (await parseFile(FILE, "a.md", "deck")).map((c) => ({
      ...c,
      repo: "someone/cards",
    }));
    await updateDeckFiles(
      [{ repo: "someone/cards", path: "a.md", sha: "sha-1", cards }],
      []
    );
    const { loadCards } = await import("../sync");
    await loadCards();

    const { renderDrill } = await import("./drill");
    await renderDrill(container, cards, () => {}, options);
    return { cards };
  }

  /** Wait for what the sheet actually does; opening it awaits a fetch. */
  async function until(done: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (done()) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async function openSheet(): Promise<void> {
    editButton().click();
    await until(() => sheet() !== null, "the editor to open");
  }

  async function saveSheet(text: string): Promise<void> {
    const box = sheet();
    box.value = text;
    box.dispatchEvent(new Event("input"));
    (document.querySelector(".editor-save") as HTMLButtonElement).click();
    await until(() => sheet() === null, "the editor to close");
  }

  it("opens the card's own lines in a sheet, without leaving the drill", async () => {
    await drillOnFile();
    await openSheet();

    expect(sheet().value).toBe(
      "Q: What does S3 stand for?\nA: Simple Storage Service"
    );
    expect(container.querySelector(".card-container")).not.toBeNull();
  });

  it("opens on the e key too, since reaching for the mouse is where the intention dies", async () => {
    await drillOnFile();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "e" }));
    await until(() => sheet() !== null, "the editor to open");

    expect(sheet()).not.toBeNull();
  });

  it("puts what the edit produced on screen, in the same slot", async () => {
    await drillOnFile();
    await openSheet();
    await saveSheet("Q: What does S3 stand for?\nA: Simple Storage Service, obviously");

    expect(writes).toHaveLength(1);
    await until(
      () => cardText().includes("obviously"),
      "the rewritten card to be painted"
    );
    expect(cardText()).toContain("What does S3 stand for?");
  });

  it("ends the drill when the edit deleted the only card left", async () => {
    await drillOnFile();
    await openSheet();
    await saveSheet("");

    await until(
      () => container.querySelector(".finished") !== null,
      "the summary screen"
    );
  });

  /**
   * The drill listens for Space and 1–4 on the document. With a modal over the
   * card, a key that reached them would grade a card the user is not looking
   * at — and one they are in the middle of rewriting.
   */
  it("suspends the drill's shortcuts while the sheet is open", async () => {
    await drillOnFile();
    await openSheet();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));

    expect(
      container.querySelector(".card-content")!.classList.contains("revealed")
    ).toBe(false);
  });

  it("gives the shortcuts back when the sheet is dismissed", async () => {
    await drillOnFile();
    await openSheet();
    (document.querySelector(".editor-cancel") as HTMLButtonElement).click();
    await until(() => sheet() === null, "the editor to close");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));

    expect(
      container.querySelector(".card-content")!.classList.contains("revealed")
    ).toBe(true);
  });

  it("is absent when no repo is configured", async () => {
    localStorage.clear();
    const { renderDrill } = await freshDrill();
    await renderDrill(container, [basicCard(1)], () => {});

    expect(editButton().hidden).toBe(true);
  });

  it("is absent in demo mode, whose cards are in no repo at all", async () => {
    const { renderDrill } = await freshDrill();
    await renderDrill(container, [basicCard(1)], () => {}, { dryRun: true });

    expect(editButton().hidden).toBe(true);
  });
});
