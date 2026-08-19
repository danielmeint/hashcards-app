// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { GitHubConfig } from "../github";

const CONFIG: GitHubConfig = { owner: "someone", repo: "cards", branch: "main" };

const FILE = `Q: What does S3 stand for?
A: Simple Storage Service

Q: What is the default S3 durability?
A: Eleven nines
`;

let files: Map<string, { text: string; sha: string }>;
let writes: string[];

async function openSheet(
  options: { failWrite?: number; reviewed?: boolean } = {}
) {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  files = new Map([["a.md", { text: FILE, sha: "sha-1" }]]);
  writes = [];

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = decodeURIComponent(url.match(/\/contents\/([^?]+)/)![1]);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { content: string };
      writes.push(atob(body.content));
      if (options.failWrite) {
        return new Response(JSON.stringify({ message: "does not match" }), {
          status: options.failWrite,
        });
      }
      return new Response(JSON.stringify({ content: { sha: "sha-2" } }), {
        status: 200,
      });
    }
    const file = files.get(path)!;
    return new Response(
      JSON.stringify({ content: btoa(file.text), sha: file.sha }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;

  const { saveCredential } = await import("../auth");
  await saveCredential({ kind: "pat", token: "token" });

  const { parseFile } = await import("../parser");
  const { updateDeckFiles } = await import("../db");
  const cards = await parseFile(FILE, "a.md", "deck");
  await updateDeckFiles([{ path: "a.md", sha: "sha-1", cards }], []);
  const { loadCards } = await import("../sync");
  await loadCards();

  if (options.reviewed) {
    const { importState } = await import("../db");
    await importState({
      [cards[1].hash]: {
        type: "reviewed",
        lastReviewedAt: "2026-01-01T00:00:00.000Z",
        stability: 3,
        difficulty: 5,
        intervalRaw: 3,
        intervalDays: 3,
        dueDate: "2026-02-01",
        reviewCount: 7,
      },
    });
  }

  const { openCardEditor } = await import("./card-editor");
  const done = openCardEditor(cards[1], CONFIG);
  await until(() => document.querySelector(".editor-text") !== null);
  return { done, card: cards[1], db: await import("../db") };
}

/**
 * Wait for what the sheet actually does, not for a fixed number of ticks. The
 * open path awaits a fetch and an IndexedDB read before it paints, and "one
 * macrotask" is only enough for that on an unloaded machine — which is not the
 * machine the rest of the suite runs on.
 */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (done()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("the editor never got there");
}

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const textarea = () => $<HTMLTextAreaElement>(".editor-text");
const save = () => $<HTMLButtonElement>(".editor-save");

describe("the card editor", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("shows the card's own lines, not the whole file", async () => {
    await openSheet();

    expect(textarea().value).toBe(
      "Q: What is the default S3 durability?\nA: Eleven nines"
    );
    expect(textarea().value).not.toContain("Simple Storage Service");
    expect($(".editor-path").textContent).toContain("lines 4–5");
  });

  it("has nothing to save until something changes", async () => {
    await openSheet();

    expect(save().disabled).toBe(true);

    textarea().value = "Q: How durable is S3?\nA: 99.999999999%";
    textarea().dispatchEvent(new Event("input"));

    expect(save().disabled).toBe(false);
    expect(save().textContent).toBe("Save to GitHub");
  });

  it("offers to delete the card when the box is emptied", async () => {
    await openSheet();

    textarea().value = "";
    textarea().dispatchEvent(new Event("input"));

    // No confirmation dialog to explain: an empty box and a red button say it.
    expect(save().textContent).toBe("Delete card");
    expect(save().classList.contains("btn-danger")).toBe(true);
  });

  it("commits the edit and closes", async () => {
    const { done } = await openSheet();

    textarea().value = "Q: How durable is S3?\nA: 99.999999999%";
    textarea().dispatchEvent(new Event("input"));
    save().click();
    const result = await done;

    expect(writes[0]).toContain("Q: How durable is S3?");
    expect(writes[0]).toContain("Simple Storage Service");
    expect(result?.cards).toHaveLength(1);
    expect(document.querySelector(".editor-backdrop")).toBeNull();
  });

  it("offers to keep the scheduling of a card that has some", async () => {
    const { done } = await openSheet({ reviewed: true });

    const keep = $<HTMLInputElement>(".editor-keep input");
    // Checked by default: a card is edited far more often to fix it than to
    // replace it, and seven reviews of work is not something to drop quietly.
    expect(keep.checked).toBe(true);
    expect($(".editor-keep").textContent).toContain("7 reviews");

    textarea().value = "Q: How durable is S3?\nA: 99.999999999%";
    textarea().dispatchEvent(new Event("input"));
    save().click();

    expect((await done)?.migrated).toBe(1);
  });

  it("starts the card over when the offer is declined", async () => {
    const { done } = await openSheet({ reviewed: true });

    const keep = $<HTMLInputElement>(".editor-keep input");
    keep.checked = false;
    // What a tap on the checkbox does. Setting `.checked` alone tells whoever
    // reads the DOM at commit time and nobody else, which is a fact about how
    // the view is built rather than about what the user did.
    keep.dispatchEvent(new Event("change"));
    textarea().value = "Q: Something else entirely\nA: Indeed";
    textarea().dispatchEvent(new Event("input"));
    save().click();

    expect((await done)?.migrated).toBe(0);
  });

  it("does not offer the choice for a card with no history to keep", async () => {
    await openSheet();

    expect(document.querySelector(".editor-keep")).toBeNull();
  });

  it("keeps the sheet open when the file moved underneath it", async () => {
    await openSheet({ failWrite: 409 });

    textarea().value = "Q: How durable is S3?\nA: 99.999999999%";
    textarea().dispatchEvent(new Event("input"));
    save().click();
    await until(() => !$<HTMLElement>(".editor-error").hidden);

    // Closing here would throw away what was typed, for the one failure the
    // user can actually do something about.
    expect(document.querySelector(".editor-backdrop")).not.toBeNull();
    expect($(".editor-error").textContent).toContain("changed on GitHub");
    expect(textarea().value).toContain("99.999999999%");
    expect(save().disabled).toBe(false);
  });

  it("does not let Escape discard typing", async () => {
    const { done } = await openSheet();
    let closed = false;
    void done.then(() => (closed = true));

    textarea().value = "half a thought";
    textarea().dispatchEvent(new Event("input"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise((r) => setTimeout(r, 0));

    expect(closed).toBe(false);
    expect(document.querySelector(".editor-backdrop")).not.toBeNull();

    // Untouched, it closes on Escape like any other sheet.
    textarea().value = "Q: What is the default S3 durability?\nA: Eleven nines";
    textarea().dispatchEvent(new Event("input"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await done).toBeNull();
  });
});
