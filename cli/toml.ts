/**
 * The part of TOML that `hashcards.toml` uses: `[tables]`, `key = value`,
 * strings, numbers, booleans and arrays of them (arrays may span lines),
 * comments. Not a TOML parser — no inline tables, dates, dotted keys or
 * multi-line strings — but strict about what it does read, so a typo is an
 * error with a line number rather than a silently missing setting. A full TOML
 * dependency would outweigh the rest of the CLI for a dozen keys.
 */

export type TomlValue = string | number | boolean | TomlValue[];
export type TomlTable = Record<string, TomlValue>;
/** Top-level keys under `""`, every `[table]` under its name. */
export type TomlDocument = Record<string, TomlTable>;

export class TomlError extends Error {
  constructor(
    message: string,
    readonly line: number
  ) {
    super(`${message} (line ${line})`);
  }
}

export function parseToml(text: string): TomlDocument {
  const doc: TomlDocument = { "": {} };
  let table = doc[""];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = stripComment(lines[i]).trim();
    if (line === "") continue;

    const header = line.match(/^\[\s*([A-Za-z0-9_-]+)\s*\]$/);
    if (header) {
      if (doc[header[1]]) throw new TomlError(`table [${header[1]}] defined twice`, lineNo);
      table = doc[header[1]] = {};
      continue;
    }

    const pair = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!pair) throw new TomlError(`expected 'key = value' or '[table]', got '${line}'`, lineNo);
    const [, key, first] = pair;
    if (key in table) throw new TomlError(`key '${key}' defined twice`, lineNo);

    // An array may run over several lines: gather until its brackets balance.
    let source = first;
    while (source.startsWith("[") && !balanced(source)) {
      i++;
      if (i >= lines.length) throw new TomlError(`unclosed array for '${key}'`, lineNo);
      source += " " + stripComment(lines[i]).trim();
    }
    const reader = { src: source, pos: 0 };
    const value = readValue(reader, lineNo);
    skipSpace(reader);
    if (reader.pos !== reader.src.length) {
      throw new TomlError(`unexpected '${reader.src.slice(reader.pos)}' after the value of '${key}'`, lineNo);
    }
    table[key] = value;
  }
  return doc;
}

/** The line without its comment; a `#` inside a string is not one. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

function balanced(src: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
  }
  return depth <= 0;
}

type Reader = { src: string; pos: number };

function skipSpace(r: Reader): void {
  while (r.pos < r.src.length && /\s/.test(r.src[r.pos])) r.pos++;
}

function readValue(r: Reader, line: number): TomlValue {
  skipSpace(r);
  const rest = r.src.slice(r.pos);
  if (rest.startsWith("[")) {
    r.pos++;
    const items: TomlValue[] = [];
    for (;;) {
      skipSpace(r);
      if (r.src[r.pos] === "]") {
        r.pos++;
        return items;
      }
      items.push(readValue(r, line));
      skipSpace(r);
      if (r.src[r.pos] === ",") r.pos++;
      else if (r.src[r.pos] !== "]") throw new TomlError("expected ',' or ']' in array", line);
    }
  }
  const basic = rest.match(/^"((?:[^"\\]|\\.)*)"/);
  if (basic) {
    r.pos += basic[0].length;
    try {
      return JSON.parse(`"${basic[1]}"`) as string;
    } catch {
      throw new TomlError(`bad escape in string ${basic[0]}`, line);
    }
  }
  const literal = rest.match(/^'([^']*)'/);
  if (literal) {
    r.pos += literal[0].length;
    return literal[1];
  }
  const bool = rest.match(/^(true|false)\b/);
  if (bool) {
    r.pos += bool[0].length;
    return bool[1] === "true";
  }
  const num = rest.match(/^[+-]?(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/);
  if (num && num[0] !== "") {
    r.pos += num[0].length;
    return Number(num[0].replaceAll("_", ""));
  }
  throw new TomlError(`cannot read a value from '${rest}'`, line);
}
