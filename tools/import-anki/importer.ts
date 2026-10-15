/**
 * The import itself: deck files + collection data -> output files + report.
 *
 * Pure (no I/O), so the whole mapping is testable with synthetic inputs. The
 * CLI (`import-anki.ts`) does the reading and writing around it.
 */

import type { AnkictlConfig, DeckFile, DeckNote, OutCard, OutDeck } from "./decks.ts";
import { renderDeck } from "./decks.ts";
import type { CollectionCard, CollectionData } from "./collection.ts";
import {
  assignCardIds,
  convertCloze,
  convertMarkdown,
  convertRawHtml,
  deckDisplayName,
  deckToPath,
  escapeBrackets,
} from "./convert.ts";
import type { ReviewEvent, SkipReason } from "./revlog.ts";
import { ankiDue, checkScheduler, classifyRevlog, localMonth, toEvent } from "./revlog.ts";

export type ImportOptions = {
  /** IANA zone the reviews happened in. Anki does not record one. */
  timeZone: string;
  maxMs: number;
  /** Words to write in this case in deck names, e.g. `CKA`. */
  acronyms: string[];
};

/** Why a revlog row did not become an event. */
export type RevlogSkip =
  | SkipReason
  | "card deleted from collection"
  | "note has no key field"
  | "note key not in deck files"
  | "card ordinal has no hashcards card";

export type ReferenceCard = {
  ankiCardId: number;
  deck: string;
  state: "new" | "learning" | "review" | "relearning";
  suspended: boolean;
  buried: boolean;
  /** Local calendar date the card is due, in the import's time zone. */
  due: string | null;
  /** Exact time for intraday learning cards. */
  dueAt?: string;
  /** New-card queue position, for new cards. */
  newPosition?: number;
  intervalDays: number;
  reps: number;
  lapses: number;
  fsrs: {
    stability: number;
    difficulty: number;
    desiredRetention: number | null;
    decay: number | null;
    lastReview: string | null;
  } | null;
};

export type Warning = { key: string | null; message: string };

export type ImportSummary = {
  notes: { inDeckFiles: number; written: number; matchedInAnki: number; notInAnki: number };
  cards: { hashcards: number; ankiMapped: number; ankiUnmapped: number };
  reviews: { revlogRows: number; imported: number; skipped: Record<string, number> };
  idChanges: { key: string; id: string }[];
  /** Per cloze note: Anki c-number -> hashcards card key. */
  clozeMaps: Record<string, Record<string, string>>;
  warnings: Warning[];
};

export type ImportResult = {
  /** Output path (relative, `/`-separated) -> file content. */
  files: Map<string, string>;
  summary: ImportSummary;
};

type NoteKind = "basic" | "cloze";

/**
 * Basic or cloze, by fields rather than by notetype name alone, so a stock
 * Anki "Cloze" or "Basic" note that ankictl adopted converts as well as its own
 * notetypes. ankictl's YAML keys are the lowercased field names.
 */
function noteKind(note: DeckNote, cfg: AnkictlConfig): NoteKind | null {
  const has = (f: string) => f in note.md || f in note.raw;
  if (note.notetype === cfg.clozeNotetype || (has("text") && !has("front"))) return "cloze";
  if (has("front")) return "basic";
  return null;
}

/** Field content as hashcards Markdown, whichever form ankictl stored it in. */
function field(note: DeckNote, name: string, warn: (m: string) => void): string | null {
  if (name in note.raw) {
    const r = convertRawHtml(note.raw[name]);
    r.warnings.forEach((w) => warn(`${name}: ${w}`));
    return r.text;
  }
  if (name in note.md) {
    const r = convertMarkdown(note.md[name]);
    r.warnings.forEach((w) => warn(`${name}: ${w}`));
    return r.text;
  }
  return null;
}

/** Fields a note has besides the ones a card side is built from. */
function otherFields(note: DeckNote, used: string[]): string[] {
  return [...new Set([...Object.keys(note.md), ...Object.keys(note.raw)])].filter((f) => !used.includes(f));
}

/** Extra content under a cloze, set apart as a quote so it reads as a note. */
function asQuote(text: string): string {
  return text
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function buildImport(
  deckFiles: DeckFile[],
  col: CollectionData,
  cfg: AnkictlConfig,
  opts: ImportOptions
): ImportResult {
  const warnings: Warning[] = [];
  const warn = (key: string | null, message: string) => warnings.push({ key, message });

  const schedulerProblem = checkScheduler(col.schedVer);
  if (schedulerProblem) throw new Error(schedulerProblem);

  // ---- Keys -> IDs ------------------------------------------------------
  const allKeys: string[] = [];
  const seenIn = new Map<string, string>();
  for (const f of deckFiles) {
    for (const n of f.notes) {
      if (seenIn.has(n.key)) {
        throw new Error(`duplicate note key '${n.key}' in ${f.source}, already used in ${seenIn.get(n.key)}`);
      }
      seenIn.set(n.key, f.source);
      allKeys.push(n.key);
    }
  }
  const idByKey = assignCardIds(allKeys);
  const idChanges = allKeys.filter((k) => idByKey.get(k) !== k).map((k) => ({ key: k, id: idByKey.get(k)! }));
  for (const c of idChanges) warn(c.key, `key is not a valid card ID; slugged to "${c.id}"`);

  // ---- Collection side, by key -----------------------------------------
  const nidByKey = new Map<string, number>();
  for (const note of col.notes.values()) {
    if (!note.key) continue;
    if (nidByKey.has(note.key)) warn(note.key, "key appears on more than one Anki note; using the first");
    else nidByKey.set(note.key, note.nid);
  }
  const cardsByNid = new Map<number, CollectionCard[]>();
  for (const card of col.cards.values()) {
    const list = cardsByNid.get(card.nid) ?? [];
    list.push(card);
    cardsByNid.set(card.nid, list);
  }

  /** Anki card id -> hashcards card key, for every card we can map. */
  const keyByCid = new Map<number, string>();
  /** Anki card id -> why it has no hashcards card. */
  const unmappedCid = new Map<number, RevlogSkip>();

  // ---- Deck files -> v2 files ------------------------------------------
  const files = new Map<string, string>();
  const deckPaths = new Map<string, string>();
  let written = 0;
  let matched = 0;
  let hashcardsCards = 0;
  const clozeMaps: Record<string, Record<string, string>> = {};

  for (const file of deckFiles) {
    const path = deckToPath(file.deck);
    if (deckPaths.has(path)) {
      throw new Error(`decks "${file.deck}" and "${deckPaths.get(path)}" both map to ${path}`);
    }
    deckPaths.set(path, file.deck);
    const out: OutDeck = { name: deckDisplayName(file.deck, opts.acronyms), tags: uniq(file.tags), cards: [] };

    for (const note of file.notes) {
      const id = idByKey.get(note.key)!;
      const w = (m: string) => warn(note.key, m);
      const kind = noteKind(note, cfg);
      if (!kind) {
        w(`notetype "${note.notetype}" has neither front nor text; note skipped`);
        continue;
      }

      const nid = nidByKey.get(note.key);
      const ankiCards = nid === undefined ? [] : (cardsByNid.get(nid) ?? []);
      if (nid === undefined) w("not in the Anki collection; imported with no history");
      else matched++;

      // Tags: the note's own, minus what the file already applies.
      const tags = uniq(note.tags).filter((t) => !file.tags.includes(t));
      for (const t of tags) if (t.includes(",")) w(`tag "${t}" contains a comma, which Tags: cannot hold`);
      if (nid !== undefined) {
        const known = new Set([...note.tags, ...file.tags, cfg.orphanTag]);
        const ankiOnly = col.notes.get(nid)!.tags.filter((t) => !known.has(t));
        if (ankiOnly.length) w(`Anki-only tags not imported: ${ankiOnly.join(" ")}`);
      }

      const suspended = ankiCards.filter((c) => c.queue === -1).length;
      if (suspended && suspended < ankiCards.length) {
        w(`${suspended} of ${ankiCards.length} Anki cards suspended; Status: is per note, so left active`);
      }
      const status = suspended && suspended === ankiCards.length ? "suspended" : null;

      // Anki card ordinal -> hashcards card key.
      const keyForOrd = new Map<number, string>();
      let card: OutCard;
      if (kind === "basic") {
        const question = field(note, "front", w) ?? "";
        let answer = field(note, "back", w) ?? "";
        for (const extra of otherFields(note, ["front", "back"])) {
          const text = field(note, extra, w);
          if (text) {
            answer = answer ? `${answer}\n\n${text}` : text;
            w(`field "${extra}" appended to the answer`);
          }
        }
        if (!question.trim()) w("empty front");
        if (!answer.trim()) w("empty back");
        // Stock "Basic (and reversed card)" makes ord 1 the reverse. The
        // "optional reversed" kind only does when its Add Reverse field is
        // set, which ankictl stores as an ordinary field; that one is flagged.
        const reverse = /and reversed/i.test(note.notetype);
        if (/optional reversed/i.test(note.notetype)) w("optional-reverse notetype: Reverse: not set; check by hand");
        keyForOrd.set(0, id);
        if (reverse) keyForOrd.set(1, `${id}:r`);
        card = { id, tags, status, reverse, type: "basic", question, answer };
        hashcardsCards += reverse ? 2 : 1;
      } else {
        const source = field(note, "text", w) ?? "";
        const cloze = convertCloze(source);
        cloze.warnings.forEach(w);
        let text = cloze.text;
        for (const extra of otherFields(note, ["text"])) {
          const body = field(note, extra, w);
          // Hashcards has no back-extra for clozes. Kept, but now visible
          // before the reveal as well as after.
          if (body) text += "\n\n" + asQuote(escapeBrackets(body));
        }
        clozeMaps[note.key] = {};
        for (const [cNum, index] of cloze.cNumToIndex) {
          keyForOrd.set(cNum - 1, `${id}:${index}`);
          clozeMaps[note.key][`c${cNum}`] = `${id}:${index}`;
        }
        card = { id, tags, status, reverse: false, type: "cloze", text };
        hashcardsCards += cloze.deletions.length;
      }
      out.cards.push(card);
      written++;

      for (const c of ankiCards) {
        const key = keyForOrd.get(c.ord);
        if (key) keyByCid.set(c.cid, key);
        else {
          unmappedCid.set(c.cid, "card ordinal has no hashcards card");
          w(`Anki card ord ${c.ord} (${kind === "cloze" ? `c${c.ord + 1}` : "template " + c.ord}) has no hashcards card; its reviews are skipped`);
        }
      }
    }
    files.set(path, renderDeck(out));
  }

  // ---- Collection notes the deck files do not have --------------------
  const deckKeys = new Set(allKeys);
  for (const card of col.cards.values()) {
    if (keyByCid.has(card.cid) || unmappedCid.has(card.cid)) continue;
    const note = col.notes.get(card.nid);
    unmappedCid.set(card.cid, note?.key ? "note key not in deck files" : "note has no key field");
  }
  const strayNotes = [...col.notes.values()].filter((n) => !n.key || !deckKeys.has(n.key));
  for (const n of strayNotes) {
    warn(n.key, `Anki note ${n.nid} (${n.notetype}) is not in the deck files; its reviews are skipped`);
  }

  // ---- Revlog -> events --------------------------------------------------
  const skipped: Record<string, number> = {};
  const byMonth = new Map<string, ReviewEvent[]>();
  let imported = 0;
  for (const row of col.revlog) {
    let reason: RevlogSkip | null = null;
    const key = keyByCid.get(row.cid);
    if (!key) reason = unmappedCid.get(row.cid) ?? "card deleted from collection";
    let grade: 1 | 2 | 3 | 4 | null = null;
    if (!reason) {
      const c = classifyRevlog(row);
      if ("skip" in c) reason = c.skip;
      else grade = c.grade;
    }
    if (reason || !key || !grade) {
      skipped[reason!] = (skipped[reason!] ?? 0) + 1;
      continue;
    }
    const event = toEvent(row, key, grade, opts.timeZone, opts.maxMs);
    const month = localMonth(row.id, event.tz);
    const list = byMonth.get(month) ?? [];
    list.push(event);
    byMonth.set(month, list);
    imported++;
  }
  for (const [month, events] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
    // revlog is read ORDER BY id, so each month is already chronological.
    files.set(`reviews/${month}.anki.jsonl`, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  // ---- Reference state --------------------------------------------------
  const reference: Record<string, ReferenceCard> = {};
  for (const [cid, key] of [...keyByCid].sort(([, a], [, b]) => a.localeCompare(b))) {
    reference[key] = referenceCard(col.cards.get(cid)!, col, opts.timeZone);
  }
  files.set(
    "reference.json",
    JSON.stringify(
      {
        about:
          "Anki's scheduling state per hashcards card key at import time, for M6's parity check. " +
          "Due dates are local dates in `timeZone`, with Anki's day rollover applied.",
        timeZone: opts.timeZone,
        rolloverHour: col.rollover,
        fsrsEnabled: col.fsrs,
        cards: reference,
      },
      null,
      2
    ) + "\n"
  );

  const summary: ImportSummary = {
    notes: {
      inDeckFiles: allKeys.length,
      written,
      matchedInAnki: matched,
      notInAnki: written - matched,
    },
    cards: { hashcards: hashcardsCards, ankiMapped: keyByCid.size, ankiUnmapped: unmappedCid.size },
    reviews: { revlogRows: col.revlog.length, imported, skipped },
    idChanges,
    clozeMaps,
    warnings,
  };
  return { files, summary };
}

const STATES = ["new", "learning", "review", "relearning"] as const;

function referenceCard(card: CollectionCard, col: CollectionData, timeZone: string): ReferenceCard {
  const due = ankiDue(card, col.crt, col.rollover, timeZone);
  const data = card.data;
  const fsrs =
    col.fsrs && data && typeof data.s === "number" && typeof data.d === "number"
      ? {
          stability: data.s,
          difficulty: data.d,
          desiredRetention: data.dr ?? null,
          decay: data.decay ?? null,
          lastReview: data.lrt ? new Date(data.lrt * 1000).toISOString() : null,
        }
      : null;
  return {
    ankiCardId: card.cid,
    deck: col.decks.get(card.odid || card.did) ?? String(card.did),
    state: STATES[card.type] ?? "new",
    suspended: card.queue === -1,
    buried: card.queue === -2 || card.queue === -3,
    due: due.kind === "new" ? null : due.date,
    ...(due.kind === "time" ? { dueAt: due.at } : {}),
    ...(due.kind === "new" ? { newPosition: due.position } : {}),
    intervalDays: card.ivl,
    reps: card.reps,
    lapses: card.lapses,
    fsrs,
  };
}
