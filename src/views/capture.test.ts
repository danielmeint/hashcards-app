// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { GitHubConfig } from "../github";

/**
 * Quick capture, driven through the sheet. What matters here is what reaches
 * the repo and what the sheet refuses to send — the appending itself is
 * `card-edit.test.ts`.
 */

const CONFIG: GitHubConfig = { owner: "someone", repo: "cards", branch: "main" };

const FILE = `Q: What does S3 stand for?
A: Simple Storage Service
`;

const DECKS = [
  { path: "a.md", name: "AWS" },
  { path: "maths/Algebra.md", name: "maths/Algebra" },
];

let files: Map<string, { text: string; sha: string }>;
let writes: { path: string; text: string }[];

async function openSheet(decks = DECKS) {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  files = new Map([["a.md", { text: FILE, sha: "sha-1" }]]);
  writes = [];

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = decodeURIComponent(url.match(/\/contents\/([^?]+)/)![1]);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { content: string };
      // A previous test's fire-and-forget state push can still be in flight
      // and lands in this array; only card files are this suite's business.
      if (path.endsWith(".md")) writes.push({ path, text: atob(body.content) });
      return new Response(JSON.stringify({ content: { sha: "sha-2" } }), {
        status: 200,
      });
    }
    const file = files.get(path);
    if (!file) return new Response(null, { status: 404 });
    return new Response(
      JSON.stringify({ content: btoa(file.text), sha: file.sha }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;

  const { saveCredential } = await import("../auth");
  await saveCredential({ kind: "pat", token: "token" });

  const { parseFile } = await import("../parser");
  const { updateDeckFiles } = await import("../db");
  await updateDeckFiles(
    [{ path: "a.md", sha: "sha-1", cards: await parseFile(FILE, "a.md", "AWS") }],
    []
  );
  const { loadCards } = await import("../sync");
  await loadCards();

  const { openCapture } = await import("./capture");
  const done = openCapture(CONFIG, decks);
  return { done };
}

async function until(done: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (done()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const box = () => $<HTMLTextAreaElement>(".capture-text");
const save = () => $<HTMLButtonElement>(".capture-save");
const picker = () => $<HTMLSelectElement>(".capture-deck");

function type(text: string): void {
  box().value = text;
  box().dispatchEvent(new Event("input"));
}

/** Pick an option by what it says, so the test does not know how it is keyed. */
function choose(label: string): void {
  const option = [...picker().options].find(
    (o) => (o.textContent ?? "").trim() === label
  );
  if (!option) throw new Error(`No deck option labelled ${label}`);
  picker().value = option.value;
  picker().dispatchEvent(new Event("change"));
}

const chosen = () => (picker().selectedOptions[0].textContent ?? "").trim();

describe("quick capture", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("will not save an empty box", async () => {
    await openSheet();
    expect(save().disabled).toBe(true);

    type("Q: What is S3 Glacier?\nA: Cold storage");
    expect(save().disabled).toBe(false);
  });

  it("appends to the deck that was picked", async () => {
    const { done } = await openSheet();
    type("Q: What is S3 Glacier?\nA: Cold storage");
    save().click();

    await done;
    expect(writes).toEqual([
      { path: "a.md", text: FILE + "\nQ: What is S3 Glacier?\nA: Cold storage\n" },
    ]);
  });

  it("offers the deck the last card went into", async () => {
    localStorage.setItem("last_deck_path", "maths/Algebra.md");
    const { done } = await openSheet();
    type("C: A [monoid] has an identity");
    save().click();

    await done;
    expect(writes[0].path).toBe("maths/Algebra.md");
  });

  it("falls back to the first deck when the remembered one is gone", async () => {
    localStorage.setItem("last_deck_path", "deleted.md");
    const { done } = await openSheet();
    type("Q: Still?\nA: Yes");
    save().click();

    await done;
    expect(writes[0].path).toBe("a.md");
  });

  it("remembers where the card went, for the next one", async () => {
    const { done } = await openSheet();
    choose("maths/Algebra");
    type("C: A [monoid] has an identity");
    save().click();

    await done;
    expect(localStorage.getItem("last_deck_path")).toBe("maths/Algebra.md");
  });

  it("writes a deck that does not exist yet", async () => {
    const { done } = await openSheet();
    choose("New deck…");
    $<HTMLInputElement>(".capture-path").value = "new/Physics";
    $<HTMLInputElement>(".capture-path").dispatchEvent(new Event("input"));
    type("C: Force is [mass times acceleration]");
    save().click();

    await done;
    // A name with no extension is a name, not a file — the parser reads `.md`.
    expect(writes[0].path).toBe("new/Physics.md");
  });

  it("has nothing to append to when the collection is empty, so it offers a new deck", async () => {
    await openSheet([]);
    expect(chosen()).toBe("New deck…");
    expect($<HTMLInputElement>(".capture-path")).not.toBeNull();
  });

  it("will not save a new deck with no name", async () => {
    await openSheet([]);
    type("Q: Anything?\nA: No");

    expect(save().disabled).toBe(true);
  });

  it("says what is wrong with a card the parser will not take, and sends nothing", async () => {
    await openSheet();
    type("C: A cloze with no deletion in it");
    save().click();

    await until(
      () => !$<HTMLElement>(".editor-error").hidden,
      "the syntax error to be shown"
    );
    expect($<HTMLElement>(".editor-error").textContent).toContain(
      "isn't a card yet"
    );
    expect(writes).toHaveLength(0);
    // The sheet stays open, holding the text, so it can be fixed in place.
    expect(box().value).toBe("C: A cloze with no deletion in it");
  });

  it("resolves with nothing when it is cancelled", async () => {
    const { done } = await openSheet();
    $<HTMLButtonElement>(".editor-close").click();

    expect(await done).toBeNull();
    expect(writes).toHaveLength(0);
  });

  it("keeps Escape from throwing away something typed", async () => {
    const { done } = await openSheet();
    type("Q: Half a thought");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(box()).not.toBeNull();

    // And lets it through once the box is empty again.
    type("");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await done).toBeNull();
  });
});

describe("the path typed for a new deck", () => {
  it("adds the extension the parser looks for", async () => {
    const { normalisePath } = await import("./capture");
    expect(normalisePath("Physics")).toBe("Physics.md");
    expect(normalisePath("maths/Algebra.md")).toBe("maths/Algebra.md");
  });

  it("does not double an extension that is already there, whatever its case", async () => {
    const { normalisePath } = await import("./capture");
    expect(normalisePath("Notes.MD")).toBe("Notes.MD");
  });

  it("drops a leading slash, which would name a file at the root of nothing", async () => {
    const { normalisePath } = await import("./capture");
    expect(normalisePath("/deep/Notes.md")).toBe("deep/Notes.md");
  });

  it("is empty for a box with nothing but spaces in it", async () => {
    const { normalisePath } = await import("./capture");
    expect(normalisePath("   ")).toBe("");
  });
});
