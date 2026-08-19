import { Card, Grade, Review } from "./types";

/**
 * Cards that keep failing.
 *
 * Full review history sits in IndexedDB and has only ever been surfaced as
 * aggregates — how many reviews, what retention, which days. The actionable
 * signal in it is *which specific cards* keep failing, because a card that
 * fails repeatedly is almost always a badly written card rather than a hard
 * fact: two questions in one, an ambiguous answer, a cloze with nothing around
 * it to cue the recall.
 */

export type Leech = {
  card: Card;
  /** Reviews graded Forgot — the only grade FSRS treats as a failure. */
  lapses: number;
  reviews: number;
  lastLapseAt: string;
  /** Successful reviews since the last lapse. */
  streak: number;
};

/**
 * Anki's default is 8, which suits a collection with years behind it. Three is
 * the point at which a card is worth *looking* at here — this list suggests a
 * rewrite rather than suspending anything, so being early is cheap.
 */
export const LEECH_THRESHOLD = 3;

/** Answered correctly this many times running: whatever was wrong, it stuck. */
export const RECOVERED_STREAK = 3;

export function isRecovering(leech: Leech): boolean {
  return leech.streak >= RECOVERED_STREAK;
}

/**
 * Cards with at least `threshold` lapses, worst first.
 *
 * Reviews for cards that are no longer in the collection are ignored: editing a
 * card gives it a new hash (see roadmap 1.7), and the old history is still in
 * the store but belongs to a card there is no longer anything to rewrite.
 */
export function findLeeches(
  cards: Card[],
  reviews: Review[],
  threshold: number = LEECH_THRESHOLD
): Leech[] {
  const byHash = new Map(cards.map((c) => [c.hash, c]));

  const grouped = new Map<string, Review[]>();
  for (const review of reviews) {
    if (!byHash.has(review.cardHash)) continue;
    const list = grouped.get(review.cardHash);
    if (list) list.push(review);
    else grouped.set(review.cardHash, [review]);
  }

  const leeches: Leech[] = [];
  for (const [hash, history] of grouped) {
    // Insertion order is chronological in practice, but an undo removes and a
    // later grade re-adds, so sort rather than assume.
    history.sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));

    const lapseIndexes = history
      .map((r, i) => (r.grade === Grade.Forgot ? i : -1))
      .filter((i) => i >= 0);
    if (lapseIndexes.length < threshold) continue;

    const last = lapseIndexes[lapseIndexes.length - 1];
    leeches.push({
      card: byHash.get(hash)!,
      lapses: lapseIndexes.length,
      reviews: history.length,
      lastLapseAt: history[last].reviewedAt,
      streak: history.length - last - 1,
    });
  }

  // Still failing first, then by how much. A card that has since been answered
  // correctly several times running is not what you came here to rewrite, but
  // it is worth being able to see.
  leeches.sort(
    (a, b) =>
      Number(isRecovering(a)) - Number(isRecovering(b)) ||
      b.lapses - a.lapses ||
      b.lapses / b.reviews - a.lapses / a.reviews ||
      a.card.hash.localeCompare(b.card.hash)
  );
  return leeches;
}

/**
 * One line of plain text identifying a card, for a list where you are
 * recognising it rather than answering it. Cloze cards show the sentence with
 * the deletion marked, since the sentence is what you would be rewriting.
 */
export function cardSummary(card: Card): string {
  if (card.content.type === "basic") return collapse(card.content.question);

  // start/end are byte offsets into the text, as the parser's scanner produced
  // them — slicing by character would cut multi-byte text in the wrong place.
  const { text, start, end } = card.content;
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder();
  return collapse(
    decoder.decode(bytes.slice(0, start)) +
      "[…]" +
      decoder.decode(bytes.slice(end + 1))
  );
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
