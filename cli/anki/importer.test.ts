import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFile } from "../../src/parser";
import { assertNotLiveCollection, openCollectionCopy, readCollection } from "./collection";
import { loadAnkictlConfig, loadDeckFiles, parseDeckFile } from "./decks";
import { buildImport, type ImportResult } from "./importer";
import { DECK, FSRS6, makeCollection } from "./test-collection";

let dir: string;
let result: ImportResult;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "import-anki-"));
  makeCollection(join(dir, "collection.anki2"));
  mkdirSync(join(dir, "decks", "decks", "Cka"), { recursive: true });
  writeFileSync(join(dir, "decks", "ankictl.yaml"), "key_field: Key\n");
  writeFileSync(join(dir, "decks", "decks", "Cka", "Storage.yaml"), DECK);

  const cfg = loadAnkictlConfig(join(dir, "decks"));
  const db = openCollectionCopy(join(dir, "collection.anki2"));
  const col = readCollection(db, cfg.keyField);
  db.close();
  result = buildImport(loadDeckFiles(join(dir, "decks", "decks")), col, cfg, {
    timeZone: "Europe/Berlin",
    maxMs: 60_000,
    acronyms: ["CKA"],
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const events = (month: string) =>
  (result.files.get(`reviews/${month}.anki.jsonl`) ?? "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe("buildImport against a synthetic collection", () => {
  it("writes the deck file the app's parser reads", async () => {
    const md = result.files.get("cka/storage.md")!;
    expect(md).toBe(`---
name = "CKA: Storage"
tags = ["storage"]
---

ID: pv-reclaim
Tags: cka/type/syntax-pattern
Q: Reclaim policy that keeps the data?
A: **Retain**\\
(\\~1 min, 2\\~3 retries)

---

ID: pv-binding
C: [\`storageClassName\`] matches, capacity [≥ request], mode [RWO]
Extra: \`k describe pvc\` [events]

---

ID: not-a-slug
Q: Q
A: A
`);
    const cards = await parseFile(md, "cka/storage.md", "storage");
    expect(cards).toHaveLength(5); // 2 basic + 3 deletions
    expect(cards[0].deckName).toBe("CKA: Storage");
    expect(cards[0].tags).toEqual(["storage", "cka/type/syntax-pattern"]);
    // The cloze Extra field is the card's Extra section, on every deletion.
    expect(cards.filter((c) => c.id === "pv-binding").map((c) => c.content.extra)).toEqual(
      Array(3).fill("`k describe pvc` [events]")
    );
  });

  it("maps cloze ordinals by first appearance", () => {
    expect(result.summary.clozeMaps["pv-binding"]).toEqual({
      c3: "pv-binding:1",
      c1: "pv-binding:2",
      c2: "pv-binding:3",
    });
    const sept = events("2026-09").map((e) => e.card);
    expect(sept).toContain("pv-binding:2"); // Anki c1 (ord 0)
    expect(sept).toContain("pv-binding:1"); // Anki c3 (ord 2)
  });

  it("emits v2 events grouped by local month, with per-instant tz", () => {
    expect(events("2026-08")).toEqual([]);
    const sept = events("2026-09");
    expect(sept[0]).toEqual({
      v: 2,
      card: "pv-reclaim",
      at: "2026-08-31T22:30:00.000Z",
      tz: 120,
      grade: 3,
      ms: 9100,
      src: "anki",
    });
    expect(sept[1]).toMatchObject({ grade: 1, ms: 60_000 });
    expect(events("2026-10")).toEqual([
      { v: 2, card: "pv-reclaim", at: "2026-10-26T08:00:00.000Z", tz: 60, grade: 3, ms: 5000, src: "anki" },
    ]);
  });

  it("counts every skipped row by reason", () => {
    expect(result.summary.reviews).toEqual({
      revlogRows: 11,
      imported: 5,
      skipped: {
        "cram (filtered deck without rescheduling)": 1,
        "manual (set due date / forget)": 1,
        rescheduled: 1,
        "card deleted from collection": 1,
        "note key not in deck files": 1,
        "note has no key field": 1,
      },
    });
  });

  it("writes no event for a skipped row, deleted cards' included", () => {
    const written = [...result.files]
      .filter(([path]) => path.startsWith("reviews/"))
      .flatMap(([, text]) => text.trim().split("\n"));
    expect(written).toHaveLength(result.summary.reviews.imported);
    // Row 999's card is gone from the collection: counted above, written nowhere.
    expect([...result.files.values()].join("\n")).not.toContain("2026-09-07T10:00:00");
  });

  it("reports slugged keys, dropped hints, Anki-only tags and partial suspension", () => {
    expect(result.summary.idChanges).toEqual([{ key: "Not A Slug", id: "not-a-slug" }]);
    const messages = result.summary.warnings.map((w) => `${w.key}: ${w.message}`).join("\n");
    expect(messages).toMatch(/pv-binding: c2 hint "hint" dropped/);
    expect(messages).toMatch(/pv-reclaim: Anki-only tags not imported: leech/);
    expect(messages).toMatch(/pv-reclaim: tag "c\+\+" has no valid hashcards form; dropped/);
    expect(messages).toMatch(/pv-binding: 1 of 3 Anki cards suspended/);
    expect(messages).toMatch(/Not A Slug: not in the Anki collection/);
    expect(messages).toMatch(/gone-from-files: Anki note 3/);
    expect(result.summary.notes).toEqual({ inDeckFiles: 3, written: 3, matchedInAnki: 2, notInAnki: 1 });
    expect(result.summary.cards).toEqual({ hashcards: 5, ankiMapped: 4, ankiUnmapped: 2 });
  });

  it("writes Anki's scheduling state per card key", () => {
    const ref = JSON.parse(result.files.get("reference.json")!);
    expect(ref.cards["pv-reclaim"]).toEqual({
      ankiCardId: 101,
      deck: "Cka::Storage",
      state: "review",
      suspended: false,
      buried: false,
      due: "2026-10-11",
      intervalDays: 11,
      reps: 3,
      lapses: 0,
      fsrs: {
        stability: 9.19,
        difficulty: 5.09,
        desiredRetention: 0.9,
        decay: 0.154,
        lastReview: "2026-09-30T11:40:21.000Z",
      },
    });
    expect(ref.deckConfigs).toEqual({
      "1": { name: "Default", fsrs: { version: null, params: [], desiredRetention: 0.9 } },
      "2": { name: "CKA", fsrs: { version: 6, params: FSRS6, desiredRetention: 0.92 } },
    });
    expect(ref.decks).toEqual({
      "Cka::Storage": { config: 2, desiredRetention: 0.85 },
      Cram: { config: null },
      Default: { config: 1 },
    });
    expect(ref.cards["pv-binding:3"]).toMatchObject({ state: "new", due: null, newPosition: 7, fsrs: null });
    expect(ref.cards["pv-binding:1"]).toMatchObject({ suspended: true });
  });
});

describe("safety and parsing details", () => {
  it("refuses a collection inside Anki's profile directory", () => {
    const live = join(dir, "Anki2", "User 1");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "collection.anki2"), "");
    expect(() => assertNotLiveCollection(join(live, "collection.anki2"))).toThrow(/Copy collection.anki2/);
  });

  it("reads YAML the way ankictl's PyYAML did", () => {
    const f = parseDeckFile("deck: D\nnotetype: B\nnotes:\n- key: 42\n  front: yes\n  back_html: <b>x</b>\n", "d.yaml");
    expect(f.notes[0]).toMatchObject({ key: "42", md: { front: "True" }, raw: { back: "<b>x</b>" } });
  });
});
