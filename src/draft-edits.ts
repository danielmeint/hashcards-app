import { Card, ParsedCard } from "./types";
import { parseFile, topMetadata } from "./parser";
import { spliceLines } from "./card-edit-text";

/**
 * What the Inbox does to a card file, as text (PLAN-1.0 M7).
 *
 * A draft is a card block with a `Status: draft` line among its metadata.
 * Curating it is one of three edits to the file it sits in — keep it (the line
 * goes, and it gets an ID if it had none), discard it (the block goes), or
 * rewrite it — and each of them changes the lines of that one block and
 * nothing else. The file is someone's, often an agent's; a diff that touches
 * anything outside the block is a diff nobody wants to review.
 *
 * Blocks are found by the content hashes of their cards, not by line number.
 * Hashes are what a queued change can still recognise after the file has moved
 * underneath it — an edit elsewhere in the file, another draft kept first —
 * and they never include metadata, so keeping a draft does not change them.
 */

/** A line that ends its block's run of metadata as a draft. */
const DRAFT_LINE = /^Status:\s*draft\s*\r?$/;
const SEPARATOR = /^---\s*\r?$/;
const blank = (line: string | undefined) => line !== undefined && line.trim() === "";

/**
 * One draft as the Inbox shows it: a whole block, which may be several cards —
 * a cloze with three deletions, or a basic card and its reverse.
 */
export type DraftBlock = {
  repo: string;
  path: string;
  /** In the order the parser produced them: forward before reverse, deletions in order. */
  cards: Card[];
};

/** The content hashes that identify a block, in card order. */
export function blockHashes(block: DraftBlock): string[] {
  return block.cards.map((c) => c.hash);
}

/**
 * The drafts among `cards`, one entry per block, in the order the cards came.
 * `writable` says which collections may be changed: a subscription's drafts
 * are someone else's to accept.
 */
export function findDrafts(
  cards: Card[],
  writable: (repo: string) => boolean
): DraftBlock[] {
  const blocks = new Map<string, DraftBlock>();
  for (const card of cards) {
    if (card.status !== "draft" || !writable(card.repo)) continue;
    // Every card of a block shares its range; that is what makes them one block.
    const at = `${card.repo}\u0000${card.filePath}\u0000${card.range[0]}`;
    const block = blocks.get(at);
    if (block) block.cards.push(card);
    else blocks.set(at, { repo: card.repo, path: card.filePath, cards: [card] });
  }
  return [...blocks.values()];
}

/**
 * Where the block holding cards with these hashes sits in `text` now, or null
 * if it is not there any more — it was edited, removed, or already kept.
 * `draftOnly` refuses a block that is no longer a draft: keeping or discarding
 * one that someone else already accepted would undo their decision.
 */
export async function locateBlock(
  text: string,
  path: string,
  hashes: string[],
  draftOnly = true
): Promise<{ range: [number, number]; cards: ParsedCard[] } | null> {
  const wanted = new Set(hashes);
  const cards = (await parseFile(text, path, "")).filter((c) => wanted.has(c.hash));
  if (cards.length === 0) return null;
  // Two blocks can't share a hash in one file (the parser keeps the first), so
  // matching cards from different ranges means the block was split by an edit.
  const start = cards[0].range[0];
  if (cards.some((c) => c.range[0] !== start)) return null;
  if (draftOnly && cards.some((c) => c.status !== "draft")) return null;
  const end = Math.max(...cards.map((c) => c.range[1]));
  return { range: [start, end], cards };
}

/**
 * The block at `range` (1-based, inclusive, as `Card.range`) with its
 * `Status: draft` line taken out: a one-line diff. Throws if the block is not a draft: the caller located
 * it as one, so that would be a bug, not a conflict.
 */
export function keepDraft(text: string, range: [number, number]): string {
  const lines = text.split("\n");
  const [start, end] = [range[0] - 1, range[1] - 1];
  let draftAt = -1;
  for (let i = start; i <= end; i++) {
    if (blank(lines[i])) continue;
    if (DRAFT_LINE.test(lines[i])) draftAt = i;
    else if (topMetadata(lines[i]).size === 0) break;
  }
  if (draftAt === -1) throw new Error(`No 'Status: draft' line in lines ${range[0]}–${range[1]}`);
  lines.splice(draftAt, 1);
  return lines.join("\n");
}

/**
 * `text` without the block at `range`, and without the separator that set it
 * apart, so no empty block is left behind between two `---` lines.
 *
 * Which separator goes depends on where the block is. One followed by a
 * separator takes that separator and the blank lines after it, so the next
 * card moves up into its place. The last block in a file takes the separator
 * before it, and the blank lines before that, so the file ends where the card
 * before it ended — with whatever trailing newline it had. A block with no
 * separator on either side (the file's only card, or one ended by the next
 * card's tag) takes only its own lines and the blank ones after them.
 *
 * `contentStart` is the first line after any frontmatter (0-based): the
 * frontmatter's closing `---` is not a card separator and must never go.
 */
export function discardBlock(
  text: string,
  range: [number, number],
  contentStart = frontmatterEnd(text)
): string {
  const lines = text.split("\n");
  const start = range[0] - 1;
  const end = range[1] - 1;

  let next = end + 1;
  while (blank(lines[next])) next++;
  const restBlank = (from: number) => lines.slice(from).every((l) => l.trim() === "");

  if (next < lines.length && SEPARATOR.test(lines[next]) && !restBlank(next + 1)) {
    let after = next + 1;
    while (blank(lines[after])) after++;
    lines.splice(start, after - start);
    return lines.join("\n");
  }

  if (next >= lines.length || restBlank(next)) {
    // The last block. Find the separator above it, if there is one.
    let prev = start - 1;
    while (prev >= contentStart && blank(lines[prev])) prev--;
    if (prev >= contentStart && SEPARATOR.test(lines[prev])) {
      let from = prev;
      while (from - 1 >= contentStart && blank(lines[from - 1])) from--;
      // Through the block's own last line; whatever followed it (the file's
      // trailing newline, and a separator left dangling at the very end) stays.
      lines.splice(from, end - from + 1);
      return lines.join("\n");
    }
    lines.splice(start, end - start + 1);
    return lines.join("\n");
  }

  // Followed directly by another card: take the blank lines between too.
  lines.splice(start, next - start);
  return lines.join("\n");
}

/** The 0-based line where card content starts: after the frontmatter, if any. */
export function frontmatterEnd(text: string): number {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return 0;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === "---") return i + 1;
  return 0;
}

/**
 * The block at `range` rewritten to `replacement`. An empty replacement is a
 * discard, and takes the separator with it.
 */
export function rewriteBlock(text: string, range: [number, number], replacement: string): string {
  if (replacement.trim() === "") return discardBlock(text, range);
  return spliceLines(text, range, replacement);
}

/** One queued change to a file, as far as applying it needs to know. */
export type FileOp = {
  action: "keep" | "discard" | "edit";
  /** The hashes of the block's cards when the change was made. */
  block: string[];
  /** edit: the block's new text. */
  text?: string;
};

/**
 * `ops` applied to `text` in order, each finding its block afresh — so an
 * earlier one moving lines around costs a later one nothing, and so does a
 * file that changed on GitHub since the changes were queued, as long as the
 * block itself did not. One whose block is gone, or is no longer a draft, is a
 * conflict: it is left out rather than forced, the way a card edit refuses to
 * overwrite a file that moved under it.
 */
export async function applyOps<T extends FileOp>(
  text: string,
  path: string,
  ops: T[]
): Promise<{ text: string; applied: T[]; conflicts: T[] }> {
  const applied: T[] = [];
  const conflicts: T[] = [];
  for (const op of ops) {
    const at = await locateBlock(text, path, op.block);
    if (!at) {
      conflicts.push(op);
      continue;
    }
    let next: string;
    if (op.action === "keep") next = keepDraft(text, at.range);
    else if (op.action === "discard") next = discardBlock(text, at.range);
    else next = rewriteBlock(text, at.range, op.text ?? "");
    // A rewrite was checked against the file as it was when it was typed; the
    // file around it may have changed since. Never commit what will not parse.
    try {
      await parseFile(next, path, "");
    } catch {
      conflicts.push(op);
      continue;
    }
    text = next;
    applied.push(op);
  }
  return { text, applied, conflicts };
}
