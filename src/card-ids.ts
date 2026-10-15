import { isValidId } from "./card-key";
import { scanFile } from "./parser";

/**
 * Giving cards their IDs (PLAN-1.0 §2.1).
 *
 * A file written by hand or by an agent may have cards with no `ID:` line. They
 * still work — their key falls back to the content hash — but that key moves
 * with every typo fix, which is the problem IDs exist to solve. Stamping writes
 * one in, once, and from then on the card is the ID however its text changes.
 */

/**
 * Crockford's base32 alphabet, lowercased: digits and letters without i, l, o
 * and u. Every one of them is valid in an ID, and none of them can be misread
 * as another by someone copying an ID off a screen.
 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Eight characters: 40 bits, so a collision in one collection is not a worry. */
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  // 256 is a multiple of 32, so masking keeps every character equally likely.
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join("");
}

/**
 * How many times to ask for an ID that is not already taken before deciding
 * the generator is broken. A real one collides about never; a test double that
 * returns the same value forever should fail, not hang.
 */
const MAX_ATTEMPTS = 100;

/**
 * `fileText` with an `ID:` line added at the top of every card block that has
 * none, and every other byte exactly as it was: frontmatter, blank lines, line
 * endings, the trailing newline or its absence. A file someone else wrote is
 * theirs, and a diff that touches anything but the new lines is one nobody can
 * review.
 *
 * Stamping is idempotent, and leaves every card's v1 hash alone: metadata
 * never enters it. Throws, like the parser, on a file it cannot read.
 */
export function stampIds(
  fileText: string,
  generate: () => string = randomId,
  filePath = "(unnamed file)"
): string {
  const { lines, lineOffset, cards } = scanFile(fileText, filePath);

  const taken = new Set(
    cards.flatMap((card) => (card.meta?.id ? [card.meta.id.value] : []))
  );
  const fresh = (): string => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const id = generate();
      if (!isValidId(id)) throw new Error(`Generated an invalid card ID: '${id}'`);
      if (!taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
    throw new Error(`Could not generate an unused card ID in ${MAX_ATTEMPTS} attempts`);
  };

  // Decided top to bottom, so IDs read in file order; inserted bottom to top,
  // so each insertion leaves the line numbers of the ones still to come alone.
  const insertions = cards
    .filter((card) => !card.meta?.id)
    .map((card) => {
      const at = lineOffset + card.startLine;
      // The line we are inserting above says how this file ends its lines.
      const eol = lines[at].endsWith("\r") ? "\r" : "";
      const idLine = `ID: ${fresh()}${eol}`;
      // A card begun by the tag that ended the one before has no block top to
      // put metadata on: an ID line there would be the previous card's answer.
      // A separator makes it one.
      return { at, added: card.implicit ? [`---${eol}`, idLine] : [idLine] };
    });

  for (const { at, added } of insertions.reverse()) {
    lines.splice(at, 0, ...added);
  }
  return lines.join("\n");
}
