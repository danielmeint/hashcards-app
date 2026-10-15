import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFile } from "../../src/parser";
import { assertNotLiveCollection, openCollectionCopy, readCollection } from "./collection.ts";
import { loadAnkictlConfig, loadDeckFiles, parseDeckFile } from "./decks.ts";
import { buildImport, type ImportResult } from "./importer.ts";

/**
 * A tiny collection with Anki's real quirks: WAL mode, and `COLLATE unicase`
 * on the tables the importer reads. node:sqlite cannot create a unicase
 * column, so the tables are made with nocase and the schema text is flipped
 * afterwards, which is exactly what the importer has to undo.
 */
function makeCollection(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE col (id integer PRIMARY KEY, crt integer NOT NULL);
    CREATE TABLE config (KEY text NOT NULL PRIMARY KEY, val blob NOT NULL) WITHOUT ROWID;
    CREATE TABLE notetypes (id integer NOT NULL PRIMARY KEY, name text NOT NULL COLLATE nocase);
    CREATE TABLE fields (ntid integer NOT NULL, ord integer NOT NULL, name text NOT NULL COLLATE nocase,
      PRIMARY KEY (ntid, ord)) WITHOUT ROWID;
    CREATE TABLE decks (id integer PRIMARY KEY NOT NULL, name text NOT NULL COLLATE nocase);
    CREATE TABLE notes (id integer PRIMARY KEY, mid integer NOT NULL, tags text NOT NULL, flds text NOT NULL);
    CREATE TABLE cards (id integer PRIMARY KEY, nid integer NOT NULL, did integer NOT NULL, ord integer NOT NULL,
      type integer NOT NULL, queue integer NOT NULL, due integer NOT NULL, ivl integer NOT NULL,
      reps integer NOT NULL, lapses integer NOT NULL, odue integer NOT NULL, odid integer NOT NULL, data text NOT NULL);
    CREATE TABLE revlog (id integer PRIMARY KEY, cid integer NOT NULL, ease integer NOT NULL,
      time integer NOT NULL, type integer NOT NULL, factor integer NOT NULL);
  `);
  // 2026-02-15 04:00 CET, rollover 4, as in the real collection.
  db.exec("INSERT INTO col VALUES (1, 1771124400)");
  const config = db.prepare("INSERT INTO config VALUES (?, CAST(? AS BLOB))");
  config.run("rollover", "4");
  config.run("schedVer", "2");
  config.run("fsrs", "true");
  db.exec(`
    INSERT INTO notetypes VALUES (10, 'Flashcards-as-Code Basic'), (20, 'Flashcards-as-Code Cloze'), (30, 'Basic');
    INSERT INTO fields VALUES (10, 0, 'Front'), (10, 1, 'Back'), (10, 2, 'Key'),
      (20, 0, 'Text'), (20, 1, 'Extra'), (20, 2, 'key'), (30, 0, 'Front'), (30, 1, 'Back');
    INSERT INTO decks VALUES (1, 'Default'), (100, 'Cka' || char(31) || 'Storage');
  `);
  const sep = "\x1f";
  const note = db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?)");
  note.run(1, 10, " storage leech ", ["Q", "A", "pv-reclaim"].join(sep));
  note.run(2, 20, " storage ", ["…", "", "pv-binding"].join(sep));
  note.run(3, 10, " ", ["Q", "A", "gone-from-files"].join(sep));
  note.run(4, 30, " ", ["unmanaged", "note"].join(sep));

  const card = db.prepare("INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const fsrs = JSON.stringify({ s: 9.19, d: 5.09, dr: 0.9, decay: 0.154, lrt: 1790768421 });
  card.run(101, 1, 100, 0, 2, 2, 238, 11, 3, 0, 0, 0, fsrs); // review, due day 238
  card.run(201, 2, 100, 0, 2, 2, 230, 3, 2, 0, 0, 0, "{}"); // c1
  card.run(202, 2, 100, 1, 0, 0, 7, 0, 0, 0, 0, 0, "{}"); // c2, new
  card.run(203, 2, 100, 2, 2, -1, 231, 4, 2, 0, 0, 0, "{}"); // c3, suspended
  card.run(301, 3, 100, 0, 2, 2, 230, 3, 1, 0, 0, 0, "{}");
  card.run(401, 4, 100, 0, 2, 2, 230, 3, 1, 0, 0, 0, "{}");

  const rev = db.prepare("INSERT INTO revlog VALUES (?, ?, ?, ?, ?, ?)");
  const at = (iso: string) => Date.parse(iso);
  rev.run(at("2026-08-31T22:30:00Z"), 101, 3, 9100, 0, 0); // 00:30 local, September
  rev.run(at("2026-09-02T18:01:44Z"), 101, 1, 600000, 1, 2500); // time capped
  rev.run(at("2026-10-26T08:00:00Z"), 101, 3, 5000, 1, 2500); // after DST: +60
  rev.run(at("2026-09-03T10:00:00Z"), 201, 3, 4000, 0, 0); // c1
  rev.run(at("2026-09-03T10:01:00Z"), 203, 2, 4000, 0, 0); // c3
  rev.run(at("2026-09-04T10:00:00Z"), 101, 3, 4000, 3, 0); // cram
  rev.run(at("2026-09-05T10:00:00Z"), 101, 0, 0, 4, 0); // manual
  rev.run(at("2026-09-06T10:00:00Z"), 101, 0, 0, 5, 0); // rescheduled
  rev.run(at("2026-09-07T10:00:00Z"), 999, 3, 4000, 1, 2500); // card deleted
  rev.run(at("2026-09-08T10:00:00Z"), 301, 3, 4000, 1, 2500); // note not in files
  rev.run(at("2026-09-09T10:00:00Z"), 401, 3, 4000, 1, 2500); // note without key field

  db.enableDefensive(false);
  db.exec("PRAGMA writable_schema = ON");
  db.exec("UPDATE sqlite_master SET sql = replace(sql, 'COLLATE nocase', 'COLLATE unicase')");
  db.close();
}

const DECK = `deck: Cka::Storage
notetype: Flashcards-as-Code Basic
tags: [storage]
notes:
- key: pv-reclaim
  tags: [CKA::Type::Syntax-Pattern]
  front: Reclaim policy that keeps the data?
  back: |-
    **Retain**\\
    (~1 min, 2~3 retries)
- key: pv-binding
  notetype: Flashcards-as-Code Cloze
  text: |-
    {{c3::\`storageClassName\`}} matches, capacity {{c1::≥ request}}, mode {{c2::RWO::hint}}
  extra: |-
    \`k describe pvc\` [events]
- key: Not A Slug
  front: Q
  back: A
`;

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
Tags: CKA::Type::Syntax-Pattern
Q: Reclaim policy that keeps the data?
A: **Retain**\\
(\\~1 min, 2\\~3 retries)

---

ID: pv-binding
C: [\`storageClassName\`] matches, capacity [≥ request], mode [RWO]

> \`k describe pvc\` \\[events\\]

---

ID: not-a-slug
Q: Q
A: A
`);
    const cards = await parseFile(md, "cka/storage.md", "storage");
    expect(cards).toHaveLength(5); // 2 basic + 3 deletions
    expect(cards[0].deckName).toBe("CKA: Storage");
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

  it("reports slugged keys, dropped hints, Anki-only tags and partial suspension", () => {
    expect(result.summary.idChanges).toEqual([{ key: "Not A Slug", id: "not-a-slug" }]);
    const messages = result.summary.warnings.map((w) => `${w.key}: ${w.message}`).join("\n");
    expect(messages).toMatch(/pv-binding: c2 hint "hint" dropped/);
    expect(messages).toMatch(/pv-reclaim: Anki-only tags not imported: leech/);
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
