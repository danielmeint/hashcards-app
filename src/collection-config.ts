import { MAX_RETENTION, MIN_RETENTION } from "./core/schedule";

/**
 * `hashcards.toml`: the collection's settings, kept in the repository so every
 * device (and `hc`) reads the same ones (PLAN-1.0 §2.5).
 *
 *     [review]
 *     new_per_day = 20
 *     desired_retention = 0.9     # 0.80–0.95
 *     fuzz = true
 *
 *     [decks]
 *     include = ["**\/*.md"]
 *     exclude = ["README.md", "AGENTS.md", "archive/**"]
 *
 * Not a TOML library. The file has five documented keys, and the frontmatter
 * reader (M1) already set the precedent of reading the subset this format uses
 * by hand rather than shipping a parser for the rest. What this reads: tables,
 * `key = value` with integers, floats, booleans, basic strings and arrays of
 * strings (which may span lines), and `#` comments. Anything else in the file
 * is left alone — not read, and when writing, not touched.
 *
 * Writing patches the lines of the keys that changed and keeps every other
 * byte, so a hand-written comment or an unknown table survives the app saving
 * a setting.
 */

export type ReviewConfig = {
  newPerDay?: number;
  desiredRetention?: number;
  fuzz?: boolean;
};

export type DeckConfig = {
  include?: string[];
  exclude?: string[];
};

export type CollectionConfig = {
  review: ReviewConfig;
  decks: DeckConfig;
};

type Value = string | number | boolean | string[];

/** A `#` outside a string starts a comment. */
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && inString) i++;
    else if (c === '"') inString = !inString;
    else if (c === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function parseString(text: string): string | undefined {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(text);
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return undefined;
  }
}

function parseValue(text: string): Value | undefined {
  const t = text.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^[+-]?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith('"')) return parseString(t);
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (inner === "") return [];
    const items: string[] = [];
    // Split on commas outside strings; a trailing comma is allowed.
    let depth = "";
    let current = "";
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === "\\" && depth) {
        current += c + inner[++i];
        continue;
      }
      if (c === '"') depth = depth ? "" : '"';
      if (c === "," && !depth) {
        items.push(current);
        current = "";
      } else current += c;
    }
    if (current.trim() !== "") items.push(current);
    const strings = items.map((item) => parseString(item.trim()));
    return strings.every((s): s is string => s !== undefined) ? strings : undefined;
  }
  return undefined;
}

type Entry = { table: string; key: string; value: Value | undefined; first: number; last: number };

/** Every `key = value` in the file, with the lines it spans. */
function entries(text: string): { entries: Entry[]; tables: Map<string, number>; lines: string[] } {
  const lines = text.split("\n");
  const found: Entry[] = [];
  const tables = new Map<string, number>();
  let table = "";
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (line === "") continue;
    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header) {
      table = header[1];
      tables.set(table, i);
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    let raw = kv[2];
    let last = i;
    // An array may run over several lines until its closing bracket.
    if (raw.startsWith("[") && !raw.trimEnd().endsWith("]")) {
      while (last + 1 < lines.length) {
        last++;
        raw += " " + stripComment(lines[last]).trim();
        if (raw.trimEnd().endsWith("]")) break;
      }
    }
    found.push({ table, key: kv[1], value: parseValue(raw), first: i, last });
  }
  return { entries: found, tables, lines };
}

function lookup(found: Entry[], table: string, key: string): Value | undefined {
  return found.find((e) => e.table === table && e.key === key)?.value;
}

/**
 * What the file says. A value of the wrong type or out of range is ignored —
 * the device keeps its own — rather than refusing the whole file over it.
 */
export function parseConfig(text: string): CollectionConfig {
  const { entries: found } = entries(text);
  const review: ReviewConfig = {};
  const decks: DeckConfig = {};

  const perDay = lookup(found, "review", "new_per_day");
  if (typeof perDay === "number" && Number.isInteger(perDay) && perDay >= 0) {
    review.newPerDay = perDay;
  }
  const retention = lookup(found, "review", "desired_retention");
  if (
    typeof retention === "number" &&
    retention >= MIN_RETENTION &&
    retention <= MAX_RETENTION
  ) {
    review.desiredRetention = retention;
  }
  const fuzz = lookup(found, "review", "fuzz");
  if (typeof fuzz === "boolean") review.fuzz = fuzz;

  const include = lookup(found, "decks", "include");
  if (Array.isArray(include)) decks.include = include;
  const exclude = lookup(found, "decks", "exclude");
  if (Array.isArray(exclude)) decks.exclude = exclude;

  return { review, decks };
}

function formatValue(value: Value): string {
  if (Array.isArray(value)) return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

const REVIEW_KEYS: [keyof ReviewConfig, string][] = [
  ["newPerDay", "new_per_day"],
  ["desiredRetention", "desired_retention"],
  ["fuzz", "fuzz"],
];

/**
 * `text` with the given `[review]` values set, everything else kept. A key
 * already in the file has its value replaced in place (a trailing comment
 * stays); a missing one goes at the end of the table; a missing table goes at
 * the end of the file.
 */
export function writeReviewConfig(text: string, review: ReviewConfig): string {
  let out = text;
  for (const [field, key] of REVIEW_KEYS) {
    const value = review[field];
    if (value === undefined) continue;
    out = setValue(out, "review", key, value);
  }
  return out;
}

function setValue(text: string, table: string, key: string, value: Value): string {
  const { entries: found, tables, lines } = entries(text);
  const line = `${key} = ${formatValue(value)}`;
  const existing = found.find((e) => e.table === table && e.key === key);
  if (existing) {
    const original = lines[existing.first];
    const comment = original.slice(stripComment(original).length);
    const indent = /^\s*/.exec(original)![0];
    const replacement = `${indent}${line}${comment ? " " + comment.trimStart() : ""}`;
    lines.splice(existing.first, existing.last - existing.first + 1, replacement);
    return lines.join("\n");
  }
  if (tables.has(table)) {
    // After the table's last entry, so it does not land after a blank line
    // that separates this table from the next one.
    const inTable = found.filter((e) => e.table === table);
    const at = inTable.length > 0 ? inTable[inTable.length - 1].last + 1 : tables.get(table)! + 1;
    lines.splice(at, 0, line);
    return lines.join("\n");
  }
  const body = text.replace(/\s+$/, "");
  return `${body}${body === "" ? "" : "\n\n"}[${table}]\n${line}\n`;
}

// --- Deck globs ---------------------------------------------------------------

/**
 * Which Markdown files are decks.
 *
 * Patterns are matched against the path from the repository root, with `/`
 * between segments:
 *
 * - `*` matches any run of characters within one segment, `?` one character.
 * - `**` as a whole segment matches any number of segments, including none:
 *   `**\/*.md` is every Markdown file, `archive/**` everything under `archive`.
 * - A pattern with no `/` matches the file name at any depth, as in
 *   `.gitignore`: `README.md` excludes every README, not only the top one.
 *   One with a `/` is anchored at the root.
 *
 * No braces, no character classes, no negation: a file is a deck when it
 * matches some `include` (all `.md` files when there is none) and no
 * `exclude`. Only `.md` files are ever decks, whatever the globs say.
 */
export function isDeckPath(path: string, decks: DeckConfig): boolean {
  if (!path.endsWith(".md")) return false;
  const include = decks.include ?? ["**/*.md"];
  return (
    include.some((pattern) => globMatch(pattern, path)) &&
    !(decks.exclude ?? []).some((pattern) => globMatch(pattern, path))
  );
}

const regexCache = new Map<string, RegExp>();

export function globMatch(pattern: string, path: string): boolean {
  let re = regexCache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    regexCache.set(pattern, re);
  }
  return re.test(path);
}

function globToRegExp(pattern: string): RegExp {
  const anchored = pattern.includes("/");
  const segments = pattern.replace(/^\/+/, "").split("/");
  let source = "";
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === "**") {
      source += last ? ".*" : "(?:[^/]+/)*";
      return;
    }
    source += segment
      .split("")
      .map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("");
    if (!last) source += "/";
  });
  return new RegExp(anchored ? `^${source}$` : `^(?:.*/)?${source}$`);
}
