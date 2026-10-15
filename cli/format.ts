import { cardSummary } from "../src/leeches";
import type { ParsedCard } from "../src/types";

/**
 * Human output. Plain text, aligned, nothing a pipe would choke on: colour and
 * decoration are not worth a second code path when `--json` exists for
 * scripts, and agents read the plain text best anyway.
 */

/** One line naming a card, cloze deletions marked `[…]`. */
export function summary(card: ParsedCard, width = 72): string {
  return truncate(cardSummary({ ...card, repo: "" }), width);
}

export function truncate(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, width - 1) + "…";
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Rows as aligned columns; the last column is left ragged. */
export function table(rows: string[][], indent = "  "): string {
  if (rows.length === 0) return "";
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map(
      (r) =>
        indent +
        r
          .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i])))
          .join("  ")
          .trimEnd()
    )
    .join("\n");
}

export const GRADE_NAMES: Record<number, string> = { 1: "forgot", 2: "hard", 3: "good", 4: "easy" };

/** A percentage, or "–" for no data. */
export function percent(rate: number | null): string {
  return rate === null ? "–" : `${(rate * 100).toFixed(1)}%`;
}

/** A horizontal bar for small counts, scaled to `max`. */
export function bar(n: number, max: number, width = 30): string {
  if (max === 0 || n === 0) return "";
  return "█".repeat(Math.max(1, Math.round((n / max) * width)));
}
