export enum Grade {
  Forgot = 1,
  Hard = 2,
  Good = 3,
  Easy = 4,
}

export type BasicCard = {
  type: "basic";
  question: string;
  answer: string;
};

export type ClozeCard = {
  type: "cloze";
  text: string;
  start: number;
  end: number;
};

export type CardContent = BasicCard | ClozeCard;

export type Card = {
  deckName: string;
  /**
   * `owner/repo` — which collection this card came out of. Stamped when cards
   * are read out of the deck store rather than stored on each one, so it cannot
   * drift from the file it actually belongs to; an edit needs it to know which
   * repository to commit to, and there may be more than one.
   */
  repo: string;
  filePath: string;
  /**
   * The lines of `filePath` this card was parsed from: absolute, 1-based and
   * inclusive, counting the frontmatter. That is what a `#L12-L18` link on
   * GitHub means by a line number, and what a person reading the file expects.
   */
  range: [number, number];
  content: CardContent;
  /**
   * The v1 content hash. Since M3 the app keys on `key`; the hash only derives
   * `h:` keys, maps v1 history across, and is what a collection that has not
   * been migrated yet still records. Metadata lines never enter it, so stamping
   * an ID onto a card leaves it unchanged.
   */
  hash: string;
  familyHash: string | null;
  /** The `ID:` line of the card's block, if it has one. */
  id: string | null;
  /** What the review log will call this card — see `card-key.ts`. */
  key: string;
  /** The file's frontmatter `tags`, then the block's own `Tags:`, deduplicated. */
  tags: string[];
  /**
   * `draft` cards are proposals waiting in the Inbox, `suspended` ones are kept
   * but not scheduled: neither is ever due, nor introduced as new.
   */
  status: CardStatus;
};

export type CardStatus = "active" | "draft" | "suspended";

/**
 * A card as the parser produces it: everything a file can say about a card, and
 * nothing about where the file came from. The parser reads a file; which
 * collection that file belongs to is not a question it can answer.
 */
export type ParsedCard = Omit<Card, "repo">;

export type NewPerformance = {
  type: "new";
};

export type ReviewedPerformance = {
  type: "reviewed";
  lastReviewedAt: string; // ISO date string
  stability: number;
  difficulty: number;
  intervalRaw: number;
  intervalDays: number;
  dueDate: string; // YYYY-MM-DD
  reviewCount: number;
};

export type Performance = NewPerformance | ReviewedPerformance;

/**
 * One grade, as this device recorded it. Each one is a v2 review event
 * (`reviewEvent` in `review-log.ts`) in the log of collection `log`, and the
 * extra fields are what a not-yet-migrated collection's v1 files still need.
 */
export type Review = {
  /**
   * The card, as the app keys it locally: `owner/repo/<key>`
   * (`stateKey` in `db.ts`).
   */
  key: string;
  /**
   * `owner/repo` of the collection whose data branch this review is pushed to:
   * the card's own collection, or for a subscribed card the first one you can
   * write to. Empty when there is none, and the review stays on this device.
   */
  log: string;
  /** Local UTC offset in minutes when it was taken, east positive. */
  tz: number;
  /** The v1 content hash of the card at the time, for v1 files. */
  cardHash: string;
  reviewedAt: string;
  grade: Grade;
  stability: number;
  difficulty: number;
  intervalRaw: number;
  intervalDays: number;
  dueDate: string;
  /**
   * How long the card was in front of you before this grade, as Anki records
   * it. Absent on reviews from before it was measured.
   */
  durationMs?: number;
  /**
   * Already in a v1 log file (`hashcards-reviews/`). Migration (M4) carries
   * those into the data branch itself, so this device must not push them there
   * a second time — replay would count the grade twice.
   */
  v1Pushed?: boolean;
};

/**
 * A drill in progress, persisted alongside each grade so an interrupted session
 * can be picked up where it left off. Cards are stored by key and rehydrated
 * from the cached card set; a card that has since vanished from the repo is
 * dropped on resume.
 *
 * `revealed` is deliberately not persisted — resuming should show the front of
 * the card, not hand back an answer that was already on screen.
 */
export type DrillSession = {
  /** Remaining cards, in queue order. */
  queue: string[];
  /**
   * Cards in the old reinforcement mode (Again / Got it). No longer written —
   * a re-shown card is graded like any other — but a session saved before that
   * change may still carry it, and it is safe to ignore.
   */
  requeued?: string[];
  /** Cards retired from the queue. */
  completed: string[];
  /** New cards already charged against today's budget this session. */
  gradedNew: string[];
  /** Queue size at session start, for the progress bar. */
  totalCards: number;
  startedAt: string;
};
