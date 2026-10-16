/**
 * The text half of editing a card: which lines are the card, and how a
 * rewrite goes back into the file. Pure, and kept apart from `card-edit.ts`
 * so that what the Inbox does to a file (`draft-edits.ts`) can share it
 * without importing the sync machinery that commits it.
 */

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
