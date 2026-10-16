import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFile as parseLog } from "../../src/core/events";
import type { ReviewLogEvent } from "../../src/core/events";
import { ANKI_DEVICE, monthFiles, parseMonthFilePath } from "../../src/core/month-files";
import { parseFile } from "../../src/parser";
import { stripIds } from "../../src/card-ids";
import { assertNotLiveCollection, openCollectionCopy, readCollection } from "../anki/collection";
import { loadAnkictlConfig, loadDeckFiles } from "../anki/decks";
import { buildImport } from "../anki/importer";
import type { ImportSummary, ReferenceCard } from "../anki/importer";
import { checkModel, checkParity } from "../anki/parity";
import type { ModelParity, Parity } from "../anki/parity";
import { DEFAULT_MAX_MS, tzOffsetMinutes } from "../anki/revlog";
import { defaultDeckName, isDeckPath, loadCollection } from "../collection";
import { CONFIG_FILE } from "../config";
import { CommandError, EXIT, UsageError } from "../command";
import type { Command, Context } from "../command";
import { plural } from "../format";
import {
  commitTree,
  currentBranch,
  dirtyPaths,
  isGitRepo,
  listFiles,
  moveWorktree,
  resolveRef,
  updateRefs,
  writeTree,
} from "../git";
import type { TreeChanges } from "../git";
import { DATA_BRANCH, STATE_FILE, V1_LOG_DIR, dataRef } from "../history";
import { message } from "./migrate";

/**
 * `hc import anki` (PLAN-1.0 M6): an ankictl deck repo and a copy of the Anki
 * collection, into a 1.0 card repo.
 *
 * - On the current branch: one deck file per Anki deck, under `--dir`.
 * - On `hashcards-data`: Anki's review log as `reviews/<month>.anki.jsonl`
 *   (`anki` is a reserved writer name: no device rebuilds those files).
 *
 * The conversion is `cli/anki/`, unchanged from the M6 prototype. Its rules
 * carry over too: the collection is only ever a copy (a path through an
 * `Anki2` directory is refused), opened read-only and patched in memory.
 *
 * Like `hc migrate`, a dry run unless `--apply`, both branches moved in one
 * ref transaction, nothing pushed. The dry run also runs the parity check —
 * the imported reviews replayed by hashcards against Anki's own due dates —
 * since that is what to look at before trusting the import.
 */

export const importCmd: Command = {
  name: "import",
  summary: "import an Anki collection: decks to main, reviews to hashcards-data (hc import anki)",
  positionals: 1,
  help: `Usage: hc import anki --decks <ankictl repo> --collection <copy of collection.anki2>
                      [--into <card repo>] [--dir <dir>] [--apply]

Converts an ankictl deck repo (ankictl.yaml + decks/**/*.yaml) and a COPY of
the Anki collection into a migrated (1.0) card repo:

  <branch>         one deck file per Anki deck, under --dir
  hashcards-data   the review log, reviews/<month>.anki.jsonl ("anki" is reserved)

A dry run by default: prints what would be written, the importer's warnings,
and a parity check (the imported reviews replayed by hashcards, against Anki's
due dates). With --apply, one commit on each branch, locally. Never pushes.

Never the live collection: a path inside an Anki2 directory is refused. Copy
collection.anki2 and any -wal/-shm beside it somewhere else first. The copy is
only read.

Refuses a dirty working tree, a repo not yet migrated (run \`hc migrate\`),
deck files or cards the repo already has, and a second import (unless --force).

Options:
  --decks <dir>        ankictl repo (required)
  --collection <file>  a copy of collection.anki2 (required)
  --into <dir>         the card repo (default: --repo, or the current directory)
  --dir <dir>          where the decks go; replaces the top-level Anki deck's
                       directory (default: its name, e.g. cka/)
  --tz <zone>          IANA zone the reviews were done in (default Europe/Berlin)
  --max-ms <n>         cap on one review's time (default ${DEFAULT_MAX_MS})
  --acronym <word>     write this word in this case in deck names (repeatable)
  --out <dir>          also write reference.json and import-report.json there
  --force              replace an earlier import's review files
  --verbose            every warning and every parity row
  --apply              commit (default: dry run)

Exit: 0 done (or would be), 1 dry run found blockers, 2 refused or error.`,
  options: {
    decks: { type: "string" },
    collection: { type: "string" },
    into: { type: "string" },
    dir: { type: "string" },
    tz: { type: "string" },
    "max-ms": { type: "string" },
    acronym: { type: "string", multiple: true },
    out: { type: "string" },
    force: { type: "boolean" },
    verbose: { type: "boolean" },
    apply: { type: "boolean" },
  },
  async run(ctx) {
    if (ctx.positionals[0] !== "anki") {
      throw new UsageError(
        ctx.positionals[0] === undefined
          ? "say what to import: hc import anki"
          : `can only import from anki, not '${ctx.positionals[0]}'`
      );
    }
    const opt = (name: string) => (typeof ctx.values[name] === "string" ? (ctx.values[name] as string) : undefined);
    const decksDir = opt("decks");
    const collectionPath = opt("collection");
    if (!decksDir || !collectionPath) throw new UsageError("--decks and --collection are required");
    const timeZone = opt("tz") ?? "Europe/Berlin";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
    } catch {
      throw new UsageError(`--tz: unknown time zone '${timeZone}'`);
    }
    const maxMs = Number(opt("max-ms") ?? DEFAULT_MAX_MS);
    if (!Number.isFinite(maxMs) || maxMs <= 0) throw new UsageError("--max-ms must be a positive number");
    const repo = opt("into") ? resolve(ctx.io.cwd, opt("into")!) : ctx.repo;

    // Read the sources first: a refused collection path must stop everything.
    const source = resolve(ctx.io.cwd, decksDir);
    if (!statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
      throw new CommandError(`--decks: ${source} is not a directory`);
    }
    const colPath = resolve(ctx.io.cwd, collectionPath);
    if (!existsSync(colPath)) throw new CommandError(`--collection: ${colPath} does not exist`);
    let built;
    try {
      assertNotLiveCollection(colPath);
      const cfg = loadAnkictlConfig(source);
      const decks = loadDeckFiles(join(source, cfg.decksDir));
      const db = openCollectionCopy(colPath);
      const col = readCollection(db, cfg.keyField);
      db.close();
      built = buildImport(decks, col, cfg, {
        timeZone,
        maxMs,
        acronyms: (ctx.values.acronym as string[] | undefined) ?? [],
      });
    } catch (error) {
      if (error instanceof CommandError) throw error;
      throw new CommandError((error as Error).message);
    }

    if (!isGitRepo(repo)) throw new CommandError(`${repo} is not a git repository`);
    const head = resolveRef(repo, "HEAD");
    if (!head) throw new CommandError("the card repo has no commits");
    const branch = currentBranch(repo);

    // --- What would be written --------------------------------------------
    const deckPaths = [...built.files.keys()].filter((p) => p.endsWith(".md"));
    const place = placement(deckPaths, opt("dir"));
    // The importer names cards by ID, as ankictl's note keys; a card is its
    // text (PLAN-1.0 §2.7). Each ID key maps to the card's content key, and
    // the ID lines come out of the files.
    const keyOf = new Map<string, string>();
    const newKeys = new Map<string, string>();
    const parseErrors: string[] = [];
    const decks = new Map<string, string>();
    for (const p of deckPaths) {
      const path = place(p);
      const text = built.files.get(p)!;
      try {
        for (const card of await parseFile(text, path, defaultDeckName(path))) {
          if (card.legacyKey) keyOf.set(card.legacyKey, card.key);
          newKeys.set(card.key, path);
        }
        decks.set(path, stripIds(text, path));
      } catch (error) {
        parseErrors.push(`${path} as converted does not parse: ${(error as Error).message}`);
        decks.set(path, text);
      }
    }
    const rekey = (key: string) => keyOf.get(key) ?? key;
    const events: ReviewLogEvent[] = [];
    for (const [path, text] of built.files) {
      if (!path.startsWith("reviews/")) continue;
      const parsed = parseLog(text);
      // The importer writes these lines itself; one that does not parse is a bug.
      if (parsed.errors.length > 0) throw new CommandError(`${path}:${parsed.errors[0].line}: ${parsed.errors[0].error}`);
      events.push(...parsed.events.map((e) => ({ ...e, card: rekey(e.card) })));
    }
    const reviewFiles = monthFiles(events, ANKI_DEVICE);
    const referenceById = JSON.parse(built.files.get("reference.json")!) as {
      rolloverHour: number;
      cards: Record<string, ReferenceCard>;
    };
    const reference = {
      ...referenceById,
      cards: Object.fromEntries(Object.entries(referenceById.cards).map(([k, v]) => [rekey(k), v])),
    };

    // --- Blockers ----------------------------------------------------------
    const blockers: string[] = [];
    if (!branch) blockers.push("HEAD is detached: check out the branch to import into (main)");
    const dirty = dirtyPaths(repo);
    if (dirty.length > 0) {
      blockers.push(`the working tree has changes; commit or stash them first:\n${dirty.slice(0, 10).map((l) => `    ${l}`).join("\n")}`);
    }
    const tracked = listFiles(repo, head);
    if (tracked.includes(STATE_FILE) || tracked.some((p) => p.startsWith(`${V1_LOG_DIR}/`))) {
      blockers.push("the repo has not been migrated to 1.0 yet: run `hc migrate` first");
    }
    const collection = await loadCollection(repo);
    for (const path of decks.keys()) {
      if (existsSync(join(repo, path))) blockers.push(`${path} already exists`);
      if (!isDeckPath(path, collection.config.config)) {
        blockers.push(`${path} would not be read as a deck under ${CONFIG_FILE}'s [decks] globs`);
      }
    }
    blockers.push(...parseErrors);
    const there = new Map(collection.cards.map((c) => [c.key, c]));
    const clashes = [...newKeys.keys()].filter((key) => there.has(key));
    if (clashes.length > 0) {
      blockers.push(
        `${plural(clashes.length, "card")} already in the repo: ` +
          clashes.slice(0, 10).map((k) => `${there.get(k)!.filePath}:${there.get(k)!.range[0]}`).join(", ")
      );
    }
    const tipRef = dataRef(repo);
    const tip = tipRef ? resolveRef(repo, tipRef) : null;
    const earlier = tip ? listFiles(repo, tip, "reviews").filter((p) => parseMonthFilePath(p)?.device === ANKI_DEVICE) : [];
    if (earlier.length > 0 && !ctx.values.force) {
      blockers.push(`${DATA_BRANCH} already has ${plural(earlier.length, "Anki review file")} (--force replaces them)`);
    }

    // --- Parity ------------------------------------------------------------
    const review = collection.config.config.review;
    const parity = checkParity(events, reference.cards, { retention: review.desiredRetention, fuzz: review.fuzz });
    const model = checkModel(events, reference.cards, reference.rolloverHour, (ms) => tzOffsetMinutes(ms, timeZone), {
      retention: review.desiredRetention,
    });

    const out = opt("out");
    if (out) writeOut(resolve(ctx.io.cwd, out), built.files.get("reference.json")!, built.summary);

    const report = { repo, branch, decks, reviewFiles, summary: built.summary, parity, model, earlier };
    if (!ctx.values.apply || blockers.length > 0) {
      if (ctx.json) ctx.emit({ applied: false, blockers, ...jsonReport(report) });
      else {
        printReport(ctx, report);
        ctx.say("");
        if (blockers.length === 0) ctx.say("No blockers. Run again with --apply to commit it.");
        else {
          ctx.say(ctx.values.apply ? "Refusing to apply:" : "Blockers (--apply would refuse):");
          for (const b of blockers) ctx.say(`  - ${b}`);
          if (ctx.values.apply) ctx.io.stderr(`hc import anki: refused, ${plural(blockers.length, "blocker")} (see above)\n`);
        }
      }
      if (blockers.length === 0) return EXIT.ok;
      return ctx.values.apply ? EXIT.error : EXIT.findings;
    }

    // --- Commit -----------------------------------------------------------
    const s = built.summary;
    const dataChanges: TreeChanges = new Map();
    for (const path of earlier) dataChanges.set(path, null);
    for (const [path, text] of reviewFiles) dataChanges.set(path, text);
    const data = commitTree(
      repo,
      writeTree(repo, tip, dataChanges),
      tip ? [tip] : [],
      message("Import the Anki review log", [
        `${plural(s.reviews.imported, "review")} of ${plural(s.cards.ankiMapped, "card")}, ` +
          `from ${plural(s.reviews.revlogRows, "revlog row")} (${s.reviews.revlogRows - s.reviews.imported} skipped). ` +
          `Times in ${timeZone}.`,
        "Written by `hc import anki`.",
      ])
    );
    const mainChanges: TreeChanges = new Map(decks);
    const main = commitTree(
      repo,
      writeTree(repo, head, mainChanges),
      [head],
      message("Import the Anki decks", [
        `${plural(s.notes.written, "note")} in ${plural(decks.size, "deck file")}, ` +
          `${plural(s.cards.hashcards, "card")}. Their history is on ${DATA_BRANCH}, ${data.slice(0, 7)}.`,
        "Written by `hc import anki`.",
      ])
    );
    updateRefs(
      repo,
      [
        { ref: `refs/heads/${branch}`, to: main, old: head },
        // Built on the remote's tip when there is no local branch yet: the
        // local one is then created, and the push is a fast-forward.
        { ref: `refs/heads/${DATA_BRANCH}`, to: data, old: resolveRef(repo, `refs/heads/${DATA_BRANCH}`) },
      ],
      "hc import anki"
    );
    moveWorktree(repo, head, main);

    const push = `git push --atomic origin ${branch} ${DATA_BRANCH}`;
    if (ctx.json) ctx.emit({ applied: true, commits: { main, data }, push, ...jsonReport(report) });
    else {
      printReport(ctx, report);
      ctx.say("");
      ctx.say("Committed (locally, nothing pushed):");
      ctx.say(`  ${branch}  ${main.slice(0, 7)}  the decks`);
      ctx.say(`  ${DATA_BRANCH}  ${data.slice(0, 7)}  the review log`);
      ctx.say("");
      ctx.say("Check it (`hc lint`, `hc due`, `hc stats`), then publish both branches together:");
      ctx.say(`  ${push}`);
    }
    return EXIT.ok;
  },
};

/**
 * Where each converted deck goes. The importer names files after the Anki
 * deck path (`Cka::Storage` → `cka/storage.md`); `--dir` replaces the
 * top-level deck's directory when every deck shares one, and otherwise holds
 * them all.
 */
export function placement(paths: string[], dir: string | undefined): (path: string) => string {
  if (dir === undefined) return (p) => p;
  const target = dir.replace(/^\.?\/+|\/+$/g, "");
  const prefix = target === "" || target === "." ? "" : `${target}/`;
  const tops = new Set(paths.map((p) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : null)));
  const [top] = tops;
  const shared = tops.size === 1 && top !== null ? top : null;
  return (p) => prefix + (shared !== null ? p.slice(shared.length + 1) : p);
}

/** `--out`: the files the prototype wrote for inspection. Only into a new or empty directory. */
function writeOut(dir: string, reference: string, summary: ImportSummary): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new CommandError(`--out: ${dir} is not empty; refusing to write there`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "reference.json"), reference);
  writeFileSync(join(dir, "import-report.json"), JSON.stringify(summary, null, 2) + "\n");
}

type Report = {
  repo: string;
  branch: string | null;
  decks: Map<string, string>;
  reviewFiles: Map<string, string>;
  summary: ImportSummary;
  parity: Parity;
  model: ModelParity;
  earlier: string[];
};

function parityJson(p: Parity) {
  return {
    compared: p.compared,
    withinOneDay: p.withinOneDay,
    share: p.share,
    histogram: Object.fromEntries(p.histogram),
    skipped: p.skipped,
    rows: p.rows,
  };
}

function jsonReport(r: Report) {
  return {
    repo: r.repo,
    decks: [...r.decks.keys()],
    reviewFiles: [...r.reviewFiles.keys()],
    replaces: r.earlier,
    summary: r.summary,
    parity: parityJson(r.parity),
    parityWithoutFuzz: { ...r.model, histogram: Object.fromEntries(r.model.histogram) },
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function printReport(ctx: Context, r: Report): void {
  const s = r.summary;
  const verbose = ctx.values.verbose === true;
  ctx.say(ctx.values.apply ? "hc import anki" : "hc import anki: dry run, nothing written (--apply to commit)");
  ctx.say("");
  ctx.say(
    `Notes     ${s.notes.inDeckFiles} in deck files, ${s.notes.written} written, ` +
      `${s.notes.matchedInAnki} matched in Anki, ${s.notes.notInAnki} not in Anki`
  );
  ctx.say(
    `Cards     ${s.cards.hashcards} hashcards cards; ${s.cards.ankiMapped} Anki cards mapped, ${s.cards.ankiUnmapped} unmapped`
  );
  ctx.say(`Decks     → ${r.branch ?? "HEAD"}:`);
  for (const path of r.decks.keys()) ctx.say(`            ${path}`);
  ctx.say(
    `Reviews   ${s.reviews.revlogRows} revlog rows, ${s.reviews.imported} imported, ` +
      `${s.reviews.revlogRows - s.reviews.imported} skipped → ${DATA_BRANCH}:`
  );
  for (const [reason, n] of Object.entries(s.reviews.skipped).sort(([, a], [, b]) => b - a)) {
    ctx.say(`            ${String(n).padStart(5)}  skipped: ${reason}`);
  }
  for (const path of r.reviewFiles.keys()) ctx.say(`            ${path}`);
  if (r.earlier.length > 0) ctx.say(`          replacing ${plural(r.earlier.length, "earlier Anki file")}`);
  ctx.say(`Warnings  ${s.warnings.length}${s.warnings.length && !verbose ? " (--verbose lists them)" : ""}`);
  if (verbose) for (const w of s.warnings) ctx.say(`            ${w.key ?? "-"}: ${w.message}`);

  const p = r.parity;
  ctx.say("");
  ctx.say(`Parity    hashcards' replay (default FSRS parameters) against Anki's due dates`);
  ctx.say(`          ${p.withinOneDay} of ${p.compared} within a day of Anki's due date: ${pct(p.share)}`);
  ctx.say(
    `          left out: ${p.skipped.new} new, ${p.skipped.suspended} suspended, ${p.skipped.noHistory} with no imported reviews`
  );
  ctx.say(`          days (hashcards − Anki) → cards: ${[...p.histogram].map(([d, n]) => `${d > 0 ? "+" : ""}${d}: ${n}`).join(", ")}`);
  const m = r.model;
  ctx.say(
    `          without fuzz on either side: ${m.withinOneDay} of ${m.compared} within a day (${pct(m.share)}); ` +
      `stability within 1% of Anki's for ${m.sameStability}`
  );
  ctx.say(`          days → cards, without fuzz: ${[...m.histogram].map(([d, n]) => `${d > 0 ? "+" : ""}${d}: ${n}`).join(", ")}`);
  const shown = verbose ? p.rows : p.rows.filter((row) => Math.abs(row.delta) > 1).slice(0, 10);
  for (const row of shown) {
    ctx.say(`            ${row.key.padEnd(40)} ${row.state.padEnd(10)} anki ${row.anki}  hashcards ${row.hashcards}  ${row.delta > 0 ? "+" : ""}${row.delta}`);
  }
}
