import {
  ConflictError,
  FileEntry,
  GitHubConfig,
  getBlobText,
  readFileIfPresent,
  repoKey,
  writeFile,
} from "./github";
import { getMeta, setMeta } from "./db";
import {
  CollectionConfig,
  ReviewConfig,
  parseConfig,
  writeReviewConfig,
} from "./collection-config";
import { settings } from "./settings";

/**
 * Keeping the review settings and `hashcards.toml` in step.
 *
 * The file is read on every sync of a collection whose tree changed, and
 * cached with its blob SHA. Its `[decks]` globs decide which files of *that*
 * collection are decks. Its `[review]` values are the collection's settings —
 * taken from your own collection, the first one you can write to, since there
 * is one schedule and one new-card budget however many collections feed it —
 * and copied into the local settings the app reads synchronously.
 *
 * A change made here is the other direction: the setter marks the value
 * dirty, and the next sync writes it into the file as one small commit through
 * the contents API, keeping every other line of the file as it was. Until it
 * has, the local value wins over the file's, so a sync in between does not
 * undo what you just chose.
 */

export const CONFIG_PATH = "hashcards.toml";

type Cached = { sha: string; text: string } | null;
const cacheKey = (repo: string) => `collection_config:${repo}`;

const FIELDS = ["newPerDay", "desiredRetention", "fuzz"] as const;
type Field = (typeof FIELDS)[number];

/**
 * The collection's config as of `entry`, its tree entry in a fresh listing
 * (undefined if the file is not there). Fetched only when its SHA moved.
 */
export async function readCollectionConfig(
  config: GitHubConfig,
  entry: FileEntry | undefined
): Promise<CollectionConfig> {
  const repo = repoKey(config);
  let cached = (await getMeta<Cached>(cacheKey(repo))) ?? null;
  if (!entry) {
    cached = null;
  } else if (cached?.sha !== entry.sha) {
    cached = { sha: entry.sha, text: await getBlobText(config, entry.sha) };
  }
  await setMeta(cacheKey(repo), cached);
  return parseConfig(cached?.text ?? "");
}

/** The config as last read, without asking GitHub. */
export async function cachedCollectionConfig(repo: string): Promise<CollectionConfig> {
  const cached = (await getMeta<Cached>(cacheKey(repo))) ?? null;
  return parseConfig(cached?.text ?? "");
}

export function markDirty(field: Field): void {
  const dirty = new Set(settings.collectionDirty.get());
  dirty.add(field);
  settings.collectionDirty.set([...dirty]);
}

/** Local values as a `[review]` table, for the fields given. */
function localReview(fields: Iterable<string>): ReviewConfig {
  const review: ReviewConfig = {};
  for (const field of fields) {
    if (field === "newPerDay") review.newPerDay = settings.newCardsPerDay.get();
    if (field === "desiredRetention") review.desiredRetention = settings.desiredRetention.get();
    if (field === "fuzz") review.fuzz = settings.intervalFuzz.get();
  }
  return review;
}

/**
 * Take the file's `[review]` values for every setting not changed here since.
 * Returns whether anything that schedules cards changed, which means the
 * replayed state is out of date.
 */
export function adoptReviewConfig(review: ReviewConfig): boolean {
  const dirty = new Set(settings.collectionDirty.get());
  let rescheduled = false;
  if (review.newPerDay !== undefined && !dirty.has("newPerDay")) {
    settings.newCardsPerDay.set(review.newPerDay);
  }
  if (
    review.desiredRetention !== undefined &&
    !dirty.has("desiredRetention") &&
    review.desiredRetention !== settings.desiredRetention.get()
  ) {
    settings.desiredRetention.set(review.desiredRetention);
    rescheduled = true;
  }
  if (review.fuzz !== undefined && !dirty.has("fuzz") && review.fuzz !== settings.intervalFuzz.get()) {
    settings.intervalFuzz.set(review.fuzz);
    rescheduled = true;
  }
  return rescheduled;
}

/**
 * Write the settings changed here into the collection's `hashcards.toml`, as
 * one commit. Creates the file if there is none. A lost race (another device
 * saved it first) is read again and retried once: only the dirty lines are
 * ours to change, so building on the newer file loses nothing of theirs.
 */
export async function pushCollectionSettings(config: GitHubConfig): Promise<void> {
  const dirty = settings.collectionDirty.get();
  if (dirty.length === 0) return;
  const repo = repoKey(config);
  const written = localReview(dirty);
  for (let attempt = 0; ; attempt++) {
    const existing = await readFileIfPresent(config, CONFIG_PATH);
    const before = existing?.text ?? "";
    const text = writeReviewConfig(before, written);
    try {
      let sha = existing?.sha ?? "";
      if (text !== before) {
        sha = await writeFile(config, CONFIG_PATH, text, {
          ...(existing ? { sha: existing.sha } : {}),
          message: "Update review settings",
        });
      }
      await setMeta(cacheKey(repo), { sha, text } satisfies Cached);
      break;
    } catch (e) {
      if (!(e instanceof ConflictError) || attempt >= 1) throw e;
    }
  }
  // Only what was written: a setting changed again while the write was in
  // flight is still owed.
  const now = localReview(FIELDS);
  settings.collectionDirty.set(
    settings.collectionDirty
      .get()
      .filter((f) => written[f as Field] === undefined || written[f as Field] !== now[f as Field])
  );
}
