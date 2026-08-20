import { Card } from "./types";
import {
  GitHubConfig,
  deleteFile,
  readFile,
  RepoConfig,
  readFileIfPresent,
  repoFor,
  repoKey,
  writeFile,
} from "./github";
import { parseFile } from "./parser";
import {
  getAllPerformances,
  inRepo,
  migrateCardHistory,
  updateDeckFiles,
} from "./db";
import { deckNameFor, exclusive, loadCachedCards, loadCards } from "./sync";

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

/**
 * The card's own lines, and the file around them, from the collection the card
 * came out of — not from whichever repo happens to be the writable one. With
 * more than one configured those are different answers, and using the wrong one
 * reads a file that has nothing to do with the card on screen.
 */
export async function readCardSource(card: Card): Promise<CardSource> {
  const repo = repoFor(card.repo);
  if (!repo) throw new Error(`${card.repo} is no longer one of your collections.`);
  const { text, sha } = await readFile(repo, card.filePath);
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
  /**
   * The one card that took the edited card's place, paired by position — the
   * card a drill should put back on screen. Null if the edit deleted it.
   */
  card: Card | null;
  /** How many of them kept the history of the card they replaced. */
  migrated: number;
  /** Whether the old card's history followed the new hash. */
  keptScheduling: boolean;
  /** Whether the file itself was deleted, having nothing left in it. */
  removedFile: boolean;
};

/**
 * The text in the box is not a card file.
 *
 * Distinguished from every other failure because it is the only one the user
 * can fix from where they are standing — nothing has been sent anywhere, and
 * the text is still in the box.
 */
export class CardSyntaxError extends Error {}

/**
 * The collection this card lives in is one the app only reads.
 *
 * A subscription is someone else's repository. The app has no business
 * committing to it, and the credential very likely cannot anyway — so this is
 * refused here, where the answer is certain, rather than as a 403 from GitHub
 * after the user has typed out a card.
 */
export class ReadOnlyRepoError extends Error {
  constructor(repo: string) {
    super(`${repo} is a subscription — it is read here, never written to.`);
  }
}

/** The collection to commit to, or a refusal naming why there is none. */
function writableRepo(key: string): RepoConfig {
  const repo = repoFor(key);
  if (!repo) throw new Error(`${key} is no longer one of your collections.`);
  if (repo.readOnly) throw new ReadOnlyRepoError(key);
  return repo;
}

/**
 * Commit an edit and reconcile everything local with it.
 *
 * `source` is the read the user's text was typed against, not a fresh one: its
 * SHA is what makes a file that changed underneath us fail loudly rather than
 * quietly overwrite whatever moved it.
 */
export function commitCardEdit(
  card: Card,
  source: CardSource,
  replacement: string,
  options: { keepScheduling: boolean }
): Promise<EditResult> {
  // Refused before the queue rather than inside it: there is nothing to
  // serialize about an edit that is not going to happen.
  const config = writableRepo(card.repo);
  // Queued behind any sync in progress, and any sync queued behind it. Both
  // write the deck store, and this one also writes the repo.
  return exclusive(() => runEdit(config, card, source, replacement, options));
}

async function runEdit(
  config: RepoConfig,
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
    await updateDeckFiles([], [{ repo: card.repo, path: card.filePath }]);
    await loadCards();
    return {
      cards: [],
      card: null,
      migrated: 0,
      keptScheduling: false,
      removedFile: true,
    };
  }

  const removing = replacement.trim() === "";

  // Parsed before it is committed, not after. `parseFile` throws on a file it
  // cannot read, and a throw on this side of the write used to leave the repo
  // holding a file the app then refused to load — with the SHA the edit was
  // based on now stale, so trying again conflicted rather than recovering.
  const parsed = await validate(updated, card.repo, card.filePath, deck);

  const sha = await writeFile(config, card.filePath, updated, {
    sha: source.sha,
    message: removing
      ? `Remove a card from ${card.filePath}`
      : `Rewrite a card in ${card.filePath}`,
  });

  await updateDeckFiles(
    [{ repo: card.repo, path: card.filePath, sha, cards: parsed }],
    []
  );
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

  // Paired by position, the same way the history is: the card that replaced
  // this one is the one that landed in its slot.
  const slot = before.findIndex((c) => c.hash === card.hash);
  return {
    cards: after,
    card: after[slot === -1 ? 0 : slot] ?? null,
    migrated,
    keptScheduling: options.keepScheduling,
    removedFile: false,
  };
}

/**
 * What a file would parse into, or a `CardSyntaxError` saying why it would not.
 *
 * The parser's own message names the file and the line, which is the useful
 * half; the prefix says whose fault it is, since the same message from a sync
 * means "someone else broke this" and here it means "what you just typed".
 */
async function validate(
  text: string,
  repo: string,
  path: string,
  deck: string
): Promise<Card[]> {
  try {
    return inRepo(await parseFile(text, path, deck), repo);
  } catch (e) {
    throw new CardSyntaxError(`That isn't a card yet — ${(e as Error).message}`);
  }
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

/**
 * A card written from scratch rather than fixed in place.
 *
 * The other half of authoring, and deliberately the simpler one: appending to
 * the end of a file needs no range, no SHA arithmetic on the lines around it,
 * and no history to carry — a card that did not exist has nothing to keep.
 * What it does share with an edit is that the file is parsed before it is
 * committed, so a half-typed `Q:` with no `A:` is refused here rather than
 * pushed to the repo and refused by every device that syncs it.
 */
export type CaptureResult = {
  /** What the appended text parsed into — usually one card, more for a cloze. */
  cards: Card[];
  path: string;
  /** Whether this wrote the deck file into existence. */
  created: boolean;
};

export function createCard(
  config: GitHubConfig,
  path: string,
  text: string
): Promise<CaptureResult> {
  return exclusive(() => runCapture(writableRepo(repoKey(config)), path, text));
}

async function runCapture(
  config: GitHubConfig,
  path: string,
  text: string
): Promise<CaptureResult> {
  const body = text.trim();
  if (body === "") throw new CardSyntaxError("There is nothing to save yet.");

  const existing = await readFileIfPresent(config, path);
  const deck = deckNameFor(path);
  const before = existing?.text ?? "";

  // A blank line between cards, and exactly one — the format separates cards by
  // their tags, but a file people also read should not run them together.
  const head = before.replace(/\s+$/, "");
  const updated = head === "" ? `${body}\n` : `${head}\n\n${body}\n`;

  const parsed = await validate(updated, repoKey(config), path, deck);

  const sha = await writeFile(config, path, updated, {
    ...(existing ? { sha: existing.sha } : {}),
    message: existing ? `Add a card to ${path}` : `Add ${path}`,
  });
  await updateDeckFiles(
    [{ repo: repoKey(config), path, sha, cards: parsed }],
    []
  );
  await loadCards();

  // The lines the new text occupies: everything after what was already there.
  const firstLine = head === "" ? 1 : head.split("\n").length + 2;
  return {
    cards: cardsInRange(parsed, path, [firstLine, updated.split("\n").length]),
    path,
    created: existing === null,
  };
}
