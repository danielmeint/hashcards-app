import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RETENTION, MAX_RETENTION, MIN_RETENTION } from "../src/core/schedule";
import { readLimit } from "../src/core/limits";
import type { NewCardLimit } from "../src/core/limits";
import { parseToml, TomlError } from "./toml";
import type { TomlTable, TomlValue } from "./toml";

/**
 * `hashcards.toml` (PLAN-1.0 §2.5): the collection's settings, read by the CLI.
 *
 * The app reads and writes the same file from M3 on; this is the CLI's reader
 * until the two can share one in `src/core/`. Missing file, missing table or
 * missing key all mean the default — a repo needs no config to work.
 */

export const CONFIG_FILE = "hashcards.toml";

export type Config = {
  review: {
    newPerDay: number;
    desiredRetention: number;
    fuzz: boolean;
  };
  /** Null when the file has no `[decks]`: then the default rule applies (`decks.ts`). */
  decks: { include: string[]; exclude: string[] } | null;
  /** `[limits.<name>]` new-card groups in file order (`src/core/limits.ts`), the usable ones. */
  limits: NewCardLimit[];
};

export type ConfigResult = {
  config: Config;
  /** Whether `hashcards.toml` exists. */
  present: boolean;
  /** What was wrong with it. The defaults stand in for whatever could not be read. */
  problems: { line: number | null; message: string }[];
};

export const DEFAULT_NEW_PER_DAY = 20;

export function defaultConfig(): Config {
  return {
    review: { newPerDay: DEFAULT_NEW_PER_DAY, desiredRetention: DEFAULT_RETENTION, fuzz: true },
    decks: null,
    limits: [],
  };
}

export function readConfig(repo: string): ConfigResult {
  let text: string;
  try {
    text = readFileSync(join(repo, CONFIG_FILE), "utf8");
  } catch {
    return { config: defaultConfig(), present: false, problems: [] };
  }
  return { ...parseConfig(text), present: true };
}

export function parseConfig(text: string): Omit<ConfigResult, "present"> {
  const config = defaultConfig();
  const problems: ConfigResult["problems"] = [];
  let doc;
  try {
    doc = parseToml(text);
  } catch (error) {
    if (!(error instanceof TomlError)) throw error;
    return { config, problems: [{ line: error.line, message: error.message }] };
  }
  const problem = (message: string) => problems.push({ line: null, message });

  const review: TomlTable = doc.review ?? {};
  const newPerDay = review.new_per_day;
  if (newPerDay !== undefined) {
    if (typeof newPerDay === "number" && Number.isInteger(newPerDay) && newPerDay >= 0) {
      config.review.newPerDay = newPerDay;
    } else problem(`[review] new_per_day must be a whole number ≥ 0, got ${show(newPerDay)}`);
  }
  const retention = review.desired_retention;
  if (retention !== undefined) {
    if (typeof retention === "number" && retention >= MIN_RETENTION && retention <= MAX_RETENTION) {
      config.review.desiredRetention = retention;
    } else {
      problem(
        `[review] desired_retention must be from ${MIN_RETENTION} to ${MAX_RETENTION}, got ${show(retention)}`
      );
    }
  }
  if (review.fuzz !== undefined) {
    if (typeof review.fuzz === "boolean") config.review.fuzz = review.fuzz;
    else problem(`[review] fuzz must be true or false, got ${show(review.fuzz)}`);
  }

  if (doc.decks) {
    const list = (key: string, fallback: string[]): string[] => {
      const value = doc.decks[key];
      if (value === undefined) return fallback;
      if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
      problem(`[decks] ${key} must be an array of glob strings, got ${show(value)}`);
      return fallback;
    };
    config.decks = { include: list("include", ["**/*.md"]), exclude: list("exclude", []) };
  }

  // Each group is its own table; a broken one is reported and left out.
  if (doc.limits && Object.keys(doc.limits).length > 0) {
    problem("[limits] holds no keys of its own: each group is a table, [limits.<name>]");
  }
  for (const [table, values] of Object.entries(doc)) {
    if (!table.startsWith("limits.")) continue;
    const { limit, problems: found } = readLimit(table.slice("limits.".length), values);
    found.forEach(problem);
    if (limit) config.limits.push(limit);
  }
  return { config, problems };
}

function show(value: TomlValue): string {
  return JSON.stringify(value);
}

/**
 * The file `hc init` and `hc migrate` write. `exclude` is whatever is not a
 * deck in this repo today; `review` is the defaults unless the caller knows
 * better (`hc migrate` reads them off the v1 state file).
 */
export function renderConfig(
  exclude: readonly string[],
  review: Partial<Config["review"]> = {}
): string {
  const list = exclude.map((p) => JSON.stringify(p)).join(", ");
  const { newPerDay, desiredRetention, fuzz } = { ...defaultConfig().review, ...review };
  const pad = (s: string) => s.padEnd(29);
  return `# Hashcards collection settings. Shared by every device and by \`hc\`.
# Device preferences (theme, haptics) stay on the device.

[review]
new_per_day = ${newPerDay}
${pad(`desired_retention = ${desiredRetention}`)} # 0.80–0.95: the recall you aim for when a card comes due
${pad(`fuzz = ${fuzz}`)} # spread cards learned together over neighbouring days

[decks]
# Globs. One without a "/" matches a file name at any depth.
include = ["**/*.md"]
exclude = [${list}]

# A group of decks can have its own new cards per day, within new_per_day
# above. A deck counts in the first group whose globs match it.
# [limits.languages]
# decks = ["languages/**"]
# new_per_day = 5
`;
}
