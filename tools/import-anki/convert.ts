/**
 * Content conversion: ankictl deck YAML -> hashcards v2 card text.
 *
 * Everything here is a pure string function, so the importer's semantics can
 * be tested without a collection or a file system.
 */

import { Marked } from "marked";

/** The app's renderer minus its extensions: GFM, `breaks: false`. */
const gfm = new Marked();

// --------------------------------------------------------------------------
// Card IDs

/** PLAN-1.0.md §2.1. IDs cannot contain `/` or `:`, so card keys parse. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MAX_ID = 64;

/**
 * ankictl's slug rules (naming.py `slugify`), so a key that is already a valid
 * ankictl slug comes out unchanged: NFKD, drop non-ASCII, lowercase, collapse
 * everything else to single hyphens.
 */
export function slugify(text: string, maxLen = MAX_ID): string {
  let slug = text
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > maxLen) {
    // Cut at a word boundary when there is one, as ankictl does, so a long key
    // does not end mid-word.
    const cut = slug.slice(0, maxLen);
    const lastHyphen = cut.lastIndexOf("-");
    slug = (lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/, "");
  }
  return slug;
}

/** FNV-1a, 32-bit. Only used to make a fallback ID deterministic. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * A valid card ID for an ankictl key, deterministically.
 *
 * Valid keys pass through untouched: they are what Daniel types and what the
 * review log refers to. Anything else is slugged; a key with nothing sluggable
 * in it (`"?"`, `"日本"`) gets `k-<hash>`, so it is still stable across runs.
 */
export function toCardId(key: string): string {
  if (ID_PATTERN.test(key)) return key;
  const slug = slugify(key);
  if (ID_PATTERN.test(slug)) return slug;
  return `k-${fnv1a(key)}`;
}

/**
 * Assign IDs to keys in order, resolving collisions created by slugging
 * (`Foo` and `foo` both slug to `foo`) with `-2`, `-3`, … . A key that was
 * already valid always keeps its ID, so collisions only ever move slugged keys.
 */
export function assignCardIds(keys: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set(keys.filter((k) => ID_PATTERN.test(k)));
  for (const key of keys) {
    if (ID_PATTERN.test(key)) {
      out.set(key, key);
      continue;
    }
    const base = toCardId(key);
    let id = base;
    for (let n = 2; taken.has(id); n++) {
      const suffix = `-${n}`;
      id = base.slice(0, MAX_ID - suffix.length).replace(/-+$/, "") + suffix;
    }
    taken.add(id);
    out.set(key, id);
  }
  return out;
}

// --------------------------------------------------------------------------
// Deck paths and names

const MINOR_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs"]);

/** `Cka::Workloads And Scheduling` -> `cka/workloads-and-scheduling.md`. */
export function deckToPath(deck: string): string {
  const parts = deck.split("::").map((p) => slugify(p.trim(), 80) || "deck");
  return parts.join("/") + ".md";
}

/**
 * `Cka::Workloads And Scheduling` -> `CKA: Workloads and Scheduling`.
 *
 * ankictl title-cases every word of a deck name (`Cka`, `And`), which reads
 * badly as a heading. Minor words go back to lower case except at the start,
 * and words listed in `acronyms` (matched case-insensitively) are written as
 * given. Anything else is left exactly as Anki has it.
 */
export function deckDisplayName(deck: string, acronyms: string[] = []): string {
  const byLower = new Map(acronyms.map((a) => [a.toLowerCase(), a]));
  return deck
    .split("::")
    .map((part) =>
      part
        .trim()
        .split(/\s+/)
        .map((word, i) => {
          const lower = word.toLowerCase();
          if (byLower.has(lower)) return byLower.get(lower)!;
          if (i > 0 && MINOR_WORDS.has(lower)) return lower;
          return word;
        })
        .join(" ")
    )
    .join(": ");
}

// --------------------------------------------------------------------------
// Cloze

export type ClozeDeletion = {
  /** Anki's c-number: `{{c3::…}}` is 3, card ordinal 2. */
  cNum: number;
  text: string;
  hint: string | null;
};

export type ClozeConversion = {
  /** Hashcards cloze body: `[…]` deletions, every other bracket escaped. */
  text: string;
  /** Deletions in order of appearance, which is hashcards' 1-based index. */
  deletions: ClozeDeletion[];
  /**
   * Anki c-number -> hashcards deletion index (1-based). Anki makes one card
   * per c-number, so this is how its review history finds the right card. A
   * c-number used more than once maps to its first deletion.
   */
  cNumToIndex: Map<number, number>;
  warnings: string[];
};

const CLOZE_OPEN = /\{\{c(\d+)::/y;

/**
 * Escape `[` and `]` that are not deletions.
 *
 * Hashcards' cloze scanner (src/parser.ts `scanClozeBytes`) treats every
 * unescaped `[` as a deletion, including inside code spans. `\[` is consumed
 * by the scanner and comes out as a literal `[` in the rendered text, inside
 * code spans too. Brackets that are already escaped stay as they are.
 */
export function escapeBrackets(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && (text[i + 1] === "[" || text[i + 1] === "]")) {
      out += c + text[i + 1];
      i++;
    } else if (c === "[" || c === "]") {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return out;
}

/** Split `text::hint` at the first top-level `::`. */
function splitHint(inner: string): { text: string; hint: string | null } {
  let depth = 0;
  for (let i = 0; i < inner.length - 1; i++) {
    if (inner.startsWith("{{", i)) depth++;
    else if (inner.startsWith("}}", i)) depth--;
    else if (depth === 0 && inner.startsWith("::", i)) {
      return { text: inner.slice(0, i), hint: inner.slice(i + 2) };
    }
  }
  return { text: inner, hint: null };
}

/**
 * `{{c1::text}}` / `{{c1::text::hint}}` -> `[text]`.
 *
 * Semantics that cannot be carried over are reported rather than changed:
 * - Hints have no hashcards equivalent and are dropped.
 * - A c-number used twice is one Anki card hiding both spans at once. In
 *   hashcards every `[…]` is its own card, so the second span becomes a new
 *   card with no history.
 * - Nested clozes cannot be expressed. The inner markers are flattened to
 *   plain text, so the inner c-number loses its card.
 */
export function convertCloze(source: string): ClozeConversion {
  const deletions: ClozeDeletion[] = [];
  const warnings: string[] = [];
  let out = "";
  let plainStart = 0;
  let i = 0;

  while (i < source.length) {
    CLOZE_OPEN.lastIndex = i;
    const open = CLOZE_OPEN.exec(source);
    if (!open) {
      i++;
      continue;
    }
    // Find the matching `}}`, counting nested openers.
    let depth = 1;
    let j = CLOZE_OPEN.lastIndex;
    let nested = false;
    while (j < source.length && depth > 0) {
      CLOZE_OPEN.lastIndex = j;
      if (CLOZE_OPEN.exec(source)) {
        depth++;
        nested = true;
        j = CLOZE_OPEN.lastIndex;
      } else if (source.startsWith("}}", j)) {
        depth--;
        j += 2;
      } else {
        j++;
      }
    }
    if (depth > 0) {
      warnings.push(`unterminated cloze at offset ${i}; left as text`);
      break;
    }

    const cNum = Number(open[1]);
    const inner = source.slice(i + open[0].length, j - 2);
    let { text, hint } = splitHint(inner);
    if (nested) {
      warnings.push(`nested cloze inside c${cNum}: inner deletions flattened to text`);
      text = flattenCloze(text);
    }
    if (hint !== null) {
      warnings.push(`c${cNum} hint "${hint}" dropped (hashcards has no cloze hints)`);
    }

    const before = escapeBrackets(source.slice(plainStart, i));
    if (before.endsWith("\\")) {
      // `\[` would make the deletion's own bracket literal.
      warnings.push(`c${cNum} follows a backslash; inserted a space so it stays a deletion`);
      out += before + " ";
    } else {
      out += before;
    }
    out += "[" + escapeBrackets(text) + "]";
    deletions.push({ cNum, text, hint });
    plainStart = i = j;
  }
  out += escapeBrackets(source.slice(plainStart));

  const cNumToIndex = new Map<number, number>();
  deletions.forEach((d, idx) => {
    if (cNumToIndex.has(d.cNum)) {
      warnings.push(
        `c${d.cNum} is used more than once: Anki shows these together as one card, ` +
          `hashcards makes deletion ${idx + 1} a separate card with no history`
      );
    } else {
      cNumToIndex.set(d.cNum, idx + 1);
    }
  });
  if (deletions.length === 0) warnings.push("cloze note has no {{cN::…}} deletions");

  return { text: out, deletions, cNumToIndex, warnings };
}

/** Replace every `{{cN::text::hint}}` with `text`, innermost first. */
export function flattenCloze(text: string): string {
  const innermost = /\{\{c\d+::((?:(?!\{\{c\d+::)[\s\S])*?)\}\}/;
  let prev: string;
  do {
    prev = text;
    text = text.replace(innermost, (_m, inner: string) => splitHint(inner).text);
  } while (text !== prev);
  return text;
}

// --------------------------------------------------------------------------
// Markdown dialect

export type MarkdownConversion = { text: string; warnings: string[] };

/** Code spans and fenced blocks, which no rewrite below may touch. */
const CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`]*?`+)/g;

/** Apply `fn` to the prose between code spans and fences only. */
function outsideCode(text: string, fn: (prose: string) => string): string {
  return text
    .split(CODE)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("");
}

/**
 * Port of src/typeset.ts `hasMath`: what makes the app load KaTeX and typeset
 * `$…$`. Applied to prose only, since KaTeX's auto-render skips `<code>`.
 */
export function looksLikeMath(prose: string): boolean {
  if (/\$\$[\s\S]+?\$\$/.test(prose)) return true;
  for (const [, inner] of prose.matchAll(/\$([^\s$][^$\n]*)\$/g)) {
    if (/[\\^_{}]/.test(inner)) return true;
    if (!/\s/.test(inner) && inner.length <= 8) return true;
  }
  return false;
}

/**
 * One field of ankictl Markdown (CommonMark via markdown-it, plus tables) ->
 * what hashcards renders (marked, GFM, `breaks: false`).
 *
 * Mostly the identity: a trailing `\` is a hard line break in both. The
 * differences that matter for real cards are handled here:
 * - GFM strikes through `~text~` and `~~text~~`; ankictl's CommonMark never
 *   did. marked is asked directly: when it would strike anything through,
 *   every tilde outside code is escaped. ("~1 min, ~2 billion" is safe:
 *   a closing tilde must not follow a space.)
 * - A line that is exactly `---` ends the card in a hashcards file. After a
 *   blank line it is a thematic break and becomes `***`; after text it is a
 *   setext heading and is flagged.
 * - A line starting `Q:`, `A:` or `C:` would start a new card. Flagged.
 * - `$…$` that hashcards would typeset as maths. Flagged.
 */
export function convertMarkdown(source: string): MarkdownConversion {
  const warnings: string[] = [];

  let text = source;
  const strikes = (t: string) => ((gfm.parse(t, { async: false }) as string).match(/<del>/g) ?? []).length;
  if (strikes(source) > (source.match(/<del>/g) ?? []).length) {
    text = outsideCode(source, (prose) => prose.replace(/(?<!\\)~/g, "\\~"));
    warnings.push("escaped `~` so GFM does not strike text through");
  }

  const lines = text.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    if (/^---\s*$/.test(line)) {
      if (i === 0 || lines[i - 1].trim() === "") {
        lines[i] = "***";
        warnings.push("`---` thematic break rewritten as `***` (`---` separates cards)");
      } else {
        warnings.push(`line ${i + 1}: setext \`---\` heading would end the card; fix by hand`);
      }
    }
    if (/^(Q|A|C):/.test(line)) {
      warnings.push(`line ${i + 1} starts with "${line.slice(0, 2)}", which starts a new card`);
    }
  }
  text = lines.join("\n");

  if (outsideCode(text, (p) => (looksLikeMath(p) ? "\u0000" : "")).includes("\u0000")) {
    warnings.push("contains `$…$` outside code that hashcards will typeset as maths");
  }
  return { text, warnings };
}

/**
 * ankictl's `<field>_html` escape hatch, which holds what Markdown could not:
 * typically MathJax. marked passes raw HTML through, so the HTML is kept, but
 * MathJax delimiters become the `$` / `$$` that hashcards' KaTeX looks for.
 */
export function convertRawHtml(html: string): MarkdownConversion {
  const warnings = ["raw HTML field kept as HTML (from ankictl `_html`)"];
  const text = html
    .replace(/\\\((.*?)\\\)/gs, (_m, tex: string) => `$${tex}$`)
    .replace(/\\\[(.*?)\\\]/gs, (_m, tex: string) => `$$${tex}$$`);
  if (text !== html) warnings.push("MathJax \\( \\) / \\[ \\] rewritten as $ / $$");
  // A blank line ends an HTML block in GFM, and the rest renders as Markdown.
  if (/\n\s*\n/.test(text.trim())) warnings.push("raw HTML contains blank lines; check rendering");
  return { text: text.trim(), warnings };
}
