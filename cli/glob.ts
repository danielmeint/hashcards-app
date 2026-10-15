/**
 * Glob patterns for `hashcards.toml`'s `[decks] include` / `exclude`.
 *
 * `**` crosses directories, `*` and `?` do not, `{a,b}` is either. A pattern
 * with no `/` matches a file's name at any depth (`README.md` excludes every
 * README, as in `.gitignore`); one with a `/` is matched against the whole path
 * from the repo root. Paths always use `/`.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) re += "\\{";
      else {
        const alternatives = pattern.slice(i + 1, close).split(",");
        re += `(?:${alternatives.map((a) => globToRegExp(a).source.slice(1, -1)).join("|")})`;
        i = close;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesGlob(path: string, pattern: string): boolean {
  const target = pattern.includes("/") ? path : path.slice(path.lastIndexOf("/") + 1);
  return globToRegExp(pattern).test(target);
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesGlob(path, p));
}
