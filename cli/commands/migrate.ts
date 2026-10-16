import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { planIdRemoval, planMigration } from "../../src/migrate";
import type { CheckRow, MigrationPlan } from "../../src/migrate";
import { hasIds } from "../../src/card-ids";
import { utcOffsetMinutes } from "../../src/core/schedule";
import { linkFileChanges } from "../links";
import { localDay } from "../../src/fsrs";
import { isDeckPath, isDocFile, loadCollection, markdownFiles } from "../collection";
import type { Collection } from "../collection";
import { CONFIG_FILE, parseConfig, renderConfig } from "../config";
import { CommandError, EXIT } from "../command";
import type { Command, Context } from "../command";
import { plural } from "../format";
import {
  commitTree,
  currentBranch,
  dirtyPaths,
  git,
  isGitRepo,
  listFiles,
  moveWorktree,
  resolveRef,
  updateRefs,
  writeTree,
} from "../git";
import type { RefUpdate, TreeChanges } from "../git";
import { DATA_BRANCH, STATE_FILE, V1_LOG_DIR, dataRef, loadRawHistory } from "../history";

/**
 * `hc migrate` (PLAN-1.0 M4): a v1 collection, moved to 1.0 in two commits.
 *
 * - On the current branch (`main`): `hashcards.toml` added,
 *   `hashcards-state.json` and `hashcards-reviews/` removed.
 * - A new orphan `hashcards-data` branch: the history, re-keyed from v1 hashes
 *   to 1.0 keys, as `reviews/<month>.v1.jsonl` (`src/migrate.ts` says why
 *   `v1`).
 *
 * A collection the first 1.0 builds migrated has `ID:` lines instead (§2.7):
 * for one of those, `hc migrate` takes them out and writes a `link` per card
 * to the data branch (`removeIds` below).
 *
 * **A dry run unless `--apply`.** The migration rewrites every deck and
 * deletes the state file, and its before/after check is the thing to read
 * before agreeing to that — so the default is to show the plan and the check
 * and change nothing. `--apply` commits, locally only: both refs move in one
 * transaction, so the repo is never half-migrated, and nothing is pushed. The
 * push is printed for the person to run, once they have looked.
 */

type Blocker = string;

export const migrate: Command = {
  name: "migrate",
  summary: "move a repo to 1.0: v1 history to hashcards-data, or ID: lines to links",
  help: `Usage: hc migrate [--apply] [--force] [--verbose]

Moves a v1 collection (hashcards-state.json and hashcards-reviews/ on main)
to the 1.0 layout:

  main             hashcards.toml added,
                   hashcards-state.json and hashcards-reviews/ removed
  hashcards-data   a new orphan branch with the history, re-keyed to 1.0 keys:
                   reviews/<month>.v1.jsonl ("v1" is reserved: no device writes it)

On a collection already on 1.0 whose decks still have ID: lines (written by
early 1.0 builds), removes them instead:

  main             every ID: line removed
  hashcards-data   one link event per card, from its ID key to its content key,
                   in reviews/<month>.hc.jsonl; keys no card has any more are
                   looked up in earlier versions of the decks

A dry run by default: prints the plan and a before/after check of every card
(the state file against a replay of the migrated events) and changes nothing.
With --apply, makes one commit on each branch, locally. Never pushes.

Refuses a dirty working tree, an existing hashcards-data branch (unless
--force), a repo with nothing of v1 left, deck files that do not parse or share
an ID, and any card whose schedule moves by more than fuzz.

Options:
  --apply     commit the migration (default: dry run)
  --force     replace an existing hashcards-data branch
  --verbose   list every card the check compared, not only the notable ones

Exit: 0 done (or would be), 1 dry run found blockers, 2 refused or error.`,
  options: {
    apply: { type: "boolean" },
    force: { type: "boolean" },
    verbose: { type: "boolean" },
  },
  async run(ctx) {
    const repo = ctx.repo;
    if (!isGitRepo(repo)) throw new CommandError(`${repo} is not a git repository`);
    const head = resolveRef(repo, "HEAD");
    if (!head) throw new CommandError("the repository has no commits");

    const v1Logs = listFiles(repo, head, V1_LOG_DIR);
    const hasState = listFiles(repo, head).includes(STATE_FILE);
    const dataRefs = existingDataRefs(repo);
    if (!hasState && v1Logs.length === 0 && dataRefs.length > 0) {
      const collection = await loadCollection(repo);
      if (collection.files.some((f) => f.cards !== null && hasIds(f.text, f.path))) {
        return removeIds(ctx, head, collection);
      }
    }
    if (!hasState && v1Logs.length === 0) {
      throw new CommandError(
        dataRefs.length > 0
          ? `already migrated: ${DATA_BRANCH} exists and nothing of v1 is left on ${currentBranch(repo) ?? "HEAD"}`
          : `nothing to migrate: no ${STATE_FILE} or ${V1_LOG_DIR}/ in the last commit`
      );
    }

    const blockers: Blocker[] = [];
    const branch = currentBranch(repo);
    if (!branch) blockers.push("HEAD is detached: check out the branch to migrate (main)");
    const dirty = dirtyPaths(repo);
    if (dirty.length > 0) {
      blockers.push(
        `the working tree has changes; commit or stash them first:\n${dirty.slice(0, 10).map((l) => `    ${l}`).join("\n")}`
      );
    }
    if (dataRefs.length > 0 && !ctx.values.force) {
      blockers.push(`${dataRefs.join(" and ")} already exists (--force replaces the local branch)`);
    }

    const collection = await loadCollection(repo);
    for (const p of collection.problems.filter((p) => p.severity === "error")) {
      blockers.push(`${p.file}${p.line ? `:${p.line}` : ""}: ${p.message} (see \`hc lint\`)`);
    }

    const plan = await planMigration({
      decks: collection.files.filter((f) => f.cards !== null).map(({ path, text }) => ({ path, text })),
      state: hasState ? readFileSync(join(repo, STATE_FILE), "utf8") : null,
      logs: readLogs(repo),
    });
    if (plan.check.other > 0) {
      blockers.push(
        `${plural(plan.check.other, "card")} would move by more than fuzz (verdict "other" below): a migration bug, not applied`
      );
    }

    const config = configFile(repo, collection, plan);
    if (config.deckChange) blockers.push(config.deckChange);

    const today = localDay(ctx.io.now());
    const report = { branch, plan, config, today, dataRefs, logs: v1Logs.length, hasState };

    if (!ctx.values.apply || blockers.length > 0) {
      if (ctx.json) ctx.emit({ applied: false, blockers, ...summary(report) });
      else {
        printPlan(ctx, report);
        printBlockers(ctx, blockers, ctx.values.apply === true);
      }
      if (blockers.length === 0) return EXIT.ok;
      return ctx.values.apply ? EXIT.error : EXIT.findings;
    }

    const commits = apply(repo, branch!, head, plan, config.text, [
      ...(hasState ? [STATE_FILE] : []),
      ...v1Logs,
    ], dataRefs);
    if (ctx.json) ctx.emit({ applied: true, commits, push: pushCommand(branch!, dataRefs), ...summary(report) });
    else {
      printPlan(ctx, report);
      ctx.say("");
      ctx.say(`Committed (locally, nothing pushed):`);
      ctx.say(`  ${branch}  ${commits.main.slice(0, 7)}  hashcards.toml, v1 files removed`);
      ctx.say(`  ${DATA_BRANCH}  ${commits.data.slice(0, 7)}  the history, re-keyed`);
      ctx.say("");
      ctx.say("Check it (`hc lint`, `hc due`, `hc stats`), then publish both branches together:");
      ctx.say(`  ${pushCommand(branch!, dataRefs)}`);
      ctx.say("Sync every device before reviewing again. `hc init` adds AGENTS.md and a lint workflow.");
    }
    return EXIT.ok;
  },
};

/** Local and remote-tracking data branches that already exist. */
function existingDataRefs(repo: string): string[] {
  // `for-each-ref` sees packed refs too, which a look in .git/refs would not.
  return git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"])
    .split("\n")
    .filter((ref) => ref === `refs/heads/${DATA_BRANCH}` || (ref.startsWith("refs/remotes/") && ref.endsWith(`/${DATA_BRANCH}`)))
    .map((ref) => ref.replace(/^refs\/(heads|remotes)\//, ""));
}

function readLogs(repo: string): { path: string; text: string }[] {
  let names: string[] = [];
  try {
    names = readdirSync(join(repo, V1_LOG_DIR)).filter((n) => n.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  return names.map((name) => ({
    path: `${V1_LOG_DIR}/${name}`,
    text: readFileSync(join(repo, V1_LOG_DIR, name), "utf8"),
  }));
}

type ConfigPlan = {
  /** The new `hashcards.toml`, or null when the repo already has one (kept). */
  text: string | null;
  exclude: string[];
  /** Set when writing the file would change which files are decks: a bug. */
  deckChange: string | null;
};

/**
 * `hashcards.toml` for the migrated repo: the review settings the state file
 * shows, and a `[decks]` table that keeps exactly today's decks — every
 * Markdown file the default rule reads, and not the documentation it skips
 * (`CARD_GUIDE.md`), which would otherwise be read as a deck the moment a
 * `[decks]` table exists. A repo that already has the file keeps it.
 */
function configFile(repo: string, collection: Collection, plan: MigrationPlan): ConfigPlan {
  if (collection.config.present) return { text: null, exclude: [], deckChange: null };
  const docs = markdownFiles(repo).filter(isDocFile);
  const exclude = [...new Set(["README.md", "AGENTS.md", "CLAUDE.md", ...docs])];
  const text = renderConfig(exclude, {
    desiredRetention: plan.settings.retention.value,
    fuzz: plan.settings.fuzz.value,
  });
  const after = parseConfig(text).config;
  const decksAfter = markdownFiles(repo).filter((p) => isDeckPath(p, after));
  const decksBefore = collection.files.map((f) => f.path);
  const same =
    decksAfter.length === decksBefore.length && decksAfter.every((p, i) => p === decksBefore[i]);
  return {
    text,
    exclude,
    deckChange: same
      ? null
      : `hashcards.toml would change which files are decks (before: ${decksBefore.join(", ")}; after: ${decksAfter.join(", ")})`,
  };
}

function apply(
  repo: string,
  branch: string,
  head: string,
  plan: MigrationPlan,
  config: string | null,
  removed: string[],
  dataRefs: string[]
): { main: string; data: string } {
  // The data branch first, so the main commit can say where its history went.
  const dataTree = writeTree(repo, null, new Map(plan.files));
  const c = plan.counts;
  const data = commitTree(
    repo,
    dataTree,
    [],
    message("Carry the v1 review history over", [
      `${plural(c.baselines + c.unknownBaselines, "baseline")} from ${STATE_FILE} and ` +
        `${plural(c.reviews + c.unknownReviews, "review")} from ${V1_LOG_DIR}/, re-keyed to 1.0 keys. ` +
        `${plural(c.unknownHashes, "hash", "hashes")} no deck has keep their h: keys.`,
      `Written by \`hc migrate\` from ${branch} at ${head.slice(0, 7)}.`,
    ])
  );

  const changes: TreeChanges = new Map();
  if (config !== null) changes.set(CONFIG_FILE, config);
  for (const path of removed) changes.set(path, null);
  const mainTree = writeTree(repo, head, changes);
  const main = commitTree(
    repo,
    mainTree,
    [head],
    message("Migrate to hashcards 1.0", [
      `${config !== null ? "Add hashcards.toml and move" : "Move"} the review history ` +
        `(${STATE_FILE}, ${V1_LOG_DIR}/) to the ${DATA_BRANCH} branch, ${data.slice(0, 7)}.`,
      "Written by `hc migrate`.",
    ])
  );

  const updates: RefUpdate[] = [
    { ref: `refs/heads/${branch}`, to: main, old: head },
    {
      ref: `refs/heads/${DATA_BRANCH}`,
      to: data,
      old: dataRefs.includes(DATA_BRANCH) ? resolveRef(repo, `refs/heads/${DATA_BRANCH}`) : null,
    },
  ];
  updateRefs(repo, updates, "hc migrate");
  moveWorktree(repo, head, main);
  return { main, data };
}

/** A commit message: subject, then paragraphs wrapped at 72 columns. */
export function message(subject: string, paragraphs: string[]): string {
  const wrap = (text: string) => {
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(/\s+/)) {
      if (line && line.length + 1 + word.length > 72) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    return [...lines, line].join("\n");
  };
  return [subject, ...paragraphs.map(wrap)].join("\n\n") + "\n";
}

function pushCommand(branch: string, dataRefs: string[]): string {
  // A remote data branch already there means --force replaced it here, and
  // the push has to replace it there too: say so rather than hide it.
  const remote = dataRefs.some((r) => r !== DATA_BRANCH);
  return remote
    ? `git push origin ${branch} && git push --force-with-lease origin ${DATA_BRANCH}`
    : `git push --atomic origin ${branch} ${DATA_BRANCH}`;
}

// --- Output -----------------------------------------------------------------

type Report = {
  branch: string | null;
  plan: MigrationPlan;
  config: ConfigPlan;
  today: string;
  dataRefs: string[];
  logs: number;
  hasState: boolean;
};

/** Cards whose due date moved across today: due before and not after, or the reverse. */
function dueTodayChanges(report: Report) {
  return report.plan.dueShift.moved.filter(
    (m) => (m.before <= report.today) !== (m.after <= report.today)
  );
}

function summary(report: Report) {
  const { plan } = report;
  const { rows, ...verdicts } = plan.check;
  return {
    branch: report.branch,
    cards: plan.counts.cards,
    dataFiles: [...plan.files.keys()],
    counts: plan.counts,
    settings: plan.settings,
    hashcardsToml: report.config.text === null ? "kept" : { exclude: report.config.exclude },
    check: { ...verdicts, rows },
    dueShift: { ...plan.dueShift, today: report.today, dueTodayChanged: dueTodayChanges(report) },
    warnings: plan.warnings,
  };
}

function printPlan(ctx: Context, report: Report): void {
  const { plan, config } = report;
  const c = plan.counts;
  const verbose = ctx.values.verbose === true;
  ctx.say(ctx.values.apply ? "hc migrate" : "hc migrate: dry run, nothing written (--apply to commit)");
  ctx.say("");
  ctx.say(`Decks     ${plural(c.cards, "card")}, unchanged`);
  ctx.say(
    `History   ${report.hasState ? STATE_FILE : "no state file"} + ${plural(report.logs, "log file")} → ${DATA_BRANCH}:`
  );
  for (const path of plan.files.keys()) ctx.say(`            ${path}`);
  ctx.say(`          ${plural(c.baselines, "baseline")} and ${plural(c.reviews, "review")} for cards in decks`);
  ctx.say(
    `          ${plural(c.unknownHashes, "hash", "hashes")} no deck has, kept under h: keys ` +
      `(${plural(c.unknownBaselines, "baseline")}, ${plural(c.unknownReviews, "review")})`
  );
  const s = plan.settings;
  if (config.text === null) ctx.say(`Settings  ${CONFIG_FILE} exists and is kept as it is`);
  else {
    ctx.say(`Settings  ${CONFIG_FILE}:`);
    ctx.say(`            desired_retention = ${s.retention.value}  (${s.retention.source}: ${s.retention.note})`);
    ctx.say(`            fuzz = ${s.fuzz.value}  (${s.fuzz.source}: ${s.fuzz.note})`);
    ctx.say(`            new_per_day = 20  (default: the state file does not record it)`);
    ctx.say(`            [decks] exclude = ${config.exclude.join(", ")}`);
  }
  for (const w of plan.warnings) ctx.say(`warning: ${w}`);

  const k = plan.check;
  ctx.say("");
  ctx.say(`Check     every state-file card: the state file against a replay of the migrated events`);
  ctx.say(
    `          ${k.exact} exact · ${k.fuzz} fuzz only · ${k.newer} newer reviews · ` +
      `${k.retention} retention · ${k.rules} v1 rules · ${k.other} other`
  );
  const notable = k.rows.filter((r) => verbose || (r.verdict !== "exact" && r.verdict !== "fuzz"));
  for (const row of notable) ctx.say(`            ${formatRow(row)}`);
  if (!verbose && k.fuzz > 0) {
    const deltas = k.rows.filter((r) => r.verdict === "fuzz").map((r) => Math.abs(r.dueDelta ?? 0));
    ctx.say(`          fuzz only: due dates ${Math.min(...deltas)}–${Math.max(...deltas)} days apart (--verbose lists them)`);
  }

  const shift = plan.dueShift;
  const crossing = dueTodayChanges(report);
  ctx.say("");
  ctx.say(
    `Due       what the app and \`hc due\` show for cards with history: ${shift.same} unchanged, ` +
      `${shift.moved.length} moved by fuzz (seeded by the new key)`
  );
  if (shift.moved.length > 0) {
    const earliest = shift.moved.map((m) => (m.before < m.after ? m.before : m.after)).sort()[0];
    ctx.say(
      crossing.length === 0
        ? `          none of them due by ${report.today} either way (earliest involved: ${earliest})`
        : `          due by ${report.today} changes for: ${crossing.map((m) => `${m.key} ${m.before}→${m.after}`).join(", ")}`
    );
    if (verbose) for (const m of shift.moved) ctx.say(`            ${m.key}  ${m.before} → ${m.after}`);
  }
}

function formatRow(row: CheckRow): string {
  const after = row.after ? `${row.after.due} (s ${round(row.after.s)})` : "none";
  const delta = row.dueDelta === null ? "" : ` ${row.dueDelta >= 0 ? "+" : ""}${row.dueDelta}d`;
  const name = row.known ? row.key : `${row.key} (no deck)`;
  return `${row.verdict.padEnd(9)} ${name}  ${row.before.due} (s ${round(row.before.s)}) → ${after}${delta}${row.why ? `  ${row.why}` : ""}`;
}

const round = (n: number) => Math.round(n * 100) / 100;

function printBlockers(ctx: Context, blockers: Blocker[], applying: boolean): void {
  ctx.say("");
  if (blockers.length === 0) {
    ctx.say("No blockers. Run `hc migrate --apply` to commit it.");
    return;
  }
  ctx.say(applying ? "Refusing to apply:" : "Blockers (--apply would refuse):");
  for (const b of blockers) ctx.say(`  - ${b}`);
  if (applying) ctx.io.stderr(`hc migrate: refused, ${plural(blockers.length, "blocker")} (see above)\n`);
}

// --- Removing ID: lines (PLAN-1.0 §2.7) -------------------------------------

/**
 * Every `ID:` line out of the decks, and a `link` per card onto the data
 * branch, in one ref transaction. Like the v1 migration, a dry run unless
 * `--apply`, and never pushed.
 */
async function removeIds(ctx: Context, head: string, collection: Collection): Promise<number> {
  const repo = ctx.repo;
  const blockers: Blocker[] = [];
  const branch = currentBranch(repo);
  if (!branch) blockers.push("HEAD is detached: check out the branch to migrate (main)");
  const dirty = dirtyPaths(repo);
  if (dirty.length > 0) {
    blockers.push(`the working tree has changes; commit or stash them first:\n${dirty.slice(0, 10).map((l) => `    ${l}`).join("\n")}`);
  }
  for (const p of collection.problems.filter((p) => p.severity === "error")) {
    blockers.push(`${p.file}${p.line ? `:${p.line}` : ""}: ${p.message} (see \`hc lint\`)`);
  }

  const tipRef = dataRef(repo);
  const tip = tipRef ? resolveRef(repo, tipRef) : null;
  const raw = loadRawHistory(repo, collection.cards);
  const now = ctx.io.now();
  const review = collection.config.config.review;
  const plan = await planIdRemoval(
    {
      decks: collection.files.filter((f) => f.cards !== null).map(({ path, text }) => ({ path, text })),
      history: deckHistory(repo, head),
      events: raw.events,
      at: now.toISOString(),
      tz: utcOffsetMinutes(now.toISOString()),
    },
    { retention: review.desiredRetention, fuzz: review.fuzz }
  );
  if (plan.check.changed.length > 0) {
    blockers.push(`${plural(plan.check.changed.length, "card")} would change schedule: a migration bug, not applied`);
  }

  const ids = plan.stripped.reduce((n, d) => n + d.ids, 0);
  if (ctx.json) {
    // Emitted below, with the result.
  } else {
    ctx.say(ctx.values.apply ? "hc migrate: removing ID: lines" : "hc migrate: removing ID: lines, dry run (--apply to commit)");
    ctx.say("");
    ctx.say(`Decks     ${plural(ids, "ID: line")} to remove from ${plural(plan.stripped.length, "file")}`);
    for (const d of plan.stripped) ctx.say(`            ${d.path}  -${d.ids}`);
    ctx.say(`Links     ${plural(plan.links.length, "link")} → ${DATA_BRANCH}: ${plan.counts.current} for cards in the decks, ` +
      `${plan.counts.recovered} found in earlier versions of them`);
    ctx.say(`          ${plural(plan.counts.orphans, "key")} with history that no card or earlier version has (kept, unlinked)`);
    ctx.say(`Check     ${plan.check.same} cards with history unchanged, ${plan.check.changed.length} changed`);
    for (const c of plan.check.changed) ctx.say(`            ${c.key}  ${c.before} → ${c.after}`);
  }

  const result = { mode: "remove-ids", ids, files: plan.stripped.map(({ path, ids }) => ({ path, ids })), links: plan.links.length, counts: plan.counts, check: plan.check };
  if (!ctx.values.apply || blockers.length > 0) {
    if (ctx.json) ctx.emit({ applied: false, blockers, ...result });
    else printBlockers(ctx, blockers, ctx.values.apply === true);
    if (blockers.length === 0) return EXIT.ok;
    return ctx.values.apply ? EXIT.error : EXIT.findings;
  }

  const data = commitTree(
    repo,
    writeTree(repo, tip, linkFileChanges(repo, tip, plan.links)),
    tip ? [tip] : [],
    message("Link card history from IDs to content keys", [
      `${plural(plan.links.length, "link")}: a card is its text again, so history filed under ID keys follows it to its content key.`,
      "Written by `hc migrate`.",
    ])
  );
  const changes: TreeChanges = new Map(plan.stripped.map((d) => [d.path, d.text]));
  const main = commitTree(
    repo,
    writeTree(repo, head, changes),
    [head],
    message("Remove card IDs", [
      `${plural(ids, "ID: line")} out of ${plural(plan.stripped.length, "deck")}: a card is its text. ` +
        `Their history is linked on ${DATA_BRANCH}, ${data.slice(0, 7)}.`,
      "Written by `hc migrate`.",
    ])
  );
  updateRefs(
    repo,
    [
      { ref: `refs/heads/${branch}`, to: main, old: head },
      { ref: `refs/heads/${DATA_BRANCH}`, to: data, old: resolveRef(repo, `refs/heads/${DATA_BRANCH}`) },
    ],
    "hc migrate"
  );
  moveWorktree(repo, head, main);
  const push = `git push --atomic origin ${branch} ${DATA_BRANCH}`;
  if (ctx.json) ctx.emit({ applied: true, commits: { main, data }, push, ...result });
  else {
    ctx.say("");
    ctx.say("Committed (locally, nothing pushed):");
    ctx.say(`  ${branch}  ${main.slice(0, 7)}  ID: lines removed`);
    ctx.say(`  ${DATA_BRANCH}  ${data.slice(0, 7)}  the links`);
    ctx.say("");
    ctx.say("Check it (`hc lint`, `hc due`), then publish both branches together:");
    ctx.say(`  ${push}`);
  }
  return EXIT.ok;
}

/**
 * Every earlier version of every Markdown file on `head`'s history, newest
 * first. What `planIdRemoval` looks deleted and archived cards up in.
 */
function deckHistory(repo: string, head: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const seen = new Set<string>();
  const log = git(repo, ["log", "--format=%H", "--name-only", "--diff-filter=AMD", head, "--", "*.md"]);
  let commit = "";
  for (const line of log.split("\n")) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      commit = line;
      continue;
    }
    if (!line.endsWith(".md")) continue;
    // A deleted file has no blob at that commit: its last version is in the parent.
    for (const rev of [`${commit}:${line}`, `${commit}^:${line}`]) {
      const sha = tryRevParse(repo, rev);
      if (!sha || seen.has(sha)) continue;
      seen.add(sha);
      out.push({ path: line, text: git(repo, ["cat-file", "blob", sha]) });
      break;
    }
  }
  return out;
}

function tryRevParse(repo: string, rev: string): string | null {
  try {
    return git(repo, ["rev-parse", "--verify", "--quiet", rev]).trim() || null;
  } catch {
    return null;
  }
}
