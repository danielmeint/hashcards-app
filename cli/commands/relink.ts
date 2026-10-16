import { utcOffsetMinutes } from "../../src/core/schedule";
import type { LinkEvent } from "../../src/core/events";
import { parseFile } from "../../src/parser";
import type { ParsedCard } from "../../src/types";
import { defaultDeckName, isDeckPath, locate } from "../collection";
import { CommandError, EXIT, UsageError } from "../command";
import type { Command } from "../command";
import { plural } from "../format";
import { commitTree, dirtyPaths, isGitRepo, listFiles, resolveRef, showFile, updateRefs, writeTree } from "../git";
import { DATA_BRANCH, dataRef } from "../history";
import { linkFileChanges } from "../links";
import { sides } from "./show";
import { message } from "./migrate";
import { openWorkspace } from "../workspace";

/**
 * `hc relink` (PLAN-1.0 §2.7): carry a card's history over an edit made
 * outside the app.
 *
 * A card is its text, so an edit on GitHub, in an editor or by an agent makes
 * it a new card, and the old one's history is left where it was — never lost,
 * but no longer attached. This attaches it again, with a `link` event on the
 * data branch, on request. Nothing guesses behind anyone's back.
 *
 * With no arguments it compares the decks at a revision with the working tree
 * and proposes pairs: in each file, the cards that disappeared and the cards
 * that appeared between the same unchanged neighbours, matched in order when
 * there are as many of each. Anything less clear-cut is listed, not paired,
 * and can be linked by name.
 */
export const relink: Command = {
  name: "relink",
  summary: "carry history over cards edited outside the app (link old → new)",
  positionals: 2,
  help: `Usage:
  hc relink [--since <rev>] [--apply]
  hc relink <old-key> <new-key|file:line> [--apply]

A card is its text: an edit made outside the app (on GitHub, in an editor,
by an agent) makes it a new card, and its history stays with the old text.
This links the old card to the new one on the hashcards-data branch, so the
history follows. Edits made in the app do this by themselves.

With no arguments, compares the decks at --since (default: HEAD when deck
files have uncommitted changes, otherwise HEAD's parent) with the working
tree. In each file, cards that disappeared are paired in order with cards
that appeared in the same place. Only cards with history are proposed.
Anything ambiguous is listed for linking by name.

With two arguments, links that pair: the old card's key (hc show, hc due
print keys; history of a deleted card is kept under its key) and the new
card, by key or by file:line.

A dry run unless --apply, which commits the links to ${DATA_BRANCH} locally.
Never pushes.

Options:
  --since <rev>  the revision to compare the working tree with
  --apply        commit the links (default: dry run)

Exit: 0 done (or nothing to do), 1 dry run with links to make, 2 error.`,
  options: {
    since: { type: "string" },
    apply: { type: "boolean" },
  },
  async run(ctx) {
    const repo = ctx.repo;
    if (!isGitRepo(repo)) throw new CommandError(`${repo} is not a git repository`);
    const { collection, states } = await openWorkspace(ctx);
    const hasHistory = (key: string) => states.has(key);

    let pairs: Pair[];
    let unpaired: string[] = [];
    let compared: string;
    if (ctx.positionals.length === 2) {
      const [from, to] = ctx.positionals;
      const target = findCard(collection.cards, to);
      if (!target) throw new UsageError(`no card at '${to}': give a key or file:line`);
      if (!hasHistory(from)) throw new CommandError(`'${from}' has no history to carry over`);
      if (collection.cards.some((c) => c.key === from)) {
        throw new CommandError(`'${from}' is a card in the decks now; link only from a card that is gone`);
      }
      pairs = [{ from, old: null, to: target }];
      compared = "by name";
    } else if (ctx.positionals.length === 1) {
      throw new UsageError("give both cards (old key, new key or file:line), or neither");
    } else {
      const rev = typeof ctx.values.since === "string" ? ctx.values.since : defaultSince(repo);
      const commit = resolveRef(repo, `${rev}^{commit}`);
      if (!commit) throw new UsageError(`--since: '${rev}' is not a commit`);
      const before = await cardsAt(repo, commit, (p) => isDeckPath(p, collection.config.config));
      const proposed = propose(before, collection.cards, hasHistory);
      pairs = proposed.pairs;
      unpaired = proposed.unpaired;
      compared = `${rev} (${commit.slice(0, 7)}) → working tree`;
    }

    const now = ctx.io.now().toISOString();
    const links: LinkEvent[] = pairs.map((p) => ({
      v: 2,
      kind: "link",
      card: p.to.key,
      from: p.from,
      at: now,
      tz: utcOffsetMinutes(now),
      src: "relink",
    }));

    const apply = ctx.values.apply === true && links.length > 0;
    let commit: string | null = null;
    if (apply) {
      const tipRef = dataRef(repo);
      const tip = tipRef ? resolveRef(repo, tipRef) : null;
      commit = commitTree(
        repo,
        writeTree(repo, tip, linkFileChanges(repo, tip, links)),
        tip ? [tip] : [],
        message(`Relink ${plural(links.length, "edited card")}`, [
          pairs.map((p) => `${p.from} → ${p.to.key} (${locate(p.to)})`).join("\n"),
          "Written by `hc relink`.",
        ])
      );
      updateRefs(
        repo,
        [{ ref: `refs/heads/${DATA_BRANCH}`, to: commit, old: resolveRef(repo, `refs/heads/${DATA_BRANCH}`) }],
        "hc relink"
      );
    }

    if (ctx.json) {
      ctx.emit({
        applied: apply,
        compared,
        links: pairs.map((p) => ({ from: p.from, to: p.to.key, file: p.to.filePath, line: p.to.range[0] })),
        unpaired,
        ...(commit ? { commit, push: `git push origin ${DATA_BRANCH}` } : {}),
      });
    } else {
      ctx.say(`hc relink: ${compared}${ctx.values.apply ? "" : ", dry run (--apply to commit)"}`);
      if (pairs.length === 0) ctx.say("\nNothing to link: no edited card with history.");
      for (const p of pairs) {
        ctx.say("");
        ctx.say(`  ${locate(p.to)}  ${p.from} → ${p.to.key}`);
        if (p.old) ctx.say(`    was: ${oneLine(sides(p.old).back)}`);
        ctx.say(`    now: ${oneLine(sides(p.to).back)}`);
      }
      if (unpaired.length > 0) {
        ctx.say("\nNot paired (link by name if they belong together: hc relink <old-key> <file:line>):");
        for (const u of unpaired) ctx.say(`  ${u}`);
      }
      if (commit) {
        ctx.say("");
        ctx.say(`Committed ${plural(links.length, "link")} to ${DATA_BRANCH} ${commit.slice(0, 7)} (locally). Publish it:`);
        ctx.say(`  git push origin ${DATA_BRANCH}`);
      }
    }
    if (links.length === 0) return EXIT.ok;
    return apply ? EXIT.ok : EXIT.findings;
  },
};

type Pair = { from: string; old: ParsedCard | null; to: ParsedCard };

/** What to compare the working tree with when no `--since` is given. */
function defaultSince(repo: string): string {
  const dirty = dirtyPaths(repo).some((line) => line.slice(3).endsWith(".md"));
  if (dirty) return "HEAD";
  if (!resolveRef(repo, "HEAD^")) throw new CommandError("HEAD has no parent to compare with; give --since");
  return "HEAD^";
}

/** Every deck card as of `commit`. A file that did not parse then has none. */
async function cardsAt(repo: string, commit: string, isDeck: (path: string) => boolean): Promise<ParsedCard[]> {
  const cards: ParsedCard[] = [];
  for (const path of listFiles(repo, commit).filter(isDeck)) {
    const text = showFile(repo, commit, path);
    if (text === null) continue;
    try {
      cards.push(...(await parseFile(text, path, defaultDeckName(path))));
    } catch {
      // Not a deck then, or a broken one: nothing in it to carry over.
    }
  }
  return cards;
}

/**
 * Pairs of (gone, new) cards, file by file. Cards present on both sides (in
 * any file: a move is not an edit) are anchors, and split each file into
 * segments; the cards that went and the cards that came between the same two
 * anchors are paired in order if there are as many of each, of the same
 * kinds. If the anchors themselves moved around, the whole file is one
 * segment. Only gone cards with history are proposed.
 */
export function propose(
  before: ParsedCard[],
  after: ParsedCard[],
  hasHistory: (key: string) => boolean
): { pairs: Pair[]; unpaired: string[] } {
  const keysBefore = new Set(before.map((c) => c.key));
  const keysAfter = new Set(after.map((c) => c.key));
  const split = (cards: ParsedCard[], isAnchor: (c: ParsedCard) => boolean) => {
    const segments: ParsedCard[][] = [[]];
    const anchors: string[] = [];
    for (const card of cards) {
      if (isAnchor(card)) {
        anchors.push(card.key);
        segments.push([]);
      } else segments[segments.length - 1].push(card);
    }
    return { segments, anchors };
  };
  const kinds = (cs: ParsedCard[]) => cs.map((c) => c.content.type).join(",");

  const pairs: Pair[] = [];
  const unpaired: string[] = [];
  for (const file of [...new Set(before.map((c) => c.filePath))].sort()) {
    const old = split(before.filter((c) => c.filePath === file), (c) => keysAfter.has(c.key));
    const now = split(after.filter((c) => c.filePath === file), (c) => keysBefore.has(c.key));
    const aligned = old.anchors.join("\n") === now.anchors.join("\n");
    const goneSegs = aligned ? old.segments : [old.segments.flat()];
    const cameSegs = aligned ? now.segments : [now.segments.flat()];
    goneSegs.forEach((gone, k) => {
      const came = cameSegs[k];
      const relevant = gone.filter((c) => hasHistory(c.key));
      if (relevant.length === 0) return;
      if (gone.length === came.length && kinds(gone) === kinds(came)) {
        gone.forEach((g, i) => {
          if (hasHistory(g.key)) pairs.push({ from: g.key, old: g, to: came[i] });
        });
      } else {
        for (const g of relevant) unpaired.push(`${g.key}  was ${file}:${g.range[0]}: ${oneLine(sides(g).back)}`);
      }
    });
  }
  return { pairs, unpaired };
}

function findCard(cards: ParsedCard[], query: string): ParsedCard | null {
  const at = /^(.+\.md):(\d+)$/.exec(query);
  const matches = cards.filter((c) =>
    at ? c.filePath === at[1] && c.range[0] <= Number(at[2]) && c.range[1] >= Number(at[2]) : c.key === query
  );
  if (matches.length > 1) {
    throw new UsageError(`${query} is a block of ${matches.length} cards (a reverse or cloze): give the new card's key`);
  }
  return matches[0] ?? null;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 87)}…` : flat;
}
