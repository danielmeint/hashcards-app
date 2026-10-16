import { Card } from "./types";
import { stateKey } from "./card-key";

/**
 * What is wrong with the collection's files, for Today to say out loud.
 *
 * People, scripts and agents all write the decks, and on GitHub nothing stops
 * a broken line from landing. A file the parser refuses used to drop out of
 * the app with a console message and nothing else: its cards simply vanished
 * from Today. Now its last good cards stay (`syncCards`) and the problem is
 * shown here, with the line to fix.
 *
 * The other thing worth saying is the same card twice (PLAN-1.0 §2.7): same
 * text, so one card with one schedule. The second copy is not shown; this is
 * where you learn why.
 */

export type FileProblem = {
  /** The parser's message, without its `Location:` suffix. */
  message: string;
  /** 1-based, counting the frontmatter; null when the parser named no line. */
  line: number | null;
};

export type DeckProblem = {
  kind: "parse" | "duplicate";
  repo: string;
  path: string;
  line: number | null;
  message: string;
  /** parse: whether the last version that parsed is still being shown. */
  keptOld?: boolean;
};

/** A parser error as a problem: its message, and the line it names. */
export function problemOf(error: unknown): FileProblem {
  const text = error instanceof Error ? error.message : String(error);
  const m = text.match(/^([\s\S]*?)\s*(?:Location: .*:(\d+)|File: .*)$/);
  if (!m) return { message: text.trim(), line: null };
  return { message: m[1].trim(), line: m[2] ? Number(m[2]) : null };
}

/**
 * `cards` with every repeat of a key after the first left out, and a problem
 * for each repeat. In file order, so the copy that stays is the one a person
 * reading the files meets first. Within one file the parser already keeps the
 * first, and records the rest on the file (`duplicates`).
 */
export function dedupeCards(cards: Card[]): { cards: Card[]; problems: DeckProblem[] } {
  const first = new Map<string, Card>();
  const kept: Card[] = [];
  const problems: DeckProblem[] = [];
  for (const card of cards) {
    const key = stateKey(card);
    const seen = first.get(key);
    if (!seen) {
      first.set(key, card);
      kept.push(card);
      continue;
    }
    problems.push(duplicate(card.repo, card.filePath, card.range[0], seen.filePath, seen.range[0]));
  }
  return { cards: kept, problems };
}

export function duplicate(repo: string, path: string, line: number, firstPath: string, firstLine: number): DeckProblem {
  const where = firstPath === path ? `line ${firstLine}` : `${firstPath}:${firstLine}`;
  return {
    kind: "duplicate",
    repo,
    path,
    line,
    message: `The same card as ${where}, so it is one card with one schedule. Delete one of them.`,
  };
}
