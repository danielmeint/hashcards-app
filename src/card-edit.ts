import { Card } from "./types";
import { GitHubConfig, deleteFile, readFile, writeFile } from "./github";
import { parseFile } from "./parser";
import { getAllPerformances, migrateCardHistory, updateDeckFiles } from "./db";
import { deckNameFor, loadCachedCards, loadCards } from "./sync";

/**
 * Editing a card in the app rather than on GitHub.
 *
 * The deep link from 4.2 hands you off to a web editor with the whole file in
 * it, on a device where typing is unpleasant, and then leaves you to find your
 * way back. Everything needed to do it here already existed: cards carry
 * `filePath` and an absolute line `range`, and the credential is write-scoped.
 *
 * The part that only works here is scheduling. Card identity is a hash of the
 * content, so an edit produces a new card and the old one's history is stranded
 * — see 1.7. An edit made in the app is the one moment both hashes are known at
 * once, so it is the one place that history can follow the card.
 */

export type CardSource = {
  /** Just the card's own lines — what the editor puts in the box. */
  text: string;
  /** The whole file, so an edit can be spliced back into it. */
  file: string;
  /** The blob SHA this edit is based on. */
  sha: string;
};

export async function readCardSource(
  config: GitHubConfig,
  card: Card
): Promise<CardSource> {
  const { text, sha } = await readFile(config, card.filePath);
  return { file: text, sha, text: sliceLines(text, card.range) };
}

/** The lines `range` covers: absolute, 1-based, inclusive, as `Card` means it. */
export function sliceLines(file: string, [start, end]: [number, number]): string {
  return file.split("\n").slice(start - 1, end).join("\n");
}

/**
 * Put `replacement` where `range` used to be. An empty replacement removes
 * those lines outright — clearing the box is how a card gets deleted, which
 * needs no separate button and no confirmation dialog to explain itself.
 */
export function spliceLines(
  file: string,
  [start, end]: [number, number],
  replacement: string
): string {
  const lines = file.split("\n");
  const inserted =
    replacement.trim() === "" ? [] : replacement.replace(/\n+$/, "").split("\n");
  lines.splice(start - 1, end - start + 1, ...inserted);
  return lines.join("\n");
}

export type EditResult = {
  /** What the edited lines parse into now — empty if the edit removed them. */
  cards: Card[];
  /** How many of them kept the history of the card they replaced. */
  migrated: number;
  /** Whether the file itself was deleted, having nothing left in it. */
  removedFile: boolean;
};

/**
 * Commit an edit and reconcile everything local with it.
 *
 * `source` is the read the user's text was typed against, not a fresh one: its
 * SHA is what makes a file that changed underneath us fail loudly rather than
 * quietly overwrite whatever moved it.
 */
export async function commitCardEdit(
  config: GitHubConfig,
  card: Card,
  source: CardSource,
  replacement: string,
  options: { keepScheduling: boolean }
): Promise<EditResult> {
  const before = cardsInRange(await loadCachedCards(), card.filePath, card.range);
  const updated = spliceLines(source.file, card.range, replacement);
  const deck = deckNameFor(card.filePath);

  // A file with nothing left in it is not a file to leave behind as an empty
  // commit — the deck it backs is gone either way, and an empty deck in the
  // list is worse than no deck.
  if (updated.trim() === "") {
    await deleteFile(
      config,
      card.filePath,
      source.sha,
      `Remove ${card.filePath}, its last card deleted`
    );
    await updateDeckFiles([], [card.filePath]);
    await loadCards();
    return { cards: [], migrated: 0, removedFile: true };
  }

  const removing = replacement.trim() === "";
  const sha = await writeFile(config, card.filePath, updated, {
    sha: source.sha,
    message: removing
      ? `Remove a card from ${card.filePath}`
      : `Rewrite a card in ${card.filePath}`,
  });

  const parsed = await parseFile(updated, card.filePath, deck);
  await updateDeckFiles([{ path: card.filePath, sha, cards: parsed }], []);
  await loadCards();

  // Where the replacement now sits: the same first line, however many lines it
  // turned into.
  const lineCount = removing ? 0 : replacement.replace(/\n+$/, "").split("\n").length;
  const after = removing
    ? []
    : cardsInRange(parsed, card.filePath, [
        card.range[0],
        card.range[0] + lineCount - 1,
      ]);

  const migrated = options.keepScheduling ? await carryHistory(before, after) : 0;
  return { cards: after, migrated, removedFile: false };
}

/** Cards whose own lines overlap `range` — a cloze block yields several. */
function cardsInRange(
  cards: Card[],
  path: string,
  [start, end]: [number, number]
): Card[] {
  return cards
    .filter(
      (c) => c.filePath === path && c.range[0] <= end && c.range[1] >= start
    )
    .sort((a, b) => a.range[0] - b.range[0]);
}

/**
 * Pair what was there against what replaced it, in order, and move each pair's
 * history across.
 *
 * By position rather than by content, because content is exactly what changed.
 * It is the right answer for the case this exists to serve — one card rewritten
 * in place — and for a cloze block whose deletions keep their order. Deletions
 * reordered within a block would pair wrongly; that costs the scheduling of
 * cards you were editing anyway, which is the same thing that happens today
 * with no pairing at all.
 */
async function carryHistory(before: Card[], after: Card[]): Promise<number> {
  const performances = await getAllPerformances();
  let migrated = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const from = before[i].hash;
    const to = after[i].hash;
    // An unchanged sibling in an edited cloze block already has its history.
    if (from === to || !performances.has(from)) continue;
    await migrateCardHistory(from, to);
    migrated++;
  }
  return migrated;
}
