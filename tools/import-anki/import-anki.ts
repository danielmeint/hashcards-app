#!/usr/bin/env node
/**
 * Prototype of `hc import anki` (PLAN-1.0.md M6).
 *
 *   node tools/import-anki/import-anki.ts \
 *     --decks ~/projects/personal/anki-decks \
 *     --collection /tmp/anki-copy/collection.anki2 \
 *     --out tools/import-anki/out
 *
 * Reads only. Writes only into --out, which must be empty, missing, or a
 * previous output of this tool (recognised by its marker file).
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadAnkictlConfig, loadDeckFiles } from "./decks.ts";
import { assertNotLiveCollection, openCollectionCopy, readCollection } from "./collection.ts";
import { buildImport, type ImportSummary } from "./importer.ts";
import { DEFAULT_MAX_MS } from "./revlog.ts";

const MARKER = ".import-anki-output";

const USAGE = `usage: node tools/import-anki/import-anki.ts --decks <anki-decks dir> --collection <copy of collection.anki2> --out <dir>
  --tz <IANA zone>     zone the reviews happened in (default Europe/Berlin)
  --max-ms <n>         cap on a review's time (default ${DEFAULT_MAX_MS})
  --acronym <word>     write this word in this case in deck names (repeatable), e.g. CKA
  --json               print the summary as JSON`;

/**
 * Refuse to write anywhere that is not ours: a typo in --out must not be able
 * to overwrite a deck repo. A previous output (it has the marker) is cleared,
 * so a re-run never leaves stale month files behind.
 */
function prepareOutDir(out: string): void {
  if (existsSync(out)) {
    const entries = readdirSync(out);
    if (entries.length && !entries.includes(MARKER)) {
      throw new Error(`${out} is not empty and is not a previous import-anki output; refusing to write there`);
    }
    if (entries.length) rmSync(out, { recursive: true });
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, MARKER), "Written by tools/import-anki. Safe to delete.\n");
}

function printSummary(s: ImportSummary, out: string): void {
  const lines = [
    `notes    ${s.notes.inDeckFiles} in deck files, ${s.notes.written} written, ` +
      `${s.notes.matchedInAnki} matched in Anki, ${s.notes.notInAnki} not in Anki`,
    `cards    ${s.cards.hashcards} hashcards cards; ${s.cards.ankiMapped} Anki cards mapped, ` +
      `${s.cards.ankiUnmapped} unmapped`,
    `reviews  ${s.reviews.revlogRows} revlog rows, ${s.reviews.imported} imported, ` +
      `${s.reviews.revlogRows - s.reviews.imported} skipped`,
  ];
  for (const [reason, n] of Object.entries(s.reviews.skipped).sort(([, a], [, b]) => b - a)) {
    lines.push(`           ${String(n).padStart(5)}  ${reason}`);
  }
  if (s.idChanges.length) lines.push(`ids      ${s.idChanges.length} keys slugged (see import-report.json)`);
  lines.push(`warnings ${s.warnings.length}`);
  for (const w of s.warnings) lines.push(`  ${w.key ?? "-"}: ${w.message}`);
  lines.push(`output   ${out}`);
  console.log(lines.join("\n"));
}

function main(): void {
  const { values } = parseArgs({
    options: {
      decks: { type: "string" },
      collection: { type: "string" },
      out: { type: "string" },
      tz: { type: "string", default: "Europe/Berlin" },
      "max-ms": { type: "string", default: String(DEFAULT_MAX_MS) },
      acronym: { type: "string", multiple: true, default: [] },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || !values.decks || !values.collection || !values.out) {
    console.error(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  const maxMs = Number(values["max-ms"]);
  if (!Number.isFinite(maxMs) || maxMs <= 0) throw new Error("--max-ms must be a positive number");
  // Fails fast on a zone name Intl does not know.
  new Intl.DateTimeFormat("en-US", { timeZone: values.tz });

  const repo = resolve(values.decks);
  const cfg = loadAnkictlConfig(repo);
  const decks = loadDeckFiles(join(repo, cfg.decksDir));

  assertNotLiveCollection(values.collection);
  const db = openCollectionCopy(values.collection);
  const col = readCollection(db, cfg.keyField);
  db.close();

  const result = buildImport(decks, col, cfg, {
    timeZone: values.tz!,
    maxMs,
    acronyms: values.acronym as string[],
  });

  const out = resolve(values.out);
  prepareOutDir(out);
  for (const [path, content] of result.files) {
    const target = join(out, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  writeFileSync(join(out, "import-report.json"), JSON.stringify(result.summary, null, 2) + "\n");

  if (values.json) console.log(JSON.stringify(result.summary, null, 2));
  else printSummary(result.summary, out);
}

try {
  main();
} catch (err) {
  console.error(`import-anki: ${(err as Error).message}`);
  process.exit(1);
}
