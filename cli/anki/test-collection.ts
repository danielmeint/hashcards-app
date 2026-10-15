import { DatabaseSync } from "node:sqlite";
import { pb } from "./protobuf-writer";

/**
 * A synthetic Anki collection and ankictl deck, shared by the importer's
 * tests and `hc import anki`'s.
 */

/**
 * A tiny collection with Anki's real quirks: WAL mode, and `COLLATE unicase`
 * on the tables the importer reads. node:sqlite cannot create a unicase
 * column, so the tables are made with nocase and the schema text is flipped
 * afterwards, which is exactly what the importer has to undo.
 */
export function makeCollection(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE col (id integer PRIMARY KEY, crt integer NOT NULL);
    CREATE TABLE config (KEY text NOT NULL PRIMARY KEY, val blob NOT NULL) WITHOUT ROWID;
    CREATE TABLE notetypes (id integer NOT NULL PRIMARY KEY, name text NOT NULL COLLATE nocase);
    CREATE TABLE fields (ntid integer NOT NULL, ord integer NOT NULL, name text NOT NULL COLLATE nocase,
      PRIMARY KEY (ntid, ord)) WITHOUT ROWID;
    CREATE TABLE decks (id integer PRIMARY KEY NOT NULL, name text NOT NULL COLLATE nocase, kind blob NOT NULL);
    CREATE TABLE deck_config (id integer PRIMARY KEY NOT NULL, name text NOT NULL COLLATE nocase, config blob NOT NULL);
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
  `);
  // Default: never optimised. CKA: FSRS-6 parameters, and the Storage deck
  // overrides its retention. A filtered deck has no preset.
  const deck = db.prepare("INSERT INTO decks VALUES (?, ?, ?)");
  deck.run(1, "Default", pb.blob(pb.bytes(1, pb.uint(1, 1))));
  deck.run(100, "Cka\x1fStorage", pb.blob(pb.bytes(1, [...pb.uint(1, 2), ...pb.float(10, 0.85)])));
  deck.run(200, "Cram", pb.blob(pb.bytes(2, pb.uint(1, 1))));
  const preset = db.prepare("INSERT INTO deck_config VALUES (?, ?, ?)");
  preset.run(1, "Default", pb.blob(pb.packedFloats(1, [1, 10]), pb.float(37, 0.9)));
  preset.run(2, "CKA", pb.blob(pb.packedFloats(6, FSRS6), pb.float(37, 0.92)));
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

export const FSRS6 = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
  0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

export const DECK = `deck: Cka::Storage
notetype: Flashcards-as-Code Basic
tags: [storage]
notes:
- key: pv-reclaim
  tags: [CKA::Type::Syntax-Pattern, Storage, c++]
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

