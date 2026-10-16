import { scanFile } from "./parser";

/**
 * Removing `ID:` lines (PLAN-1.0 §2.7).
 *
 * The first 1.0 builds gave every card an `ID:` line. A card is its text
 * again, so those lines only say what the card used to be called — which
 * `hc migrate` records as `link` events before it calls this to take them out.
 */

/**
 * `fileText` without the `ID:` line of any card block, and every other byte
 * exactly as it was: frontmatter, blank lines, line endings, the trailing
 * newline or its absence. Idempotent. Throws, like the parser, on a file it
 * cannot read.
 */
export function stripIds(fileText: string, filePath = "(unnamed file)"): string {
  const { lines, lineOffset, cards } = scanFile(fileText, filePath);
  const drop = new Set(
    cards.flatMap((card) => (card.meta?.id ? [lineOffset + card.meta.id.line] : []))
  );
  return drop.size === 0 ? fileText : lines.filter((_, i) => !drop.has(i)).join("\n");
}

/** Whether `fileText` has any `ID:` line left to strip. */
export function hasIds(fileText: string, filePath = "(unnamed file)"): boolean {
  return scanFile(fileText, filePath).cards.some((card) => card.meta?.id);
}
