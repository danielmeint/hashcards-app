/**
 * The globs of `hashcards.toml`: `[decks] include` / `exclude` and each
 * `[limits.<name>] decks`. One implementation for the app and `hc`, which
 * used to have one each and disagreed on braces and on a leading `/`.
 *
 * Patterns are matched against the path from the repository root, with `/`
 * between segments:
 *
 * - `*` matches any run of characters within one segment, `?` one character.
 * - `**` as a whole segment matches any number of segments, including none:
 *   `**\/*.md` is every Markdown file, `archive/**` everything under `archive`.
 *   Anywhere else it is an ordinary `*`, as in `.gitignore`.
 * - `{a,b}` is either alternative.
 * - A pattern with no `/` matches the file name at any depth, as in
 *   `.gitignore`: `README.md` matches every README, not only the top one.
 *   One with a `/` is anchored at the root; a leading `/` changes nothing.
 *
 * No character classes and no negation: `[` and `!` are themselves.
 */

const regexCache = new Map<string, RegExp>();

export function globMatch(pattern: string, path: string): boolean {
  let re = regexCache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    regexCache.set(pattern, re);
  }
  return re.test(path);
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globMatch(pattern, path));
}

/**
 * What is wrong with `pattern`, or null if nothing is. A pattern that can
 * never match is the usual mistake: an empty one, an unclosed brace, or a
 * folder written as `interview/` where every file in it is `interview/**`.
 */
export function globProblem(pattern: string): string | null {
  if (pattern.trim() === "") return "an empty glob matches nothing";
  let depth = 0;
  for (const c of pattern) {
    if (c === "{") depth++;
    else if (c === "}" && --depth < 0) return `'${pattern}' has a '}' with no '{'`;
  }
  if (depth > 0) return `'${pattern}' has a '{' with no '}'`;
  if (pattern.endsWith("/")) {
    return `'${pattern}' ends with '/' and matches no file: '${pattern}**' is everything in it`;
  }
  return null;
}

function globToRegExp(pattern: string): RegExp {
  // Anchoring is the whole pattern's: `{cka,geo}/*.md` is two folders at the root.
  const anchored = pattern.includes("/");
  const source = expandBraces(pattern.replace(/^\/+/, ""))
    .map(segmentsToRegExp)
    .join("|");
  return new RegExp(anchored ? `^(?:${source})$` : `^(?:.*/)?(?:${source})$`);
}

/** `a{b,c}d` → `abd`, `acd`; nested braces too. An unmatched brace is literal. */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  let depth = 0;
  const commas: number[] = [];
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "{") depth++;
    else if (c === "," && depth === 1) commas.push(i);
    else if (c === "}" && --depth === 0) {
      const head = pattern.slice(0, open);
      const tail = pattern.slice(i + 1);
      const cuts = [open, ...commas, i];
      const alternatives = cuts.slice(1).map((end, k) => pattern.slice(cuts[k] + 1, end));
      return alternatives.flatMap((alt) => expandBraces(head + alt + tail));
    }
  }
  return [pattern];
}

function segmentsToRegExp(pattern: string): string {
  const segments = pattern.split("/");
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
  return source;
}
