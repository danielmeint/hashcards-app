/**
 * Read-only access to a COPY of Anki's `collection.anki2`.
 *
 * The file is never opened read-write. It is opened read-only, serialised,
 * and every query runs against an in-memory database built from those bytes.
 * Two reasons for the detour:
 *
 * - Anki declares columns `COLLATE unicase`, a collation only its own SQLite
 *   build registers. `node:sqlite` cannot register collations, and SQLite
 *   refuses to even scan a WITHOUT ROWID table whose key uses an unknown one
 *   (`fields`, `notetypes`, `decks`). In memory the schema text can be
 *   rewritten to `nocase`. We only ever full-scan, so the ordering difference
 *   between unicase and nocase on non-ASCII text cannot change a result.
 * - A collection in WAL mode cannot be deserialised writable; clearing the
 *   WAL flag in the in-memory header fixes that. Nothing is written back.
 */

import { DatabaseSync } from "node:sqlite";
import { realpathSync } from "node:fs";
import type { RevlogRow } from "./revlog";
import { type DeckKind, type FsrsSettings, decodeDeckConfig, decodeDeckKind } from "./deck-config";

/**
 * The importer's one hard rule: never the live collection, only a copy.
 * Anki's profile directory is `Anki2` on every platform (macOS
 * `~/Library/Application Support/Anki2`, Linux `~/.local/share/Anki2`), so any
 * path through a directory of that name is refused, symlinks resolved.
 */
export function assertNotLiveCollection(path: string): void {
  const real = realpathSync(path);
  if (real.split(/[\\/]/).includes("Anki2")) {
    throw new Error(
      `${path} is inside Anki's profile directory. Copy collection.anki2 (and any -wal/-shm) ` +
        "somewhere else first and pass the copy."
    );
  }
}

export function openCollectionCopy(path: string): DatabaseSync {
  const source = new DatabaseSync(path, { readOnly: true });
  let bytes: Uint8Array;
  try {
    // Includes committed WAL frames when the copy has a -wal beside it.
    bytes = source.serialize();
  } finally {
    source.close();
  }
  // File format bytes 18/19: 2 = WAL, 1 = rollback journal.
  bytes[18] = 1;
  bytes[19] = 1;
  const db = new DatabaseSync(":memory:");
  db.deserialize(bytes);
  db.enableDefensive(false);
  db.exec("PRAGMA writable_schema = ON");
  db.exec(
    "UPDATE sqlite_master SET sql = replace(sql, 'COLLATE unicase', 'COLLATE nocase') " +
      "WHERE sql LIKE '%unicase%'"
  );
  db.exec("PRAGMA writable_schema = RESET");
  db.enableDefensive(true);
  return db;
}

export type CollectionNote = {
  nid: number;
  notetype: string;
  /** The ankictl key from the configured key field, if the notetype has one. */
  key: string | null;
  tags: string[];
};

export type CollectionCard = {
  cid: number;
  nid: number;
  did: number;
  ord: number;
  type: number;
  queue: number;
  due: number;
  odue: number;
  odid: number;
  ivl: number;
  reps: number;
  lapses: number;
  /** `cards.data`: FSRS memory state when FSRS is on. */
  data: { s?: number; d?: number; dr?: number; decay?: number; lrt?: number } | null;
};

export type CollectionData = {
  crt: number;
  rollover: number;
  schedVer: number | null;
  fsrs: boolean;
  decks: Map<number, string>;
  /** Deck id -> its kind: which options preset a normal deck uses. */
  deckKinds: Map<number, DeckKind>;
  /** Options preset id -> its name and FSRS settings. */
  deckConfigs: Map<number, { name: string; fsrs: FsrsSettings }>;
  notes: Map<number, CollectionNote>;
  cards: Map<number, CollectionCard>;
  revlog: RevlogRow[];
};

/** `config.val` is a JSON document stored as a blob. */
function configValue(db: DatabaseSync, key: string): unknown {
  const row = db.prepare("SELECT CAST(val AS TEXT) AS v FROM config WHERE KEY = ?").get(key) as
    | { v: string }
    | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.v);
  } catch {
    return undefined;
  }
}

export function readCollection(db: DatabaseSync, keyField: string): CollectionData {
  const col = db.prepare("SELECT crt FROM col").get() as { crt: number };
  const rollover = configValue(db, "rollover");
  const schedVer = configValue(db, "schedVer");

  const notetypes = new Map<number, string>();
  for (const r of db.prepare("SELECT id, name FROM notetypes").all() as { id: number; name: string }[]) {
    notetypes.set(r.id, r.name);
  }
  // Which field ordinal holds the key, per notetype. Field names are
  // case-insensitive in Anki (unicase), so compare that way.
  const keyOrd = new Map<number, number>();
  for (const r of db.prepare("SELECT ntid, ord, name FROM fields").all() as { ntid: number; ord: number; name: string }[]) {
    if (r.name.toLowerCase() === keyField.toLowerCase()) keyOrd.set(r.ntid, r.ord);
  }

  const decks = new Map<number, string>();
  const deckKinds = new Map<number, DeckKind>();
  for (const r of db.prepare("SELECT id, name, kind FROM decks").all() as {
    id: number;
    name: string;
    kind: Uint8Array;
  }[]) {
    const name = r.name.replaceAll("\x1f", "::");
    decks.set(r.id, name);
    try {
      deckKinds.set(r.id, decodeDeckKind(r.kind));
    } catch (e) {
      throw new Error(`deck "${name}": cannot read its kind: ${(e as Error).message}`);
    }
  }

  const deckConfigs = new Map<number, { name: string; fsrs: FsrsSettings }>();
  for (const r of db.prepare("SELECT id, name, config FROM deck_config").all() as {
    id: number;
    name: string;
    config: Uint8Array;
  }[]) {
    try {
      deckConfigs.set(r.id, { name: r.name, fsrs: decodeDeckConfig(r.config) });
    } catch (e) {
      throw new Error(`deck options "${r.name}": cannot read its config: ${(e as Error).message}`);
    }
  }

  const notes = new Map<number, CollectionNote>();
  for (const r of db.prepare("SELECT id, mid, tags, flds FROM notes").all() as {
    id: number;
    mid: number;
    tags: string;
    flds: string;
  }[]) {
    const ord = keyOrd.get(r.mid);
    const key = ord === undefined ? null : (r.flds.split("\x1f")[ord] ?? "").trim() || null;
    notes.set(r.id, {
      nid: r.id,
      notetype: notetypes.get(r.mid) ?? String(r.mid),
      key,
      tags: r.tags.trim().split(/\s+/).filter(Boolean),
    });
  }

  const cards = new Map<number, CollectionCard>();
  for (const r of db
    .prepare("SELECT id, nid, did, ord, type, queue, due, odue, odid, ivl, reps, lapses, data FROM cards")
    .all() as (Omit<CollectionCard, "cid" | "data"> & { id: number; data: string })[]) {
    let data: CollectionCard["data"] = null;
    try {
      data = r.data ? JSON.parse(r.data) : null;
    } catch {
      data = null;
    }
    const { id, ...rest } = r;
    cards.set(id, { ...rest, cid: id, data });
  }

  const revlog = db
    .prepare("SELECT id, cid, ease, time, type, factor FROM revlog ORDER BY id")
    .all() as RevlogRow[];

  return {
    crt: col.crt,
    rollover: typeof rollover === "number" ? rollover : 4,
    schedVer: typeof schedVer === "number" ? schedVer : null,
    fsrs: configValue(db, "fsrs") === true,
    decks,
    deckKinds,
    deckConfigs,
    notes,
    cards,
    revlog,
  };
}
