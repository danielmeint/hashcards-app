import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RETENTION, MAX_RETENTION, MIN_RETENTION } from "../src/core/schedule";
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
  return { config, problems };
}

function show(value: TomlValue): string {
  return JSON.stringify(value);
}

/** The file `hc init` writes. `exclude` is whatever is not a deck in this repo today. */
export function renderConfig(exclude: readonly string[]): string {
  const list = exclude.map((p) => JSON.stringify(p)).join(", ");
  return `# Hashcards collection settings. Shared by every device and by \`hc\`.
# Device preferences (theme, haptics) stay on the device.

[review]
new_per_day = ${DEFAULT_NEW_PER_DAY}
desired_retention = ${DEFAULT_RETENTION}     # 0.80–0.95: the recall you aim for when a card comes due
fuzz = true                   # spread cards learned together over neighbouring days

[decks]
# Globs. One without a "/" matches a file name at any depth.
include = ["**/*.md"]
exclude = [${list}]
`;
}
